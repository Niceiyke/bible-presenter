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
use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo,
        Path as AxumPath,
        State as AxumState,
    },
    http::{header, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

use axum::{
    extract::Query as AxumQuery,
    routing::post,
};
use serde::Deserialize;
use wordlyte_lib::store;
use crate::{AppState, RemoteProposal};

// ─── Embedded assets ──────────────────────────────────────────────────────────

// Legacy single-file HTML pages (camera + output)
const CAMERA_HTML: &str = include_str!("camera.html");
const OUTPUT_HTML: &str = include_str!("output.html");

// React remote-ui SPA (built from remote-ui/dist/)
#[derive(rust_embed::RustEmbed)]
#[folder = "../remote-ui/dist/"]
struct RemoteUiAssets;

// ─── Start ────────────────────────────────────────────────────────────────────

pub async fn start(state: Arc<AppState>, port: u16) {
    let router = Router::new()
        // ── Legacy pages ────────────────────────────────────────────────────
        .route("/camera", get(serve_camera_html))
        .route("/output", get(serve_output_html))
        // ── WebSocket ───────────────────────────────────────────────────────
        .route("/ws",    get(ws_handler))
        // ── Media thumbnail ────────────────────────────────────────────────
        .route("/media-thumb/{id}", get(serve_media_thumb))
        // ── REST API ────────────────────────────────────────────────────────
        .route("/health",           get(health_handler))
        .route("/api/state",        get(api_get_state))
        .route("/api/versions",     get(api_get_versions))
        .route("/api/books",        get(api_get_books))
        .route("/api/chapters",     get(api_get_chapters))
        .route("/api/verse-count",  get(api_get_verse_count))
        .route("/api/verse",        get(api_get_verse))
        .route("/api/songs",        get(api_get_songs))
        .route("/api/media",        get(api_get_media))
        .route("/api/schedule",     get(api_get_schedule))
        .route("/api/lt-templates", get(api_get_lt_templates))
        .route("/api/go-live",      post(api_go_live))
        .route("/api/stage",        post(api_stage))
        .route("/api/clear-live",   post(api_clear_live))
        .route("/api/blank",        post(api_blank))
        .route("/api/lt/show",      post(api_lt_show))
        .route("/api/lt/hide",      post(api_lt_hide))
        .route("/api/timer/start",  post(api_timer_start))
        .route("/api/timer/stop",   post(api_timer_stop))
        .route("/api/timer/reset",  post(api_timer_reset))
        // ── React SPA + static assets (must be last — catch-all) ───────────
        .fallback(get(serve_spa))
        .layer(CorsLayer::permissive())
        .with_state(state.clone());

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));

    // ── Try HTTPS/WSS first; fall back to plain HTTP/WS ────────────────────
    let (cert_pem, key_pem) = state.app_cert.pem_bytes();
    match axum_server::tls_rustls::RustlsConfig::from_pem(cert_pem, key_pem).await {
        Ok(tls_config) => {
            state.log(&format!("[remote] Listening on https://{}", addr));
            if let Err(e) = axum_server::bind_rustls(addr, tls_config)
                .serve(router.into_make_service_with_connect_info::<SocketAddr>())
                .await
            {
                state.log(&format!("[remote] TLS server error: {}", e));
            }
        }
        Err(e) => {
            state.log(&format!("[remote] TLS config failed ({}), falling back to HTTP", e));
            match tokio::net::TcpListener::bind(addr).await {
                Ok(listener) => {
                    state.log(&format!("[remote] Listening on http://{}", addr));
                    if let Err(e) = axum::serve(
                        listener,
                        router.into_make_service_with_connect_info::<SocketAddr>(),
                    ).await {
                        state.log(&format!("[remote] Server error: {}", e));
                    }
                }
                Err(e) => {
                    state.log(&format!("[remote] Failed to bind port {}: {}", port, e));
                }
            }
        }
    }
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

fn check_token(state: &Arc<AppState>, req_headers: &axum::http::HeaderMap) -> bool {
    let token = req_headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    state.session_tokens.lock().contains(token)
}

// ─── HTTP handlers ─────────────────────────────────────────────────────────────

async fn health_handler() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

async fn serve_camera_html() -> impl IntoResponse {
    Html(CAMERA_HTML)
}

async fn serve_output_html() -> impl IntoResponse {
    Html(OUTPUT_HTML)
}

/// Serve the React SPA and its static assets from the embedded dist/.
async fn serve_spa(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    // Try exact asset match first
    let asset_path = if path.is_empty() { "index.html" } else { path };
    if let Some(content) = RemoteUiAssets::get(asset_path) {
        let mime = mime_guess::from_path(asset_path).first_or_octet_stream();
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, mime.as_ref())],
            content.data.into_owned(),
        ).into_response();
    }
    // Fallback to index.html for client-side routing
    if let Some(index) = RemoteUiAssets::get("index.html") {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/html")],
            index.data.into_owned(),
        ).into_response();
    }
    (StatusCode::NOT_FOUND, "Not found").into_response()
}

async fn serve_media_thumb(
    AxumPath(id): AxumPath<String>,
    AxumState(state): AxumState<Arc<AppState>>,
) -> Response {
    // Sanitise: id must not contain path separators
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return (StatusCode::BAD_REQUEST, "Invalid id").into_response();
    }
    let media_dir = state.media_schedule.get_media_dir();
    // Check thumbs sub-dir first, then fall back to the media file itself
    let thumb_path = media_dir.join("thumbs").join(format!("{}.jpg", id));
    let path = if thumb_path.exists() {
        thumb_path
    } else {
        // Look up by sidecar: find file with matching .mediaid
        let sidecar = media_dir.join(format!("{}.mediaid", id));
        if sidecar.exists() {
            // Read sidecar to get canonical filename
            if let Ok(filename) = std::fs::read_to_string(&sidecar) {
                media_dir.join(filename.trim())
            } else {
                return (StatusCode::NOT_FOUND, "Not found").into_response();
            }
        } else {
            return (StatusCode::NOT_FOUND, "Not found").into_response();
        }
    };

    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mime = match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
                "jpg" | "jpeg" => "image/jpeg",
                "png"  => "image/png",
                "gif"  => "image/gif",
                "webp" => "image/webp",
                _      => "application/octet-stream",
            };
            (StatusCode::OK, [(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "max-age=3600")], bytes).into_response()
        }
        Err(_) => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

// ─── REST API handlers ────────────────────────────────────────────────────────

/// Shared extractor: pulls token from Authorization header and validates it.
macro_rules! auth_guard {
    ($state:expr, $headers:expr) => {
        if !check_token(&$state, &$headers) {
            return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Unauthorized" }))).into_response();
        }
    };
}

#[derive(Deserialize)]
struct BooksQuery { version: String }

#[derive(Deserialize)]
struct ChaptersQuery { version: String, book: String }

#[derive(Deserialize)]
struct VerseCountQuery { version: String, book: String, chapter: i32 }

#[derive(Deserialize)]
struct VerseQuery { version: String, book: String, chapter: i32, verse: i32 }

async fn api_get_state(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    auth_guard!(state, headers);
    let live = state.live_item.lock().clone();
    let staged = state.staged_item.lock().clone();
    let lt = state.lower_third.lock().clone();
    let is_blanked = state.settings.lock().is_blanked;
    Json(json!({ "live_item": live, "staged_item": staged, "lt": lt, "is_blanked": is_blanked })).into_response()
}

async fn api_get_versions(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    auth_guard!(state, headers);
    let versions = state.store.get_available_versions();
    Json(json!({ "versions": versions })).into_response()
}

async fn api_get_books(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    AxumQuery(q): AxumQuery<BooksQuery>,
) -> Response {
    auth_guard!(state, headers);
    match state.store.get_books(&q.version) {
        Ok(books) => Json(json!({ "books": books, "version": q.version })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn api_get_chapters(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    AxumQuery(q): AxumQuery<ChaptersQuery>,
) -> Response {
    auth_guard!(state, headers);
    match state.store.get_chapters(&q.book, &q.version) {
        Ok(chapters) => Json(json!({ "chapters": chapters, "book": q.book, "version": q.version })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn api_get_verse_count(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    AxumQuery(q): AxumQuery<VerseCountQuery>,
) -> Response {
    auth_guard!(state, headers);
    match state.store.get_verses_count(&q.book, q.chapter, &q.version) {
        Ok(verses) => Json(json!({ "verses": verses, "book": q.book, "chapter": q.chapter })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn api_get_verse(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    AxumQuery(q): AxumQuery<VerseQuery>,
) -> Response {
    auth_guard!(state, headers);
    match state.store.get_verse(&q.book, q.chapter, q.verse, &q.version) {
        Ok(Some(v)) => Json(json!({ "verse": v })).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Verse not found" }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn api_get_songs(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    auth_guard!(state, headers);
    match state.media_schedule.list_songs() {
        Ok(songs) => Json(json!({ "songs": songs })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn api_get_media(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    auth_guard!(state, headers);
    match state.media_schedule.list_media() {
        Ok(items) => Json(json!({ "media_items": items })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn api_get_schedule(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    auth_guard!(state, headers);
    match state.media_schedule.load_schedule() {
        Ok(schedule) => Json(json!({ "schedule": schedule })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn api_get_lt_templates(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    auth_guard!(state, headers);
    match state.media_schedule.load_lt_templates() {
        Ok(templates) => Json(json!({ "templates": templates })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

// ── POST handlers ─────────────────────────────────────────────────────────────

async fn api_go_live(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    auth_guard!(state, headers);
    let item_val = match body.get("item") {
        Some(v) => v.clone(),
        None => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Missing 'item'" }))).into_response(),
    };
    match serde_json::from_value::<wordlyte_lib::store::DisplayItem>(item_val) {
        Ok(item) => {
            *state.live_item.lock() = Some(item.clone());
            if let Some(handle) = state.app_handle.get() {
                use tauri::Emitter;
                let update = json!({
                    "text": display_item_text(&item),
                    "detected_item": item.clone(),
                    "confidence": 1.0,
                    "source": "manual",
                    "is_partial": false,
                });
                let _ = handle.emit("operator-transcription-update", &update);
                let _ = handle.emit("preacher-transcription-update", &update);
            }
            let lt = state.lower_third.lock().clone();
            broadcast_str(&state, json!({ "type": "state", "live_item": item, "lt": lt, "changed_by": "Desktop" }).to_string());
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn api_stage(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    auth_guard!(state, headers);
    let item_val = match body.get("item") {
        Some(v) => v.clone(),
        None => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Missing 'item'" }))).into_response(),
    };
    match serde_json::from_value::<wordlyte_lib::store::DisplayItem>(item_val) {
        Ok(item) => {
            *state.staged_item.lock() = Some(item.clone());
            if let Some(handle) = state.app_handle.get() {
                use tauri::Emitter;
                let _ = handle.emit("item-staged", &item);
                let _ = handle.emit("stage-update", Some(&item));
            }
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn api_clear_live(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    auth_guard!(state, headers);
    *state.live_item.lock() = None;
    state.operator_audio.lock().media_playing.store(false, std::sync::atomic::Ordering::Relaxed);
    state.preacher_audio.lock().media_playing.store(false, std::sync::atomic::Ordering::Relaxed);
    if let Some(handle) = state.app_handle.get() {
        use tauri::Emitter;
        let clear = json!({ "text": "", "detected_item": null, "confidence": 1.0, "source": "manual", "is_partial": false });
        let _ = handle.emit("operator-transcription-update", &clear);
        let _ = handle.emit("preacher-transcription-update", &clear);
        let _ = handle.emit("stage-update", Option::<wordlyte_lib::store::DisplayItem>::None);
    }
    let lt = state.lower_third.lock().clone();
    broadcast_str(&state, json!({ "type": "state", "live_item": null, "lt": lt }).to_string());
    Json(json!({ "ok": true })).into_response()
}

async fn api_blank(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    auth_guard!(state, headers);
    // Accept explicit `blanked: bool` or toggle if omitted
    let new_blanked = body.get("blanked")
        .and_then(|b| b.as_bool())
        .unwrap_or_else(|| !state.settings.lock().is_blanked);
    let mut new_settings = state.settings.lock().clone();
    new_settings.is_blanked = new_blanked;
    match state.media_schedule.save_settings(&new_settings) {
        Ok(_) => {
            *state.settings.lock() = new_settings.clone();
            if let Some(handle) = state.app_handle.get() {
                use tauri::Emitter;
                let _ = handle.emit("settings-changed", new_settings.clone());
            }
            broadcast_str(&state, json!({ "type": "settings_update", "is_blanked": new_blanked }).to_string());
            Json(json!({ "ok": true, "is_blanked": new_blanked })).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn api_lt_show(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    auth_guard!(state, headers);
    let data_val = body.get("data").cloned().unwrap_or(Value::Null);
    let template = body.get("template").cloned().unwrap_or(Value::Object(Default::default()));
    match serde_json::from_value::<wordlyte_lib::store::LowerThirdData>(data_val) {
        Ok(lt_data) => {
            let payload = json!({ "data": lt_data, "template": template });
            *state.lower_third.lock() = Some(payload.clone());
            if let Some(handle) = state.app_handle.get() {
                use tauri::Emitter;
                let _ = handle.emit("lower-third-update", Some(payload.clone()));
            }
            broadcast_str(&state, json!({ "type": "lt_update", "payload": payload }).to_string());
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}

async fn api_lt_hide(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    auth_guard!(state, headers);
    *state.lower_third.lock() = None;
    if let Some(handle) = state.app_handle.get() {
        use tauri::Emitter;
        let _ = handle.emit("lower-third-update", Option::<Value>::None);
    }
    broadcast_str(&state, json!({ "type": "lt_update", "payload": null }).to_string());
    Json(json!({ "ok": true })).into_response()
}

async fn api_timer_start(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    auth_guard!(state, headers);
    let mut live = state.live_item.lock();
    if let Some(wordlyte_lib::store::DisplayItem::Timer(ref mut t)) = *live {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        t.started_at = Some(now_ms);
        let item = live.clone().unwrap();
        drop(live);
        if let Some(handle) = state.app_handle.get() {
            use tauri::Emitter;
            let update = json!({ "text": display_item_text(&item), "detected_item": item.clone(), "confidence": 1.0, "source": "manual", "is_partial": false });
            let _ = handle.emit("operator-transcription-update", &update);
            let _ = handle.emit("preacher-transcription-update", &update);
        }
        let lt = state.lower_third.lock().clone();
        broadcast_str(&state, json!({ "type": "state", "live_item": item, "lt": lt }).to_string());
        Json(json!({ "ok": true })).into_response()
    } else {
        (StatusCode::BAD_REQUEST, Json(json!({ "error": "No live timer" }))).into_response()
    }
}

async fn api_timer_stop(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    auth_guard!(state, headers);
    let mut live = state.live_item.lock();
    if let Some(wordlyte_lib::store::DisplayItem::Timer(ref mut t)) = *live {
        t.started_at = None;
        let item = live.clone().unwrap();
        drop(live);
        if let Some(handle) = state.app_handle.get() {
            use tauri::Emitter;
            let update = json!({ "text": display_item_text(&item), "detected_item": item.clone(), "confidence": 1.0, "source": "manual", "is_partial": false });
            let _ = handle.emit("operator-transcription-update", &update);
            let _ = handle.emit("preacher-transcription-update", &update);
        }
        let lt = state.lower_third.lock().clone();
        broadcast_str(&state, json!({ "type": "state", "live_item": item, "lt": lt }).to_string());
        Json(json!({ "ok": true })).into_response()
    } else {
        (StatusCode::BAD_REQUEST, Json(json!({ "error": "No live timer" }))).into_response()
    }
}

async fn api_timer_reset(
    AxumState(state): AxumState<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    auth_guard!(state, headers);
    let mut live = state.live_item.lock();
    if let Some(wordlyte_lib::store::DisplayItem::Timer(ref mut t)) = *live {
        t.started_at = None;
        let item = live.clone().unwrap();
        drop(live);
        if let Some(handle) = state.app_handle.get() {
            use tauri::Emitter;
            let update = json!({ "text": display_item_text(&item), "detected_item": item.clone(), "confidence": 1.0, "source": "manual", "is_partial": false });
            let _ = handle.emit("operator-transcription-update", &update);
            let _ = handle.emit("preacher-transcription-update", &update);
        }
        let lt = state.lower_third.lock().clone();
        broadcast_str(&state, json!({ "type": "state", "live_item": item, "lt": lt }).to_string());
        Json(json!({ "ok": true })).into_response()
    } else {
        (StatusCode::BAD_REQUEST, Json(json!({ "error": "No live timer" }))).into_response()
    }
}

// ─── WebSocket upgrade ────────────────────────────────────────────────────────

async fn ws_handler(
    ws: WebSocketUpgrade,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    AxumState(state): AxumState<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state, peer_addr))
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
    /// Display name provided by the client on connect (non-mobile only)
    name: String,
    /// Role: "operator" | "presenter" | "viewer"
    role: String,
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>, peer_addr: SocketAddr) {
    // ── 1. Auth handshake (extended to capture client identity) ───────────────
    let pin = state.remote_pin.lock().clone();
    let is_local = peer_addr.ip().is_loopback();
    let ip = peer_addr.ip();

    // ── Pre-auth Rate Limiting ────────────────────────────────────────────────
    let is_throttled = {
        let throttles = state.auth_throttles.lock();
        if let Some((count, last_fail)) = throttles.get(&ip) {
            // Strict lockout: 10 failed attempts = 24 hour block.
            // Minor throttling: 5 failed attempts = 15 minute block.
            (*count >= 10 && last_fail.elapsed() < std::time::Duration::from_secs(86400)) ||
            (*count >= 5  && last_fail.elapsed() < std::time::Duration::from_secs(900))
        } else {
            false
        }
    };

    if is_throttled {
        let _ = socket.send(Message::Text(json!({
            "type": "error",
            "message": "Too many failed attempts. Security lockout active."
        }).to_string())).await;
        return;
    }

    let auth_result: Result<Option<Option<ClientInfo>>, _> = tokio::time::timeout(
        tokio::time::Duration::from_secs(30),
        async {
            while let Some(Ok(msg)) = socket.recv().await {
                if let Message::Text(text) = msg {
                    if let Ok(v) = serde_json::from_str::<Value>(&text) {
                        if v.get("cmd").and_then(|c| c.as_str()) == Some("auth") {
                            let client_type = v.get("client_type")
                                .and_then(|t| t.as_str())
                                .unwrap_or("remote");
                            let is_mobile = client_type == "mobile";

                            // ── Device token fast-path (mobile cameras only) ───────
                            // Mobile clients that previously authenticated may send a
                            // `device_token` instead of the PIN. This avoids re-pairing
                            // on every reconnect without weakening security.
                            if is_mobile {
                                if let Some(token) = v.get("device_token").and_then(|t| t.as_str()) {
                                    match state.device_tokens.verify(token) {
                                        Ok(verified_device_id) => {
                                            // Token is valid — skip PIN check.
                                            let device_name = v.get("device_name")
                                                .and_then(|n| n.as_str())
                                                .unwrap_or(&verified_device_id)
                                                .to_string();
                                            let key = format!("mobile:{}", verified_device_id);
                                            return Some(Some(ClientInfo {
                                                key,
                                                device_id: verified_device_id,
                                                device_name,
                                                is_mobile: true,
                                                name: String::new(),
                                                role: "viewer".into(),
                                            }));
                                        }
                                        Err(_) => {
                                            // Invalid/expired token — fall through to PIN check.
                                        }
                                    }
                                }
                            }

                            // ── PIN auth path ─────────────────────────────────────
                            let provided = v.get("pin").and_then(|p| p.as_str()).unwrap_or("");
                            if provided != pin.as_str() {
                                // Tarpit: wait 2s before signaling failure to slow down automated brute force
                                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                                return Some(None); // wrong PIN — signal auth fail
                            }

                            let device_id = v.get("device_id")
                                .and_then(|d| d.as_str())
                                .unwrap_or("")
                                .to_string();
                            let device_name = v.get("device_name")
                                .and_then(|n| n.as_str())
                                .unwrap_or(&device_id)
                                .to_string();
                            let name = v.get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("Remote")
                                .to_string();
                            let role = v.get("role")
                                .and_then(|r| r.as_str())
                                .filter(|r| matches!(*r, "operator" | "presenter" | "viewer"))
                                .unwrap_or("operator")
                                .to_string();

                            // Only loopback connections may claim to be a Tauri window:main.
                            // This prevents a mobile client from hijacking the operator slot.
                            let key = match client_type {
                                "window:main" if is_local  => format!("window:main:{}", uuid::Uuid::new_v4()),
                                "window:output" => format!("window:output:{}", uuid::Uuid::new_v4()),
                                "window:main" => {
                                    return Some(None); // reject window:main claims from non-local IPs
                                }
                                "mobile" if !device_id.is_empty() => {
                                    format!("mobile:{}", device_id)
                                }
                                _ => format!("{}:{}", client_type, uuid::Uuid::new_v4()),
                            };

                            return Some(Some(ClientInfo { key, device_id, device_name, is_mobile, name, role }));
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
            // Success: clear throttle, issue session token
            state.auth_throttles.lock().remove(&ip);
            let token = uuid::Uuid::new_v4().to_string();
            state.session_tokens.lock().insert(token.clone());

            // For mobile cameras: issue a long-lived device token so subsequent
            // reconnects skip PIN entry entirely.
            let device_token = if info.is_mobile && !info.device_id.is_empty() {
                Some(state.device_tokens.issue(&info.device_id))
            } else {
                None
            };

            let mut auth_ok_payload = json!({
                "type": "auth_ok",
                "token": token,
                "key": info.key,
            });
            if let Some(dt) = device_token {
                auth_ok_payload["device_token"] = serde_json::Value::String(dt);
            }
            let _ = socket.send(Message::Text(auth_ok_payload.to_string())).await;
            info
        }
        Ok(Some(None)) => {
            // Failure: update throttle
            {
                let mut throttles = state.auth_throttles.lock();
                let entry = throttles.entry(ip).or_insert((0, std::time::Instant::now()));
                entry.0 += 1;
                entry.1 = std::time::Instant::now();
            }
            let _ = socket.send(Message::Text(json!({"type":"auth_fail"}).to_string())).await;
            return;
        }
        _ => {
            // Auth timeout or closed connection — close silently
            return;
        }
    };

    let client_key  = info.key.clone();
    let device_id   = info.device_id.clone();
    let device_name = info.device_name.clone();
    let is_mobile   = info.is_mobile;
    let client_name = info.name.clone();
    let role        = info.role.clone();

    // ── 2. Register direct signaling channel ──────────────────────────────────
    let (direct_tx, mut direct_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    state.signaling_clients.lock().insert(client_key.clone(), direct_tx.clone());

    // ── 2b. Register non-mobile in operator registry and announce presence ────
    if !is_mobile {
        state.remote_operators.lock().insert(client_key.clone(), crate::OperatorMeta {
            name: client_name.clone(),
            role: role.clone(),
        });
        broadcast_operators_list(&state);
    }

    // ── 3. Register mobile in camera session registry + broadcast connect ──────
    if is_mobile && !device_id.is_empty() {
        state.connected_cameras.lock().await.insert(device_id.clone(), device_name.clone());

        // Register in typed camera session registry
        let session = crate::camera::CameraSession::new(
            device_id.clone(),
            device_name.clone(),
            direct_tx,
        );
        state.camera_sessions.insert(session);
        state.camera_sessions.mark_connected(&device_id);

        // Restore authoritative tally state to reconnecting mobile
        let tally = state.camera_tally.get(&device_id);
        if tally != crate::camera::TallyState::Off {
            let event_name = match tally {
                crate::camera::TallyState::Program => "connect_program",
                crate::camera::TallyState::Preview => "connect_preview",
                crate::camera::TallyState::Off     => "disconnect_program",
            };
            state.camera_sessions.send_to(&device_id, &json!({"event": event_name}).to_string());
        }

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
                route_or_handle(&state, v, &text, &client_key, &role).await;
            }
        }
    }

    // ── 7. Cleanup ────────────────────────────────────────────────────────────
    write_task.abort();
    state.signaling_clients.lock().remove(&client_key);

    if is_mobile && !device_id.is_empty() {
        state.connected_cameras.lock().await.remove(&device_id);
        // Remove from typed camera session registry; clear tally
        state.camera_sessions.remove(&device_id);
        state.camera_tally.remove(&device_id);
        let msg = json!({
            "type": "camera_source_disconnected",
            "device_id": device_id,
        })
        .to_string();
        let _ = state.broadcast_tx.send(msg);
    }

    if !is_mobile {
        state.remote_operators.lock().remove(&client_key);
        broadcast_operators_list(&state);
    }

    // Remove any pending remote proposal from this client
    {
        let removed = state.remote_proposals.lock().remove(&client_key).is_some();
        if removed {
            broadcast_remote_proposals(&state);
        }
    }
}

// ─── Message routing ──────────────────────────────────────────────────────────

/// Routes a WebSocket message either to a specific client (signaling relay) or
/// to the general command handler (remote panel commands, state queries, etc.).
async fn route_or_handle(state: &Arc<AppState>, v: Value, raw: &str, from_key: &str, role: &str) {
    // If the message carries an explicit `target`, relay it.
    if let Some(target_raw) = v.get("target").and_then(|t| t.as_str()) {
        let target_key = normalize_target(target_raw);

        // Inject _from into the message.
        let relayed_raw = if let Some(mut obj) = v.as_object().cloned() {
            obj.insert("_from".to_string(), json!(from_key));
            Value::Object(obj).to_string()
        } else {
            raw.to_string()
        };

        // Broadcast to all clients matching the target prefix (e.g. "window:main" or "window:output")
        let clients = state.signaling_clients.lock();
        let mut sent = false;
        for (key, ch) in clients.iter() {
            if key == &target_key || key.starts_with(&format!("{}:", target_key)) {
                let _ = ch.send(relayed_raw.clone());
                sent = true;
            }
        }
        
        if !sent {
            // If no prefix match found, try exact match (for mobile:uuid etc)
            if let Some(ch) = clients.get(&target_key) {
                let _ = ch.send(relayed_raw);
            }
        }
        return;
    }

    let cmd = v.get("cmd").and_then(|c| c.as_str()).unwrap_or("");

    // Lifecycle commands: tally routing via authoritative TallyRegistry.
    if cmd == "camera_connect_program" || cmd == "camera_disconnect_program" {
        let dev_id = str_field(&v, "device_id");
        if !dev_id.is_empty() {
            let new_tally = if cmd == "camera_connect_program" {
                crate::camera::TallyState::Program
            } else {
                crate::camera::TallyState::Off
            };
            // Update authoritative tally state; clear old program device if switching
            if new_tally == crate::camera::TallyState::Program {
                if let Some(old_id) = state.camera_tally.clear_program() {
                    if old_id != dev_id {
                        state.camera_sessions.send_to(&old_id, &json!({"event":"disconnect_program"}).to_string());
                        let tally_msg = json!({"type":"tally_update","device_id":old_id,"tally":"off"}).to_string();
                        let _ = state.broadcast_tx.send(tally_msg);
                    }
                }
            }
            let changed = state.camera_tally.set(&dev_id, new_tally);
            state.camera_sessions.set_tally(&dev_id, new_tally);
            // Route tally event directly to the mobile device
            let event_name = if new_tally == crate::camera::TallyState::Program { "connect_program" } else { "disconnect_program" };
            state.camera_sessions.send_to(&dev_id, &json!({"event": event_name}).to_string());
            // Broadcast tally update to all operator/output windows
            if changed {
                let tally_str = if new_tally == crate::camera::TallyState::Program { "program" } else { "off" };
                let tally_msg = json!({"type":"tally_update","device_id":dev_id,"tally":tally_str}).to_string();
                let _ = state.broadcast_tx.send(tally_msg);
            }
        }
        return;
    }

    // Telemetry: update session quality stats and touch heartbeat.
    if cmd == "camera_telemetry" {
        let dev_id = str_field(&v, "device_id");
        if !dev_id.is_empty() {
            state.camera_sessions.touch(&dev_id);
            use std::time::{SystemTime, UNIX_EPOCH};
            let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
            state.camera_sessions.update_quality(&dev_id, |q| {
                q.battery_pct    = v.get("battery").and_then(|b| b.as_u64()).map(|b| b as u8);
                q.resolution_w   = v.get("resolution_w").and_then(|b| b.as_u64()).map(|b| b as u16);
                q.resolution_h   = v.get("resolution_h").and_then(|b| b.as_u64()).map(|b| b as u16);
                q.rtt_ms         = v.get("rtt_ms").and_then(|b| b.as_u64()).map(|b| b as u32);
                q.bitrate_kbps   = v.get("bitrate_kbps").and_then(|b| b.as_u64()).map(|b| b as u32);
                q.updated_at_ms  = now_ms;
            });
        }
        // Forward telemetry to operator windows too (for UI quality badges)
        let _ = state.broadcast_tx.send(v.to_string());
        return;
    }

    // General remote-panel command dispatch.
    handle_command(state, v, from_key, role).await;
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

async fn handle_command(state: &Arc<AppState>, v: Value, from_key: &str, role: &str) {
    let cmd = match v.get("cmd").and_then(|c| c.as_str()) {
        Some(c) => c,
        None => return,
    };

    match cmd {
        "get_state" => {
            let live = state.live_item.lock().clone();
            let staged = state.staged_item.lock().clone();
            let lt = state.lower_third.lock().clone();
            let is_blanked = state.settings.lock().is_blanked;
            let proposals: Vec<Value> = state.remote_proposals.lock().values()
                .map(|p| json!({ "operator_key": p.operator_key, "operator_name": p.operator_name, "item": p.item, "staged_at_ms": p.staged_at_ms }))
                .collect();
            let msg = json!({ "type": "state", "live_item": live, "staged_item": staged, "lt": lt, "is_blanked": is_blanked, "remote_proposals": proposals });
            send_to(state, from_key, msg.to_string());
        }

        "dismiss_remote_proposal" => {
            if role == "viewer" {
                send_error_to(state, from_key, "Viewers cannot dismiss proposals");
                return;
            }
            let key = str_field(&v, "operator_key");
            state.remote_proposals.lock().remove(&key);
            
            // Notify the specific client that their proposal was handled
            send_to(state, &key, json!({ "type": "proposal_handled" }).to_string());

            broadcast_remote_proposals(state);
        }

        "get_versions" => {
            let versions = state.store.get_available_versions();
            let msg = json!({ "type": "versions", "versions": versions });
            send_to(state, from_key, msg.to_string());
        }

        "get_books" => {
            let version = str_field(&v, "version");
            match state.store.get_books(&version) {
                Ok(books) => {
                    let msg = json!({ "type": "books", "version": version, "books": books });
                    send_to(state, from_key, msg.to_string());
                }
                Err(e) => send_error_to(state, from_key, &e.to_string()),
            }
        }

        "get_chapters" => {
            let book = str_field(&v, "book");
            let version = str_field(&v, "version");
            match state.store.get_chapters(&book, &version) {
                Ok(chapters) => {
                    let msg = json!({ "type": "chapters", "book": book, "version": version, "chapters": chapters });
                    send_to(state, from_key, msg.to_string());
                }
                Err(e) => send_error_to(state, from_key, &e.to_string()),
            }
        }

        "get_verses" => {
            let book = str_field(&v, "book");
            let chapter = v.get("chapter").and_then(|c| c.as_i64()).unwrap_or(1) as i32;
            let version = str_field(&v, "version");
            match state.store.get_verses_count(&book, chapter, &version) {
                Ok(verses) => {
                    let msg = json!({ "type": "verses", "book": book, "chapter": chapter, "version": version, "verses": verses });
                    send_to(state, from_key, msg.to_string());
                }
                Err(e) => send_error_to(state, from_key, &e.to_string()),
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
                    send_to(state, from_key, msg.to_string());
                }
                Ok(None) => send_error_to(state, from_key, "Verse not found"),
                Err(e) => send_error_to(state, from_key, &e.to_string()),
            }
        }

        "search" => {
            let query = str_field(&v, "query");
            match state.store.search_manual_all_versions(&query) {
                Ok(results) => {
                    let msg = json!({ "type": "search_results", "results": results, "method": "keyword" });
                    send_to(state, from_key, msg.to_string());
                }
                Err(e) => send_error_to(state, from_key, &e.to_string()),
            }
        }

        "go_live" => {
            // Remote operators cannot send items live directly.
            // Promote to a remote proposal so the main operator can approve it.
            if role == "viewer" {
                send_error_to(state, from_key, "Viewers cannot stage items");
                return;
            }
            if let Some(item_val) = v.get("item") {
                match serde_json::from_value::<store::DisplayItem>(item_val.clone()) {
                    Ok(item) => {
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        let proposal = RemoteProposal {
                            operator_key: from_key.to_string(),
                            operator_name: operator_name(state, from_key),
                            item: item.clone(),
                            staged_at_ms: now_ms,
                        };
                        state.remote_proposals.lock().insert(from_key.to_string(), proposal);
                        broadcast_remote_proposals(state);
                        // Acknowledge to the remote client that their item is staged
                        send_to(state, from_key, json!({ "type": "staged", "staged_item": item }).to_string());
                    }
                    Err(e) => send_error_to(state, from_key, &format!("Invalid item: {}", e)),
                }
            }
        }

        "stage_item" => {
            if role == "viewer" {
                send_error_to(state, from_key, "Viewers cannot stage items");
                return;
            }
            if let Some(item_val) = v.get("item") {
                match serde_json::from_value::<store::DisplayItem>(item_val.clone()) {
                    Ok(item) => {
                        if from_key.starts_with("window:main") {
                            // Desktop's own staging slot
                            *state.staged_item.lock() = Some(item.clone());
                            if let Some(handle) = state.app_handle.get() {
                                use tauri::Emitter;
                                let _ = handle.emit("item-staged", &item);
                                let _ = handle.emit("stage-update", Some(&item));
                            }
                            let by = operator_name(state, from_key);
                            let msg = json!({ "type": "staged", "staged_item": item, "changed_by": by });
                            broadcast_str(state, msg.to_string());
                        } else {
                            // Remote operator proposal — goes into per-operator queue
                            let now_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64;
                            let proposal = RemoteProposal {
                                operator_key: from_key.to_string(),
                                operator_name: operator_name(state, from_key),
                                item: item.clone(),
                                staged_at_ms: now_ms,
                            };
                            state.remote_proposals.lock().insert(from_key.to_string(), proposal);
                            broadcast_remote_proposals(state);
                            // Acknowledge to the remote client
                            send_to(state, from_key, json!({ "type": "staged", "staged_item": item }).to_string());
                        }
                    }
                    Err(e) => send_error_to(state, from_key, &format!("Invalid item: {}", e)),
                }
            }
        }

        "get_songs" => {
            match state.media_schedule.list_songs() {
                Ok(songs) => {
                    let msg = json!({ "type": "songs", "songs": songs });
                    send_to(state, from_key, msg.to_string());
                }
                Err(e) => send_error_to(state, from_key, &e.to_string()),
            }
        }

        "get_media" => {
            match state.media_schedule.list_media() {
                Ok(media_items) => {
                    let msg = json!({ "type": "media_list", "media_items": media_items });
                    send_to(state, from_key, msg.to_string());
                }
                Err(e) => send_error_to(state, from_key, &e.to_string()),
            }
        }

        "get_settings_full" => {
            let settings = state.settings.lock().clone();
            let msg = json!({ "type": "settings_full", "settings": settings });
            send_to(state, from_key, msg.to_string());
        }

        "show_lt" => {
            if role == "viewer" {
                send_error_to(state, from_key, "Viewers cannot control the output");
                return;
            }
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
                Err(e) => send_error_to(state, from_key, &format!("Invalid lower third data: {}", e)),
            }
        }

        "hide_lt" => {
            if role == "viewer" {
                send_error_to(state, from_key, "Viewers cannot control the output");
                return;
            }
            *state.lower_third.lock() = None;

            if let Some(handle) = state.app_handle.get() {
                use tauri::Emitter;
                let _ = handle.emit("lower-third-update", Option::<Value>::None);
            }

            let msg = json!({ "type": "lt_update", "payload": null });
            broadcast_str(state, msg.to_string());
        }

        "clear_live" => {
            if role == "viewer" {
                send_error_to(state, from_key, "Viewers cannot control the output");
                return;
            }
            *state.live_item.lock() = None;
            state.operator_audio.lock().media_playing.store(false, std::sync::atomic::Ordering::Relaxed);
            state.preacher_audio.lock().media_playing.store(false, std::sync::atomic::Ordering::Relaxed);
            if let Some(handle) = state.app_handle.get() {
                use tauri::Emitter;
                let clear_update = json!({
                    "text": "",
                    "detected_item": null,
                    "confidence": 1.0,
                    "source": "manual",
                    "is_partial": false,
                });
                let _ = handle.emit("operator-transcription-update", &clear_update);
                let _ = handle.emit("preacher-transcription-update", &clear_update);
                let _ = handle.emit("stage-update", Option::<store::DisplayItem>::None);
            }
            let lt = state.lower_third.lock().clone();
            let by = operator_name(state, from_key);
            let msg = json!({ "type": "state", "live_item": null, "staged_item": null, "lt": lt, "changed_by": by });
            broadcast_str(state, msg.to_string());
        }

        "blank_output" => {
            if role == "viewer" {
                send_error_to(state, from_key, "Viewers cannot control the output");
                return;
            }
            let current_settings = state.settings.lock().clone();
            let mut new_settings = current_settings.clone();
            new_settings.is_blanked = !current_settings.is_blanked;

            match state.media_schedule.save_settings(&new_settings) {
                Ok(_) => {
                    *state.settings.lock() = new_settings.clone();
                    if let Some(handle) = state.app_handle.get() {
                        use tauri::Emitter;
                        let _ = handle.emit("settings-changed", new_settings.clone());
                    }
                    let by = operator_name(state, from_key);
                    let msg = json!({ "type": "settings_update", "is_blanked": new_settings.is_blanked, "changed_by": by });
                    broadcast_str(state, msg.to_string());
                }
                Err(e) => send_error_to(state, from_key, &format!("Failed to save settings: {}", e)),
            }
        }

        "start_live_timer" => {
            if role == "viewer" {
                send_error_to(state, from_key, "Viewers cannot control the output");
                return;
            }
            let mut live = state.live_item.lock();
            if let Some(store::DisplayItem::Timer(ref mut t)) = *live {
                let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                t.started_at = Some(now_ms);
                let item = live.clone().unwrap();
                drop(live);
                
                if let Some(handle) = state.app_handle.get() {
                    use tauri::Emitter;
                    let update = json!({
                        "text": display_item_text(&item),
                        "detected_item": item.clone(),
                        "confidence": 1.0,
                        "source": "manual",
                        "is_partial": false,
                    });
                    let _ = handle.emit("operator-transcription-update", &update);
                    let _ = handle.emit("preacher-transcription-update", &update);
                }
                let lt = state.lower_third.lock().clone();
                let msg = json!({ "type": "state", "live_item": item, "lt": lt });
                broadcast_str(state, msg.to_string());
            }
        }

        "stop_live_timer" => {
            if role == "viewer" {
                send_error_to(state, from_key, "Viewers cannot control the output");
                return;
            }
            let mut live = state.live_item.lock();
            if let Some(store::DisplayItem::Timer(ref mut t)) = *live {
                t.started_at = None;
                let item = live.clone().unwrap();
                drop(live);

                if let Some(handle) = state.app_handle.get() {
                    use tauri::Emitter;
                    let update = json!({
                        "text": display_item_text(&item),
                        "detected_item": item.clone(),
                        "confidence": 1.0,
                        "source": "manual",
                        "is_partial": false,
                    });
                    let _ = handle.emit("operator-transcription-update", &update);
                    let _ = handle.emit("preacher-transcription-update", &update);
                }
                let lt = state.lower_third.lock().clone();
                let msg = json!({ "type": "state", "live_item": item, "lt": lt });
                broadcast_str(state, msg.to_string());
            }
        }

        "reset_live_timer" => {
            if role == "viewer" {
                send_error_to(state, from_key, "Viewers cannot control the output");
                return;
            }
            let mut live = state.live_item.lock();
            if let Some(store::DisplayItem::Timer(ref mut t)) = *live {
                t.started_at = None;
                let item = live.clone().unwrap();
                drop(live);

                if let Some(handle) = state.app_handle.get() {
                    use tauri::Emitter;
                    let update = json!({
                        "text": display_item_text(&item),
                        "detected_item": item.clone(),
                        "confidence": 1.0,
                        "source": "manual",
                        "is_partial": false,
                    });
                    let _ = handle.emit("operator-transcription-update", &update);
                    let _ = handle.emit("preacher-transcription-update", &update);
                }
                let lt = state.lower_third.lock().clone();
                let msg = json!({ "type": "state", "live_item": item, "lt": lt });
                broadcast_str(state, msg.to_string());
            }
        }

        "get_schedule" => {
            match state.media_schedule.load_schedule() {
                Ok(schedule) => {
                    let msg = json!({ "type": "schedule", "schedule": schedule });
                    send_to(state, from_key, msg.to_string());
                }
                Err(e) => send_error_to(state, from_key, &e.to_string()),
            }
        }

        "get_next_verse" => {
            let book = str_field(&v, "book");
            let chapter = v.get("chapter").and_then(|c| c.as_i64()).unwrap_or(1) as i32;
            let verse = v.get("verse").and_then(|x| x.as_i64()).unwrap_or(1) as i32;
            let version = str_field(&v, "version");
            match state.store.get_next_verse(&book, chapter, verse, &version) {
                Ok(Some(vdata)) => {
                    let msg = json!({ "type": "verse_text", "verse": vdata, "nav": "next" });
                    send_to(state, from_key, msg.to_string());
                }
                Ok(None) => send_error_to(state, from_key, "No next verse"),
                Err(e) => send_error_to(state, from_key, &e.to_string()),
            }
        }

        "get_prev_verse" => {
            let book = str_field(&v, "book");
            let chapter = v.get("chapter").and_then(|c| c.as_i64()).unwrap_or(1) as i32;
            let verse = v.get("verse").and_then(|x| x.as_i64()).unwrap_or(1) as i32;
            let version = str_field(&v, "version");
            match state.store.get_prev_verse(&book, chapter, verse, &version) {
                Ok(Some(vdata)) => {
                    let msg = json!({ "type": "verse_text", "verse": vdata, "nav": "prev" });
                    send_to(state, from_key, msg.to_string());
                }
                Ok(None) => send_error_to(state, from_key, "No previous verse"),
                Err(e) => send_error_to(state, from_key, &e.to_string()),
            }
        }

        "search_hybrid" => {
            // Spawn to avoid blocking the WS read loop during ONNX inference.
            let state2 = Arc::clone(state);
            let from = from_key.to_string();
            let query = str_field(&v, "query");
            tokio::spawn(async move {
                if let Some(handle) = state2.app_handle.get() {
                    match state2.search_bible(handle, &query).await {
                        Ok(resp) => {
                            let msg = json!({ "type": "search_results", "results": resp.results, "method": resp.method });
                            send_to(&state2, &from, msg.to_string());
                        }
                        Err(e) => send_error_to(&state2, &from, &e.to_string()),
                    }
                } else {
                    send_error_to(&state2, &from, "App handle not initialized");
                }
            });
        }

        "get_lt_templates" => {
            match state.media_schedule.load_lt_templates() {
                Ok(templates) => {
                    let msg = json!({ "type": "lt_templates", "templates": templates });
                    send_to(state, from_key, msg.to_string());
                }
                Err(e) => send_error_to(state, from_key, &e.to_string()),
            }
        }

        "get_lt_presets" => {
            match state.media_schedule.list_lt_presets() {
                Ok(presets) => {
                    let msg = json!({ "type": "lt_presets", "presets": presets });
                    send_to(state, from_key, msg.to_string());
                }
                Err(e) => send_error_to(state, from_key, &e.to_string()),
            }
        }

        "save_lt_preset" => {
            if role == "viewer" {
                send_error_to(state, from_key, "Viewers cannot control the output");
                return;
            }
            // { cmd: "save_lt_preset", preset: { id, label, data: { kind, data } } }
            let preset_val = v.get("preset").cloned().unwrap_or(Value::Null);
            match serde_json::from_value::<store::LtPreset>(preset_val) {
                Ok(preset) => {
                    match state.media_schedule.save_lt_preset(preset) {
                        Ok(presets) => {
                            let msg = json!({ "type": "lt_presets", "presets": presets });
                            broadcast_str(state, msg.to_string());
                        }
                        Err(e) => send_error_to(state, from_key, &e.to_string()),
                    }
                }
                Err(e) => send_error_to(state, from_key, &format!("Invalid preset: {}", e)),
            }
        }

        "delete_lt_preset" => {
            if role == "viewer" {
                send_error_to(state, from_key, "Viewers cannot control the output");
                return;
            }
            let id = str_field(&v, "id");
            match state.media_schedule.delete_lt_preset(&id) {
                Ok(presets) => {
                    let msg = json!({ "type": "lt_presets", "presets": presets });
                    broadcast_str(state, msg.to_string());
                }
                Err(e) => send_error_to(state, from_key, &e.to_string()),
            }
        }

        "show_lt_preset" => {
            if role == "viewer" {
                send_error_to(state, from_key, "Viewers cannot control the output");
                return;
            }
            // { cmd: "show_lt_preset", id: "...", template?: { ... } }
            let id = str_field(&v, "id");
            let template = v.get("template").cloned().unwrap_or(Value::Object(Default::default()));
            match state.media_schedule.list_lt_presets() {
                Ok(presets) => {
                    if let Some(preset) = presets.into_iter().find(|p| p.id == id) {
                        let payload = json!({ "data": preset.data, "template": template });
                        *state.lower_third.lock() = Some(payload.clone());
                        if let Some(handle) = state.app_handle.get() {
                            use tauri::Emitter;
                            let _ = handle.emit("lower-third-update", Some(payload.clone()));
                        }
                        let lt_msg = json!({ "type": "lt_update", "payload": payload });
                        broadcast_str(state, lt_msg.to_string());
                    } else {
                        send_error_to(state, from_key, &format!("Preset '{}' not found", id));
                    }
                }
                Err(e) => send_error_to(state, from_key, &e.to_string()),
            }
        }

        // Sent by window:main on auth_ok to recover from race condition where
        // mobile connected before the operator WS was registered.
        "request_all_offers" => {
            let clients = state.signaling_clients.lock();
            for (key, ch) in clients.iter() {
                if key.starts_with("mobile:") {
                    let _ = ch.send(json!({ "event": "request_offer" }).to_string());
                }
            }
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

fn broadcast_str(state: &AppState, msg: String) {
    let _ = state.broadcast_tx.send(msg);
}

/// Send a message to a single client by key. No-op if client is not connected.
pub fn send_to(state: &AppState, client_key: &str, msg: String) {
    let clients = state.signaling_clients.lock();
    if let Some(ch) = clients.get(client_key) {
        let _ = ch.send(msg);
    }
}

/// Send an error message back to the requesting client only (not broadcast).
fn send_error_to(state: &AppState, client_key: &str, message: &str) {
    let msg = json!({ "type": "error", "message": message }).to_string();
    send_to(state, client_key, msg);
}

fn display_item_text(item: &store::DisplayItem) -> String {
    item.to_label()
}

// ─── Multi-operator helpers ───────────────────────────────────────────────────

/// Broadcast the current connected-operators list to all clients.
fn broadcast_operators_list(state: &AppState) {
    let ops: Vec<Value> = state
        .remote_operators
        .lock()
        .iter()
        .map(|(key, meta)| json!({ "key": key, "name": meta.name, "role": meta.role }))
        .collect();
    broadcast_str(state, json!({ "type": "operators", "operators": ops }).to_string());
}

/// Look up the display name of a client by key. Falls back to "Remote".
fn operator_name(state: &AppState, client_key: &str) -> String {
    state
        .remote_operators
        .lock()
        .get(client_key)
        .map(|m| m.name.clone())
        .unwrap_or_else(|| "Remote".to_string())
}

/// Broadcast the current remote proposals list to all WS clients and to the Tauri desktop app.
pub fn broadcast_remote_proposals(state: &AppState) {
    let proposals: Vec<Value> = state.remote_proposals.lock().values()
        .map(|p| json!({
            "operator_key": p.operator_key,
            "operator_name": p.operator_name,
            "item": p.item,
            "staged_at_ms": p.staged_at_ms,
        }))
        .collect();
    broadcast_str(state, json!({ "type": "remote_proposals", "proposals": proposals }).to_string());
    if let Some(handle) = state.app_handle.get() {
        use tauri::Emitter;
        let _ = handle.emit("remote-proposals-update", &proposals);
    }
}
