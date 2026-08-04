use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub async fn list_scenes(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    state.media_schedule.list_scenes().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_scene(state: State<'_, AppState>, scene: serde_json::Value) -> Result<(), String> {
    state.media_schedule.save_scene(&scene).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_scene(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.media_schedule.delete_scene(&id).map_err(|e| e.to_string())
}
