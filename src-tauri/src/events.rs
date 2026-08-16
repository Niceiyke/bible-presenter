use serde::{Deserialize, Serialize};
use crate::store;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct LiveItemUpdate {
    pub detected_item: Option<store::DisplayItem>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MonitorInfo {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenePayload {
    pub id: String,
    pub name: String,
    pub settings: store::PresentationSettings,
    pub props: Vec<store::PropItem>,
    pub lower_third_data: Option<store::LowerThirdData>,
    pub lower_third_template: Option<serde_json::Value>,
    pub camera: Option<store::DisplayItem>,
    #[serde(default)]
    pub layout: Option<store::SceneLayout>,
}

/// Emit an event and forward failures to the `system-log` channel so the
/// operator UI can surface them as a warning chip. Never panics.
pub fn emit_checked(
    app: &AppHandle,
    event: &str,
    payload: &(impl serde::Serialize + Clone),
) {
    if let Err(e) = app.emit(event, payload.clone()) {
        let msg = format!("emit '{}' failed: {}", event, e);
        let _ = app.emit("system-log", serde_json::json!({
            "level": "warn",
            "message": msg,
            "timestamp": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        }));
    }
}
