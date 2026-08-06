use crate::state::AppState;
use crate::store;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

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

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Persist an arbitrary JSON blob (operator workspace: recents, schedule
/// undo/redo stacks) under a named key in the data DB.
#[tauri::command]
pub async fn save_workspace(state: State<'_, AppState>, key: String, value: serde_json::Value) -> Result<(), String> {
    state.media_schedule.save_workspace_blob(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_workspace(state: State<'_, AppState>, key: String) -> Result<Option<serde_json::Value>, String> {
    state.media_schedule.load_workspace_blob(&key).map_err(|e| e.to_string())
}
