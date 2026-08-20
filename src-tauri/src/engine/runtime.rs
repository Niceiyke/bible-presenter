//! Standalone engine runtime (Phase A2).
//!
//! [`EngineRuntime`] is the host for the broadcast engine in the sidecar
//! process. It implements [`EngineBackend`] exactly like `AppState` does in the
//! Tauri shell — owning the authoritative `PresentationState` plus the
//! persistence and (relayed) remote-sink side effects — so the exact same
//! `Engine::op_*` methods run in both hosts.
//!
//! The runtime's emit sink converts the engine's Tauri-style window events into
//! [`EngineEventFrame`]s buffered on the runtime; [`dispatch`] drains them after
//! each command so the console can replay them in order alongside the response.
//!
//! Persistence note (Phase A2 skeleton): the runtime uses an in-memory
//! `MediaScheduleStore` so the sidecar never touches the console's SQLite data
//! DB during migration. Settings/props/scene writes survive for the process
//! lifetime only; disk handoff is a Phase A follow-up.

use crate::engine::backend::EngineBackend;
use crate::engine::compositor::{resolve_program_frame, ProgramFrameInput, ResolverSnapshot};
use crate::engine::ipc::{EngineCommand, EngineEvent, EngineEventFrame, EngineResponse};
use crate::engine::presentation::Engine;
use crate::engine::transport::TransportManager;
use crate::engine::windows::{SharedFrame, WindowCommand, WindowHostHandle};
use crate::remote::protocol::RemoteEventKind;
use crate::state::PresentationState;
use crate::store::{self, MediaScheduleStore};
use base64::Engine as _;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The sidecar's engine host. Holds the authoritative presentation state, an
/// in-memory persistence store, and the buffer of events emitted since the last
/// drain (drained by [`dispatch`]).
pub struct EngineRuntime {
    pub presentation: PresentationState,
    store: MediaScheduleStore,
    app_data_dir: PathBuf,
    pending_events: Arc<Mutex<Vec<EngineEventFrame>>>,
    /// The engine-owned winit window host (Phase C). `None` in headless/unit
    /// contexts; window commands reply with an error when it is absent.
    windows: Option<WindowHostHandle>,
    /// Registered window output configs keyed by host window label, used to
    /// resolve each window's program frame after presentation mutations.
    window_configs: Mutex<HashMap<String, crate::outputs::OutputConfig>>,
    /// The shared encode → fan-out → mux transport pipeline (Phase D): one
    /// ffmpeg encoder feeding every RTMP/recording session.
    pub transport: TransportManager,
}

impl EngineRuntime {
    /// Creates the runtime. `app_data_dir` is used for prop-path validation and
    /// any future disk persistence; the store itself is in-memory during Phase
    /// A2 (see module docs). No window host is spawned.
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        Self::with_windows_and_pending(app_data_dir, None, Arc::new(Mutex::new(Vec::new())))
    }

    /// Creates the runtime and spawns the engine-owned winit window host (the
    /// sidecar process path). The host thread idles until a window command
    /// arrives; it is joined on drop. The preview sink it pushes frames through
    /// feeds the same event buffer `dispatch` drains, so `PreviewFrame` events
    /// ride along with the next reply the console polls.
    pub fn new_with_windows(app_data_dir: PathBuf) -> Result<Self, String> {
        let pending = Arc::new(Mutex::new(Vec::<EngineEventFrame>::new()));
        let preview_sink = preview_sink(Arc::clone(&pending));
        let windows = crate::engine::windows::spawn(app_data_dir.clone(), preview_sink)
            .map(Some)
            .map_err(|e| format!("could not start window host: {e}"))?;
        Self::with_windows_and_pending(app_data_dir, windows, pending)
    }

    fn with_windows_and_pending(
        app_data_dir: PathBuf,
        windows: Option<WindowHostHandle>,
        pending_events: Arc<Mutex<Vec<EngineEventFrame>>>,
    ) -> Result<Self, String> {
        let store = MediaScheduleStore::in_memory(app_data_dir.clone()).map_err(|e| e.to_string())?;
        let initial_settings = store.load_settings().unwrap_or_default();
        Ok(Self {
            presentation: PresentationState::new(initial_settings),
            store,
            app_data_dir: app_data_dir.clone(),
            pending_events,
            windows,
            window_configs: Mutex::new(HashMap::new()),
            transport: TransportManager::new(app_data_dir),
        })
    }

    /// The current presentation revision (for `Ping`/read-only responses).
    pub fn revision(&self) -> u64 {
        self.presentation.current_revision()
    }

    /// Adopts a console-provided `PresentationSnapshot` wholesale (Phase C4).
    /// The engine's own presentation store starts empty and only tracks the
    /// mutations it performs, so the console — which owns the authoritative
    /// `AppState` during Phase C — pushes its snapshot after every presentation
    /// event and whenever a window is revealed. Validates `schema_version` and
    /// adopts the revision verbatim so both hosts agree on event ordering.
    pub fn apply_sync(&self, snapshot: crate::engine::presentation::PresentationSnapshot) -> Result<(), String> {
        use std::sync::atomic::Ordering;
        if snapshot.schema_version != crate::engine::presentation::PRESENTATION_SCHEMA_VERSION {
            return Err(format!(
                "presentation schema mismatch: console is v{}, engine is v{}",
                snapshot.schema_version,
                crate::engine::presentation::PRESENTATION_SCHEMA_VERSION
            ));
        }
        let p = &self.presentation;
        *p.live_item.lock() = snapshot.live;
        *p.previous_item.lock() = snapshot.previous;
        *p.staged_item.lock() = snapshot.staged;
        *p.settings.lock() = snapshot.settings;
        *p.lower_third.lock() = snapshot.lower_third;
        *p.props_layer.lock() = snapshot.props;
        *p.last_updated.lock() = snapshot.updated_at;
        p.revision.store(snapshot.revision, Ordering::SeqCst);
        Ok(())
    }

    /// Translates the engine's Tauri-style window event into an `EngineEvent`
    /// frame, or returns `None` for events that are not part of the IPC surface.
    fn translate_event(name: &str, payload: Value) -> Option<EngineEventFrame> {
        let frame = match name {
            "live-item-update" => EngineEvent::LiveItemUpdate {
                detected_item: payload.get("detected_item").cloned().and_then(|v| serde_json::from_value(v).ok()),
                revision: payload.get("revision").and_then(|v| v.as_u64()).unwrap_or(0),
            },
            "item-staged" => EngineEvent::ItemStaged {
                item: payload.get("item").cloned().and_then(|v| {
                    if v.is_null() {
                        None
                    } else {
                        serde_json::from_value(v).ok()
                    }
                }),
                revision: payload.get("revision").and_then(|v| v.as_u64()).unwrap_or(0),
            },
            "settings-changed" => EngineEvent::SettingsChanged {
                settings: serde_json::from_value(payload.get("settings")?.clone()).ok()?,
                revision: payload.get("revision").and_then(|v| v.as_u64()).unwrap_or(0),
            },
            "lower-third-update" => EngineEvent::LowerThirdUpdate {
                lower_third: payload.get("lower_third").cloned().filter(|v| !v.is_null()),
                revision: payload.get("revision").and_then(|v| v.as_u64()).unwrap_or(0),
            },
            "props-update" => EngineEvent::PropsUpdate {
                props: serde_json::from_value(payload.get("props")?.clone()).ok()?,
                revision: payload.get("revision").and_then(|v| v.as_u64()).unwrap_or(0),
            },
            _ => return None,
        };
        Some(EngineEventFrame { event: frame })
    }

    /// Builds the emit sink for a single dispatch. Converts window events to
    /// `EngineEventFrame`s and buffers them; non-presentation events are
    /// dropped (they are not part of the Phase A2 IPC surface).
    fn emit_sink(&self) -> impl Fn(&str, Value) + '_ {
        let pending = Arc::clone(&self.pending_events);
        move |name, payload| {
            if let Some(frame) = Self::translate_event(name, payload) {
                pending.lock().push(frame);
            }
        }
    }

    /// Drains and returns every event buffered since the last drain.
    fn drain_events(&self) -> Vec<EngineEventFrame> {
        std::mem::take(&mut *self.pending_events.lock())
    }

    /// Builds the resolver snapshot from the current presentation state.
    fn resolver_snapshot(&self) -> ResolverSnapshot {
        let lower_third = self
            .presentation
            .lower_third
            .lock()
            .clone()
            .and_then(|v| serde_json::from_value::<crate::engine::compositor::LowerThirdPayload>(v).ok());
        ResolverSnapshot {
            live: self.presentation.live_item.lock().clone(),
            staged: self.presentation.staged_item.lock().clone(),
            settings: self.presentation.settings.lock().clone(),
            props: self.presentation.props_layer.lock().clone(),
            lower_third,
            revision: self.presentation.current_revision(),
        }
    }

    /// Resolves the current program frame for every registered window config.
    /// Pure and testable: returns `(host label, shared frame)` pairs without
    /// touching the window host.
    fn resolve_window_frames(&self) -> Vec<(String, SharedFrame)> {
        let snapshot = self.resolver_snapshot();
        let revision = snapshot.revision;
        let scenes = self.store.list_scenes().ok();
        self.window_configs
            .lock()
            .iter()
            .map(|(label, config)| {
                let input = ProgramFrameInput {
                    config: config.clone(),
                    snapshot: snapshot.clone(),
                    scenes: scenes.clone(),
                    colors: None,
                    timestamp: None,
                    fps: None,
                };
                let frame = resolve_program_frame(input);
                (label.clone(), SharedFrame { revision, frame: Arc::new(frame) })
            })
            .collect()
    }

    /// Publishes the current program frame for every registered window to the
    /// window host so the winit windows re-render. No-op without a host.
    fn publish_window_frames(&self) {
        if let Some(host) = &self.windows {
            for (label, frame) in self.resolve_window_frames() {
                host.publish_frame(&label, frame);
            }
        }
    }

    /// Pushes the current resolver snapshot + scenes to the transport manager
    /// so its capture thread renders the live program (Phase D). Called after
    /// every presentation mutation and state adoption.
    fn sync_transport_state(&self) {
        let snapshot = self.resolver_snapshot();
        let scenes = self.store.list_scenes().ok();
        self.transport.sync_state(snapshot, scenes);
    }

    /// The window host, if present (for window-control dispatch).
    fn window_host(&self) -> Option<&WindowHostHandle> {
        self.windows.as_ref()
    }
}

impl EngineBackend for EngineRuntime {
    fn presentation(&self) -> &PresentationState {
        &self.presentation
    }

    fn app_data_dir(&self) -> &Path {
        &self.app_data_dir
    }

    fn load_settings(&self) -> Result<store::PresentationSettings, String> {
        self.store.load_settings().map_err(|e| e.to_string())
    }

    fn save_settings(&self, settings: &store::PresentationSettings) -> Result<(), String> {
        self.store.save_settings(settings).map_err(|e| e.to_string())
    }

    fn save_props(&self, props: &[store::PropItem]) -> Result<(), String> {
        self.store.save_props(props).map_err(|e| e.to_string())
    }

    fn load_props(&self) -> Result<Vec<store::PropItem>, String> {
        self.store.load_props().map_err(|e| e.to_string())
    }

    fn list_scenes(&self) -> Result<Vec<store::Scene>, String> {
        self.store.list_scenes().map_err(|e| e.to_string())
    }

    fn publish_remote(&self, _kind: RemoteEventKind, _payload: Value, _source: Option<String>) {
        // The standalone engine has no remote hub; the console relays remote
        // commands into engine commands and owns hub publication. The remote
        // events are intentionally dropped here (Phase A2).
    }
}

/// Builds the window-host preview sink: wraps each pushed (JPEG) preview frame
/// as a base64 `EngineEvent::PreviewFrame` buffered into `pending`, so previews
/// drain with the next dispatched command's reply.
fn preview_sink(pending: Arc<Mutex<Vec<EngineEventFrame>>>) -> crate::engine::windows::PreviewSink {
    Arc::new(move |output_id, frame_index, width, height, jpeg| {
        pending.lock().push(EngineEventFrame {
            event: EngineEvent::PreviewFrame {
                output_id,
                frame_index,
                width,
                height,
                image_base64: base64::engine::general_purpose::STANDARD.encode(jpeg),
            },
        });
    })
}

/// Dispatches one engine command and returns the response plus every event the
/// mutation emitted (drained in order, so the console can replay them safely).
///
/// Mirrors the desktop adapters in `commands/display.rs` etc. — each command
/// maps to the same single-lock, single-revision `Engine::op_*` method, so a
/// staged item, a failed clear, or a props failure behaves identically whether
/// it crosses the Tauri boundary or the stdio boundary.
pub fn dispatch(runtime: &EngineRuntime, id: u64, command: EngineCommand) -> (EngineResponse, Vec<EngineEventFrame>) {
    let sink = runtime.emit_sink();
    let engine = Engine { state: runtime, emit: &sink };

    let response = dispatch_command(&engine, runtime, id, command);

    // After a successful mutation, republish the window program frames so the
    // engine's winit windows re-render the updated program, and push the same
    // state to the transport capture thread. No-ops when no windows/transports
    // are active.
    if response.ok {
        runtime.publish_window_frames();
        runtime.sync_transport_state();
    }

    // Drain events AFTER computing the response so the console applies the
    // mutation's events before/with the revision the response reports.
    let events = runtime.drain_events();
    (response, events)
}

fn dispatch_command<B: EngineBackend>(
    engine: &Engine<'_, B>,
    runtime: &EngineRuntime,
    id: u64,
    command: EngineCommand,
) -> EngineResponse {
    let revision = || runtime.revision();
    let ok = |id: u64, rev: u64| EngineResponse::ok(id, rev);
    let ok_with = |id: u64, rev: u64, result: Value| EngineResponse::ok_with(id, rev, result);
    let err = |id: u64, rev: u64, code: &str, msg: &str| EngineResponse::err(id, rev, code, msg);

    // Helper: run a fallible op, mapping its error string to a response.
    macro_rules! run {
        ($expr:expr) => {
            match $expr {
                Ok(result) => result,
                Err(e) => return err(id, revision(), "engine_error", &e),
            }
        };
    }

    match command {
        EngineCommand::Ping => {
            let result = json!({
                "ok": true,
                "version": "wordlyte-engine",
                "capabilities": crate::engine::ipc::ENGINE_CAPABILITIES,
            });
            ok_with(id, revision(), result)
        }
        EngineCommand::Shutdown => ok(id, revision()),
        EngineCommand::PresentationSnapshot => {
            let snap = crate::engine::snapshot(runtime);
            ok_with(id, revision(), serde_json::to_value(&snap).unwrap_or_else(|_| json!({})))
        }
        EngineCommand::StageItem { item, source } => {
            run!(engine.op_stage(*item, source, 0));
            ok(id, revision())
        }
        EngineCommand::CommitStaged { source } => {
            run!(engine.op_commit_staged(source));
            ok(id, revision())
        }
        EngineCommand::GoLive { source } => {
            run!(engine.op_commit_staged(source));
            ok(id, revision())
        }
        EngineCommand::SendLiveItem { item, source } => {
            let r = run!(engine.op_send_live(*item, source));
            ok_with(id, revision(), json!({ "committed": r.committed }))
        }
        EngineCommand::GoLiveItem { item, source } => {
            run!(engine.op_go_live_item(*item, source));
            ok(id, revision())
        }
        EngineCommand::ClearLive { source } => {
            run!(engine.op_clear_live(source));
            ok(id, revision())
        }
        EngineCommand::ClearStaged { source } => {
            run!(engine.op_clear_staged(source));
            ok(id, revision())
        }
        EngineCommand::ClearAll { source } => {
            run!(engine.op_clear_all(source));
            ok(id, revision())
        }
        EngineCommand::UpdateTimer { started_at } => {
            run!(engine.op_update_timer(started_at));
            ok(id, revision())
        }
        EngineCommand::SaveSettings { settings } => {
            run!(engine.op_save_settings(*settings));
            ok(id, revision())
        }
        EngineCommand::SetBlackout { on, source } => {
            run!(engine.op_set_blackout(on, source));
            ok(id, revision())
        }
        EngineCommand::SetLogo { on, source } => {
            run!(engine.op_set_logo(on, source));
            ok(id, revision())
        }
        EngineCommand::ShowLowerThird { data, template, source } => {
            run!(engine.op_show_lower_third(data, template, source));
            ok(id, revision())
        }
        EngineCommand::HideLowerThird { source } => {
            run!(engine.op_hide_lower_third(source));
            ok(id, revision())
        }
        EngineCommand::SetProps { props } => {
            run!(engine.op_set_props(props));
            ok(id, revision())
        }
        EngineCommand::GetProps => {
            let props = run!(crate::engine::op_get_props(runtime));
            ok_with(id, revision(), json!({ "props": props }))
        }
        EngineCommand::ApplyScene { id: scene_id } => {
            run!(engine.op_apply_scene(scene_id));
            ok(id, revision())
        }
        EngineCommand::GetCurrentItem => {
            let item = runtime.presentation.live_item.lock().clone();
            ok_with(id, revision(), json!({ "item": item }))
        }
        EngineCommand::GetStagedItem => {
            let item = runtime.presentation.staged_item.lock().clone();
            ok_with(id, revision(), json!({ "item": item }))
        }
        EngineCommand::GetSettings => {
            let settings = runtime.presentation.settings.lock().clone();
            ok_with(id, revision(), json!({ "settings": settings }))
        }
        EngineCommand::OutputWindowShow { label, style, preferred_monitor, width, height } => {
            match runtime.window_host() {
                Some(host) => {
                    host.send(WindowCommand::Show { label, style, preferred_monitor, width, height });
                    ok(id, revision())
                }
                None => err(id, revision(), "window_host_unavailable", "The engine window host is not running."),
            }
        }
        EngineCommand::OutputWindowHide { label } => match runtime.window_host() {
            Some(host) => {
                host.send(WindowCommand::Hide { label });
                ok(id, revision())
            }
            None => err(id, revision(), "window_host_unavailable", "The engine window host is not running."),
        },
        EngineCommand::OutputWindowSetMonitor { label, monitor } => match runtime.window_host() {
            Some(host) => {
                host.send(WindowCommand::SetMonitor { label, monitor });
                ok(id, revision())
            }
            None => err(id, revision(), "window_host_unavailable", "The engine window host is not running."),
        },
        EngineCommand::OutputWindowResize { label, width, height } => match runtime.window_host() {
            Some(host) => {
                host.send(WindowCommand::Resize { label, width, height });
                ok(id, revision())
            }
            None => err(id, revision(), "window_host_unavailable", "The engine window host is not running."),
        },
        EngineCommand::OutputWindowSetConfig { label, config } => {
            runtime.window_configs.lock().insert(label, *config);
            ok(id, revision())
        }
        EngineCommand::ListMonitors => match runtime.window_host() {
            Some(host) => match host.list_monitors() {
                Some(monitors) => ok_with(id, revision(), json!({ "monitors": monitors })),
                None => err(id, revision(), "window_host_timeout", "The engine window host did not respond."),
            },
            None => err(id, revision(), "window_host_unavailable", "The engine window host is not running."),
        },
        EngineCommand::SyncPresentation { snapshot } => {
            match runtime.apply_sync(*snapshot) {
                Ok(()) => ok(id, revision()),
                Err(msg) => err(id, revision(), "sync_error", &msg),
            }
        }
        EngineCommand::RtmpStart { session_id, url, fps, width, height } => {
            match runtime.transport.start_rtmp(&session_id, &url, fps, width, height) {
                Ok(()) => ok(id, revision()),
                Err(e) => err(id, revision(), "rtmp_error", &e),
            }
        }
        EngineCommand::RtmpStop { session_id } => {
            match runtime.transport.stop(&session_id) {
                Ok(()) => ok(id, revision()),
                Err(e) => err(id, revision(), "rtmp_error", &e),
            }
        }
        EngineCommand::RtmpStatus => {
            let sessions = runtime.transport.status();
            let statuses: Vec<Value> = sessions
                .iter()
                .filter(|s| s.kind == "rtmp")
                .map(|s| serde_json::to_value(s).unwrap_or_else(|_| json!({})))
                .collect();
            ok_with(id, revision(), json!({ "sessions": statuses }))
        }
        EngineCommand::RecordingStart { session_id, path, fps, width, height } => {
            let path = std::path::PathBuf::from(&path);
            match runtime.transport.start_recording(&session_id, &path, fps, width, height) {
                Ok(()) => ok(id, revision()),
                Err(e) => err(id, revision(), "recording_error", &e),
            }
        }
        EngineCommand::RecordingStop { session_id } => {
            match runtime.transport.stop(&session_id) {
                Ok(()) => ok(id, revision()),
                Err(e) => err(id, revision(), "recording_error", &e),
            }
        }
        EngineCommand::RecordingStatus => {
            let sessions = runtime.transport.status();
            let statuses: Vec<Value> = sessions
                .iter()
                .filter(|s| s.kind == "recording")
                .map(|s| serde_json::to_value(s).unwrap_or_else(|_| json!({})))
                .collect();
            ok_with(id, revision(), json!({ "sessions": statuses }))
        }
        EngineCommand::Unknown => EngineResponse::unsupported(id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::ipc::EngineCommand;
    use crate::store::{DisplayItem, Verse};

    fn runtime() -> EngineRuntime {
        EngineRuntime::new(std::env::temp_dir().join("wordlyte-engine-test")).unwrap()
    }

    fn verse_item() -> DisplayItem {
        DisplayItem::Verse(Verse {
            book: "John".into(),
            chapter: 3,
            verse: 16,
            text: "For God so loved the world".into(),
            version: "KJV".into(),
            split_index: None,
            total_splits: None,
            score: None,
        })
    }

    #[test]
    fn ping_reports_ok_and_capabilities() {
        let rt = runtime();
        let (res, events) = dispatch(&rt, 1, EngineCommand::Ping);
        assert!(res.ok);
        assert!(events.is_empty());
        let result = res.result.unwrap();
        let caps = result["capabilities"].as_array().unwrap();
        assert!(caps.iter().any(|c| c == "presentation"));
    }

    #[test]
    fn send_live_bumps_revision_and_emits_live_event() {
        let rt = runtime();
        let (res, events) = dispatch(&rt, 2, EngineCommand::SendLiveItem {
            item: Box::new(verse_item()),
            source: None,
        });
        assert!(res.ok);
        assert_eq!(res.revision.unwrap(), 1);
        assert!(events.iter().any(|f| matches!(f.event, EngineEvent::LiveItemUpdate { revision: 1, .. })));
        assert!(rt.presentation.live_item.lock().is_some());
    }

    #[test]
    fn clear_all_clears_live_and_staged_with_events() {
        let rt = runtime();
        dispatch(&rt, 3, EngineCommand::SendLiveItem { item: Box::new(verse_item()), source: None });
        dispatch(&rt, 4, EngineCommand::StageItem { item: Box::new(verse_item()), source: None });
        let (res, events) = dispatch(&rt, 5, EngineCommand::ClearAll { source: None });
        assert!(res.ok);
        assert!(rt.presentation.live_item.lock().is_none());
        assert!(rt.presentation.staged_item.lock().is_none());
        assert!(events.iter().any(|f| matches!(f.event, EngineEvent::LiveItemUpdate { detected_item: None, .. })));
    }

    #[test]
    fn unknown_command_is_unsupported() {
        let rt = runtime();
        let (res, _) = dispatch(&rt, 6, EngineCommand::Unknown);
        assert!(!res.ok);
        assert_eq!(res.error.unwrap().code, "unsupported");
    }

    #[test]
    fn snapshot_matches_presentation_state() {
        let rt = runtime();
        dispatch(&rt, 7, EngineCommand::SendLiveItem { item: Box::new(verse_item()), source: None });
        let (res, _) = dispatch(&rt, 8, EngineCommand::PresentationSnapshot);
        let snap = res.result.unwrap();
        assert_eq!(snap["revision"], 1);
        assert_eq!(snap["live"]["type"], "Verse");
        assert_eq!(snap["live"]["data"]["book"], "John");
        assert_eq!(snap["live"]["data"]["verse"], 16);
    }

    #[test]
    fn get_settings_returns_default_settings() {
        let rt = runtime();
        let (res, _) = dispatch(&rt, 9, EngineCommand::GetSettings);
        assert!(res.ok);
        assert!(res.result.unwrap()["settings"].is_object());
    }

    #[test]
    fn window_commands_error_without_host() {
        let rt = runtime();
        let (res, _) = dispatch(&rt, 10, EngineCommand::OutputWindowShow {
            label: "output".into(),
            style: crate::engine::windows::WindowStyle::default(),
            preferred_monitor: None,
            width: 1920,
            height: 1080,
        });
        assert!(!res.ok);
        assert_eq!(res.error.unwrap().code, "window_host_unavailable");
    }

    #[test]
    fn list_monitors_errors_without_host() {
        let rt = runtime();
        let (res, _) = dispatch(&rt, 11, EngineCommand::ListMonitors);
        assert!(!res.ok);
        assert_eq!(res.error.unwrap().code, "window_host_unavailable");
    }

    #[test]
    fn set_config_then_resolve_window_frame() {
        let rt = runtime();
        let config = crate::outputs::OutputConfig {
            schema_version: crate::outputs::OUTPUT_SCHEMA_VERSION,
            id: "output-main".into(),
            kind: crate::outputs::OutputKind::Window,
            label: "Output".into(),
            enabled: true,
            visible: true,
            source: crate::outputs::OutputSource::Live,
            geometry: crate::outputs::OutputGeometry { width: 1920, height: 1080 },
            capture_fps: None,
            presentation: None,
            overlays: crate::outputs::OutputOverlays { props: true, lower_third: true, logo: true },
            window_label: Some("output".into()),
            recording: None,
            streaming: None,
            stream_destinations: None,
        };
        let (res, _) = dispatch(&rt, 12, EngineCommand::OutputWindowSetConfig {
            label: "output".into(),
            config: Box::new(config),
        });
        assert!(res.ok);

        dispatch(&rt, 13, EngineCommand::SendLiveItem {
            item: Box::new(verse_item()),
            source: None,
        });

        let frames = rt.resolve_window_frames();
        assert_eq!(frames.len(), 1);
        let (label, shared) = &frames[0];
        assert_eq!(label, "output");
        assert_eq!(shared.revision, 1);
        // The resolved frame reflects the live item (verse source).
        assert!(shared.frame.layers.iter().any(|l| !matches!(l, crate::engine::compositor::ProgramLayer::Waiting)));
    }

    #[test]
    fn resolve_window_frame_without_configs_is_empty() {
        let rt = runtime();
        assert!(rt.resolve_window_frames().is_empty());
    }

    #[test]
    fn preview_sink_emits_base64_preview_frame_event() {
        let pending = Arc::new(Mutex::new(Vec::new()));
        let sink = preview_sink(Arc::clone(&pending));
        sink("output".into(), 7, 480, 270, vec![0xFF, 0xD8, 0x42]);
        let frames = pending.lock().clone();
        assert_eq!(frames.len(), 1);
        match &frames[0].event {
            EngineEvent::PreviewFrame { output_id, frame_index, width, height, image_base64 } => {
                assert_eq!(output_id, "output");
                assert_eq!(*frame_index, 7);
                assert_eq!((*width, *height), (480, 270));
                // Base64 of the 3 JPEG bytes round-trips.
                let decoded = base64::engine::general_purpose::STANDARD
                    .decode(image_base64)
                    .unwrap();
                assert_eq!(decoded, vec![0xFF, 0xD8, 0x42]);
            }
            other => panic!("expected PreviewFrame, got {other:?}"),
        }
    }

    #[test]
    fn sync_presentation_adopts_state_and_revision() {
        let rt = runtime();
        // Drive the engine's own state to revision 1 via a mutation, then
        // overwrite it with a console-provided snapshot at a higher revision.
        dispatch(&rt, 20, EngineCommand::SendLiveItem { item: Box::new(verse_item()), source: None });
        let snap = crate::engine::presentation::PresentationSnapshot {
            schema_version: crate::engine::presentation::PRESENTATION_SCHEMA_VERSION,
            live: None,
            previous: None,
            staged: None,
            settings: rt.presentation.settings.lock().clone(),
            lower_third: None,
            props: vec![],
            active_scene_id: None,
            revision: 42,
            updated_at: 123456789,
        };
        let (res, _) = dispatch(&rt, 21, EngineCommand::SyncPresentation { snapshot: Box::new(snap) });
        assert!(res.ok);
        assert_eq!(res.revision.unwrap(), 42);
        assert!(rt.presentation.live_item.lock().is_none());
        assert_eq!(rt.presentation.current_revision(), 42);
        assert_eq!(*rt.presentation.last_updated.lock(), 123456789);
    }

    #[test]
    fn sync_presentation_rejects_schema_mismatch() {
        let rt = runtime();
        let snap = crate::engine::presentation::PresentationSnapshot {
            schema_version: crate::engine::presentation::PRESENTATION_SCHEMA_VERSION + 1,
            live: None,
            previous: None,
            staged: None,
            settings: rt.presentation.settings.lock().clone(),
            lower_third: None,
            props: vec![],
            active_scene_id: None,
            revision: 1,
            updated_at: 0,
        };
        let (res, _) = dispatch(&rt, 22, EngineCommand::SyncPresentation { snapshot: Box::new(snap) });
        assert!(!res.ok);
        assert_eq!(res.error.unwrap().code, "sync_error");
        // The engine keeps its own state untouched.
        assert_eq!(rt.presentation.current_revision(), 0);
    }
}