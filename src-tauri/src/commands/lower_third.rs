use crate::state::AppState;
use crate::store;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn show_lower_third(
    app: AppHandle,
    state: State<'_, AppState>,
    data: store::LowerThirdData,
    template: serde_json::Value,
) -> Result<(), String> {
    let payload = serde_json::json!({ "data": data, "template": template });
    *state.presentation.lower_third.lock() = Some(payload.clone());
    let _ = app.emit("lower-third-update", Some(payload.clone()));
    Ok(())
}

#[tauri::command]
pub async fn hide_lower_third(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    *state.presentation.lower_third.lock() = None;
    let _ = app.emit("lower-third-update", Option::<serde_json::Value>::None);
    Ok(())
}

#[tauri::command]
pub async fn save_lt_templates(state: State<'_, AppState>, templates: Vec<serde_json::Value>) -> Result<(), String> {
    state.media_schedule.save_lt_templates(&serde_json::Value::Array(templates)).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_lt_templates(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.media_schedule.load_lt_templates().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_current_lower_third(state: State<'_, AppState>) -> Result<Option<serde_json::Value>, String> {
    Ok(state.presentation.lower_third.lock().clone())
}

#[tauri::command]
pub async fn list_lt_presets(state: State<'_, AppState>) -> Result<Vec<store::LtPreset>, String> {
    state.media_schedule.list_lt_presets().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_lt_preset(state: State<'_, AppState>, preset: store::LtPreset) -> Result<Vec<store::LtPreset>, String> {
    state.media_schedule.save_lt_preset(preset).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_lt_preset(state: State<'_, AppState>, id: String) -> Result<Vec<store::LtPreset>, String> {
    state.media_schedule.delete_lt_preset(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn show_lt_preset(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    template: Option<serde_json::Value>,
) -> Result<(), String> {
    let presets = state.media_schedule.list_lt_presets().map_err(|e| e.to_string())?;
    let preset = presets.into_iter().find(|p| p.id == id)
        .ok_or_else(|| format!("Preset '{}' not found", id))?;

    let mut tpl = template.unwrap_or(serde_json::json!({}));

    if tpl.as_object().map_or(true, |o| o.is_empty()) {
        if let Some(tpl_id) = &preset.template_id {
            if let Ok(all_tpls) = state.media_schedule.load_lt_templates() {
                if let Some(arr) = all_tpls.as_array() {
                    if let Some(found) = arr.iter().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(tpl_id)) {
                        tpl = found.clone();
                    }
                }
            }
        }
    }

    let payload = serde_json::json!({ "data": preset.data, "template": tpl });
    *state.presentation.lower_third.lock() = Some(payload.clone());
    let _ = app.emit("lower-third-update", Some(payload.clone()));
    Ok(())
}
