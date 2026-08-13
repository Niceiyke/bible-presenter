use crate::remote::auth::{now_unix, AuthError, StoredDevice};
use crate::remote::commands;
use crate::remote::protocol::{
    RemoteCommand, RemoteCommandResult, RemoteCommandType, RemoteEvent, RemoteEventKind,
    RemotePairPayload, RemoteRole,
};
use crate::remote::RemoteControl;
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::mpsc;
use tower_http::services::ServeDir;

/// Everything the remote server needs to serve requests. `state` and
/// `control` are the *authoritative* application state — the server never
/// keeps a second copy. Cloning the context clones the AppHandle and cheap
/// Arcs, so axum can own it.
#[derive(Clone)]
pub struct RemoteCtx {
    pub app: AppHandle,
    pub state: AppState,
    pub control: Arc<RemoteControl>,
}

pub fn router(ctx: RemoteCtx) -> Router {
    let assets_dir = ctx.control.files_dir.clone();

    Router::new()
        .route("/ws", get(ws_handler))
        .route("/remote", get(|| async { axum::response::Redirect::temporary("/remote.html") }))
        .route("/health", get(|| async { "ok" }))
        .fallback_service(ServeDir::new(&assets_dir).not_found_service(tower_http::services::ServeFile::new(assets_dir.join("index.html"))))
        .with_state(ctx)
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(ctx): State<RemoteCtx>,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, ctx, addr))
}

/// Binds the remote server on a random local port and returns the bound
/// address. `files_dir` must already contain the compiled `remote.html`.
/// Records the bound address and task handle on `control` so `remote_disable`
/// can shut the server down and `remote_status` can report port/URLs.
pub async fn start(ctx: RemoteCtx) -> Result<SocketAddr, String> {
    let control = ctx.control.clone();
    control.enabled.store(true, std::sync::atomic::Ordering::SeqCst);
    let app = router(ctx);
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let handle = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    *control.task.lock() = Some(handle);
    *control.bound_addr.lock() = Some(addr);
    Ok(addr)
}

async fn handle_socket(socket: WebSocket, ctx: RemoteCtx, addr: SocketAddr) {
    let (mut sender, mut receiver) = socket.split();

    // --- Authentication handshake (first message must be pair or auth) ---
    let (device, newly_issued_token) = match authenticate_handshake(&mut receiver, &ctx, addr).await {
        Ok(ok) => ok,
        Err(e) => {
            let result = RemoteCommandResult::err("handshake", 0, e.code(), &e.message());
            let _ = sender
                .send(Message::Text(Utf8Bytes::from(serde_json::to_string(&result).unwrap_or_default())))
                .await;
            return;
        }
    };

    ctx.control.sessions.connect(&device.id, &device.name);
    ctx.control.tokens.touch_last_seen(&device.id);
    ctx.control.persist_devices();

    let device_id = device.id.clone();

    // A freshly-paired device must learn its long-lived token before anything
    // else so the browser can persist it for future sessions.
    if let Some(token) = newly_issued_token {
        let result = RemoteCommandResult::ok_with(
            "pair",
            ctx.control.hub.current_revision(),
            json!({ "device_id": device_id.clone(), "device_token": token, "role": "operator" }),
        );
        if sender.send(Message::Text(Utf8Bytes::from(serde_json::to_string(&result).unwrap_or_default()))).await.is_err() {
            return;
        }
    }

    // Send the initial authoritative snapshot before entering the live loop so
    // every client hydrates before it can send mutating commands.
    let snapshot = crate::remote::snapshot::build_snapshot(
        &ctx.app,
        &ctx.state,
        device.role.clone(),
        Some(device_id.clone()),
        ctx.control.lease.state(),
    );
    let snapshot_event = RemoteEvent {
        kind: RemoteEventKind::Snapshot,
        revision: ctx.control.hub.current_revision(),
        timestamp: now_unix(),
        source_device_id: None,
        payload: serde_json::to_value(&snapshot).unwrap_or_else(|_| json!({})),
    };
    if sender
        .send(Message::Text(Utf8Bytes::from(serde_json::to_string(&snapshot_event).unwrap_or_default())))
        .await
        .is_err()
    {
        return;
    }

    let device_ctx = DeviceCtx {
        device,
        state: ctx.state.clone(),
        control: ctx.control.clone(),
        app: ctx.app.clone(),
    };

    // Client messages arrive on `incoming`; responses/events go out on
    // `outgoing` so the single select loop never contends over the socket.
    let (incoming_tx, mut incoming_rx) = mpsc::unbounded_channel::<Message>();
    let (outgoing_tx, mut outgoing_rx) = mpsc::unbounded_channel::<Message>();

    {
        let incoming_tx = incoming_tx.clone();
        let mut receiver = receiver;
        tokio::spawn(async move {
            while let Some(msg) = receiver.next().await {
                match msg {
                    Ok(Message::Text(t)) => {
                        if incoming_tx.send(Message::Text(t)).is_err() {
                            break;
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            let _ = incoming_tx.send(Message::Close(None));
        });
    }

    let mut hub_rx = ctx.control.hub.subscribe();
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(15));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            msg = incoming_rx.recv() => {
                let Some(raw) = msg else { break };
                match raw {
                    Message::Text(text) => handle_client_text(text.as_str(), &device_ctx, &outgoing_tx).await,
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            out = outgoing_rx.recv() => {
                let Some(msg) = out else { break };
                if sender.send(msg).await.is_err() {
                    break;
                }
            }
            ev = hub_rx.recv() => {
                match ev {
                    Ok(event) => {
                        let json = serde_json::to_string(&event).unwrap_or_default();
                        if outgoing_tx.send(Message::Text(Utf8Bytes::from(json))).is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Missed events — resynchronize with a fresh snapshot.
                        let snapshot = crate::remote::snapshot::build_snapshot(
                            &ctx.app,
                            &ctx.state,
                            device_ctx.device.role.clone(),
                            Some(device_ctx.device.id.clone()),
                            ctx.control.lease.state(),
                        );
                        let event = RemoteEvent {
                            kind: RemoteEventKind::Snapshot,
                            revision: ctx.control.hub.current_revision(),
                            timestamp: now_unix(),
                            source_device_id: None,
                            payload: serde_json::to_value(&snapshot).unwrap_or_else(|_| json!({})),
                        };
                        let json = serde_json::to_string(&event).unwrap_or_default();
                        if outgoing_tx.send(Message::Text(Utf8Bytes::from(json))).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            _ = heartbeat.tick() => {
                if outgoing_tx.send(Message::Ping(Bytes::new())).is_err() {
                    break;
                }
            }
        }
    }

    // Cleanup: unregister session and release the controller lease so another
    // device can take over. Disconnecting never alters displayed content.
    ctx.control.sessions.disconnect(&device_id.clone());
    if ctx.control.lease.holder_id().as_deref() == Some(device_id.as_str()) {
        ctx.control.lease.release(&device_id);
        ctx.control.hub.publish(
            RemoteEventKind::ControllerChanged,
            json!({ "controller_state": ctx.control.lease.state() }),
            None,
        );
    }
}

#[derive(Clone)]
struct DeviceCtx {
    device: StoredDevice,
    state: AppState,
    control: Arc<RemoteControl>,
    app: AppHandle,
}

/// Reads the first WS message and pairs or authenticates the device. Returns
/// the authenticated device and the newly-issued token (if this was a pair).
async fn authenticate_handshake(
    receiver: &mut futures_util::stream::SplitStream<WebSocket>,
    ctx: &RemoteCtx,
    addr: SocketAddr,
) -> Result<(StoredDevice, Option<String>), AuthError> {
    let Some(msg) = receiver.next().await else {
        return Err(AuthError::UnknownToken);
    };
    let text = match msg {
        Ok(Message::Text(t)) => t,
        _ => return Err(AuthError::UnknownToken),
    };
    let command: RemoteCommand = serde_json::from_str(text.as_str()).map_err(|_| AuthError::UnknownToken)?;

    match command.r#type {
        RemoteCommandType::RemotePair => {
            let payload: RemotePairPayload = command
                .payload
                .and_then(|v| serde_json::from_value(v).ok())
                .ok_or(AuthError::UnknownToken)?;
ctx.control
            .tokens
            .validate_pairing(&payload.pairing_token, &addr.ip().to_string())?;
            let device_token = crate::remote::auth::new_token();
            let device = ctx.control.tokens.register_device(
                &device_token,
                payload.device_name,
                RemoteRole::Operator,
            );
            ctx.control.tokens.consume_pairing(&payload.pairing_token);
            ctx.control.persist_devices();
            Ok((device, Some(device_token)))
        }
        RemoteCommandType::RemoteAuthenticate => {
            let token = command
                .payload
                .and_then(|v| v.get("device_token").and_then(|t| t.as_str()).map(|s| s.to_string()))
                .ok_or(AuthError::UnknownToken)?;
            let device = ctx.control.tokens.authenticate_device(&token)?;
            Ok((device, None))
        }
        _ => Err(AuthError::UnknownToken),
    }
}

async fn handle_client_text(text: &str, ctx: &DeviceCtx, outgoing: &mpsc::UnboundedSender<Message>) {
    let command: RemoteCommand = match serde_json::from_str(text) {
        Ok(c) => c,
        Err(_) => {
            let result = RemoteCommandResult::err(
                "parse",
                ctx.control.hub.current_revision(),
                "parse_error",
                "Invalid command JSON",
            );
            send_result(outgoing, &result);
            return;
        }
    };

    ctx.control.sessions.touch(&ctx.device.id);
    ctx.control.tokens.touch_last_seen(&ctx.device.id);

    if ctx.control.lease.is_held_by(&ctx.device.id) {
        let _ = ctx.control.lease.renew(&ctx.device.id);
    }

    let result = commands::dispatch(
        &ctx.app,
        &ctx.state,
        &ctx.control,
        &ctx.device,
        &command,
    )
    .await;
    send_result(outgoing, &result);
}

fn send_result(outgoing: &mpsc::UnboundedSender<Message>, result: &RemoteCommandResult) {
    if let Ok(json) = serde_json::to_string(result) {
        let _ = outgoing.send(Message::Text(Utf8Bytes::from(json)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_result_serializes_device_token() {
        let json = serde_json::json!({
            "device_id": "d1",
            "device_token": "tok-123",
            "role": "operator"
        });
        assert_eq!(json["device_token"], "tok-123");
    }
}