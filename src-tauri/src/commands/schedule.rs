use crate::state::AppState;
use crate::store;
use tauri::State;

#[tauri::command]
pub async fn save_schedule(state: State<'_, AppState>, schedule: store::Schedule) -> Result<(), String> {
    state.media_schedule.save_schedule(schedule).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_schedule(state: State<'_, AppState>) -> Result<store::Schedule, String> {
    state.media_schedule.load_schedule().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_recovery(state: State<'_, AppState>, data: serde_json::Value) -> Result<(), String> {
    let path = state.app_data_dir.join("recovery.json");
    if let Ok(json) = serde_json::to_string_pretty(&data) {
        let tmp = path.with_extension("tmp");
        let _ = std::fs::write(&tmp, json);
        let _ = std::fs::rename(tmp, &path);
    }
    Ok(())
}

#[tauri::command]
pub async fn load_recovery(state: State<'_, AppState>) -> Result<Option<serde_json::Value>, String> {
    let path = state.app_data_dir.join("recovery.json");
    if !path.exists() { return Ok(None); }
    let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let data: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(Some(data))
}

#[tauri::command]
pub async fn clear_recovery(state: State<'_, AppState>) -> Result<(), String> {
    let path = state.app_data_dir.join("recovery.json");
    if path.exists() { let _ = std::fs::remove_file(path); }
    Ok(())
}

#[tauri::command]
pub async fn list_services(state: State<'_, AppState>) -> Result<Vec<store::ServiceMeta>, String> {
    state.media_schedule.list_services().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_service(state: State<'_, AppState>, schedule: store::Schedule) -> Result<(), String> {
    state.media_schedule.save_service(&schedule).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_service(state: State<'_, AppState>, id: String) -> Result<store::Schedule, String> {
    state.media_schedule.load_service(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_service(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.media_schedule.delete_service(&id).map_err(|e| e.to_string())
}
