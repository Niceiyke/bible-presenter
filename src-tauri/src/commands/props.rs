use crate::state::AppState;
use crate::store;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn get_props(state: State<'_, AppState>) -> Result<Vec<store::PropItem>, String> {
    let current = state.presentation.props_layer.lock().clone();
    if current.is_empty() {
        if let Ok(loaded) = state.media_schedule.load_props() {
            if !loaded.is_empty() {
                *state.presentation.props_layer.lock() = loaded.clone();
                return Ok(loaded);
            }
        }
    }
    Ok(current)
}

#[tauri::command]
pub async fn set_props(app: AppHandle, state: State<'_, AppState>, props: Vec<store::PropItem>) -> Result<(), String> {
    *state.presentation.props_layer.lock() = props.clone();
    let _ = app.emit("props-update", &props);
    let _ = state.media_schedule.save_props(&props);
    Ok(())
}
