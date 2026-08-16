#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use wordlyte_lib::{remote, store, state};
use store::log_msg;
use parking_lot::Mutex;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::Manager;

use state::{AppState, PresentationState};
use wordlyte_lib::commands::assets;

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

            let db_path = assets::bible_db_path(&app_data_dir, &resource_path);

            log_msg(app, &format!("Bible Database path: {:?}", db_path));
            if db_path.exists() {
                log_msg(app, "Bible database found.");
            } else {
                log_msg(app, "Bible database not found — download in Settings.");
            }

            let db_path_str = db_path.to_str()
                .ok_or_else(|| format!("Bible DB path contains non-UTF-8 characters: {:?}", db_path))?;

            let store = match store::BibleStore::new(app.handle(), db_path_str) {
                Ok(s) => {
                    log_msg(app, "Bible Store initialized.");
                    Arc::new(s)
                }
                Err(e) => {
                    log_msg(app, &format!(
                        "Warning: Could not connect to Bible Database: {}. Using empty placeholder.", e
                    ));
                    Arc::new(store::BibleStore::new_empty(app.handle()))
                }
            };

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

            let remote_files_dir = remote::assets::resolve_remote_assets_dir(&resource_path);
            log_msg(
                app,
                &format!(
                    "Remote assets dir: {} (remote.html {}))",
                    remote_files_dir.display(),
                    if remote_files_dir.join("remote.html").exists() { "found" } else { "missing — run `npm run build`" }
                ),
            );

            let initial_settings = media_schedule
                .load_settings()
                .unwrap_or_else(|_| store::PresentationSettings::default());

            let remote_control = Arc::new(remote::RemoteControl::new(remote_files_dir, &app_data_dir));

            let outputs = Arc::new(wordlyte_lib::outputs::OutputManager::new(&app_data_dir));

            let state = AppState {
                presentation: PresentationState {
                    live_item: Arc::new(Mutex::new(None)),
                    staged_item: Arc::new(Mutex::new(None)),
                    settings: Arc::new(Mutex::new(initial_settings.clone())),
                    lower_third: Arc::new(Mutex::new(None)),
                    props_layer: Arc::new(Mutex::new(Vec::new())),
                },
                store,
                media_schedule,
                app_data_dir,
                download_in_progress: Arc::new(AtomicBool::new(false)),
                remote: remote_control,
                outputs,
                rtmp: Arc::new(Mutex::new(None)),
            };

            app.manage(state);

            // Windows are declared with `create: false`, so they are only
            // built here — after state is managed. Config-declared windows
            // load their webviews immediately and fire hydrate invokes
            // before `.manage()` runs; building them here guarantees the
            // `AppState` exists for any command the webviews call on mount.
            for window_config in app.config().app.windows.iter() {
                tauri::WebviewWindowBuilder::from_config(app.handle(), window_config)?.build()?;
            }

            for label in ["output", "stage", "studio"] {
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
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            wordlyte_lib::commands::bible::get_bible_versions,
            wordlyte_lib::commands::bible::set_bible_version,
            wordlyte_lib::commands::bible::split_verse,
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
            wordlyte_lib::commands::media::add_media_streaming,
            wordlyte_lib::commands::media::save_camera_snapshot,
            wordlyte_lib::commands::media::relink_media,
            wordlyte_lib::commands::media::delete_media,
            wordlyte_lib::commands::media::set_media_fit,
            wordlyte_lib::commands::media::set_media_playback,
            wordlyte_lib::commands::media::update_media_metadata,
            wordlyte_lib::commands::media::bulk_delete_media,
            wordlyte_lib::commands::media::bulk_update_media,
            wordlyte_lib::commands::media::check_media_existence,
            wordlyte_lib::commands::media::check_media_existence_bulk,
            wordlyte_lib::commands::media::get_media_references,
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
            wordlyte_lib::commands::display::commit_staged,
            wordlyte_lib::commands::display::go_live,
            wordlyte_lib::commands::display::go_live_item,
            wordlyte_lib::commands::display::clear_live,
            wordlyte_lib::commands::display::clear_all,
            wordlyte_lib::commands::display::update_timer,
            wordlyte_lib::commands::display::get_current_item,
            wordlyte_lib::commands::display::get_staged_item,
            wordlyte_lib::commands::display::get_settings,
            wordlyte_lib::commands::display::save_settings,
            wordlyte_lib::commands::studio_pres::list_studio_presentations,
            wordlyte_lib::commands::studio_pres::save_studio_presentation,
            wordlyte_lib::commands::studio_pres::load_studio_presentation,
            wordlyte_lib::commands::studio_pres::delete_studio_presentation,
            wordlyte_lib::commands::studio_pres::list_slide_templates,
            wordlyte_lib::commands::studio_pres::save_slide_template,
            wordlyte_lib::commands::studio_pres::delete_slide_template,
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
            wordlyte_lib::commands::windows::toggle_output_window,
            wordlyte_lib::commands::windows::toggle_stage_window,
            wordlyte_lib::commands::windows::toggle_studio_window,
            wordlyte_lib::commands::windows::get_available_monitors,
            wordlyte_lib::commands::windows::show_output_test_pattern,
            wordlyte_lib::commands::windows::hide_output_test_pattern,
            wordlyte_lib::commands::props::get_props,
            wordlyte_lib::commands::props::set_props,
            wordlyte_lib::commands::misc::get_app_data_dir,
            wordlyte_lib::commands::misc::list_fonts,
            wordlyte_lib::commands::misc::get_hymn_library,
            wordlyte_lib::commands::misc::write_text_file,
            wordlyte_lib::commands::misc::read_text_file,
            wordlyte_lib::commands::misc::save_workspace,
            wordlyte_lib::commands::misc::load_workspace,
            wordlyte_lib::commands::scenes::list_scenes,
            wordlyte_lib::commands::scenes::save_scene,
            wordlyte_lib::commands::scenes::delete_scene,
            wordlyte_lib::commands::scenes::apply_scene,
            wordlyte_lib::commands::scenes::capture_scene,
            wordlyte_lib::commands::outputs::outputs_list,
            wordlyte_lib::commands::outputs::outputs_states,
            wordlyte_lib::commands::outputs::outputs_update,
            wordlyte_lib::commands::outputs::outputs_set_visible,
            wordlyte_lib::commands::recordings::recordings_list,
            wordlyte_lib::commands::recordings::recording_save,
            wordlyte_lib::commands::recordings::recording_delete,
            wordlyte_lib::commands::recordings::recordings_open_folder,
            wordlyte_lib::commands::rtmp::rtmp_start,
            wordlyte_lib::commands::rtmp::rtmp_send,
            wordlyte_lib::commands::rtmp::rtmp_stop,
            wordlyte_lib::commands::rtmp::rtmp_status,
            wordlyte_lib::commands::assets::get_startup_status,
            wordlyte_lib::commands::assets::download_bible_db_cmd,
            wordlyte_lib::commands::remote::remote_enable,
            wordlyte_lib::commands::remote::remote_disable,
            wordlyte_lib::commands::remote::remote_status,
            wordlyte_lib::commands::remote::remote_regenerate_pairing,
            wordlyte_lib::commands::remote::remote_revoke_device,
            wordlyte_lib::commands::remote::remote_revoke_all,
            wordlyte_lib::commands::remote::remote_claim_control,
            wordlyte_lib::commands::remote::remote_set_role,
            wordlyte_lib::commands::remote::remote_set_permissions,
            wordlyte_lib::commands::remote::remote_set_auto_revoke,
            wordlyte_lib::commands::remote::remote_rename_device,
            wordlyte_lib::commands::remote::phone_camera_answer,
            wordlyte_lib::commands::remote::phone_camera_ice,
            wordlyte_lib::commands::remote::list_phone_cameras,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
