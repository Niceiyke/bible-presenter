use crate::state::AppState;
use crate::store;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub async fn get_audio_devices(state: State<'_, AppState>) -> Result<Vec<(String, String)>, String> {
    let audio = state.audio.operator.lock();
    audio.list_devices().map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub async fn set_operator_device(state: State<'_, AppState>, device_name: String) -> Result<(), String> {
    if *state.pipeline.is_running.lock() {
        state.audio.operator.lock().hot_swap_device(&device_name).map_err(|e: anyhow::Error| e.to_string())
    } else {
        state.audio.operator.lock().select_device(&device_name).map_err(|e: anyhow::Error| e.to_string())
    }
}

#[tauri::command]
pub async fn set_preacher_device(app: AppHandle, state: State<'_, AppState>, device_name: String) -> Result<(), String> {
    let is_running = *state.pipeline.is_running.lock();
    let is_active = state.audio.preacher.lock().session_active();

    if is_running && is_active {
        state.audio.preacher.lock().hot_swap_device(&device_name).map_err(|e: anyhow::Error| e.to_string())
    } else if is_running && !is_active {
        state.audio.preacher.lock().select_device(&device_name).map_err(|e: anyhow::Error| e.to_string())?;
        let _ = app.emit("session-toast", "Preacher mic change takes effect on next session start");
        Ok(())
    } else {
        state.audio.preacher.lock().select_device(&device_name).map_err(|e: anyhow::Error| e.to_string())
    }
}

#[tauri::command]
pub async fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    app.path().app_local_data_dir()
        .or_else(|_| app.path().app_data_dir())
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_hymn_library(app: AppHandle) -> Result<Vec<store::Song>, String> {
    let resolver = app.path();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = resolver.resource_dir() { candidates.push(p); }
    if let Ok(exe) = std::env::current_exe() { if let Some(dir) = exe.parent() { candidates.push(dir.to_path_buf()); } }
    if let Ok(cwd) = std::env::current_dir() { candidates.push(cwd); }

    let chosen = candidates.iter().find(|p| p.join("bible_data/hymns.json").exists())
        .or_else(|| candidates.first()).cloned();

    if let Some(p) = chosen {
        let path = p.join("bible_data/hymns.json");
        if path.exists() {
            let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
            let hymns: Vec<store::Song> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            return Ok(hymns);
        }
    }
    Ok(Vec::new())
}
