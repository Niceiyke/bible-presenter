use crate::state::AppState;
use crate::events::{emit_checked, MonitorInfo};
use tauri::{AppHandle, Manager, State};

/// Toggle the output window. This is the SAME authoritative path the Output
/// Manager uses (`outputs_set_visible` → `set_output_visible`), so the header /
/// keyboard shortcut can never diverge from the persisted/runtime output state.
/// Since Phase C4 the output window is engine-owned, so visibility comes from
/// the OutputManager's persisted entry rather than a Tauri webview.
#[tauri::command]
pub async fn toggle_output_window(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let visible = state
        .outputs
        .get("output")
        .map(|o| o.visible)
        .unwrap_or(false);
    crate::commands::outputs::set_output_visible(&app, state.inner(), "output", !visible)
}

/// Show the output window on the preferred monitor with a test pattern so the
/// operator can verify cable/signal routing before the service begins.
#[tauri::command]
pub async fn show_output_test_pattern(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    crate::license::ensure_allowed(&state)?;
    crate::commands::outputs::set_output_visible(&app, state.inner(), "output", true)?;
    emit_checked(&app, "monitor-test", &serde_json::json!({ "active": true }));
    Ok(())
}

#[tauri::command]
pub async fn hide_output_test_pattern(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    emit_checked(&app, "monitor-test", &serde_json::json!({ "active": false }));
    crate::commands::outputs::set_output_visible(&app, state.inner(), "output", false)
}

/// Toggle the stage confidence monitor through the same authoritative path.
/// Since Phase C4 the stage window is engine-owned, so visibility comes from
/// the OutputManager's persisted entry rather than a Tauri webview.
#[tauri::command]
pub async fn toggle_stage_window(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let visible = state
        .outputs
        .get("stage")
        .map(|o| o.visible)
        .unwrap_or(false);
    crate::commands::outputs::set_output_visible(&app, state.inner(), "stage", !visible)
}

#[tauri::command]
pub async fn toggle_studio_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("studio") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e: tauri::Error| e.to_string())?;
        } else {
            window.show().map_err(|e: tauri::Error| e.to_string())?;
            window.set_focus().map_err(|e: tauri::Error| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn get_available_monitors(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let win = app.get_webview_window("main").ok_or("no main window")?;
    let primary_name = win.primary_monitor().map_err(|e: tauri::Error| e.to_string())?
        .and_then(|m| m.name().map(|s| s.to_string()));
    let monitors = win.available_monitors().map_err(|e: tauri::Error| e.to_string())?;
    Ok(monitors.into_iter().map(|m| {
        let name = m.name().map(|s| s.to_string()).unwrap_or_default();
        let is_primary = Some(&name) == primary_name.as_ref();
        MonitorInfo {
            name, width: m.size().width, height: m.size().height,
            x: m.position().x, y: m.position().y,
            is_primary,
        }
    }).collect())
}