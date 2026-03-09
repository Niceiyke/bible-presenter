use tauri::State;
use serde::Serialize;
use crate::AppState;
use super::types::{TallyState, CameraDeviceInfo};

#[derive(Serialize)]
pub struct CameraStatus {
    pub connected_count: usize,
    pub program_device: Option<String>,
    pub preview_device: Option<String>,
    pub devices: Vec<CameraDeviceInfo>,
}

#[tauri::command]
pub async fn camera_list_devices(
    state: State<'_, AppState>,
) -> Result<Vec<CameraDeviceInfo>, String> {
    Ok(state.camera_sessions.list())
}

#[tauri::command]
pub async fn camera_get_status(state: State<'_, AppState>) -> Result<CameraStatus, String> {
    let devices = state.camera_sessions.list();
    let program_device = state.camera_tally.program_device();
    let preview_device = state.camera_tally.preview_device();
    Ok(CameraStatus {
        connected_count: devices.len(),
        program_device,
        preview_device,
        devices,
    })
}

#[tauri::command]
pub async fn camera_set_program(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<(), String> {
    _set_tally(&state, &device_id, TallyState::Program);
    Ok(())
}

#[tauri::command]
pub async fn camera_set_preview(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<(), String> {
    _set_tally(&state, &device_id, TallyState::Preview);
    Ok(())
}

#[tauri::command]
pub async fn camera_clear_program(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(id) = state.camera_tally.clear_program() {
        _notify_tally(&state, &id, TallyState::Off);
    }
    Ok(())
}

#[tauri::command]
pub async fn camera_kick_device(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<(), String> {
    use serde_json::json;
    state
        .camera_sessions
        .send_to(&device_id, &json!({"event":"kicked"}).to_string());
    state.camera_sessions.remove(&device_id);
    state.camera_tally.remove(&device_id);
    Ok(())
}

// ── private helpers ────────────────────────────────────────────────────────

fn _set_tally(state: &AppState, device_id: &str, new_tally: TallyState) {
    // Clear whatever was occupying this role
    match new_tally {
        TallyState::Program => {
            if let Some(old) = state.camera_tally.clear_program() {
                if old != device_id {
                    _notify_tally(state, &old, TallyState::Off);
                }
            }
        }
        TallyState::Preview => {
            if let Some(old) = state.camera_tally.preview_device() {
                if old != device_id {
                    state.camera_tally.set(&old, TallyState::Off);
                    _notify_tally(state, &old, TallyState::Off);
                }
            }
        }
        TallyState::Off => {}
    }

    let changed = state.camera_tally.set(device_id, new_tally);
    state.camera_sessions.set_tally(device_id, new_tally);
    if changed {
        _notify_tally(state, device_id, new_tally);
    }
}

fn _notify_tally(state: &AppState, device_id: &str, tally: TallyState) {
    use serde_json::json;
    let event_name = match tally {
        TallyState::Program => "connect_program",
        TallyState::Preview => "connect_preview",
        TallyState::Off => "disconnect_program",
    };
    let msg = json!({ "event": event_name }).to_string();
    state.camera_sessions.send_to(device_id, &msg);

    // Also broadcast tally update to all operator/output windows
    let broadcast = json!({
        "type": "tally_update",
        "device_id": device_id,
        "tally": tally,
    })
    .to_string();
    let _ = state.broadcast_tx.send(broadcast);
}
