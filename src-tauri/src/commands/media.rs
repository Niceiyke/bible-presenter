use crate::state::AppState;
use crate::store;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn list_media(state: State<'_, AppState>) -> Result<Vec<store::MediaItem>, String> {
    state.media_schedule.list_media().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_media(state: State<'_, AppState>, path: String) -> Result<store::MediaItem, String> {
    state.media_schedule.add_media(std::path::PathBuf::from(path)).map_err(|e| e.to_string())
}

/// Streaming media import: copies in 1 MiB chunks with a `download-progress`
/// event per chunk (fraction 0.0–1.0) and runs the whole copy on a blocking
/// thread so large videos don't stall the async runtime.
#[tauri::command]
pub async fn add_media_streaming(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<store::MediaItem, String> {
    let store = state.media_schedule.clone();
    let app_handle = app.clone();
    // spawn_blocking so the chunked copy + progress events stay off the async
    // executor. The closure captures a handle clone to emit progress.
    tokio::task::spawn_blocking(move || {
        store.add_media_streaming(std::path::PathBuf::from(path), |frac| {
            let _ = app_handle.emit("download-progress", serde_json::json!({ "progress": frac }));
        })
    }).await.map_err(|e| format!("import task failed: {}", e))?.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_media(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.media_schedule.delete_media(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_media_fit(state: State<'_, AppState>, id: String, fit_mode: String) -> Result<(), String> {
    state.media_schedule.set_media_fit(&id, &fit_mode).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_media_metadata(
    state: State<'_, AppState>,
    id: String,
    description: Option<String>,
    tags: Vec<String>,
    category: Option<String>,
) -> Result<(), String> {
    state.media_schedule.update_media_metadata(&id, description, tags, category).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_media_existence(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).exists())
}

#[tauri::command]
pub async fn bulk_delete_media(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    state.media_schedule.bulk_delete_media(ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn bulk_update_media(
    state: State<'_, AppState>,
    ids: Vec<String>,
    tags_to_add: Vec<String>,
    tags_to_remove: Vec<String>,
    category: Option<String>,
) -> Result<(), String> {
    state.media_schedule.bulk_update_media(ids, tags_to_add, tags_to_remove, category).map_err(|e| e.to_string())
}