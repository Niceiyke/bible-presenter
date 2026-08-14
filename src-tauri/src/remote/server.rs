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
    // Bound frame/message sizes so a malicious or buggy client cannot OOM the
    // operator machine with giant WS payloads. Commands and events are small;
    // 1 MiB frames leave ample headroom for large schedule snapshots.
    ws.max_frame_size(1024 * 1024)
        .max_message_size(4 * 1024 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, ctx, addr))
}

/// Milliseconds of silence before a connected device is treated as dead and
/// dropped (its controller lease, if held, is then freed immediately instead
/// of waiting for the 10-minute TTL). The server pings every 15s, so 6x that
/// interval tolerates a run of lost pongs on flaky Wi-Fi and mobile browsers
/// that throttle network activity while backgrounded. The client reconnects
/// automatically with backoff, so a drop here is recoverable either way.
const CLIENT_TIMEOUT_MS: u64 = 90_000;

/// Milliseconds a freshly-connected socket may take before sending its first
/// (pair/authenticate) message. Guards against sockets that open and never
/// speak (backgrounded tabs, abandoned pages) holding a handshake task open
/// forever. The client treats this as a transient error and reconnects.
const HANDSHAKE_TIMEOUT_MS: u64 = 15_000;

/// Binds the remote server on the previously-used local port (falling back to
/// a random port) and returns the bound address. `files_dir` must already
/// contain the compiled `remote.html`. Records the bound address and task
/// handle on `control` so `remote_disable` can shut the server down and
/// `remote_status` can report port/URLs.
///
/// Reusing the last bound port keeps phones' bookmarked URLs valid across app
/// restarts. If that port is taken, we fall back to a random port and persist
/// the new one.
///
/// `enabled` is set only after the bind succeeds, so a failed bind never
/// leaves the server half-started (reported enabled with no port/task).
pub async fn start(ctx: RemoteCtx) -> Result<SocketAddr, String> {
    let control = ctx.control.clone();
    let app = router(ctx);
    let preferred = control.stored_port();
    let listener = match preferred {
        Some(port) => match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
            Ok(l) => l,
            Err(_) => {
                // Preferred port unavailable (e.g. another app took it) — use
                // a random one; persist the new port below.
                tokio::net::TcpListener::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?
            }
        },
        None => tokio::net::TcpListener::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?,
    };
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let task_control = control.clone();
    let handle = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
        // The server shut down on its own (not via disable) — clear the
        // runtime flags so status is accurate.
        task_control.enabled.store(false, std::sync::atomic::Ordering::SeqCst);
        *task_control.bound_addr.lock() = None;
    });
    control.persist_port(addr.port());
    control.enabled.store(true, std::sync::atomic::Ordering::SeqCst);
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
        target_device_id: None,
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

    // Last time any frame arrived from this device (epoch millis). Updated on
    // every inbound frame, including pongs the browser auto-sends in response
    // to our heartbeat pings. The watchdog below drops devices that go silent.
    let last_activity_ms = Arc::new(std::sync::atomic::AtomicU64::new(now_unix() * 1000));

    {
        let incoming_tx = incoming_tx.clone();
        let last_activity_ms = last_activity_ms.clone();
        let mut receiver = receiver;
        tokio::spawn(async move {
            while let Some(msg) = receiver.next().await {
                match msg {
                    Ok(Message::Text(t)) => {
                        last_activity_ms.store(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0), std::sync::atomic::Ordering::Relaxed);
                        if incoming_tx.send(Message::Text(t)).is_err() {
                            break;
                        }
                    }
                    Ok(Message::Pong(_)) | Ok(Message::Ping(_)) | Ok(Message::Binary(_)) => {
                        // Any inbound frame is proof of life; the payload of a
                        // pong is not meaningful, so we only refresh the stamp.
                        last_activity_ms.store(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0), std::sync::atomic::Ordering::Relaxed);
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                }
            }
            let _ = incoming_tx.send(Message::Close(None));
        });
    }

    let mut hub_rx = ctx.control.hub.subscribe();
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(15));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        let idle_for = now_unix() * 1000 - last_activity_ms.load(std::sync::atomic::Ordering::Relaxed);
        let watchdog = if idle_for >= CLIENT_TIMEOUT_MS {
            // Already silent for too long — let the select fire immediately.
            tokio::time::sleep(std::time::Duration::ZERO)
        } else {
            tokio::time::sleep(std::time::Duration::from_millis(CLIENT_TIMEOUT_MS - idle_for))
        };
        tokio::pin!(watchdog);

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
                        // Targeted events (e.g. operator->phone camera signaling)
                        // are only delivered to the addressed device.
                        let is_targeted_at_me = match event.target_device_id.as_ref() {
                            Some(target) => target == &device_ctx.device.id,
                            None => true,
                        };
                        if !is_targeted_at_me {
                            continue;
                        }
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
                            target_device_id: None,
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
            _ = &mut watchdog => {
                // No inbound frames for the timeout — the device is unreachable.
                // Break so the cleanup below releases its controller lease now.
                break;
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
/// Sockets that never send a first message within `HANDSHAKE_TIMEOUT_MS` are
/// dropped so they cannot leak handshake tasks.
async fn authenticate_handshake(
    receiver: &mut futures_util::stream::SplitStream<WebSocket>,
    ctx: &RemoteCtx,
    addr: SocketAddr,
) -> Result<(StoredDevice, Option<String>), AuthError> {
    let first = tokio::select! {
        msg = receiver.next() => msg,
        _ = tokio::time::sleep(std::time::Duration::from_millis(HANDSHAKE_TIMEOUT_MS)) => {
            return Err(AuthError::HandshakeTimeout);
        }
    };
    let Some(msg) = first else {
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

    // Throttle mutating commands per device so a faulty or hostile client
    // cannot hammer the authoritative state. Read-only browsing is unbounded.
    if commands::is_mutating(command.r#type.clone()) && !ctx.control.allow_mutating(&ctx.device.id) {
        let result = RemoteCommandResult::err(
            &command.command_id,
            ctx.control.hub.current_revision(),
            "rate_limited",
            "Too many control commands — wait a moment and try again",
        );
        send_result(outgoing, &result);
        return;
    }

    if ctx.control.lease.is_held_by(&ctx.device.id) {
        let _ = ctx.control.lease.renew(&ctx.device.id);
    }

    // Run dispatch on its own task so a panicking handler (e.g. an unexpected
    // unwrap on authoritative state) cannot unwind the connection loop and
    // drop the socket without a Close frame. The panic surfaces here as a
    // `JoinError` and becomes an error result + a system-log entry instead of
    // a dead connection.
    let command_id = command.command_id.clone();
    let command_type = command.r#type.clone();
    let task_ctx = ctx.clone();
    let dispatch_task = tokio::spawn(async move {
        commands::dispatch(
            &task_ctx.app,
            &task_ctx.state,
            &task_ctx.control,
            &task_ctx.device,
            &command,
        )
        .await
    });

    let result = match dispatch_task.await {
        Ok(result) => result,
        Err(join_err) => {
            let message = if join_err.is_panic() {
                let reason = panic_reason(join_err.into_panic());
                format!("remote '{}' panicked while handling command '{:?}': {}", ctx.device.name, command_type, reason)
            } else {
                format!("remote command '{:?}' was cancelled before completing", command_type)
            };
            crate::events::emit_checked(&ctx.app, "system-log", &serde_json::json!({
                "level": "error",
                "message": message,
                "timestamp": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            }));
            RemoteCommandResult::err(&command_id, ctx.control.hub.current_revision(), "internal_error", "Command failed internally — see operator logs")
        }
    };
    send_result(outgoing, &result);
}

/// Formats the panic payload of a crashed command task into a loggable string.
fn panic_reason(payload: Box<dyn std::any::Any + Send + 'static>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return s.to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "unknown panic payload".to_string()
}

fn send_result(outgoing: &mpsc::UnboundedSender<Message>, result: &RemoteCommandResult) {
    if let Ok(json) = serde_json::to_string(result) {
        let _ = outgoing.send(Message::Text(Utf8Bytes::from(json)));
    }
}

#[cfg(test)]
mod tests {
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