use crate::events::emit_checked;
use crate::outputs::{OutputConfig, OutputState};
use crate::state::AppState;
use tauri::{AppHandle, Manager, State};

/// Emits the full output config list to every window (replace-all semantics).
fn publish_configs(app: &AppHandle) {
    let configs = app.state::<AppState>().outputs.list();
    emit_checked(app, "output-config-changed", &configs);
}

/// Emits one output's runtime state.
fn publish_state(app: &AppHandle, state: &OutputState) {
    emit_checked(app, "output-state-changed", state);
}

#[tauri::command]
pub async fn outputs_list(state: State<'_, AppState>) -> Result<Vec<OutputConfig>, String> {
    Ok(state.outputs.list())
}

#[tauri::command]
pub async fn outputs_states(state: State<'_, AppState>) -> Result<Vec<OutputState>, String> {
    Ok(state.outputs.all_states())
}

/// Replace-all config update (idempotent, like `save_lt_templates`). Persists
/// and broadcasts the authoritative list to all windows.
#[tauri::command]
pub async fn outputs_update(
    app: AppHandle,
    state: State<'_, AppState>,
    configs: Vec<OutputConfig>,
) -> Result<(), String> {
    state.outputs.set_configs(configs)?;
    publish_configs(&app);
    for s in state.outputs.all_states() {
        publish_state(&app, &s);
    }
    Ok(())
}

/// Show/hide a window output, or mark a recorder/streamer visible (active).
#[tauri::command]
pub async fn outputs_set_visible(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    visible: bool,
) -> Result<(), String> {
    // Revealing a window/recorder/streamer is a broadcast action; hiding is
    // always allowed so an operator can always take content off-air.
    if visible {
        crate::license::ensure_allowed(&state)?;
    }
    let cfg = state.outputs.get(&id).ok_or_else(|| format!("Output '{}' not found", id))?;

    // Free plan: only one on-air *window* output at a time. Recorders and
    // streamers are software surfaces and are gated in the frontend.
    if visible && cfg.window_label.is_some() {
        let info = state.license.status();
        if info.tier == crate::license::LicenseTier::Free {
            let visible_windows = state
                .outputs
                .list()
                .iter()
                .filter(|o| o.window_label.is_some() && o.id != id && o.visible)
                .count();
            if visible_windows >= 1 {
                return Err(
                    "The Free plan supports one on-air window at a time. See Settings → License to upgrade."
                        .to_owned(),
                );
            }
        }
    }
    state.outputs.set_visible(&id, visible)?;

    // Window outputs toggle their bound Tauri window.
    if let Some(label) = &cfg.window_label {
        if let Some(window) = app.get_webview_window(label) {
            if visible {
                window.show().map_err(|e: tauri::Error| e.to_string())?;
                window.set_focus().map_err(|e: tauri::Error| e.to_string())?;
                // Re-broadcast authoritative state so a freshly-revealed
                // window can hydrate even if it missed events while hidden.
                let s = &state;
                let settings = s.presentation.settings.lock().clone();
                emit_checked(&app, "settings-changed", &settings);
                let live = s.presentation.live_item.lock().clone();
                emit_checked(&app, "live-item-update", &crate::events::LiveItemUpdate {
                    detected_item: live,
                    revision: Some(s.presentation.current_revision()),
                });
                let lt = s.presentation.lower_third.lock().clone();
                emit_checked(&app, "lower-third-update", &lt);
                let props = s.presentation.props_layer.lock().clone();
                emit_checked(&app, "props-update", &props);
                let staged = s.presentation.staged_item.lock().clone();
                emit_checked(&app, "item-staged", &staged);
            } else {
                window.hide().map_err(|e: tauri::Error| e.to_string())?;
            }
        }
    }

    state.outputs.update_state(&id, visible, cfg.enabled, 0, None);
    publish_configs(&app);
    if let Some(s) = state.outputs.state(&id) {
        publish_state(&app, &s);
    }
    Ok(())
}

/// Internal helper for recorder/streamer surfaces to report runtime changes.
pub fn report_output_state(app: &AppHandle, state: &OutputState) {
    if let Some(manager) = app.try_state::<AppState>() {
        manager.outputs.update_state(&state.id, state.visible, state.rendering, state.fps, state.error.clone());
    }
    publish_state(app, state);
}