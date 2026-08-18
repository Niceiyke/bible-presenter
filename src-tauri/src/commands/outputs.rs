use crate::events::emit_checked;
use crate::outputs::{OutputConfig, OutputState};
use crate::remote::protocol::RemoteEventKind;
use crate::state::AppState;
use serde_json::json;
use tauri::{AppHandle, Manager, State};

/// Emits the full output config list to every window (replace-all semantics).
pub fn publish_configs(app: &AppHandle) {
    let configs = app.state::<AppState>().outputs.list();
    emit_checked(app, "output-config-changed", &configs);
}

/// Emits one output's runtime state.
pub fn publish_state(app: &AppHandle, state: &OutputState) {
    emit_checked(app, "output-state-changed", state);
}

/// Broadcasts the current output-window visibility state to every connected
/// remote so `output.changed` mirrors the actual window state.
pub fn publish_output_visible(app: &AppHandle, state: &AppState) {
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

/// Position the output window on the operator's preferred monitor (used when a
/// multi-monitor layout is detected).
fn position_output_on_preferred(app: &AppHandle, state: &AppState) -> Result<(), String> {
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

/// Free plan: only one on-air window at a time. Called before revealing.
fn enforce_free_window_cap(app: &AppHandle, state: &AppState, this_label: &str) -> Result<(), String> {
    let info = state.license.status();
    if info.status == crate::license::LicenseStatus::Active
        && info.tier == crate::license::LicenseTier::Free
    {
        let other_visible = ["output", "stage", "design", "studio"]
            .iter()
            .filter(|l| **l != this_label)
            .filter(|l| {
                app.get_webview_window(l)
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false)
            })
            .count();
        if other_visible >= 1 {
            return Err(
                "The Free plan supports one on-air window at a time. See Settings → License to upgrade."
                    .to_owned(),
            );
        }
    }
    Ok(())
}

/// Re-broadcast authoritative presentation state so a freshly-revealed window
/// can hydrate even if it missed events while hidden.
fn rebroadcast_presentation(app: &AppHandle, state: &AppState) {
    let settings = state.presentation.settings.lock().clone();
    emit_checked(app, "settings-changed", &settings);
    let live = state.presentation.live_item.lock().clone();
    emit_checked(app, "live-item-update", &crate::events::LiveItemUpdate {
        detected_item: live,
        revision: Some(state.presentation.current_revision()),
    });
    let lt = state.presentation.lower_third.lock().clone();
    emit_checked(app, "lower-third-update", &lt);
    let props = state.presentation.props_layer.lock().clone();
    emit_checked(app, "props-update", &props);
    let staged = state.presentation.staged_item.lock().clone();
    emit_checked(app, "item-staged", &staged);
}

/// THE single authoritative visibility path for window outputs (and the toggle
/// used by the header / keyboard shortcut / stage section / output manager).
///
/// Order matters: the bound window is toggled FIRST so a show/focus failure is
/// surfaced before any state is persisted, then the OutputManager config +
/// runtime are updated, and finally the authoritative config/state is
/// broadcast. This guarantees the UI, the runtime `OutputState`, the persisted
/// `outputs.json`, and the actual window can never disagree.
pub fn set_output_visible(app: &AppHandle, state: &AppState, id: &str, visible: bool) -> Result<(), String> {
    // Revealing a window/recorder/streamer is a broadcast action; hiding is
    // always allowed so an operator can always take content off-air.
    if visible {
        crate::license::ensure_allowed(state)?;
    }
    let cfg = state.outputs.get(id).ok_or_else(|| format!("Output '{}' not found", id))?;

    // Free plan: one on-air *window* output at a time (recorders/streamers are
    // software surfaces and are gated in the frontend).
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

    // 1) Toggle the bound window first. A failure here must NOT persist state.
    if let Some(label) = &cfg.window_label {
        let window = app
            .get_webview_window(label)
            .ok_or_else(|| format!("No window bound to output '{}'", id))?;
        if visible {
            enforce_free_window_cap(app, state, label)?;
            if label == "output" {
                position_output_on_preferred(app, state)?;
            }
            let _ = window.set_ignore_cursor_events(true);
            window.show().map_err(|e: tauri::Error| e.to_string())?;
            window.set_focus().map_err(|e: tauri::Error| e.to_string())?;
            rebroadcast_presentation(app, state);
        } else {
            window.hide().map_err(|e: tauri::Error| e.to_string())?;
        }
    }

    // 2) Persist + mutate the in-memory config ONLY after the window op
    //    succeeded, so a failed operation never leaves disk/runtime/UI diverged.
    state.outputs.set_visible(id, visible)?;
    state.outputs.update_state(id, visible, cfg.enabled, 0, None);
    publish_configs(app);
    if let Some(s) = state.outputs.state(id) {
        publish_state(app, &s);
    }
    publish_output_visible(app, state);
    Ok(())
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
/// Window outputs go through the single authoritative `set_output_visible`
/// path so UI, runtime, persisted config, and the actual window stay in sync.
#[tauri::command]
pub async fn outputs_set_visible(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    visible: bool,
) -> Result<(), String> {
    set_output_visible(&app, state.inner(), &id, visible)
}

/// Internal helper for recorder/streamer surfaces to report runtime changes.
pub fn report_output_state(app: &AppHandle, state: &OutputState) {
    if let Some(manager) = app.try_state::<AppState>() {
        manager.outputs.update_state(&state.id, state.visible, state.rendering, state.fps, state.error.clone());
    }
    publish_state(app, state);
}