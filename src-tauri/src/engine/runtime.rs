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
use crate::engine::ipc::{EngineCommand, EngineEvent, EngineEventFrame, EngineResponse};
use crate::engine::presentation::Engine;
use crate::remote::protocol::RemoteEventKind;
use crate::state::PresentationState;
use crate::store::{self, MediaScheduleStore};
use parking_lot::Mutex;
use serde_json::{json, Value};
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
}

impl EngineRuntime {
    /// Creates the runtime. `app_data_dir` is used for prop-path validation and
    /// any future disk persistence; the store itself is in-memory during Phase
    /// A2 (see module docs).
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        let store = MediaScheduleStore::in_memory(app_data_dir.clone()).map_err(|e| e.to_string())?;
        let initial_settings = store.load_settings().unwrap_or_default();
        Ok(Self {
            presentation: PresentationState::new(initial_settings),
            store,
            app_data_dir,
            pending_events: Arc::new(Mutex::new(Vec::new())),
        })
    }

    /// The current presentation revision (for `Ping`/read-only responses).
    pub fn revision(&self) -> u64 {
        self.presentation.current_revision()
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
}