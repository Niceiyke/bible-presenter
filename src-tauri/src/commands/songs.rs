use crate::state::AppState;
use crate::store;
use tauri::State;

#[tauri::command]
pub async fn list_songs(state: State<'_, AppState>) -> Result<Vec<store::Song>, String> {
    state.media_schedule.list_songs().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_song(state: State<'_, AppState>, song: store::Song) -> Result<store::Song, String> {
    state.media_schedule.save_song(song).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_song(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.media_schedule.delete_song(&id).map_err(|e| e.to_string())
}
