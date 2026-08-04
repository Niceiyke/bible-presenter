#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use wordlyte_lib::{audio, engine, state, store};
use store::log_msg;
use parking_lot::Mutex;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use engine::model_manager::TranscriptionConfig;
use tauri::Manager;

use state::{AppState, AudioState, ModelState, PresentationState, PipelineState};

fn main() {
    std::panic::set_hook(Box::new(|info| {
        use std::io::Write;
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic payload".to_string()
        };
        let loc = info.location().map(|l| l.to_string()).unwrap_or_default();
        let backtrace = std::backtrace::Backtrace::force_capture();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let text = format!("[{}] PANIC: {} (at {})\n{}\n", stamp, payload, loc, backtrace);
        let dir = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join("io.wordlyte.app")
            .join("logs");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("panic.log")) {
            let _ = f.write_all(text.as_bytes());
        }
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let resolver = app.path();

            let resource_path: PathBuf = {
                let mut candidates: Vec<PathBuf> = Vec::new();
                if let Ok(p) = resolver.resource_dir() { candidates.push(p); }
                if let Ok(exe) = std::env::current_exe() {
                    if let Some(dir) = exe.parent() { candidates.push(dir.to_path_buf()); }
                }
                if let Ok(cwd) = std::env::current_dir() { candidates.push(cwd); }
                let chosen = candidates.iter()
                    .find(|p| p.join("bible_data/wordlyte_bible.db").exists())
                    .or_else(|| candidates.first())
                    .cloned();
                match chosen {
                    Some(p) => { log_msg(app, &format!("Resource Dir: {:?}", p)); p }
                    None => {
                        log_msg(app, "CRITICAL: Could not locate resource directory");
                        return Err("Could not locate resource directory".into());
                    }
                }
            };

            let app_data_dir = app.path()
                .app_local_data_dir()
                .or_else(|_| app.path().app_data_dir())
                .map_err(|e| e.to_string())?;
            log_msg(app, &format!("User data dir: {:?}", app_data_dir));
            if !app_data_dir.exists() {
                fs::create_dir_all(&app_data_dir)
                    .map_err(|e| format!("Cannot create data dir {:?}: {}", app_data_dir, e))?;
            }

            let embedding_model_path = engine::model_manager::bge_model_path(&app_data_dir, &resource_path);
            let tokenizer_path = engine::model_manager::bge_tokenizer_path(&app_data_dir, &resource_path);
            let reranker_model_path = engine::model_manager::reranker_model_path(&app_data_dir, &resource_path);
            let reranker_tokenizer_path = engine::model_manager::reranker_tokenizer_path(&app_data_dir, &resource_path);
            let db_path = engine::model_manager::bible_db_path(&app_data_dir, &resource_path);
            let embeddings_path = engine::model_manager::semantic_index_path(&app_data_dir, &resource_path);

            for (label, path) in [
                ("ONNX model", &embedding_model_path),
                ("Tokenizer", &tokenizer_path),
                ("Reranker model", &reranker_model_path),
                ("Reranker Tokenizer", &reranker_tokenizer_path),
                ("Bible Database", &db_path),
            ] {
                if path.exists() {
                    log_msg(app, &format!("{} found at {:?}", label, path));
                } else {
                    log_msg(app, &format!("{} not found at {:?}", label, path));
                }
            }

            let db_path_str = db_path.to_str()
                .ok_or_else(|| format!("Bible DB path contains non-UTF-8 characters: {:?}", db_path))?;
            let embeddings_path_str = embeddings_path.as_ref().and_then(|p| p.to_str());

            let store = match store::BibleStore::new(app.handle(), db_path_str, embeddings_path_str) {
                Ok(s) => {
                    if s.is_embeddings_loaded() {
                        log_msg(app, "Bible Store: Semantic search index loaded.");
                    }
                    Arc::new(s)
                }
                Err(e) => {
                    log_msg(app, &format!(
                        "Warning: Could not connect to Bible Database: {}. (Expected if not yet downloaded)", e
                    ));
                    Arc::new(store::BibleStore::new_empty(app.handle()))
                }
            };

            let operator_audio = Arc::new(Mutex::new(audio::AudioEngine::new()));
            let preacher_audio = Arc::new(Mutex::new(audio::AudioEngine::new()));
            log_msg(app, "Audio Engines initialized.");

            let media_schedule = match store::MediaScheduleStore::new(app_data_dir.clone()) {
                Ok(ms) => {
                    log_msg(app, "Media Schedule Store initialized.");
                    Arc::new(ms)
                }
                Err(e) => {
                    log_msg(app, &format!(
                        "Warning: Media Schedule Store failed to initialize: {}. Using in-memory fallback.",
                        e
                    ));
                    Arc::new(store::MediaScheduleStore::in_memory(app_data_dir.clone())?)
                }
            };

            let initial_settings = media_schedule
                .load_settings()
                .unwrap_or_else(|_| store::PresentationSettings::default());

            let transcription_config = TranscriptionConfig::load(&app_data_dir);
            let _ = fs::create_dir_all(engine::model_manager::user_models_dir(&app_data_dir));
            let initial_whisper = engine::model_manager::resolve_whisper_path(&transcription_config, &app_data_dir, &resource_path);
            if let Some(ref p) = initial_whisper {
                log_msg(app, &format!("Whisper model resolved: {:?}", p));
            } else {
                log_msg(app, "No Whisper model found — user must download one in Settings.");
            }
            log_msg(app, "AI models will be loaded on the first START LIVE click (lazy load).");

            let state = AppState {
                audio: AudioState {
                    operator: operator_audio,
                    preacher: preacher_audio,
                    studio: Arc::new(Mutex::new(audio::AudioEngine::new())),
                    operator_ptt_active: Arc::new(AtomicBool::new(false)),
                    operator_muted: Arc::new(AtomicBool::new(false)),
                    preacher_muted: Arc::new(AtomicBool::new(false)),
                    operator_is_active: Arc::new(AtomicBool::new(false)),
                    preacher_is_active: Arc::new(AtomicBool::new(false)),
                    studio_is_active: Arc::new(AtomicBool::new(false)),
                },
                model: ModelState {
                    engine: Arc::new(Mutex::new(None)),
                    whisper_path: Arc::new(Mutex::new(initial_whisper)),
                    embedding_model_path,
                    tokenizer_path,
                    reranker_model_path,
                    reranker_tokenizer_path,
                },
                presentation: PresentationState {
                    live_item: Arc::new(Mutex::new(None)),
                    staged_item: Arc::new(Mutex::new(None)),
                    settings: Arc::new(Mutex::new(initial_settings.clone())),
                    lower_third: Arc::new(Mutex::new(None)),
                    props_layer: Arc::new(Mutex::new(Vec::new())),
                },
                pipeline: PipelineState {
                    is_running: Arc::new(Mutex::new(false)),
                    transcription_window: Arc::new(Mutex::new(16000)),
                    transcription_paused: Arc::new(AtomicBool::new(false)),
                    inference_semaphore: Arc::new(tokio::sync::Semaphore::new(1)),
                    session_transcript: Arc::new(Mutex::new(Vec::new())),
                    context_buffer: Arc::new(Mutex::new(Vec::new())),
                    session_start_ms: Arc::new(Mutex::new(0)),
                    operator_cloud_stream: Arc::new(Mutex::new(None)),
                    preacher_cloud_stream: Arc::new(Mutex::new(None)),
                },
                store,
                media_schedule,
                transcription_config: Arc::new(Mutex::new(transcription_config)),
                app_data_dir,
                download_in_progress: Arc::new(AtomicBool::new(false)),
            };

            app.manage(state);

            for label in ["output", "stage", "design", "studio"] {
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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<AppState>() {
                        if let Some(handle) = state.pipeline.operator_cloud_stream.lock().take() {
                            handle.stop();
                        }
                        if let Some(handle) = state.pipeline.preacher_cloud_stream.lock().take() {
                            handle.stop();
                        }
                        state.audio.operator.lock().stop();
                        state.audio.preacher.lock().stop();
                        *state.pipeline.is_running.lock() = false;
                    }
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            wordlyte_lib::commands::session::start_session,
            wordlyte_lib::commands::session::stop_session,
            wordlyte_lib::commands::session::start_operator_recording,
            wordlyte_lib::commands::session::stop_operator_recording,
            wordlyte_lib::commands::session::start_preacher_recording,
            wordlyte_lib::commands::session::stop_preacher_recording,
            wordlyte_lib::commands::session::set_transcription_window,
            wordlyte_lib::commands::session::set_transcription_paused,
            wordlyte_lib::commands::session::set_operator_muted,
            wordlyte_lib::commands::session::set_preacher_muted,
            wordlyte_lib::commands::session::set_operator_ptt,
            wordlyte_lib::commands::session::get_session_transcript,
            wordlyte_lib::commands::session::clear_session_transcript,
            wordlyte_lib::commands::session::export_transcript,
            wordlyte_lib::commands::bible::get_bible_versions,
            wordlyte_lib::commands::bible::set_bible_version,
            wordlyte_lib::commands::bible::split_verse,
            wordlyte_lib::commands::bible::search_manual,
            wordlyte_lib::commands::bible::search_semantic_query,
            wordlyte_lib::commands::bible::read_file_base64,
            wordlyte_lib::commands::bible::get_books,
            wordlyte_lib::commands::bible::get_chapters,
            wordlyte_lib::commands::bible::get_verses_count,
            wordlyte_lib::commands::bible::get_chapter,
            wordlyte_lib::commands::bible::get_verse,
            wordlyte_lib::commands::bible::get_next_verse,
            wordlyte_lib::commands::bible::get_prev_verse,
            wordlyte_lib::commands::media::list_media,
            wordlyte_lib::commands::media::add_media,
            wordlyte_lib::commands::media::delete_media,
            wordlyte_lib::commands::media::set_media_fit,
            wordlyte_lib::commands::media::update_media_metadata,
            wordlyte_lib::commands::media::bulk_delete_media,
            wordlyte_lib::commands::media::bulk_update_media,
            wordlyte_lib::commands::media::check_media_existence,
            wordlyte_lib::commands::schedule::save_schedule,
            wordlyte_lib::commands::schedule::load_schedule,
            wordlyte_lib::commands::schedule::save_recovery,
            wordlyte_lib::commands::schedule::load_recovery,
            wordlyte_lib::commands::schedule::clear_recovery,
            wordlyte_lib::commands::schedule::list_services,
            wordlyte_lib::commands::schedule::save_service,
            wordlyte_lib::commands::schedule::load_service,
            wordlyte_lib::commands::schedule::delete_service,
            wordlyte_lib::commands::display::stage_item,
            wordlyte_lib::commands::display::go_live,
            wordlyte_lib::commands::display::go_live_item,
            wordlyte_lib::commands::display::clear_live,
            wordlyte_lib::commands::display::update_timer,
            wordlyte_lib::commands::display::get_current_item,
            wordlyte_lib::commands::display::get_staged_item,
            wordlyte_lib::commands::display::get_settings,
            wordlyte_lib::commands::display::save_settings,
            wordlyte_lib::commands::studio_pres::list_studio_presentations,
            wordlyte_lib::commands::studio_pres::save_studio_presentation,
            wordlyte_lib::commands::studio_pres::load_studio_presentation,
            wordlyte_lib::commands::studio_pres::delete_studio_presentation,
            wordlyte_lib::commands::scenes::list_scenes,
            wordlyte_lib::commands::scenes::save_scene,
            wordlyte_lib::commands::scenes::delete_scene,
            wordlyte_lib::commands::songs::list_songs,
            wordlyte_lib::commands::songs::save_song,
            wordlyte_lib::commands::songs::delete_song,
            wordlyte_lib::commands::lower_third::show_lower_third,
            wordlyte_lib::commands::lower_third::hide_lower_third,
            wordlyte_lib::commands::lower_third::save_lt_templates,
            wordlyte_lib::commands::lower_third::load_lt_templates,
            wordlyte_lib::commands::lower_third::get_current_lower_third,
            wordlyte_lib::commands::lower_third::list_lt_presets,
            wordlyte_lib::commands::lower_third::save_lt_preset,
            wordlyte_lib::commands::lower_third::delete_lt_preset,
            wordlyte_lib::commands::lower_third::show_lt_preset,
            wordlyte_lib::commands::audio_studio::list_studio_recordings,
            wordlyte_lib::commands::audio_studio::set_studio_device,
            wordlyte_lib::commands::audio_studio::delete_studio_recording,
            wordlyte_lib::commands::audio_studio::rename_studio_recording,
            wordlyte_lib::commands::audio_studio::get_studio_recording_transcript,
            wordlyte_lib::commands::audio_studio::save_studio_recording_transcript,
            wordlyte_lib::commands::audio_studio::transcribe_studio_recording,
            wordlyte_lib::commands::audio_studio::trim_studio_recording,
            wordlyte_lib::commands::audio_studio::start_studio_recording,
            wordlyte_lib::commands::audio_studio::stop_studio_recording,
            wordlyte_lib::commands::audio_studio::import_studio_audio,
            wordlyte_lib::commands::audio_studio::get_recording_peaks,
            wordlyte_lib::commands::windows::toggle_output_window,
            wordlyte_lib::commands::windows::toggle_stage_window,
            wordlyte_lib::commands::windows::toggle_design_window,
            wordlyte_lib::commands::windows::toggle_studio_window,
            wordlyte_lib::commands::windows::get_available_monitors,
            wordlyte_lib::commands::models::list_whisper_models,
            wordlyte_lib::commands::models::get_hardware_info,
            wordlyte_lib::commands::models::download_whisper_model,
            wordlyte_lib::commands::models::cancel_whisper_download,
            wordlyte_lib::commands::models::set_active_whisper_model,
            wordlyte_lib::commands::models::set_gpu_enabled,
            wordlyte_lib::commands::models::delete_whisper_model,
            wordlyte_lib::commands::models::get_semantic_index_status,
            wordlyte_lib::commands::models::get_verse_index_status,
            wordlyte_lib::commands::models::download_bible_db_cmd,
            wordlyte_lib::commands::models::download_core_search_models_cmd,
            wordlyte_lib::commands::models::get_transcription_config,
            wordlyte_lib::commands::models::set_cloud_config,
            wordlyte_lib::commands::models::test_cloud_connection,
            wordlyte_lib::commands::models::set_confidence_threshold,
            wordlyte_lib::commands::models::get_startup_status,
            wordlyte_lib::commands::models::list_transcripts,
            wordlyte_lib::commands::props::get_props,
            wordlyte_lib::commands::props::set_props,
            wordlyte_lib::commands::misc::get_audio_devices,
            wordlyte_lib::commands::misc::set_operator_device,
            wordlyte_lib::commands::misc::set_preacher_device,
            wordlyte_lib::commands::misc::get_app_data_dir,
            wordlyte_lib::commands::misc::get_hymn_library,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
