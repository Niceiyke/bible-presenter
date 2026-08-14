use crate::state::AppState;
use crate::events::{emit_checked, MonitorInfo, LiveItemUpdate};
use crate::remote::protocol::RemoteEventKind;
use serde_json::json;
use tauri::{AppHandle, Manager, State};

/// Broadcasts the current output-window visibility state to every connected
/// remote so `output.changed` mirrors the actual window state.
fn publish_output_visible(app: &AppHandle, state: &State<'_, AppState>) {
    let visible = app
        .get_webview_window("output")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    state.remote.hub.publish(
        RemoteEventKind::OutputChanged,
        json!({ "output_visible": visible }),
        None,
    );
}

#[tauri::command]
pub async fn toggle_output_window(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("output") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e: tauri::Error| e.to_string())?;
        } else {
            position_output_on_preferred(app.clone(), &state)?;
            let _ = window.set_ignore_cursor_events(true);
            window.show().map_err(|e: tauri::Error| e.to_string())?;
            window.set_focus().map_err(|e: tauri::Error| e.to_string())?;

            // Re-broadcast all current state so a freshly-revealed window can
            // hydrate even if it missed events while hidden.
            let current_settings = state.presentation.settings.lock().clone();
            emit_checked(&app, "settings-changed", &current_settings);

            let live = state.presentation.live_item.lock().clone();
            emit_checked(&app, "live-item-update", &LiveItemUpdate { detected_item: live });

            let lt = state.presentation.lower_third.lock().clone();
            emit_checked(&app, "lower-third-update", &lt);

            let props = state.presentation.props_layer.lock().clone();
            emit_checked(&app, "props-update", &props);

            let staged = state.presentation.staged_item.lock().clone();
            emit_checked(&app, "item-staged", &staged);
        }
        publish_output_visible(&app, &state);
    }
    Ok(())
}

fn position_output_on_preferred(app: AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("output") {
        let preferred = state.presentation.settings.lock().preferred_monitor.clone();
        let monitors = window.available_monitors().map_err(|e: tauri::Error| e.to_string())?;
        if monitors.len() > 1 {
            if let Some(primary) = window.primary_monitor().map_err(|e: tauri::Error| e.to_string())? {
                let target = monitors.iter().find(|m| {
                    preferred.as_deref().is_some_and(|p| m.name().is_some_and(|n| n == p))
                }).or_else(|| monitors.iter().find(|m| m.name() != primary.name()));
                if let Some(mon) = target {
                    let pos = mon.position();
                    window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: pos.x, y: pos.y }))
                        .map_err(|e: tauri::Error| e.to_string())?;
                    window.set_fullscreen(true).map_err(|e: tauri::Error| e.to_string())?;
                }
            }
        }
    }
    Ok(())
}

/// Show the output window on the preferred monitor with a test pattern so the
/// operator can verify cable/signal routing before the service begins.
#[tauri::command]
pub async fn show_output_test_pattern(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("output") {
        position_output_on_preferred(app.clone(), &state)?;
        let _ = window.set_ignore_cursor_events(true);
        window.show().map_err(|e: tauri::Error| e.to_string())?;
        window.set_focus().map_err(|e: tauri::Error| e.to_string())?;
        emit_checked(&app, "monitor-test", &serde_json::json!({ "active": true }));
    }
    publish_output_visible(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn hide_output_test_pattern(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    emit_checked(&app, "monitor-test", &serde_json::json!({ "active": false }));
    if let Some(window) = app.get_webview_window("output") {
        window.hide().map_err(|e: tauri::Error| e.to_string())?;
    }
    publish_output_visible(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn toggle_stage_window(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("stage") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e: tauri::Error| e.to_string())?;
        } else {
            window.show().map_err(|e: tauri::Error| e.to_string())?;
            window.set_focus().map_err(|e: tauri::Error| e.to_string())?;

            let live = state.presentation.live_item.lock().clone();
            emit_checked(&app, "live-item-update", &LiveItemUpdate { detected_item: live });
            let staged = state.presentation.staged_item.lock().clone();
            emit_checked(&app, "item-staged", &staged);

            // Stage monitor also wants settings + lower-third so it can show a
            // countdown and a "lower-third is on air" indicator.
            let settings = state.presentation.settings.lock().clone();
            emit_checked(&app, "settings-changed", &settings);
            let lt = state.presentation.lower_third.lock().clone();
            emit_checked(&app, "lower-third-update", &lt);
        }
    }
    Ok(())
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
