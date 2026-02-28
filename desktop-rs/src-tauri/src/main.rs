// Bible Presenter RS Main Entry Point
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod remote;

use bible_presenter_lib::{audio, engine, store};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};

// ---------------------------------------------------------------------------
// Shared event payloads
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct TranscriptionUpdate {
    text: String,
    detected_item: Option<store::DisplayItem>,
    /// Cosine similarity score 0.0–1.0. 1.0 = explicit reference match.
    confidence: f32,
    /// "auto" = from live transcription pipeline; "manual" = operator-triggered via go_live
    source: String,
}

/// Emitted on every session lifecycle change so the frontend can update its UI.
/// status values: "loading" | "running" | "stopped" | "error"
#[derive(Clone, Serialize)]
struct SessionStatus {
    status: String,
    message: String,
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

/// Paths to AI model files, resolved at startup and stored for lazy loading.
#[derive(Clone)]
struct ModelPaths {
    whisper: PathBuf,
    embedding_model: PathBuf,
    tokenizer: PathBuf,
}

pub struct AppState {
    audio: Arc<Mutex<audio::AudioEngine>>,
    /// C5: Engine is None until the user first clicks START LIVE.
    /// Wrapped in Mutex so start_session can populate it after the fact.
    engine: Arc<Mutex<Option<Arc<engine::TranscriptionEngine>>>>,
    pub store: Arc<store::BibleStore>,
    pub media_schedule: Arc<store::MediaScheduleStore>,
    model_paths: ModelPaths,
    /// C3: Prevents duplicate sessions if START LIVE is clicked twice.
    is_running: Arc<Mutex<bool>>,
    /// Current display items (what is staged and what is live).
    pub live_item: Arc<Mutex<Option<store::DisplayItem>>>,
    pub staged_item: Arc<Mutex<Option<store::DisplayItem>>>,
    /// Persisted presentation settings (theme, reference position, etc.)
    settings: Arc<Mutex<store::PresentationSettings>>,
    /// Active lower third overlay as a combined {data, template} JSON value (None = hidden).
    pub lower_third: Arc<Mutex<Option<serde_json::Value>>>,
    /// Broadcast channel: every WS client subscribes to receive state updates.
    pub broadcast_tx: tokio::sync::broadcast::Sender<String>,
    /// Tauri AppHandle stored after setup so the remote module can emit events.
    pub app_handle: Arc<OnceLock<tauri::AppHandle>>,
    /// 4-digit PIN displayed in Settings tab; required for WS auth. Mutable so it can be regenerated.
    pub remote_pin: Arc<Mutex<String>>,
    /// Audio window fed to Whisper per inference call, in samples at 16 kHz.
    /// 8000 = 0.5 s (most responsive, highest CPU); 48000 = 3 s (lowest CPU, most latency).
    transcription_window: Arc<Mutex<usize>>,
    /// Per-client WebRTC signaling channels.
    /// Key: client identifier ("window:main", "window:output", "mobile:{device_id}").
    /// Value: unbounded sender for direct point-to-point message delivery.
    pub signaling_clients: Arc<Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<String>>>>,
    /// When true, the transcription pipeline drains its buffer without calling Whisper.
    /// Set by the operator when LAN cameras are active to free CPU for video decode.
    pub transcription_paused: Arc<AtomicBool>,
    /// Persistent props layer — graphics that survive slide changes (logos, clocks).
    pub props_layer: Arc<Mutex<Vec<store::PropItem>>>,
    /// Currently connected LAN camera clients: device_id → device_name.
    pub connected_cameras: Arc<tokio::sync::Mutex<HashMap<String, String>>>,
}

impl Clone for AppState {
    fn clone(&self) -> Self {
        Self {
            audio: self.audio.clone(),
            engine: self.engine.clone(),
            store: self.store.clone(),
            media_schedule: self.media_schedule.clone(),
            model_paths: self.model_paths.clone(),
            is_running: self.is_running.clone(),
            live_item: self.live_item.clone(),
            staged_item: self.staged_item.clone(),
            settings: self.settings.clone(),
            lower_third: self.lower_third.clone(),
            broadcast_tx: self.broadcast_tx.clone(),
            app_handle: self.app_handle.clone(),
            remote_pin: self.remote_pin.clone(),
            transcription_window: self.transcription_window.clone(),
            signaling_clients: self.signaling_clients.clone(),
            transcription_paused: self.transcription_paused.clone(),
            props_layer: self.props_layer.clone(),
            connected_cameras: self.connected_cameras.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

fn log_msg(app: &tauri::App, message: &str) {
    if let Ok(path) = app.path().app_log_dir() {
        if !path.exists() {
            let _ = std::fs::create_dir_all(&path);
        }
        let log_file = path.join("app.log");
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_file) {
            let _ = writeln!(file, "{}", message);
        }
    }
    println!("{}", message);
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn start_session(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // ── C3: Guard — reject duplicate sessions ────────────────────────────
    {
        let mut running = state.is_running.lock();
        if *running {
            return Err("A session is already running. Click STOP first.".to_string());
        }
        *running = true;
    }

    // ── C5: Lazy-load AI models on the first START LIVE click ─────────────
    // Extract everything from `state` before any .await so we're not
    // holding the Tauri State guard across an async boundary.
    let engine_mutex = state.engine.clone();
    let audio = state.audio.clone();
    let store = state.store.clone();
    let is_running = state.is_running.clone();
    let live_item_arc = state.live_item.clone();
    let broadcast_tx = state.broadcast_tx.clone();
    let transcription_window = state.transcription_window.clone();
    let transcription_paused_task = state.transcription_paused.clone();
    let whisper_path = state.model_paths.whisper.to_str().unwrap_or("").to_string();
    let embedding_path = state
        .model_paths
        .embedding_model
        .to_str()
        .unwrap_or("")
        .to_string();
    let tokenizer_path = state
        .model_paths
        .tokenizer
        .to_str()
        .unwrap_or("")
        .to_string();
    drop(state);

    let engine = { engine_mutex.lock().clone() };
    let engine = match engine {
        Some(e) => e,
        None => {
            // First run: load models in a blocking thread so the async
            // runtime is not stalled. Show a loading indicator in the UI.
            let _ = app.emit(
                "session-status",
                SessionStatus {
                    status: "loading".to_string(),
                    message: "Loading AI models (first-time setup, ~10 s)...".to_string(),
                },
            );

            match tokio::task::spawn_blocking(move || {
                engine::TranscriptionEngine::new(&whisper_path, &embedding_path, &tokenizer_path)
            })
            .await
            {
                Ok(Ok(e)) => {
                    let e = Arc::new(e);
                    *engine_mutex.lock() = Some(e.clone());
                    e
                }
                Ok(Err(e)) => {
                    *is_running.lock() = false;
                    let _ = app.emit(
                        "session-status",
                        SessionStatus {
                            status: "error".to_string(),
                            message: format!("AI models failed to load: {}", e),
                        },
                    );
                    return Err(format!("AI models failed to load: {}", e));
                }
                Err(e) => {
                    *is_running.lock() = false;
                    return Err(format!("Model loading task panicked: {}", e));
                }
            }
        }
    };

    // ── C4: Error channel — audio device errors flow to the UI ────────────
    let (error_tx, mut error_rx) = tokio::sync::mpsc::channel::<String>(10);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<f32>>(50);
    let (level_tx, mut level_rx) = tokio::sync::mpsc::channel::<f32>(50);

    {
        let mut audio_guard = audio.lock();
        if let Err(e) = audio_guard.start_capturing(tx, error_tx, Some(level_tx)) {
            *is_running.lock() = false;
            return Err(e.to_string());
        }
    }

    // C4: Dedicated task that forwards every audio error to the frontend
    let app_err = app.clone();
    tokio::spawn(async move {
        while let Some(msg) = error_rx.recv().await {
            let _ = app_err.emit("audio-error", msg);
        }
    });

    // Forward mic energy levels to the frontend for the VU meter
    let app_level = app.clone();
    tokio::spawn(async move {
        while let Some(level) = level_rx.recv().await {
            let _ = app_level.emit("audio-level", level);
        }
    });

    let _ = app.emit(
        "session-status",
        SessionStatus {
            status: "running".to_string(),
            message: "Live session started".to_string(),
        },
    );

    // ── Main processing loop ───────────────────────────────────────────────
    let app_task = app.clone();
    let is_running_t = is_running.clone();
    let _live_item_t = live_item_arc.clone();
    let broadcast_tx_task = broadcast_tx.clone();
    let transcription_window_task = transcription_window.clone();

    tokio::spawn(async move {
        let mut buffer = Vec::new();
        const OVERLAP: usize = 4000; // 250 ms — fixed context for Whisper continuity

        // Loop exits naturally when both senders are dropped (via stop_session
        // calling audio.stop() which clears active_tx and active_error_tx)
        while let Some(mut chunk) = rx.recv().await {
            buffer.append(&mut chunk);

            // Read the current window size on every iteration so the slider
            // takes effect within one audio cycle without restarting the session.
            let window_size = *transcription_window_task.lock();
            let paused = transcription_paused_task.load(Ordering::Relaxed);

            // When paused, drain the buffer to avoid memory buildup without running Whisper.
            if paused {
                if buffer.len() > window_size {
                    let keep = buffer.len().min(8000); // retain 500 ms for context on resume
                    buffer.drain(0..buffer.len() - keep);
                }
                continue;
            }

            if buffer.len() >= window_size {
                let b_clone = buffer.clone();
                let e_clone = engine.clone();
                let s_clone = store.clone();

                let result: Option<(String, Option<store::DisplayItem>, f32)> =
                    tokio::task::spawn_blocking(move || {
                        let text = e_clone.transcribe(&b_clone).ok()?;
                        let embedding = e_clone.embed(&text).ok();
                        let (verse, confidence) = s_clone.detect_verse_hybrid(&text, embedding);
                        Some((text, verse.map(store::DisplayItem::Verse), confidence))
                    })
                    .await
                    .ok()
                    .flatten();

                if let Some((text, item, confidence)) = result {
                    let lower = text.trim().to_lowercase();
                    const GARBAGE: &[&str] = &[
                        "[blank_audio]", "[silence]", "[music]",
                        "[inaudible]", "(silence)", "[ silence ]",
                    ];
                    let is_garbage = lower.is_empty()
                        || GARBAGE.iter().any(|g| lower.contains(g));
                    if !is_garbage {
                        let _ = app_task.emit(
                            "transcription-update",
                            TranscriptionUpdate {
                                text: text.clone(),
                                detected_item: item.clone(),
                                confidence,
                                source: "auto".to_string(),
                            },
                        );
                        // Broadcast transcription to WS remote clients
                        let _ = broadcast_tx_task.send(
                            serde_json::json!({
                                "type": "transcription",
                                "text": text,
                                "detected_item": item,
                                "confidence": confidence,
                                "source": "auto"
                            })
                            .to_string(),
                        );
                    }
                }

                let remaining = buffer.len().saturating_sub(OVERLAP);
                buffer = buffer[remaining..].to_vec();
            }
        }

        // C3: Session loop exited — clear the guard.
        // Emit "stopped" only if stop_session hasn't already done it
        // (i.e. the stream ended unexpectedly rather than by user action).
        let was_running = {
            let mut r = is_running_t.lock();
            let prev = *r;
            *r = false;
            prev
        };
        if was_running {
            let _ = app_task.emit(
                "session-status",
                SessionStatus {
                    status: "stopped".to_string(),
                    message: "Session ended".to_string(),
                },
            );
        }
    });

    Ok(())
}

/// C3: Stops the running session cleanly.
/// Dropping the CPAL stream closes the audio channel, which causes
/// the processing loop to exit on its next recv() call.
#[tauri::command]
async fn stop_session(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.audio.lock().stop();
    // Clear the guard immediately so START LIVE is available right away
    *state.is_running.lock() = false;
    let _ = app.emit(
        "session-status",
        SessionStatus {
            status: "stopped".to_string(),
            message: "Session stopped".to_string(),
        },
    );
    Ok(())
}

#[tauri::command]
async fn toggle_output_window(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("output") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e: tauri::Error| e.to_string())?;
        } else {
            let monitors = window
                .available_monitors()
                .map_err(|e: tauri::Error| e.to_string())?;
            if monitors.len() > 1 {
                if let Some(primary) = window
                    .primary_monitor()
                    .map_err(|e: tauri::Error| e.to_string())?
                {
                    for monitor in monitors {
                        if monitor.name() != primary.name() {
                            let pos = monitor.position();
                            window
                                .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                                    x: pos.x,
                                    y: pos.y,
                                }))
                                .map_err(|e: tauri::Error| e.to_string())?;
                            window
                                .set_fullscreen(true)
                                .map_err(|e: tauri::Error| e.to_string())?;
                            break;
                        }
                    }
                }
            }
            window.show().map_err(|e: tauri::Error| e.to_string())?;
            window
                .set_focus()
                .map_err(|e: tauri::Error| e.to_string())?;

            // Sync settings so the output window uses the current theme/position.
            let current_settings = state.settings.lock().clone();
            let _ = app.emit("settings-changed", current_settings);

            // Sync the current live item to the output window immediately on show,
            // so it doesn't display "Waiting for projection..." if something was
            // already live before the window was opened.
            let live = state.live_item.lock().clone();
            if let Some(item) = live {
                let _ = app.emit(
                    "transcription-update",
                    TranscriptionUpdate {
                        text: match &item {
                            store::DisplayItem::Verse(v) => {
                                format!("{} {}:{}", v.book, v.chapter, v.verse)
                            }
                            store::DisplayItem::Media(m) => m.name.clone(),
                            store::DisplayItem::PresentationSlide(p) => {
                                format!("{} – slide {}", p.presentation_name, p.slide_index + 1)
                            }
                            store::DisplayItem::CustomSlide(c) => {
                                format!("{} – slide {}", c.presentation_name, c.slide_index + 1)
                            }
                            store::DisplayItem::CameraFeed(cam) => {
                                if cam.label.is_empty() { cam.device_id.clone() } else { cam.label.clone() }
                            }
                            store::DisplayItem::Scene(s) => {
                                s.get("name").and_then(|v| v.as_str()).unwrap_or("Scene").to_string()
                            }
                            store::DisplayItem::Timer(t) => {
                                format!("Timer: {}", t.timer_type)
                            }
                        },
                        detected_item: Some(item),
                        confidence: 1.0,
                        source: "manual".to_string(),
                    },
                );
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn get_audio_devices(
    state: State<'_, AppState>,
) -> Result<Vec<(String, String)>, String> {
    let audio = state.audio.lock();
    audio
        .list_devices()
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn set_audio_device(
    state: State<'_, AppState>,
    device_name: String,
) -> Result<(), String> {
    let mut audio = state.audio.lock();
    audio
        .select_device(&device_name)
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn set_vad_threshold(state: State<'_, AppState>, threshold: f32) -> Result<(), String> {
    let mut audio = state.audio.lock();
    audio.set_vad_threshold(threshold);
    Ok(())
}

#[tauri::command]
async fn get_bible_versions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.store.get_available_versions())
}

#[tauri::command]
async fn set_bible_version(
    state: State<'_, AppState>,
    version: String,
) -> Result<(), String> {
    state.store.set_active_version(&version);
    Ok(())
}

#[tauri::command]
async fn search_manual(
    state: State<'_, AppState>,
    query: String,
    version: String,
) -> Result<Vec<store::Verse>, String> {
    state
        .store
        .search_manual(&query, &version)
        .map_err(|e: anyhow::Error| e.to_string())
}

/// Semantic search across all versions using ONNX embedding; falls back to keyword search.
#[tauri::command]
async fn search_semantic_query(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<store::Verse>, String> {
    // Clone the inner Arc while holding the lock briefly, then release before embed().
    let engine_opt: Option<Arc<engine::TranscriptionEngine>> = state.engine.lock().clone();
    if let Some(engine) = engine_opt {
        match engine.embed(&query) {
            Ok(embedding) => {
                let results = state.store.search_top_n_semantic(&embedding, 10);
                if !results.is_empty() {
                    return Ok(results);
                }
            }
            Err(e) => {
                eprintln!("Embedding error, falling back to keyword search: {}", e);
            }
        }
    }
    state.store.search_manual_all_versions(&query).map_err(|e| e.to_string())
}

/// Read a file from disk and return its contents as a base64 string.
#[tauri::command]
async fn read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
async fn get_books(state: State<'_, AppState>, version: String) -> Result<Vec<String>, String> {
    state
        .store
        .get_books(&version)
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_chapters(
    state: State<'_, AppState>,
    book: String,
    version: String,
) -> Result<Vec<i32>, String> {
    state
        .store
        .get_chapters(&book, &version)
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_verses_count(
    state: State<'_, AppState>,
    book: String,
    chapter: i32,
    version: String,
) -> Result<Vec<i32>, String> {
    state
        .store
        .get_verses_count(&book, chapter, &version)
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_verse(
    state: State<'_, AppState>,
    book: String,
    chapter: i32,
    verse: i32,
    version: String,
) -> Result<Option<store::Verse>, String> {
    state
        .store
        .get_verse(&book, chapter, verse, &version)
        .map_err(|e: anyhow::Error| e.to_string())
}

/// Called by the output window on mount to retrieve the last live item,
/// ensuring it shows current content even if it missed earlier events.
#[tauri::command]
async fn get_current_item(
    state: State<'_, AppState>,
) -> Result<Option<store::DisplayItem>, String> {
    Ok(state.live_item.lock().clone())
}

#[tauri::command]
async fn get_staged_item(
    state: State<'_, AppState>,
) -> Result<Option<store::DisplayItem>, String> {
    Ok(state.staged_item.lock().clone())
}

#[tauri::command]
async fn stage_item(
    app: AppHandle,
    state: State<'_, AppState>,
    item: store::DisplayItem,
) -> Result<(), String> {
    *state.staged_item.lock() = Some(item.clone());
    let _ = app.emit("item-staged", &item);
    // Notify stage display window
    let _ = app.emit("stage-update", Some(&item));
    Ok(())
}

#[tauri::command]
async fn go_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let staged = state.staged_item.lock().clone();
    if let Some(item) = staged {
        *state.live_item.lock() = Some(item.clone());
        let _ = app.emit(
            "transcription-update",
            TranscriptionUpdate {
                text: match item {
                    store::DisplayItem::Verse(ref v) => format!("{} {}:{}", v.book, v.chapter, v.verse),
                    store::DisplayItem::Media(ref m) => m.name.clone(),
                    store::DisplayItem::PresentationSlide(ref p) => {
                        format!("{} – slide {}", p.presentation_name, p.slide_index + 1)
                    }
                    store::DisplayItem::CustomSlide(ref c) => {
                        format!("{} – slide {}", c.presentation_name, c.slide_index + 1)
                    }
                    store::DisplayItem::CameraFeed(ref cam) => {
                        if cam.label.is_empty() { cam.device_id.clone() } else { cam.label.clone() }
                    }
                    store::DisplayItem::Scene(ref s) => {
                        s.get("name").and_then(|v| v.as_str()).unwrap_or("Scene").to_string()
                    }
                    store::DisplayItem::Timer(ref t) => {
                        format!("Timer: {}", t.timer_type)
                    }
                },
                detected_item: Some(item.clone()),
                confidence: 1.0,
                source: "manual".to_string(),
            },
        );
        // Broadcast to WS remote clients
        let _ = state.broadcast_tx.send(
            serde_json::json!({ "type": "state", "live_item": item }).to_string()
        );
    }
    Ok(())
}

#[tauri::command]
async fn clear_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    *state.live_item.lock() = None;
    let _ = app.emit(
        "transcription-update",
        TranscriptionUpdate {
            text: "".to_string(),
            detected_item: None,
            confidence: 1.0,
            source: "manual".to_string(),
        },
    );
    // Broadcast to WS remote clients
    let _ = state.broadcast_tx.send(
        serde_json::json!({ "type": "state", "live_item": null }).to_string()
    );
    // Clear stage display
    let _ = app.emit("stage-update", Option::<store::DisplayItem>::None);
    Ok(())
}

/// Updates the `started_at` timestamp on the currently-live timer item and re-emits it
/// so both windows tick from the same reference point.
#[tauri::command]
async fn update_timer(
    app: AppHandle,
    state: State<'_, AppState>,
    started_at: Option<u64>,
) -> Result<(), String> {
    let mut live = state.live_item.lock();
    if let Some(store::DisplayItem::Timer(ref mut t)) = *live {
        t.started_at = started_at;
        let item = live.clone().unwrap();
        drop(live);
        let _ = app.emit(
            "transcription-update",
            TranscriptionUpdate {
                text: format!("Timer: {}", match &item { store::DisplayItem::Timer(t) => &t.timer_type, _ => "" }),
                detected_item: Some(item),
                confidence: 1.0,
                source: "manual".to_string(),
            },
        );
    }
    Ok(())
}

/// Shows or hides the stage display window.
#[tauri::command]
async fn toggle_stage_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("stage") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e: tauri::Error| e.to_string())?;
        } else {
            window.show().map_err(|e: tauri::Error| e.to_string())?;
            window.set_focus().map_err(|e: tauri::Error| e.to_string())?;
        }
    }
    Ok(())
}

/// Shows or hides the Design Hub window.
#[tauri::command]
async fn toggle_design_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("design") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e: tauri::Error| e.to_string())?;
        } else {
            window.show().map_err(|e: tauri::Error| e.to_string())?;
            window.set_focus().map_err(|e: tauri::Error| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn list_presentations(
    state: State<'_, AppState>,
) -> Result<Vec<store::PresentationFile>, String> {
    state.media_schedule.list_presentations().map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_presentation(
    state: State<'_, AppState>,
    path: String,
) -> Result<store::PresentationFile, String> {
    state.media_schedule.add_presentation(PathBuf::from(path)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_presentation(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.media_schedule.delete_presentation(id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_media(state: State<'_, AppState>) -> Result<Vec<store::MediaItem>, String> {
    state.media_schedule.list_media().map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_media(
    state: State<'_, AppState>,
    path: String,
) -> Result<store::MediaItem, String> {
    state.media_schedule.add_media(PathBuf::from(path)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_media(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.media_schedule.delete_media(id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_media_fit(
    state: State<'_, AppState>,
    id: String,
    fit_mode: String,
) -> Result<(), String> {
    state.media_schedule.set_media_fit(&id, &fit_mode).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_schedule(
    state: State<'_, AppState>,
    schedule: store::Schedule,
) -> Result<(), String> {
    state.media_schedule.save_schedule(schedule).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_schedule(state: State<'_, AppState>) -> Result<store::Schedule, String> {
    state.media_schedule.load_schedule().map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_next_verse(
    state: State<'_, AppState>,
    book: String,
    chapter: i32,
    verse: i32,
    version: String,
) -> Result<Option<store::Verse>, String> {
    state
        .store
        .get_next_verse(&book, chapter, verse, &version)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<store::PresentationSettings, String> {
    Ok(state.settings.lock().clone())
}

#[tauri::command]
async fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: store::PresentationSettings,
) -> Result<(), String> {
    state
        .media_schedule
        .save_settings(&settings)
        .map_err(|e| e.to_string())?;
    *state.settings.lock() = settings.clone();
    // Broadcast to both windows so the output screen updates live
    let _ = app.emit("settings-changed", settings);
    Ok(())
}

#[tauri::command]
async fn list_studio_presentations(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    state.media_schedule.list_studio_presentations().map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_studio_presentation(
    state: State<'_, AppState>,
    presentation: store::CustomPresentation,
) -> Result<(), String> {
    state.media_schedule.save_studio_presentation(&presentation).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_studio_presentation(
    state: State<'_, AppState>,
    id: String,
) -> Result<store::CustomPresentation, String> {
    state.media_schedule.load_studio_presentation(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_studio_presentation(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.media_schedule.delete_studio_presentation(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_scenes(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    state.media_schedule.list_scenes().map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_scene(
    state: State<'_, AppState>,
    scene: serde_json::Value,
) -> Result<(), String> {
    state.media_schedule.save_scene(&scene).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_scene(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.media_schedule.delete_scene(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_connected_cameras(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let cameras = state.connected_cameras.lock().await;
    Ok(cameras.iter().map(|(id, name)| {
        serde_json::json!({ "device_id": id, "device_name": name })
    }).collect())
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_songs(state: State<'_, AppState>) -> Result<Vec<store::Song>, String> {
    state.media_schedule.list_songs().map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_song(state: State<'_, AppState>, song: store::Song) -> Result<store::Song, String> {
    state.media_schedule.save_song(song).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_song(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.media_schedule.delete_song(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Lower third
// ---------------------------------------------------------------------------

#[tauri::command]
async fn show_lower_third(
    app: AppHandle,
    state: State<'_, AppState>,
    data: store::LowerThirdData,
    template: serde_json::Value,
) -> Result<(), String> {
    let payload = serde_json::json!({ "data": data, "template": template });
    *state.lower_third.lock() = Some(payload.clone());
    let _ = app.emit("lower-third-update", Some(payload.clone()));
    // Broadcast to WS remote clients
    let _ = state.broadcast_tx.send(
        serde_json::json!({ "type": "lt_update", "payload": payload }).to_string()
    );
    Ok(())
}

#[tauri::command]
async fn hide_lower_third(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    *state.lower_third.lock() = None;
    let _ = app.emit("lower-third-update", Option::<serde_json::Value>::None);
    // Broadcast to WS remote clients
    let _ = state.broadcast_tx.send(
        serde_json::json!({ "type": "lt_update", "payload": null }).to_string()
    );
    Ok(())
}

#[tauri::command]
async fn save_lt_templates(
    state: State<'_, AppState>,
    templates: Vec<serde_json::Value>,
) -> Result<(), String> {
    state
        .media_schedule
        .save_lt_templates(&serde_json::Value::Array(templates))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_lt_templates(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state
        .media_schedule
        .load_lt_templates()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Remote control info
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct RemoteInfo {
    url: String,
    pin: String,
    /// Some("http://100.x.x.x:7420") when Tailscale is running; None otherwise.
    tailscale_url: Option<String>,
}

/// Try `tailscale ip -4` to get the Tailscale IPv4 address.
/// Returns None if Tailscale is not installed or not connected.
fn get_tailscale_ip() -> Option<String> {
    let output = std::process::Command::new("tailscale")
        .args(["ip", "-4"])
        .output()
        .ok()?;
    if output.status.success() {
        let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
        // Tailscale uses the 100.64.0.0/10 CGNAT range
        if !ip.is_empty() && ip.starts_with("100.") {
            return Some(ip);
        }
    }
    None
}

#[tauri::command]
async fn get_current_lower_third(
    state: State<'_, AppState>,
) -> Result<Option<serde_json::Value>, String> {
    Ok(state.lower_third.lock().clone())
}

#[tauri::command]
async fn get_remote_info(state: State<'_, AppState>) -> Result<RemoteInfo, String> {
    let lan_ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "localhost".to_string());

    // Run tailscale CLI in a blocking thread so we don't stall the async runtime
    let tailscale_url = tokio::task::spawn_blocking(get_tailscale_ip)
        .await
        .ok()
        .flatten()
        .map(|ip| format!("http://{}:7420", ip));

    Ok(RemoteInfo {
        url: format!("http://{}:7420", lan_ip),
        pin: state.remote_pin.lock().clone(),
        tailscale_url,
    })
}

#[tauri::command]
async fn set_transcription_window(
    state: State<'_, AppState>,
    samples: usize,
) -> Result<(), String> {
    // Clamp to 0.5 s – 3 s at 16 kHz
    *state.transcription_window.lock() = samples.clamp(8_000, 48_000);
    Ok(())
}

#[tauri::command]
async fn set_transcription_paused(
    state: State<'_, AppState>,
    paused: bool,
) -> Result<(), String> {
    state.transcription_paused.store(paused, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn regenerate_remote_pin(state: State<'_, AppState>) -> Result<String, String> {
    let new_pin = format!("{:04}", rand::random::<u16>() % 10000);
    *state.remote_pin.lock() = new_pin.clone();
    // Persist so the new PIN survives the next restart
    if let Some(handle) = state.app_handle.get() {
        let dir = handle.path().app_local_data_dir()
            .or_else(|_| handle.path().app_data_dir())
            .map_err(|e| e.to_string())?;
        std::fs::write(dir.join("remote_pin.txt"), &new_pin)
            .map_err(|e| e.to_string())?;
    }
    Ok(new_pin)
}

// ---------------------------------------------------------------------------
// Named services
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_services(state: State<'_, AppState>) -> Result<Vec<store::ServiceMeta>, String> {
    state.media_schedule.list_services().map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_service(state: State<'_, AppState>, schedule: store::Schedule) -> Result<(), String> {
    state.media_schedule.save_service(&schedule).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_service(state: State<'_, AppState>, id: String) -> Result<store::Schedule, String> {
    state.media_schedule.load_service(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_service(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.media_schedule.delete_service(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Props layer
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_props(state: State<'_, AppState>) -> Result<Vec<store::PropItem>, String> {
    Ok(state.props_layer.lock().clone())
}

#[tauri::command]
async fn set_props(
    app: AppHandle,
    state: State<'_, AppState>,
    props: Vec<store::PropItem>,
) -> Result<(), String> {
    *state.props_layer.lock() = props.clone();
    let _ = app.emit("props-update", &props);
    Ok(())
}

// ---------------------------------------------------------------------------
// LibreOffice PPTX rendering
// ---------------------------------------------------------------------------

#[tauri::command]
async fn check_libreoffice() -> bool {
    std::process::Command::new("libreoffice")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
async fn convert_pptx_slides(
    state: State<'_, AppState>,
    path: String,
    pres_id: String,
) -> Result<Vec<String>, String> {
    let cache_dir = state.media_schedule.get_pptx_cache_dir(&pres_id);
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let out = std::process::Command::new("libreoffice")
        .args([
            "--headless",
            "--convert-to",
            "png:impress_png_Export",
            "--outdir",
            cache_dir.to_str().unwrap_or(""),
            &path,
        ])
        .output()
        .map_err(|e| format!("Failed to run LibreOffice: {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let mut slides: Vec<String> = fs::read_dir(&cache_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "png").unwrap_or(false))
        .map(|e| e.path().to_string_lossy().to_string())
        .collect();
    slides.sort();
    Ok(slides)
}

#[tauri::command]
async fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    app.path().app_local_data_dir()
        .or_else(|_| app.path().app_data_dir())
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let resolver = app.path();

            // Resolve resource directory with a fallback to the executable's own directory.
            // On corporate Windows systems the standard resource_dir() path may be
            // inaccessible (e.g. redirected Roaming profile, AppLocker policy), so we
            // probe several candidates in order.
            let resource_path: PathBuf = {
                let mut candidates: Vec<PathBuf> = Vec::new();

                // 1. Tauri's canonical resource directory
                if let Ok(p) = resolver.resource_dir() {
                    candidates.push(p);
                }
                // 2. Directory of the running executable (covers portable / custom-extracted installs)
                if let Ok(exe) = std::env::current_exe() {
                    if let Some(dir) = exe.parent() {
                        candidates.push(dir.to_path_buf());
                    }
                }
                // 3. Current working directory (last resort)
                if let Ok(cwd) = std::env::current_dir() {
                    candidates.push(cwd);
                }

                let chosen = candidates.iter().find(|p| p.join("bible_data/super_bible.db").exists())
                    .or_else(|| candidates.first())
                    .cloned();

                match chosen {
                    Some(p) => {
                        log_msg(app, &format!("Resource Dir: {:?}", p));
                        p
                    }
                    None => {
                        log_msg(app, "CRITICAL: Could not locate resource directory");
                        return Err("Could not locate resource directory".into());
                    }
                }
            };

            // C5: Resolve model paths but do NOT load them — deferred to start_session
            let model_paths = ModelPaths {
                whisper: resource_path.join("models/whisper-base.bin"),
                embedding_model: resource_path.join("models/all-minilm-l6-v2.onnx"),
                tokenizer: resource_path.join("models/tokenizer.json"),
            };

            for (label, path) in [
                ("Whisper model", &model_paths.whisper),
                ("ONNX model", &model_paths.embedding_model),
                ("Tokenizer", &model_paths.tokenizer),
            ] {
                if path.exists() {
                    log_msg(app, &format!("{} found at {:?}", label, path));
                } else {
                    log_msg(
                        app,
                        &format!(
                            "Warning: {} not found at {:?} — START LIVE will report an error",
                            label, path
                        ),
                    );
                }
            }

            let db_path = resource_path.join("bible_data/super_bible.db");
            let embeddings_path = resource_path.join("bible_data/all_versions_embeddings.npy");

            log_msg(app, &format!("Looking for DB at: {:?}", db_path));
            if !db_path.exists() {
                log_msg(
                    app,
                    &format!("CRITICAL: Bible Database missing at {:?}", db_path),
                );
            }

            let db_path_str = db_path.to_str()
                .ok_or_else(|| format!("Bible DB path contains non-UTF-8 characters: {:?}", db_path))?;
            let embeddings_path_str = embeddings_path.to_str();

            let store = match store::BibleStore::new(db_path_str, embeddings_path_str) {
                Ok(s) => {
                    log_msg(app, "Bible Store loaded successfully.");
                    Arc::new(s)
                }
                Err(e) => {
                    log_msg(
                        app,
                        &format!("CRITICAL: Failed to connect to Bible Database: {}", e),
                    );
                    return Err(format!("Database error: {}", e).into());
                }
            };

            let audio = Arc::new(Mutex::new(audio::AudioEngine::new()));
            log_msg(app, "Audio Engine initialized.");

            // Use app_local_data_dir (C:\Users\{user}\AppData\Local\...) rather than
            // app_data_dir (Roaming), which on corporate systems is often redirected to a
            // network share that may be inaccessible or slow.
            let app_data_dir = app.path()
                .app_local_data_dir()
                .or_else(|_| app.path().app_data_dir())
                .map_err(|e| e.to_string())?;
            log_msg(app, &format!("User data dir: {:?}", app_data_dir));
            if !app_data_dir.exists() {
                fs::create_dir_all(&app_data_dir).map_err(|e| format!("Cannot create data dir {:?}: {}", app_data_dir, e))?;
            }
            let media_schedule = Arc::new(store::MediaScheduleStore::new(app_data_dir.clone()).map_err(|e| e.to_string())?);
            log_msg(app, "Media Schedule Store initialized.");

            let initial_settings = media_schedule
                .load_settings()
                .unwrap_or_else(|_| store::PresentationSettings::default());

            log_msg(
                app,
                "AI models will be loaded on the first START LIVE click (lazy load).",
            );

            let (broadcast_tx, _) = tokio::sync::broadcast::channel::<String>(128);

            // Load persisted PIN or generate a new one and save it.
            let pin_file = app_data_dir.join("remote_pin.txt");
            let remote_pin = std::fs::read_to_string(&pin_file)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| s.len() == 4 && s.chars().all(|c| c.is_ascii_digit()))
                .unwrap_or_else(|| {
                    let pin = format!("{:04}", rand::random::<u16>() % 10000);
                    let _ = std::fs::write(&pin_file, &pin);
                    pin
                });
            log_msg(app, &format!("Remote PIN: {}", remote_pin));

            let state = AppState {
                audio,
                engine: Arc::new(Mutex::new(None)), // loaded lazily in start_session
                store,
                media_schedule,
                model_paths,
                is_running: Arc::new(Mutex::new(false)),
                live_item: Arc::new(Mutex::new(None)),
                staged_item: Arc::new(Mutex::new(None)),
                settings: Arc::new(Mutex::new(initial_settings)),
                lower_third: Arc::new(Mutex::new(None)),
                broadcast_tx,
                app_handle: Arc::new(OnceLock::new()),
                remote_pin: Arc::new(Mutex::new(remote_pin)),
                transcription_window: Arc::new(Mutex::new(16000)), // 1 s default
                signaling_clients: Arc::new(Mutex::new(HashMap::new())),
                transcription_paused: Arc::new(AtomicBool::new(false)),
                props_layer: Arc::new(Mutex::new(Vec::new())),
                connected_cameras: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            };

            // Store app_handle so remote module can emit events to Tauri windows
            state.app_handle.set(app.handle().clone()).ok();

            // Start the LAN remote server in the background
            let remote_state = Arc::new(state.clone());
            tauri::async_runtime::spawn(async move {
                remote::start(remote_state, 7420).await;
            });

            app.manage(state);

            // Intercept close on secondary windows — hide instead of destroy so
            // the toggle commands can show them again later.
            for label in ["output", "stage", "design"] {
                if let Some(win) = app.get_webview_window(label) {
                    let win2 = win.clone();
                    win.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = win2.hide();
                        }
                    });
                }
            }

            log_msg(app, "App state managed. Ready.");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_session,
            stop_session,
            toggle_output_window,
            get_audio_devices,
            set_audio_device,
            set_vad_threshold,
            get_bible_versions,
            set_bible_version,
            search_manual,
            search_semantic_query,
            read_file_base64,
            get_current_item,
            get_staged_item,
            get_books,
            get_chapters,
            get_verses_count,
            get_verse,
            get_next_verse,
            list_presentations,
            add_presentation,
            delete_presentation,
            list_media,
            add_media,
            delete_media,
            set_media_fit,
            save_schedule,
            load_schedule,
            stage_item,
            go_live,
            clear_live,
            get_settings,
            save_settings,
            list_studio_presentations,
            save_studio_presentation,
            load_studio_presentation,
            delete_studio_presentation,
            list_scenes,
            save_scene,
            delete_scene,
            list_connected_cameras,
            list_songs,
            save_song,
            delete_song,
            show_lower_third,
            hide_lower_third,
            save_lt_templates,
            load_lt_templates,
            get_current_lower_third,
            get_remote_info,
            regenerate_remote_pin,
            set_transcription_window,
            set_transcription_paused,
            update_timer,
            toggle_stage_window,
            toggle_design_window,
            list_services,
            save_service,
            load_service,
            delete_service,
            get_props,
            set_props,
            check_libreoffice,
            convert_pptx_slides,
            get_app_data_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
