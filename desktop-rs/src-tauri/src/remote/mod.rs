/// LAN remote-control + WebRTC signaling server.
///
/// Starts an axum HTTP + WebSocket server on `0.0.0.0:port`.
/// `GET /`       → self-contained HTML remote-control panel
/// `GET /camera` → mobile PWA for sending WebRTC camera feeds
/// `WS  /ws`     → bidirectional JSON protocol
///
/// WebSocket protocol overview
/// ───────────────────────────
/// 1. First message must be {"cmd":"auth","pin":"XXXX"}
///    Extended fields for WebRTC clients:
///      - "client_type": "window:main" | "window:output" | "mobile" (default: "remote")
///      - "device_id":   mobile UUID (required when client_type="mobile")
///      - "device_name": human-readable mobile name
///
/// 2. Server replies {"type":"auth_ok"} or {"type":"auth_fail"}.
///
/// 3. Signaling messages carry a "target" field and are relayed directly:
///    - Mobile → Operator: {"cmd":"camera_offer","target":"operator","device_id":"...","sdp":"..."}
///    - Mobile → Output:   {"cmd":"camera_offer","target":"output","device_id":"...","sdp":"..."}
///    - Window → Mobile:   {"cmd":"camera_answer","target":"mobile:uuid","device_id":"...","sdp":"..."}
///    - Any side:          {"cmd":"camera_ice","target":"...","device_id":"...","candidate":{...}}
///
/// 4. Lifecycle commands (no target field; server resolves from device_id):
///    - {"cmd":"camera_connect_program",   "device_id":"uuid"} → routes {"event":"connect_program"}   to mobile
///    - {"cmd":"camera_disconnect_program","device_id":"uuid"} → routes {"event":"disconnect_program"} to mobile
///
/// 5. Mobile connect/disconnect are broadcast to all clients:
///    - {"type":"camera_source_connected",   "device_id":"...","device_name":"..."}
///    - {"type":"camera_source_disconnected","device_id":"..."}
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State as AxumState,
    },
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

use bible_presenter_lib::store;
use crate::AppState;

// ─── Embedded HTML assets ─────────────────────────────────────────────────────

const REMOTE_HTML: &str = include_str!("remote.html");
const CAMERA_HTML: &str = include_str!("camera.html");

// ─── Start ────────────────────────────────────────────────────────────────────

pub async fn start(state: Arc<AppState>, port: u16) {
    let app = Router::new()
        .route("/",      get(serve_remote_html))
        .route("/camera", get(serve_camera_html))
        .route("/ws",    get(ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            println!("[remote] Listening on http://{}", addr);
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("[remote] Server error: {}", e);
            }
        }
        Err(e) => {
            eprintln!("[remote] Failed to bind port {}: {}", port, e);
        }
    }
}

// ─── HTTP handlers ─────────────────────────────────────────────────────────────

async fn serve_remote_html() -> impl IntoResponse {
    Html(REMOTE_HTML)
}

async fn serve_camera_html() -> impl IntoResponse {
    Html(CAMERA_HTML)
}

// ─── WebSocket upgrade ────────────────────────────────────────────────────────

async fn ws_handler(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

// ─── WebSocket session ────────────────────────────────────────────────────────

/// Client identity resolved during auth handshake.
struct ClientInfo {
    /// Registry key: "window:main", "window:output", "mobile:{uuid}", "remote:{uuid}"
    key: String,
    /// Raw device_id (non-empty for mobile clients only)
    device_id: String,
    /// Human-readable name (mobile clients only)
    device_name: String,
    is_mobile: bool,
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    // ── 1. Auth handshake (extended to capture client identity) ───────────────
    let pin = state.remote_pin.lock().clone();
    let auth_result: Result<Option<Option<ClientInfo>>, _> = tokio::time::timeout(
        tokio::time::Duration::from_secs(30),
        async {
            while let Some(Ok(msg)) = socket.recv().await {
                if let Message::Text(text) = msg {
                    if let Ok(v) = serde_json::from_str::<Value>(&text) {
                        if v.get("cmd").and_then(|c| c.as_str()) == Some("auth") {
                            let provided = v.get("pin").and_then(|p| p.as_str()).unwrap_or("");
                            if provided != pin.as_str() {
                                return Some(None); // wrong PIN — signal auth fail
                            }

                            let client_type = v.get("client_type")
                                .and_then(|t| t.as_str())
                                .unwrap_or("remote");
                            let device_id = v.get("device_id")
                                .and_then(|d| d.as_str())
                                .unwrap_or("")
                                .to_string();
                            let device_name = v.get("device_name")
                                .and_then(|n| n.as_str())
                                .unwrap_or(&device_id)
                                .to_string();
                            let is_mobile = client_type == "mobile";

                            let key = match client_type {
                                "window:main"   => "window:main".to_string(),
                                "window:output" => "window:output".to_string(),
                                "mobile" if !device_id.is_empty() => {
                                    format!("mobile:{}", device_id)
                                }
                                _ => format!("remote:{}", uuid::Uuid::new_v4()),
                            };

                            return Some(Some(ClientInfo { key, device_id, device_name, is_mobile }));
                        }
                        // Ignore non-auth messages silently
                    }
                }
            }
            None // Connection closed before auth
        },
    )
    .await;

    let info = match auth_result {
        Ok(Some(Some(info))) => {
            let _ = socket.send(Message::Text(json!({"type":"auth_ok"}).to_string())).await;
            info
        }
        Ok(Some(None)) => {
            let _ = socket.send(Message::Text(json!({"type":"auth_fail"}).to_string())).await;
            return;
        }
        _ => {
            // Auth timeout or closed connection — close silently
            return;
        }
    };

    let client_key = info.key.clone();
    let device_id  = info.device_id.clone();
    let device_name = info.device_name.clone();
    let is_mobile  = info.is_mobile;

    // ── 2. Register direct signaling channel ──────────────────────────────────
    let (direct_tx, mut direct_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    state.signaling_clients.lock().insert(client_key.clone(), direct_tx);

    // ── 3. Broadcast mobile connect event ─────────────────────────────────────
    if is_mobile && !device_id.is_empty() {
        state.connected_cameras.lock().await.insert(device_id.clone(), device_name.clone());
        let msg = json!({
            "type": "camera_source_connected",
            "device_id": device_id,
            "device_name": device_name,
        })
        .to_string();
        let _ = state.broadcast_tx.send(msg);
    }

    // ── 4. Subscribe to broadcast channel ─────────────────────────────────────
    let mut bcast_rx = state.broadcast_tx.subscribe();

    // ── 5. Split socket for concurrent I/O ────────────────────────────────────
    let (mut sender, mut receiver) = socket.split();

    // Write loop: forward both broadcast messages AND direct targeted messages.
    let write_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                result = bcast_rx.recv() => {
                    match result {
                        Ok(msg) => {
                            if sender.send(Message::Text(msg)).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                msg_opt = direct_rx.recv() => {
                    match msg_opt {
                        Some(msg) => {
                            if sender.send(Message::Text(msg)).await.is_err() {
                                break;
                            }
                        }
                        None => break, // sender dropped
                    }
                }
            }
        }
    });

    // ── 6. Read loop ──────────────────────────────────────────────────────────
    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(text) = msg {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                route_or_handle(&state, v, &text, &client_key).await;
            }
        }
    }

    // ── 7. Cleanup ────────────────────────────────────────────────────────────
    write_task.abort();
    state.signaling_clients.lock().remove(&client_key);

    if is_mobile && !device_id.is_empty() {
        state.connected_cameras.lock().await.remove(&device_id);
        let msg = json!({
            "type": "camera_source_disconnected",
            "device_id": device_id,
        })
        .to_string();
        let _ = state.broadcast_tx.send(msg);
    }
}

// ─── Message routing ──────────────────────────────────────────────────────────

/// Routes a WebSocket message either to a specific client (signaling relay) or
/// to the general command handler (remote panel commands, state queries, etc.).
async fn route_or_handle(state: &Arc<AppState>, v: Value, raw: &str, from_key: &str) {
    // If the message carries an explicit `target`, relay it directly.
    if let Some(target_raw) = v.get("target").and_then(|t| t.as_str()) {
        let target_key = normalize_target(target_raw);

        // Inject _from into the message so the recipient knows who sent it.
        // This is crucial for WebRTC clients to match answers to the correct PC.
        let relayed_raw = if let Some(mut obj) = v.as_object().cloned() {
            obj.insert("_from".to_string(), json!(from_key));
            Value::Object(obj).to_string()
        } else {
            raw.to_string()
        };

        let clients = state.signaling_clients.lock();
        if let Some(ch) = clients.get(&target_key) {
            let _ = ch.send(relayed_raw);
        }
        return;
    }

    let cmd = v.get("cmd").and_then(|c| c.as_str()).unwrap_or("");

    // Lifecycle commands: implicit routing to mobile by device_id.
    if cmd == "camera_connect_program" || cmd == "camera_disconnect_program" {
        let dev_id = str_field(&v, "device_id");
        if !dev_id.is_empty() {
            let target_key = format!("mobile:{}", dev_id);
            let event_name = if cmd == "camera_connect_program" {
                "connect_program"
            } else {
                "disconnect_program"
            };
            let event_msg = json!({ "event": event_name }).to_string();
            let clients = state.signaling_clients.lock();
            if let Some(ch) = clients.get(&target_key) {
                let _ = ch.send(event_msg);
            }
        }
        return;
    }

    // General remote-panel command dispatch.
    handle_command(state, v).await;
}

/// Normalises shorthand target names to canonical client keys.
fn normalize_target(target: &str) -> String {
    match target {
        "operator" => "window:main".to_string(),
        "output"   => "window:output".to_string(),
        other      => other.to_string(),
    }
}

// ─── Command dispatch ─────────────────────────────────────────────────────────

async fn handle_command(state: &Arc<AppState>, v: Value) {
    let cmd = match v.get("cmd").and_then(|c| c.as_str()) {
        Some(c) => c,
        None => return,
    };

    match cmd {
        "get_state" => {
            let live = state.live_item.lock().clone();
            let lt = state.lower_third.lock().clone();
            let msg = json!({ "type": "state", "live_item": live, "lt": lt });
            broadcast_str(state, msg.to_string());
        }

        "get_versions" => {
            let versions = state.store.get_available_versions();
            let msg = json!({ "type": "versions", "versions": versions });
            broadcast_str(state, msg.to_string());
        }

        "get_books" => {
            let version = str_field(&v, "version");
            match state.store.get_books(&version) {
                Ok(books) => {
                    let msg = json!({ "type": "books", "version": version, "books": books });
                    broadcast_str(state, msg.to_string());
                }
                Err(e) => send_error(state, &e.to_string()),
            }
        }

        "get_chapters" => {
            let book = str_field(&v, "book");
            let version = str_field(&v, "version");
            match state.store.get_chapters(&book, &version) {
                Ok(chapters) => {
                    let msg = json!({ "type": "chapters", "book": book, "version": version, "chapters": chapters });
                    broadcast_str(state, msg.to_string());
                }
                Err(e) => send_error(state, &e.to_string()),
            }
        }

        "get_verses" => {
            let book = str_field(&v, "book");
            let chapter = v.get("chapter").and_then(|c| c.as_i64()).unwrap_or(1) as i32;
            let version = str_field(&v, "version");
            match state.store.get_verses_count(&book, chapter, &version) {
                Ok(verses) => {
                    let msg = json!({ "type": "verses", "book": book, "chapter": chapter, "version": version, "verses": verses });
                    broadcast_str(state, msg.to_string());
                }
                Err(e) => send_error(state, &e.to_string()),
            }
        }

        "get_verse" => {
            let book = str_field(&v, "book");
            let chapter = v.get("chapter").and_then(|c| c.as_i64()).unwrap_or(1) as i32;
            let verse = v.get("verse").and_then(|x| x.as_i64()).unwrap_or(1) as i32;
            let version = str_field(&v, "version");
            match state.store.get_verse(&book, chapter, verse, &version) {
                Ok(Some(vdata)) => {
                    let msg = json!({ "type": "verse_text", "verse": vdata });
                    broadcast_str(state, msg.to_string());
                }
                Ok(None) => send_error(state, "Verse not found"),
                Err(e) => send_error(state, &e.to_string()),
            }
        }

        "search" => {
            let query = str_field(&v, "query");
            match state.store.search_manual_all_versions(&query) {
                Ok(results) => {
                    let msg = json!({ "type": "search_results", "results": results });
                    broadcast_str(state, msg.to_string());
                }
                Err(e) => send_error(state, &e.to_string()),
            }
        }

        "go_live" => {
            if let Some(item_val) = v.get("item") {
                match serde_json::from_value::<store::DisplayItem>(item_val.clone()) {
                    Ok(item) => {
                        *state.live_item.lock() = Some(item.clone());

                        if let Some(handle) = state.app_handle.get() {
                            use tauri::Emitter;
                            let text = display_item_text(&item);
                            let _ = handle.emit(
                                "transcription-update",
                                serde_json::json!({
                                    "text": text,
                                    "detected_item": item.clone(),
                                    "source": "manual"
                                }),
                            );
                        }

                        let lt = state.lower_third.lock().clone();
                        let msg = json!({ "type": "state", "live_item": item, "lt": lt });
                        broadcast_str(state, msg.to_string());
                    }
                    Err(e) => send_error(state, &format!("Invalid item: {}", e)),
                }
            }
        }

        "get_songs" => {
            match state.media_schedule.list_songs() {
                Ok(songs) => {
                    let msg = json!({ "type": "songs", "songs": songs });
                    broadcast_str(state, msg.to_string());
                }
                Err(e) => send_error(state, &e.to_string()),
            }
        }

        "show_lt" => {
            let data_val = v.get("data").cloned().unwrap_or(Value::Null);
            let template = v.get("template").cloned().unwrap_or(Value::Object(Default::default()));

            match serde_json::from_value::<store::LowerThirdData>(data_val) {
                Ok(lt_data) => {
                    let payload = json!({ "data": lt_data, "template": template });
                    *state.lower_third.lock() = Some(payload.clone());

                    if let Some(handle) = state.app_handle.get() {
                        use tauri::Emitter;
                        let _ = handle.emit("lower-third-update", Some(payload.clone()));
                    }

                    let msg = json!({ "type": "lt_update", "payload": payload });
                    broadcast_str(state, msg.to_string());
                }
                Err(e) => send_error(state, &format!("Invalid lower third data: {}", e)),
            }
        }

        "hide_lt" => {
            *state.lower_third.lock() = None;

            if let Some(handle) = state.app_handle.get() {
                use tauri::Emitter;
                let _ = handle.emit("lower-third-update", Option::<Value>::None);
            }

            let msg = json!({ "type": "lt_update", "payload": null });
            broadcast_str(state, msg.to_string());
        }

        _ => {
            // Silently ignore unknown commands (e.g. unsupported client-side commands)
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

fn broadcast_str(state: &Arc<AppState>, msg: String) {
    let _ = state.broadcast_tx.send(msg);
}

fn send_error(state: &Arc<AppState>, message: &str) {
    let msg = json!({ "type": "error", "message": message }).to_string();
    let _ = state.broadcast_tx.send(msg);
}

fn display_item_text(item: &store::DisplayItem) -> String {
    item.to_label()
}
