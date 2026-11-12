use crate::events::emit_checked;
use crate::outputs::{OutputConfig, OutputState};
use crate::remote::protocol::RemoteEventKind;
use crate::state::AppState;
use serde::Serialize;
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
/// remote so `output.changed` mirrors the actual window state. Output
/// visibility now also determines the recorder/streamer's capture source, so
/// the capture-active signal is republished here too.
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
    publish_capture_active(app, state);
}

/// Broadcasts whether the `capture` window is the live WGC source for a
/// recording/streaming session, so every remote can open (or close) its
/// "capture" WebRTC peer. Called whenever a recording/broadcast starts or stops
/// AND whenever the projector window toggles, because a live session fronts the
/// real `output` window when it is visible and only the fallback `capture`
/// window while it is off.
pub fn publish_capture_active(app: &AppHandle, state: &AppState) {
    let active = (state.recording.lock().is_some() || state.streaming.lock().is_some())
        && !crate::commands::capture::output_window_visible(app);
    state.remote.hub.publish(
        RemoteEventKind::CaptureChanged,
        json!({ "capture_active": active }),
        None,
    );
}

/// Position the output window on the operator's preferred monitor (used when a
/// multi-monitor layout is detected).
fn position_window_on_assigned_monitor(
    app: &AppHandle,
    state: &AppState,
    cfg: &OutputConfig,
    label: &str,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(label) {
        let configured = cfg.monitor_name.clone();
        let preferred = configured.or_else(|| {
            (label == "output")
                .then(|| state.presentation.settings.lock().preferred_monitor.clone())
                .flatten()
        });
        let monitors = window
            .available_monitors()
            .map_err(|e: tauri::Error| e.to_string())?;
        if monitors.len() > 1 {
            if let Some(primary) = window
                .primary_monitor()
                .map_err(|e: tauri::Error| e.to_string())?
            {
                // Never place a newly opened auxiliary program over another
                // visible output unless every secondary display is already in
                // use. An explicit `monitor_name` always wins.
                let occupied: std::collections::HashSet<String> = state
                    .outputs
                    .list()
                    .into_iter()
                    .filter(|output| {
                        output.visible && output.window_label.as_deref() != Some(label)
                    })
                    .filter_map(|output| output.window_label)
                    .filter_map(|other_label| app.get_webview_window(&other_label))
                    .filter_map(|other| other.current_monitor().ok().flatten())
                    .filter_map(|monitor| monitor.name().map(ToOwned::to_owned))
                    .collect();
                let target = preferred
                    .as_deref()
                    .and_then(|name| {
                        monitors
                            .iter()
                            .find(|m| m.name().is_some_and(|monitor_name| monitor_name == name))
                    })
                    .or_else(|| {
                        monitors.iter().find(|m| {
                            m.name() != primary.name()
                                && !m.name().is_some_and(|name| occupied.contains(name))
                        })
                    })
                    .or_else(|| monitors.iter().find(|m| m.name() != primary.name()));
                if let Some(mon) = target {
                    let pos = mon.position();
                    window
                        .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                            x: pos.x,
                            y: pos.y,
                        }))
                        .map_err(|e: tauri::Error| e.to_string())?;
                    window
                        .set_fullscreen(true)
                        .map_err(|e: tauri::Error| e.to_string())?;
                }
            }
        } else if label == "output" {
            // The secondary projector disappeared. Bring the primary program
            // back onto the remaining display instead of leaving it at
            // off-screen coordinates.
            if let Some(primary) = window
                .primary_monitor()
                .map_err(|e: tauri::Error| e.to_string())?
            {
                let pos = primary.position();
                window
                    .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                        x: pos.x,
                        y: pos.y,
                    }))
                    .map_err(|e: tauri::Error| e.to_string())?;
                window
                    .set_fullscreen(true)
                    .map_err(|e: tauri::Error| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Enforce the signed on-air-window capacity before revealing an output.
fn enforce_window_cap(app: &AppHandle, state: &AppState, this_label: &str) -> Result<(), String> {
    let info = state.license.status();
    if info.status == crate::license::LicenseStatus::Active {
        let other_visible = ["output", "overflow", "stage", "design", "studio"]
            .iter()
            .filter(|l| **l != this_label)
            .filter(|l| {
                app.get_webview_window(l)
                    .and_then(|w| w.is_visible().ok())
                    .unwrap_or(false)
            })
            .count();
        if other_visible >= info.limits.max_outputs as usize {
            return Err(
                format!(
                    "Your Wordlyte plan supports {} on-air window(s) at a time. Ask your organization owner to upgrade for more.",
                    info.limits.max_outputs
                ),
            );
        }
    }
    Ok(())
}

/// Re-broadcast authoritative presentation state so a freshly-revealed window
/// can hydrate even if it missed events while hidden. Also used by the
/// recorder/streamer on start so the off-screen `capture` window converges to
/// the current program even if it missed an earlier broadcast.
pub(crate) fn rebroadcast_presentation(app: &AppHandle, state: &AppState) {
    let settings = state.presentation.settings.lock().clone();
    emit_checked(app, "settings-changed", &settings);
    let live = state.presentation.live_item.lock().clone();
    emit_checked(
        app,
        "live-item-update",
        &crate::events::LiveItemUpdate {
            detected_item: live,
            revision: Some(state.presentation.current_revision()),
        },
    );
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
pub fn set_output_visible(
    app: &AppHandle,
    state: &AppState,
    id: &str,
    visible: bool,
) -> Result<(), String> {
    // Revealing a window/recorder/streamer is a broadcast action; hiding is
    // always allowed so an operator can always take content off-air.
    if visible {
        crate::license::ensure_allowed(state)?;
    }
    let cfg = state
        .outputs
        .get(id)
        .ok_or_else(|| format!("Output '{}' not found", id))?;

    // A secondary program surface is a Pro production capability, even when
    // the primary projector is currently hidden and the signed Free output
    // capacity would otherwise leave a slot available.
    if visible && cfg.program_bus != crate::output_buses::PRIMARY_BUS_ID {
        crate::license::ensure_active_tier(state, crate::license::LicenseTier::Pro)?;
    }

    // Signed entitlement limits on-air window capacity (recorders/streamers
    // have separate backend gates).
    if visible && cfg.window_label.is_some() {
        let info = state.license.status();
        if info.status == crate::license::LicenseStatus::Active {
            let visible_windows = state
                .outputs
                .list()
                .iter()
                .filter(|o| o.window_label.is_some() && o.id != id && o.visible)
                .count();
            if visible_windows >= info.limits.max_outputs as usize {
                return Err(
                    format!(
                        "Your Wordlyte plan supports {} on-air window(s) at a time. Ask your organization owner to upgrade for more.",
                        info.limits.max_outputs
                    ),
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
            enforce_window_cap(app, state, label)?;
            position_window_on_assigned_monitor(app, state, &cfg, label)?;
            let _ = window.set_ignore_cursor_events(true);
            window.show().map_err(|e: tauri::Error| e.to_string())?;
            window
                .set_focus()
                .map_err(|e: tauri::Error| e.to_string())?;
            rebroadcast_presentation(app, state);
            // A live session should capture the real projector window now that
            // it is present. This must NOT fail the toggle (the session keeps
            // recording/streaming from the capture window), so log-then-continue.
            if label == "output" {
                let source = crate::commands::capture::output_window_visible(app);
                if let Err(e) = crate::commands::capture::sync_capture_sources(app, state, source) {
                    crate::store::log_msg(
                        app,
                        &format!("Capture source could not follow the projector: {e}"),
                    );
                }
            }
        } else {
            // Moving the projector OFF screen mid-session: the live session's
            // capture source MUST move to the dedicated `capture` window BEFORE
            // the projector hides, otherwise WGC freezes on a hidden window (the
            // recording/stream would stall on the last frame). Refuse the hide
            // if the swap fails so the session never loses its source.
            if label == "output" {
                crate::commands::capture::sync_capture_sources(app, state, false)?;
            }
            window.hide().map_err(|e: tauri::Error| e.to_string())?;
        }
    }

    // 2) Persist + mutate the in-memory config ONLY after the window op
    //    succeeded, so a failed operation never leaves disk/runtime/UI diverged.
    state.outputs.set_visible(id, visible)?;
    state
        .outputs
        .update_state(id, visible, cfg.enabled, 0, None);
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

/// Re-evaluate physical monitor placement for every visible window output.
/// Called after a display is added/removed or the preferred monitor changes so
/// the operator does not need to restart Wordlyte or hide/show the projector.
pub fn reposition_visible_outputs(app: &AppHandle, state: &AppState) {
    for cfg in state.outputs.list() {
        if !cfg.visible {
            continue;
        }
        let Some(label) = cfg.window_label.as_deref() else {
            continue;
        };
        if let Err(error) = position_window_on_assigned_monitor(app, state, &cfg, label) {
            crate::store::log_msg(
                app,
                &format!("Could not reposition output '{label}' after a monitor change: {error}"),
            );
        }
    }
}

#[tauri::command]
pub async fn outputs_reposition(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    reposition_visible_outputs(&app, state.inner());
    Ok(())
}

/// Lists logical presentation buses available for output targeting. The caller
/// cannot invent a bus id: it must be backed by a configured window output.
#[tauri::command]
pub async fn output_buses_list(
    state: State<'_, AppState>,
) -> Result<Vec<crate::output_buses::OutputBusInfo>, String> {
    Ok(state.output_buses.list())
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
    state.output_buses.sync(
        &state.outputs.list(),
        &state.presentation.settings.lock().clone(),
    );
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputMonitorInfo {
    pub name: String,
    pub primary: bool,
    pub width: u32,
    pub height: u32,
}

/// Enumerate physical displays for the per-output monitor assignment control.
#[tauri::command]
pub async fn outputs_monitors(app: AppHandle) -> Result<Vec<OutputMonitorInfo>, String> {
    let window = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("output"))
        .ok_or_else(|| "No application window is available to enumerate monitors.".to_string())?;
    let primary_name = window
        .primary_monitor()
        .map_err(|e: tauri::Error| e.to_string())?
        .and_then(|monitor| monitor.name().map(ToOwned::to_owned));
    Ok(window
        .available_monitors()
        .map_err(|e: tauri::Error| e.to_string())?
        .into_iter()
        .map(|monitor| {
            let size = monitor.size();
            let name = monitor
                .name()
                .cloned()
                .unwrap_or_else(|| "Unnamed display".to_string());
            OutputMonitorInfo {
                primary: primary_name.as_deref() == Some(name.as_str()),
                name,
                width: size.width,
                height: size.height,
            }
        })
        .collect::<Vec<_>>())
}

/// Internal helper for recorder/streamer surfaces to report runtime changes.
pub fn report_output_state(app: &AppHandle, state: &OutputState) {
    if let Some(manager) = app.try_state::<AppState>() {
        manager.outputs.update_state(
            &state.id,
            state.visible,
            state.rendering,
            state.fps,
            state.error.clone(),
        );
    }
    publish_state(app, state);
}
