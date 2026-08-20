use crate::engine::{self, Engine};
use crate::state::AppState;
use crate::store;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn get_props(state: State<'_, AppState>) -> Result<Vec<store::PropItem>, String> {
    engine::op_get_props(&*state)
}

#[tauri::command]
pub async fn set_props(app: AppHandle, state: State<'_, AppState>, props: Vec<store::PropItem>) -> Result<(), String> {
    // The engine validates image prop paths, persists BEFORE mutating (so a
    // write failure never leaves the in-memory and on-disk layers diverging),
    // then bumps revision once and broadcasts `props-update`.
    let sink = engine::app_emit_sink(&app);
    let engine = Engine { state: &*state, emit: &sink };
    engine.op_set_props(props).map(|_| ())
}
