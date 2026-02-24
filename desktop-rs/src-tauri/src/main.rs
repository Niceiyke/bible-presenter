// Bible Presenter RS Main Entry Point
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use bible_presenter_lib::{audio, engine, store};
use parking_lot::Mutex;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

// ---------------------------------------------------------------------------
// Shared event payloads
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct TranscriptionUpdate {
    text: String,
    detected_item: Option<store::DisplayItem>,
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
struct ModelPaths {
    whisper: PathBuf,
    embedding_model: PathBuf,
    tokenizer: PathBuf,
}

struct AppState {
    audio: Arc<Mutex<audio::AudioEngine>>,
    /// C5: Engine is None until the user first clicks START LIVE.
    /// Wrapped in Mutex so start_session can populate it after the fact.
    engine: Arc<Mutex<Option<Arc<engine::TranscriptionEngine>>>>,
    store: Arc<store::BibleStore>,
    media_schedule: Arc<store::MediaScheduleStore>,
    model_paths: ModelPaths,
    /// C3: Prevents duplicate sessions if START LIVE is clicked twice.
    is_running: Arc<Mutex<bool>>,
    /// Current display items (what is staged and what is live).
    live_item: Arc<Mutex<Option<store::DisplayItem>>>,
    staged_item: Arc<Mutex<Option<store::DisplayItem>>>,
    /// Persisted presentation settings (theme, reference position, etc.)
    settings: Arc<Mutex<store::PresentationSettings>>,
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
async fn start_session(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
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

    {
        let mut audio_guard = audio.lock();
        if let Err(e) = audio_guard.start_capturing(tx, error_tx) {
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
    let live_item_t = live_item_arc.clone();

    tokio::spawn(async move {
        let mut buffer = Vec::new();
        let window_size = 32000; // 2 s at 16 kHz
        let overlap = 8000; // 500 ms overlap

        // Loop exits naturally when both senders are dropped (via stop_session
        // calling audio.stop() which clears active_tx and active_error_tx)
        while let Some(mut chunk) = rx.recv().await {
            buffer.append(&mut chunk);

            if buffer.len() >= window_size {
                let b_clone = buffer.clone();
                let e_clone = engine.clone();
                let s_clone = store.clone();

                let result: Option<(String, Option<store::DisplayItem>)> =
                    tokio::task::spawn_blocking(move || {
                        let text = e_clone.transcribe(&b_clone).ok()?;
                        let embedding = e_clone.embed(&text).ok();
                        let mut verse = s_clone.detect_verse_hybrid(&text, embedding);
                        if verse.is_none() {
                            verse = s_clone.search_semantic_text(&text);
                        }
                        Some((text, verse.map(store::DisplayItem::Verse)))
                    })
                    .await
                    .ok()
                    .flatten();

                if let Some((text, item)) = result {
                    if !text.trim().is_empty() {
                        let _ = app_task.emit(
                            "transcription-update",
                            TranscriptionUpdate {
                                text,
                                detected_item: item,
                                source: "auto".to_string(),
                            },
                        );
                    }
                }

                let remaining = buffer.len() - overlap;
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
async fn stop_session(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
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
async fn toggle_output_window(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
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
                        },
                        detected_item: Some(item),
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
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<(String, String)>, String> {
    let audio = state.audio.lock();
    audio
        .list_devices()
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn set_audio_device(
    state: State<'_, Arc<AppState>>,
    device_name: String,
) -> Result<(), String> {
    let mut audio = state.audio.lock();
    audio
        .select_device(&device_name)
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn set_vad_threshold(state: State<'_, Arc<AppState>>, threshold: f32) -> Result<(), String> {
    let mut audio = state.audio.lock();
    audio.set_vad_threshold(threshold);
    Ok(())
}

#[tauri::command]
async fn search_manual(
    state: State<'_, Arc<AppState>>,
    query: String,
) -> Result<Vec<store::Verse>, String> {
    state
        .store
        .search_manual(&query)
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_books(state: State<'_, Arc<AppState>>) -> Result<Vec<String>, String> {
    state
        .store
        .get_books()
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_chapters(state: State<'_, Arc<AppState>>, book: String) -> Result<Vec<i32>, String> {
    state
        .store
        .get_chapters(&book)
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_verses_count(
    state: State<'_, Arc<AppState>>,
    book: String,
    chapter: i32,
) -> Result<Vec<i32>, String> {
    state
        .store
        .get_verses_count(&book, chapter)
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_verse(
    state: State<'_, Arc<AppState>>,
    book: String,
    chapter: i32,
    verse: i32,
) -> Result<Option<store::Verse>, String> {
    state
        .store
        .get_verse(&book, chapter, verse)
        .map_err(|e: anyhow::Error| e.to_string())
}

/// Called by the output window on mount to retrieve the last live item,
/// ensuring it shows current content even if it missed earlier events.
#[tauri::command]
async fn get_current_item(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<store::DisplayItem>, String> {
    Ok(state.live_item.lock().clone())
}

#[tauri::command]
async fn stage_item(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    item: store::DisplayItem,
) -> Result<(), String> {
    *state.staged_item.lock() = Some(item.clone());
    let _ = app.emit("item-staged", item);
    Ok(())
}

#[tauri::command]
async fn go_live(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
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
                },
                detected_item: Some(item),
                source: "manual".to_string(),
            },
        );
    }
    Ok(())
}

#[tauri::command]
async fn list_presentations(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<store::PresentationFile>, String> {
    state.media_schedule.list_presentations().map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_presentation(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<store::PresentationFile, String> {
    state.media_schedule.add_presentation(PathBuf::from(path)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_presentation(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    state.media_schedule.delete_presentation(id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_media(state: State<'_, Arc<AppState>>) -> Result<Vec<store::MediaItem>, String> {
    state.media_schedule.list_media().map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_media(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<store::MediaItem, String> {
    state.media_schedule.add_media(PathBuf::from(path)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_media(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.media_schedule.delete_media(id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_schedule(
    state: State<'_, Arc<AppState>>,
    schedule: store::Schedule,
) -> Result<(), String> {
    state.media_schedule.save_schedule(schedule).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_schedule(state: State<'_, Arc<AppState>>) -> Result<store::Schedule, String> {
    state.media_schedule.load_schedule().map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_next_verse(
    state: State<'_, Arc<AppState>>,
    book: String,
    chapter: i32,
    verse: i32,
) -> Result<Option<store::Verse>, String> {
    state
        .store
        .get_next_verse(&book, chapter, verse)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_settings(state: State<'_, Arc<AppState>>) -> Result<store::PresentationSettings, String> {
    Ok(state.settings.lock().clone())
}

#[tauri::command]
async fn save_settings(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let resolver = app.path();
            let resource_path = match resolver.resource_dir() {
                Ok(p) => p,
                Err(e) => {
                    log_msg(app, &format!("CRITICAL: Failed to get resource dir: {}", e));
                    return Err(e.into());
                }
            };
            log_msg(app, &format!("Resource Dir: {:?}", resource_path));

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

            let db_path = resource_path.join("bible_data/bible.db");
            let embeddings_path = resource_path.join("bible_data/embeddings.npy");

            log_msg(app, &format!("Looking for DB at: {:?}", db_path));
            if !db_path.exists() {
                log_msg(
                    app,
                    &format!("CRITICAL: Bible Database missing at {:?}", db_path),
                );
            }

            let store = match store::BibleStore::new(
                db_path.to_str().expect("Invalid DB path"),
                embeddings_path.to_str(),
            ) {
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

            let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            if !app_data_dir.exists() {
                fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
            }
            let media_schedule = Arc::new(store::MediaScheduleStore::new(app_data_dir).map_err(|e| e.to_string())?);
            log_msg(app, "Media Schedule Store initialized.");

            let initial_settings = media_schedule
                .load_settings()
                .unwrap_or_else(|_| store::PresentationSettings::default());

            log_msg(
                app,
                "AI models will be loaded on the first START LIVE click (lazy load).",
            );

            app.manage(Arc::new(AppState {
                audio,
                engine: Arc::new(Mutex::new(None)), // loaded lazily in start_session
                store,
                media_schedule,
                model_paths,
                is_running: Arc::new(Mutex::new(false)),
                live_item: Arc::new(Mutex::new(None)),
                staged_item: Arc::new(Mutex::new(None)),
                settings: Arc::new(Mutex::new(initial_settings)),
            }));

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
            search_manual,
            get_current_item,
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
            save_schedule,
            load_schedule,
            stage_item,
            go_live,
            get_settings,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
