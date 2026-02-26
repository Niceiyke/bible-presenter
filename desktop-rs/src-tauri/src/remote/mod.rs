/// LAN remote-control server.
///
/// Starts an axum HTTP + WebSocket server on `0.0.0.0:port`.
/// `GET /`  → self-contained HTML remote-control panel
/// `WS  /ws` → bidirectional JSON protocol (see protocol docs in plan)
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

// The remote panel HTML is embedded at compile time.
const REMOTE_HTML: &str = include_str!("remote.html");

// ─── Start ────────────────────────────────────────────────────────────────────

pub async fn start(state: Arc<AppState>, port: u16) {
    let app = Router::new()
        .route("/", get(serve_html))
        .route("/ws", get(ws_handler))
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

// ─── HTTP handler ─────────────────────────────────────────────────────────────

async fn serve_html() -> impl IntoResponse {
    Html(REMOTE_HTML)
}

// ─── WebSocket upgrade ────────────────────────────────────────────────────────

async fn ws_handler(
    ws: WebSocketUpgrade,
    AxumState(state): AxumState<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    // ── Auth handshake ────────────────────────────────────────────────────────
    // First message must be {"cmd":"auth","pin":"XXXX"}.
    // We use socket.recv() / socket.send() directly before splitting.
    let pin = state.remote_pin.lock().clone();
    let auth_result = tokio::time::timeout(
        tokio::time::Duration::from_secs(30),
        async {
            while let Some(Ok(msg)) = socket.recv().await {
                if let Message::Text(text) = msg {
                    if let Ok(v) = serde_json::from_str::<Value>(&text) {
                        if v.get("cmd").and_then(|c| c.as_str()) == Some("auth") {
                            let provided = v.get("pin").and_then(|p| p.as_str()).unwrap_or("");
                            return provided == pin.as_str();
                        }
                        // Ignore non-auth messages silently
                    }
                }
            }
            false // Connection closed without auth
        },
    )
    .await;

    match auth_result {
        Ok(true) => {
            let _ = socket
                .send(Message::Text(
                    json!({"type": "auth_ok"}).to_string(),
                ))
                .await;
        }
        Ok(false) => {
            let _ = socket
                .send(Message::Text(
                    json!({"type": "auth_fail"}).to_string(),
                ))
                .await;
            return;
        }
        Err(_) => {
            // Auth timeout — close silently
            return;
        }
    }

    // ── Subscribe to broadcast AFTER auth so we don't build up lag ───────────
    let mut bcast_rx = state.broadcast_tx.subscribe();

    // ── Split into sender + receiver for concurrent I/O ───────────────────────
    let (mut sender, mut receiver) = socket.split();

    // Write loop: broadcast channel → WS client
    let write_task = tokio::spawn(async move {
        loop {
            match bcast_rx.recv().await {
                Ok(msg) => {
                    if sender.send(Message::Text(msg)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    // Missed some messages — not fatal, keep going
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });

    // Read loop: WS client → command dispatch
    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(text) = msg {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                handle_command(&state, v).await;
            }
        }
    }

    write_task.abort();
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
                        *state.staged_item.lock() = Some(item.clone());

                        // Emit to Tauri windows via app_handle
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

                        // Broadcast state update to all WS clients
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
            send_error(state, &format!("Unknown command: {}", cmd));
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
    match item {
        store::DisplayItem::Verse(v) => format!("{} {}:{}", v.book, v.chapter, v.verse),
        store::DisplayItem::Media(m) => m.name.clone(),
        store::DisplayItem::PresentationSlide(p) => {
            format!("{} – slide {}", p.presentation_name, p.slide_index + 1)
        }
        store::DisplayItem::CustomSlide(c) => {
            format!("{} – slide {}", c.presentation_name, c.slide_index + 1)
        }
        store::DisplayItem::CameraFeed(cam) => {
            if cam.label.is_empty() {
                cam.device_id.clone()
            } else {
                cam.label.clone()
            }
        }
    }
}
