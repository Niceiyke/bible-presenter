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
/// remote so `output.changed` mirrors the actual window state. With Phase C4 the
/// output/stage windows are engine-owned, so visibility comes from the
/// OutputManager's persisted runtime entry rather than a Tauri webview.
pub fn publish_output_visible(state: &AppState) {
    let visible = state
        .outputs
        .all_states()
        .into_iter()
        .find(|s| s.id == "output")
        .map(|s| s.visible)
        .unwrap_or(false);
    state.remote.hub.publish(
        RemoteEventKind::OutputChanged,
        json!({ "output_visible": visible }),
        None,
    );
}

/// Window style for a host window label. The projection window is borderless,
/// transparent and always-on-top; the stage confidence monitor is a normal
/// decorated window.
fn engine_window_style(label: &str) -> crate::engine::windows::WindowStyle {
    if label == "output" {
        crate::engine::windows::WindowStyle {
            decorations: false,
            transparent: true,
            always_on_top: true,
            resizable: false,
        }
    } else {
        crate::engine::windows::WindowStyle::default()
    }
}

/// Free plan: only one on-air window at a time. Window outputs are read from the
/// OutputManager (the engine owns the actual windows since Phase C4); the
/// still-Tauri auxiliary windows (`design`/`studio`) are read directly.
fn enforce_free_window_cap(app: &AppHandle, state: &AppState, this_label: &str) -> Result<(), String> {
    let info = state.license.status();
    if info.status == crate::license::LicenseStatus::Active
        && info.tier == crate::license::LicenseTier::Free
    {
        let output_visible = state
            .outputs
            .list()
            .iter()
            .find(|o| o.window_label.as_deref() == Some(this_label))
            .map(|o| o.visible)
            .unwrap_or(false);
        let other_window_output_visible = state
            .outputs
            .list()
            .iter()
            .filter(|o| o.window_label.is_some() && o.window_label.as_deref() != Some(this_label) && o.visible)
            .count()
            >= 1;
        let aux_window_visible = ["design", "studio"]
            .iter()
            .filter(|l| app.get_webview_window(l).and_then(|w| w.is_visible().ok()).unwrap_or(false))
            .count()
            >= 1;
        if output_visible || other_window_output_visible || aux_window_visible {
            return Err(
                "The Free plan supports one on-air window at a time. See Settings → License to upgrade."
                    .to_owned(),
            );
        }
    }
    Ok(())
}

/// Drives an engine-owned winit window (Phase C4): registers the output's
/// config, syncs the console's authoritative presentation, then shows/hides the
/// window. The engine is the ONLY projection path for output/stage now; a
/// missing/busy sidecar is an error that aborts before any state is persisted.
fn drive_engine_window(
    state: &AppState,
    cfg: &OutputConfig,
    label: &str,
    visible: bool,
) -> Result<(), String> {
    use crate::engine::ipc::EngineCommand;
    let client = state
        .engine
        .lock()
        .clone()
        .ok_or_else(|| "engine_unavailable: the video engine is not running. The output/stage windows cannot be shown without it.".to_owned())?;
    if !client.is_running() {
        return Err("engine_unavailable: the video engine is not running. The output/stage windows cannot be shown without it.".to_owned());
    }
    if visible {
        let _ = client.invoke(EngineCommand::OutputWindowSetConfig {
            label: label.to_owned(),
            config: Box::new(cfg.clone()),
        });
        crate::engine::sync_engine_presentation(state);
        let preferred = state.presentation.settings.lock().preferred_monitor.clone();
        client
            .invoke(EngineCommand::OutputWindowShow {
                label: label.to_owned(),
                style: engine_window_style(label),
                preferred_monitor: preferred,
                width: cfg.geometry.width,
                height: cfg.geometry.height,
            })
            .map_err(|e| format!("engine output window: {e}"))?;
    } else {
        client
            .invoke(EngineCommand::OutputWindowHide { label: label.to_owned() })
            .map_err(|e| format!("engine output window: {e}"))?;
    }
    Ok(())
}

/// THE single authoritative visibility path for window outputs (and the toggle
/// used by the header / keyboard shortcut / stage section / output manager).
///
/// Order matters: the engine's winit window is driven FIRST so a show/hide
/// failure is surfaced before any state is persisted, then the OutputManager
/// config + runtime are updated, and finally the authoritative config/state is
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
        if info.status == crate::license::LicenseStatus::Active
            && info.tier == crate::license::LicenseTier::Free
        {
            let other_window_visible = state
                .outputs
                .list()
                .iter()
                .filter(|o| o.window_label.is_some() && o.id != id && o.visible)
                .count()
                >= 1;
            if other_window_visible {
                return Err(
                    "The Free plan supports one on-air window at a time. See Settings → License to upgrade."
                        .to_owned(),
                );
            }
        }
    }

    // 1) Drive the engine window first. A failure here must NOT persist state,
    //    so disk, runtime, UI, and the actual window never diverge.
    if let Some(label) = &cfg.window_label {
        if visible {
            enforce_free_window_cap(app, state, label)?;
        }
        drive_engine_window(state, &cfg, label, visible)?;
    }

    // 2) Persist + mutate the in-memory config ONLY after the window op
    //    succeeded, so a failed operation never leaves disk/runtime/UI diverged.
    //    The manager re-derives the runtime entry (phase etc.) from the
    //    persisted config; windows go live/stopped with visibility, while
    //    recorders/streamers enter `starting`/`stopped` and the frontend
    //    adapter reports the real phase once the pipeline is actually up.
    if let Err(e) = state.outputs.set_visible(id, visible) {
        // Roll the engine window back to its prior visibility so a persistence
        // failure can never leave the actual window shown/hidden while disk and
        // runtime retain the previous state.
        if let Some(label) = &cfg.window_label {
            let _ = drive_engine_window(state, &cfg, label, !visible);
        }
        return Err(e);
    }
    publish_configs(app);
    if let Some(s) = state.outputs.state(id) {
        publish_state(app, &s);
    }
    publish_output_visible(state);
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
        manager.outputs.set_state(state);
    }
    publish_state(app, state);
}

/// Recorder/streamer runtime adapters push lifecycle transitions here — the
/// OutputManager merges the state into its runtime map and broadcasts it to
/// every window. This is the authoritative path for a surface's phase
/// (`starting`/`live`/`stopping`/`failed`/`stopped`); the persisted `visible`
/// flag is flipped separately through `outputs_set_visible`.
#[tauri::command]
pub async fn report_output_state_cmd(
    app: AppHandle,
    state: OutputState,
) -> Result<(), String> {
    report_output_state(&app, &state);
    Ok(())
}