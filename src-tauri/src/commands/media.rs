use crate::state::AppState;
use crate::store;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn list_media(state: State<'_, AppState>) -> Result<Vec<store::MediaItem>, String> {
    state.media_schedule.list_media().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_media(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<store::MediaItem, String> {
    state.media_schedule.add_media(Some(app), std::path::PathBuf::from(path)).map_err(|e| e.to_string())
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
        store.add_media_streaming(Some(app_handle.clone()), std::path::PathBuf::from(path), |frac| {
            let _ = app_handle.emit("download-progress", serde_json::json!({ "progress": frac }));
        })
    }).await.map_err(|e| format!("import task failed: {}", e))?.map_err(|e| e.to_string())
}

/// Relink a missing record to a replacement source file. Unlike the old
/// `update_media_metadata` call this actually updates the stored path, clears
/// the stale thumbnail and regenerates it — the previous flow silently dropped
/// the new path and wiped the item's metadata.
#[tauri::command]
pub async fn relink_media(app: AppHandle, state: State<'_, AppState>, id: String, path: String) -> Result<store::MediaItem, String> {
    let store = state.media_schedule.clone();
    tokio::task::spawn_blocking(move || {
        store.relink_media(&id, std::path::Path::new(&path)).map_err(|e| e.to_string())
    }).await.map_err(|e| format!("relink task failed: {}", e))?.map_err(|e| e.to_string()).and_then(|item| {
        let _ = app.emit("media-updated", &item);
        Ok(item)
    })
}

/// Delete a media item. `remove_file` (default true) determines whether the
/// on-disk file is also removed; passing false only removes the library entry.
#[tauri::command]
pub async fn delete_media(state: State<'_, AppState>, id: String, remove_file: Option<bool>) -> Result<(), String> {
    let remove = remove_file.unwrap_or(true);
    state.media_schedule.delete_media_with_file(id, remove).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_media_fit(state: State<'_, AppState>, id: String, fit_mode: String) -> Result<(), String> {
    state.media_schedule.set_media_fit(&id, &fit_mode).map_err(|e| e.to_string())
}

/// Per-item playback config (P4.8): loop toggle, playback rate and default
/// volume, persisted so the live output picks them up.
#[tauri::command]
pub async fn set_media_playback(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    loop_playback: bool,
    playback_rate: f64,
    volume: f64,
) -> Result<(), String> {
    state.media_schedule.set_media_playback(&id, loop_playback, playback_rate, volume).map_err(|e| e.to_string())?;
    if let Ok(item) = state.media_schedule.get_media(&id) {
        let _ = app.emit("media-updated", &item);
    }
    Ok(())
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

/// Check a batch of media paths in a single round-trip instead of one invoke
/// per item. Returns a parallel Vec<bool> (true = file exists).
#[tauri::command]
pub async fn check_media_existence_bulk(paths: Vec<String>) -> Result<Vec<bool>, String> {
    Ok(paths.into_iter().map(|p| std::path::Path::new(&p).exists()).collect())
}

/// Where is this media item referenced (services/presentations/scenes)? Used
/// to warn the operator before a destructive delete.
#[tauri::command]
pub async fn get_media_references(state: State<'_, AppState>, id: String) -> Result<Vec<String>, String> {
    let item = state.media_schedule.get_media(&id).map_err(|e| e.to_string())?;
    Ok(state.media_schedule.find_media_references(&item.path))
}

/// Delete media items. `remove_file` (default true) determines whether the
/// on-disk files are also removed; passing false only removes library entries.
#[tauri::command]
pub async fn bulk_delete_media(state: State<'_, AppState>, ids: Vec<String>, remove_file: Option<bool>) -> Result<(), String> {
    let remove = remove_file.unwrap_or(true);
    state.media_schedule.bulk_delete_media_with_file(ids, remove).map_err(|e| e.to_string())
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
