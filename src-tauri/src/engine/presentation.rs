use crate::events::{LiveItemUpdate, ScenePayload};
use crate::remote::protocol::RemoteEventKind;
use crate::state::AppState;
use crate::store::{
    DisplayItem, LowerThirdData, PresentationSettings, PropItem, SceneCompositionData, SceneZone,
    SceneZoneSource,
};
use serde::Serialize;
use serde_json::json;
use tauri::AppHandle;

use super::backend::EngineBackend;
use crate::state::PresentationState;

/// Schema version of the `PresentationSnapshot` document. Bumped when the
/// snapshot's on-wire shape changes; consumers must reject a snapshot whose
/// `schema_version` they do not understand instead of guessing at fields.
pub const PRESENTATION_SCHEMA_VERSION: u32 = 2;

/// Authoritative presentation snapshot for window hydration. Windows call
/// `presentation_snapshot` after registering their event listeners and replay
/// their buffered events on top of it, so a reopening window converges to the
/// same state as the operator console.
#[derive(Serialize)]
pub struct PresentationSnapshot {
    pub schema_version: u32,
    pub live: Option<DisplayItem>,
    /// The item that was live immediately before `live` (P1-6 / WP6).
    pub previous: Option<DisplayItem>,
    pub staged: Option<DisplayItem>,
    pub settings: PresentationSettings,
    pub lower_third: Option<serde_json::Value>,
    pub props: Vec<PropItem>,
    /// The id of the live scene composition, if the live item is one (P1-6).
    pub active_scene_id: Option<String>,
    pub revision: u64,
    /// Unix ms of the last presentation mutation (0 before any mutation).
    pub updated_at: u64,
}

/// Result of one engine mutation. Every `op_*` returns this so command
/// adapters (desktop and remote) can reply with the post-mutation snapshot —
/// and, where the mutation changed the live slot, the committed item — without
/// a second read of authoritative state.
#[derive(Serialize)]
pub struct MutationResult {
    /// Full presentation state immediately after the mutation (single, atomic
    /// read taken under the same lock as the mutation itself).
    pub snapshot: PresentationSnapshot,
    /// The item that took the live slot (after scene-zone patching), or `None`
    /// when the mutation did not change the live slot.
    pub committed: Option<DisplayItem>,
    /// Scene payload for `op_apply_scene` so the frontend can mirror the
    /// applied scene without waiting for events to round-trip.
    pub scene: Option<ScenePayload>,
}

/// Reads the full presentation state without locking. Callers must hold the
/// presentation mutation lock (every `op_*` does) so the snapshot is
/// consistent — no event can be half-applied when it is captured.
pub fn snapshot<B: EngineBackend>(backend: &B) -> PresentationSnapshot {
    let presentation = backend.presentation();
    let live = presentation.live_item.lock().clone();
    let active_scene_id = match &live {
        Some(DisplayItem::SceneComposition(data)) => Some(data.scene_id.clone()),
        _ => None,
    };
    PresentationSnapshot {
        schema_version: PRESENTATION_SCHEMA_VERSION,
        live: live.clone(),
        previous: presentation.previous_item.lock().clone(),
        staged: presentation.staged_item.lock().clone(),
        settings: presentation.settings.lock().clone(),
        lower_third: presentation.lower_third.lock().clone(),
        props: presentation.props_layer.lock().clone(),
        active_scene_id,
        revision: presentation.current_revision(),
        updated_at: *presentation.last_updated.lock(),
    }
}

pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Acquires the presentation mutation lock. Every mutation takes this first so
/// desktop and remote callers can never interleave two operations
/// mid-transaction (audit: concurrent stage/send-live atomicity).
fn lock_presentation(presentation: &PresentationState) -> parking_lot::MutexGuard<'_, ()> {
    presentation.lock.lock()
}

/// Copies the current live item into `previous_item` (P1-6). Callers that
/// change the live slot must do this BEFORE replacing it so the snapshot's
/// `previous` reflects the item that was live immediately before.
fn capture_previous(presentation: &PresentationState) {
    let prev = presentation.live_item.lock().clone();
    *presentation.previous_item.lock() = prev;
}

// ---------------------------------------------------------------------------
// Scene-zone buses (Phase 5)
// ---------------------------------------------------------------------------

/// Map an incoming display item to the `SceneZoneSource` bus class that would
/// consume it inside a scene composition. `SceneComposition` items never
/// follow a zone (a zone can't host a nested scene) so they return `None`.
pub fn zone_source_for(item: &DisplayItem) -> Option<SceneZoneSource> {
    match item {
        DisplayItem::Verse(_) => Some(SceneZoneSource::Verse),
        DisplayItem::Camera(_) => Some(SceneZoneSource::Camera),
        DisplayItem::Timer(_) => Some(SceneZoneSource::Timer),
        DisplayItem::Song(_) => Some(SceneZoneSource::Song),
        DisplayItem::Media(_) => Some(SceneZoneSource::Media),
        DisplayItem::CustomSlide(_) => Some(SceneZoneSource::Slide),
        DisplayItem::SceneComposition(_) => None,
    }
}

/// Phase 5 — zones as bus primitives.
///
/// When a scene composition is the current live item and a new item is taken
/// live, refresh the zones whose `source` matches the incoming item's content
/// class *in place* instead of replacing the whole scene. Returns the patched
/// composition when at least one zone follows the incoming class, or `None`
/// when the live item isn't a composition or nothing follows it (callers fall
/// back to the normal replace-everything take).
pub fn patch_scene_zones(live: &DisplayItem, incoming: &DisplayItem) -> Option<DisplayItem> {
    let DisplayItem::SceneComposition(comp) = live else { return None };
    let source = zone_source_for(incoming)?;
    let mut patched = false;
    let zones: Vec<SceneZone> = comp
        .zones
        .iter()
        .map(|z| {
            if z.source.as_ref() == Some(&source) {
                patched = true;
                let mut z2 = z.clone();
                z2.item = incoming.clone();
                z2
            } else {
                z.clone()
            }
        })
        .collect();
    if !patched {
        return None;
    }
    Some(DisplayItem::SceneComposition(SceneCompositionData {
        scene_id: comp.scene_id.clone(),
        name: comp.name.clone(),
        zones,
    }))
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/// How the engine broadcasts a window event: `(event_name, serialized_payload)`.
/// The desktop shell supplies a closure that routes through `emit_checked_value`;
/// tests supply a recorder or no-op. Carries a lifetime so sinks that borrow an
/// `AppHandle` do not force the engine to be `'static`, and requires `Sync` so
/// the engine stays `Send` across `tokio::spawn` in the remote server.
pub type EmitFn<'a> = dyn Fn(&str, serde_json::Value) + Sync + 'a;

/// The Broadcast Engine. Holds the authoritative `AppState` and the emit sink,
/// and exposes every presentation mutation as a method. Contract:
///
/// - Every mutation acquires the presentation mutation lock and bumps the
///   presentation revision exactly ONCE per logical mutation, so listeners see
///   one consistent event per change and stale windows resynchronize.
/// - Every mutation returns a [`MutationResult`] carrying the post-mutation
///   [`PresentationSnapshot`] (plus the committed item / scene payload where
///   relevant) so command adapters can reply without a second read.
/// - Mutations that persist first are transactional: a persistence failure
///   aborts before any in-memory state or event is touched, and multi-write
///   operations compensate the earlier writes.
pub struct Engine<'a, B: EngineBackend> {
    /// The authoritative state + persistence/remote-sink seam. In the desktop
    /// shell this is `AppState`; in the standalone engine process it is the
    /// engine's own runtime.
    pub state: &'a B,
    /// Broadcast sink for window events produced by engine mutations. Desktop
    /// adapters route it through `crate::events::emit_checked_value`.
    pub emit: &'a EmitFn<'a>,
}

impl<'a, B: EngineBackend> Engine<'a, B> {
    fn emit_event(&self, event: &str, payload: serde_json::Value) {
        (self.emit)(event, payload);
    }

    fn presentation(&self) -> &PresentationState {
        self.state.presentation()
    }

    /// Emits `live-item-update` carrying the current presentation revision so
    /// windows can order a hydration snapshot against live events.
    fn emit_live_update(&self, detected_item: Option<DisplayItem>) {
        let update = LiveItemUpdate {
            detected_item,
            revision: Some(self.presentation().current_revision()),
        };
        self.emit_event("live-item-update", serde_json::to_value(&update).expect("LiveItemUpdate serializes"));
    }

    /// Emits `item-staged` wrapped with the current presentation revision so
    /// windows can order it against a hydration snapshot. `None` clears the
    /// staged slot.
    fn emit_staged(&self, item: Option<&DisplayItem>) {
        let revision = self.presentation().current_revision();
        self.emit_event("item-staged", json!({ "item": item, "revision": revision }));
    }

    /// Emits `settings-changed` wrapped with the current presentation revision.
    fn emit_settings(&self, settings: &PresentationSettings) {
        let revision = self.presentation().current_revision();
        self.emit_event("settings-changed", json!({ "settings": settings, "revision": revision }));
    }

    /// Emits `lower-third-update` wrapped with the current presentation
    /// revision. The payload's `lower_third` field carries the
    /// `{ data, template }` document or `null` when cleared.
    fn emit_lower_third(&self, payload: Option<&serde_json::Value>) {
        let revision = self.presentation().current_revision();
        self.emit_event("lower-third-update", json!({ "lower_third": payload, "revision": revision }));
    }

    /// Emits `props-update` wrapped with the current presentation revision.
    fn emit_props(&self, props: &[PropItem]) {
        let revision = self.presentation().current_revision();
        self.emit_event("props-update", json!({ "props": props, "revision": revision }));
    }

    // -- Stage / commit / live ------------------------------------------------

    pub fn op_stage(
        &self,
        item: DisplayItem,
        source: Option<String>,
        _revision: u64,
    ) -> Result<MutationResult, String> {
        let _guard = lock_presentation(self.presentation());
        Ok(self.op_stage_locked(item, source, _revision))
    }

    /// `op_stage` with the presentation lock already held.
    fn op_stage_locked(&self, item: DisplayItem, source: Option<String>, _revision: u64) -> MutationResult {
        self.presentation().bump_revision();
        *self.presentation().staged_item.lock() = Some(item.clone());
        self.emit_staged(Some(&item));
        self.state.publish_remote(RemoteEventKind::StagedChanged, json!({ "staged_item": item }), source);
        MutationResult {
            snapshot: snapshot(self.state),
            committed: None,
            scene: None,
        }
    }

    /// Clears the staged slot only (live stays untouched) and broadcasts the
    /// cleared state so every window — including the output/stage windows —
    /// drops the staged item. Replaces the frontend-only "clear staged" that
    /// left the backend slot populated.
    pub fn op_clear_staged(&self, source: Option<String>) -> Result<MutationResult, String> {
        let _guard = lock_presentation(self.presentation());
        self.presentation().bump_revision();
        *self.presentation().staged_item.lock() = None;
        self.emit_staged(None);
        self.state.publish_remote(RemoteEventKind::StagedChanged, json!({ "staged_item": null }), source);
        Ok(MutationResult {
            snapshot: snapshot(self.state),
            committed: None,
            scene: None,
        })
    }

    /// Commit the staged item as live, patching pinned scene-zone buses when
    /// the current live item is a composition that follows the staged content
    /// class. `committed` is `None` when nothing was staged (a no-op, never a
    /// mutation).
    pub fn op_commit_staged(&self, source: Option<String>) -> Result<MutationResult, String> {
        let _guard = lock_presentation(self.presentation());
        Ok(self.op_commit_staged_locked(source))
    }

    /// `op_commit_staged` with the presentation lock already held.
    fn op_commit_staged_locked(&self, source: Option<String>) -> MutationResult {
        capture_previous(self.presentation());
        let mut live = self.presentation().live_item.lock();
        let staged = self.presentation().staged_item.lock().clone();
        let committed = match (&*live, &staged) {
            (Some(live_item), Some(staged_item)) => {
                Some(patch_scene_zones(live_item, staged_item).unwrap_or_else(|| staged_item.clone()))
            }
            _ => staged.clone(),
        };
        let committed = match committed {
            Some(c) => c,
            None => {
                // Nothing staged — a true no-op: no revision bump, no events.
                drop(live);
                return MutationResult {
                    snapshot: snapshot(self.state),
                    committed: None,
                    scene: None,
                };
            }
        };
        self.presentation().bump_revision();
        *live = Some(committed.clone());
        drop(live);
        self.emit_live_update(Some(committed.clone()));
        self.state.publish_remote(RemoteEventKind::LiveChanged, json!({ "live_item": committed.clone() }), source);
        MutationResult {
            snapshot: snapshot(self.state),
            committed: Some(committed),
            scene: None,
        }
    }

    pub fn op_clear_live(&self, source: Option<String>) -> Result<MutationResult, String> {
        let _guard = lock_presentation(self.presentation());
        self.presentation().bump_revision();
        capture_previous(self.presentation());
        *self.presentation().live_item.lock() = None;
        self.emit_live_update(None);
        let staged = self.presentation().staged_item.lock().clone();
        self.emit_staged(staged.as_ref());
        self.state.publish_remote(RemoteEventKind::LiveChanged, json!({ "live_item": null }), source.clone());
        self.state.publish_remote(RemoteEventKind::StagedChanged, json!({ "staged_item": staged }), source);
        Ok(MutationResult {
            snapshot: snapshot(self.state),
            committed: None,
            scene: None,
        })
    }

    pub fn op_go_live_item(&self, item: DisplayItem, source: Option<String>) -> Result<MutationResult, String> {
        let _guard = lock_presentation(self.presentation());
        capture_previous(self.presentation());
        let mut live = self.presentation().live_item.lock();
        let committed = match &*live {
            // Phase 5: when a scene composition is live and the sent item
            // matches a pinned zone bus, refresh that zone in place instead of
            // replacing the whole scene (e.g. remote "camera.send_live" into a
            // camera zone).
            Some(live_item) => patch_scene_zones(live_item, &item).unwrap_or(item.clone()),
            None => item.clone(),
        };
        self.presentation().bump_revision();
        *live = Some(committed.clone());
        drop(live);
        self.emit_live_update(Some(committed.clone()));
        self.state.publish_remote(RemoteEventKind::LiveChanged, json!({ "live_item": committed.clone() }), source);
        Ok(MutationResult {
            snapshot: snapshot(self.state),
            committed: Some(committed),
            scene: None,
        })
    }

    /// Transactional send-live: stage the resolved item and commit it in one
    /// single-bump transaction under one presentation lock, so a concurrent
    /// desktop/remote caller can never commit a different item in the middle
    /// (audit: concurrent stage/send-live atomicity). `committed` is always
    /// `Some` on success.
    pub fn op_send_live(&self, item: DisplayItem, source: Option<String>) -> Result<MutationResult, String> {
        let _guard = lock_presentation(self.presentation());

        capture_previous(self.presentation());
        let mut live = self.presentation().live_item.lock();
        let committed = match &*live {
            Some(live_item) => patch_scene_zones(live_item, &item).unwrap_or(item.clone()),
            None => item.clone(),
        };
        self.presentation().bump_revision();
        *live = Some(committed.clone());
        drop(live);
        *self.presentation().staged_item.lock() = Some(item.clone());

        self.emit_staged(Some(&item));
        self.emit_live_update(Some(committed.clone()));
        self.state.publish_remote(RemoteEventKind::StagedChanged, json!({ "staged_item": item }), source.clone());
        self.state.publish_remote(RemoteEventKind::LiveChanged, json!({ "live_item": committed.clone() }), source);

        Ok(MutationResult {
            snapshot: snapshot(self.state),
            committed: Some(committed),
            scene: None,
        })
    }

    /// Clear everything the audience can see: live item, staged item,
    /// lower-third overlay and props layer. Persists the cleared props so a
    /// restart does not resurrect previously cleared props.
    /// Persist-before-mutate keeps the operation transactional: on persistence
    /// failure nothing is cleared and the error is surfaced to the operator.
    pub fn op_clear_all(&self, source: Option<String>) -> Result<MutationResult, String> {
        let _guard = lock_presentation(self.presentation());

        self.state.save_props(&[]).map_err(|e| e.to_string())?;

        self.presentation().bump_revision();
        capture_previous(self.presentation());
        *self.presentation().live_item.lock() = None;
        *self.presentation().staged_item.lock() = None;
        *self.presentation().lower_third.lock() = None;
        self.presentation().props_layer.lock().clear();

        self.emit_live_update(None);
        self.emit_staged(None);
        self.emit_lower_third(None);
        self.emit_props(&[]);

        self.state.publish_remote(RemoteEventKind::LiveChanged, json!({ "live_item": null }), source.clone());
        self.state.publish_remote(RemoteEventKind::StagedChanged, json!({ "staged_item": null }), source.clone());
        self.state.publish_remote(RemoteEventKind::LowerThirdChanged, json!({ "lower_third": null }), source);
        Ok(MutationResult {
            snapshot: snapshot(self.state),
            committed: None,
            scene: None,
        })
    }

    // -- Settings / blackout / logo -------------------------------------------

    pub fn op_set_blackout(&self, on: bool, source: Option<String>) -> Result<MutationResult, String> {
        let _guard = lock_presentation(self.presentation());
        let mut settings = self.presentation().settings.lock().clone();
        settings.is_blanked = on;
        self.state.save_settings(&settings).map_err(|e| e.to_string())?;
        self.presentation().bump_revision();
        *self.presentation().settings.lock() = settings.clone();
        self.emit_settings(&settings);
        self.state.publish_remote(RemoteEventKind::BlackoutChanged, json!({ "blackout": on }), source);
        Ok(MutationResult {
            snapshot: snapshot(self.state),
            committed: None,
            scene: None,
        })
    }

    /// Persists a full settings document and broadcasts the deltas (blackout
    /// and background-logo changes are published to remotes only when the flag
    /// actually flipped).
    pub fn op_save_settings(&self, settings: PresentationSettings) -> Result<MutationResult, String> {
        let _guard = lock_presentation(self.presentation());
        let (prev_blanked, prev_logo) = {
            let guard = self.presentation().settings.lock();
            (guard.is_blanked, guard.show_background_logo)
        };
        self.state.save_settings(&settings).map_err(|e| e.to_string())?;
        self.presentation().bump_revision();
        *self.presentation().settings.lock() = settings.clone();
        self.emit_settings(&settings);
        if prev_blanked != settings.is_blanked {
            self.state.publish_remote(
                RemoteEventKind::BlackoutChanged,
                json!({ "blackout": settings.is_blanked }),
                None,
            );
        }
        if prev_logo != settings.show_background_logo {
            self.state.publish_remote(
                RemoteEventKind::LogoChanged,
                json!({ "logo": settings.show_background_logo }),
                None,
            );
        }
        Ok(MutationResult {
            snapshot: snapshot(self.state),
            committed: None,
            scene: None,
        })
    }

    /// Sets the background-logo overlay flag (persisted) and broadcasts the
    /// change to connected remotes.
    pub fn op_set_logo(&self, on: bool, source: Option<String>) -> Result<MutationResult, String> {
        let _guard = lock_presentation(self.presentation());
        let mut settings = self.presentation().settings.lock().clone();
        settings.show_background_logo = on;
        self.state.save_settings(&settings).map_err(|e| e.to_string())?;
        self.presentation().bump_revision();
        *self.presentation().settings.lock() = settings.clone();
        self.emit_settings(&settings);
        self.state.publish_remote(RemoteEventKind::LogoChanged, json!({ "logo": on }), source);
        Ok(MutationResult {
            snapshot: snapshot(self.state),
            committed: None,
            scene: None,
        })
    }

    // -- Lower third -----------------------------------------------------------

    /// Shows a lower-third overlay through the authoritative presentation state.
    pub fn op_show_lower_third(
        &self,
        data: LowerThirdData,
        template: Option<serde_json::Value>,
        source: Option<String>,
    ) -> Result<MutationResult, String> {
        let _guard = lock_presentation(self.presentation());
        self.presentation().bump_revision();
        let payload = json!({ "data": data, "template": template.unwrap_or_else(|| json!({})) });
        *self.presentation().lower_third.lock() = Some(payload.clone());
        self.emit_lower_third(Some(&payload));
        self.state.publish_remote(RemoteEventKind::LowerThirdChanged, json!({ "lower_third": payload }), source);
        Ok(MutationResult {
            snapshot: snapshot(self.state),
            committed: None,
            scene: None,
        })
    }

    /// Hides any lower-third overlay and propagates the null change.
    pub fn op_hide_lower_third(&self, source: Option<String>) -> Result<MutationResult, String> {
        let _guard = lock_presentation(self.presentation());
        self.presentation().bump_revision();
        *self.presentation().lower_third.lock() = None;
        self.emit_lower_third(None);
        self.state.publish_remote(RemoteEventKind::LowerThirdChanged, json!({ "lower_third": null }), source);
        Ok(MutationResult {
            snapshot: snapshot(self.state),
            committed: None,
            scene: None,
        })
    }

    // -- Timers ----------------------------------------------------------------

    /// Updates the started timestamp of a live timer (start/stop the
    /// countdown). The revision is bumped per the historical behavior even
    /// when no timer is live — callers treat the response as authoritative.
    pub fn op_update_timer(&self, started_at: Option<u64>) -> Result<MutationResult, String> {
        let _guard = lock_presentation(self.presentation());
        self.presentation().bump_revision();
        let mut live = self.presentation().live_item.lock();
        if let Some(DisplayItem::Timer(ref mut t)) = *live {
            t.started_at = started_at;
            let item = live.clone();
            drop(live);
            self.emit_live_update(item.clone());
            self.state.publish_remote(RemoteEventKind::LiveChanged, json!({ "live_item": item }), None);
        }
        Ok(MutationResult {
            snapshot: snapshot(self.state),
            committed: None,
            scene: None,
        })
    }

    /// Start/stop the live timer (flip its `started_at`). Returns whether a
    /// timer was actually toggled so callers can distinguish the no-op.
    pub fn op_toggle_timer(&self, source: Option<String>) -> Result<(MutationResult, bool), String> {
        let _guard = lock_presentation(self.presentation());
        let toggled = {
            self.presentation().bump_revision();
            let mut live = self.presentation().live_item.lock();
            if let Some(DisplayItem::Timer(ref mut t)) = *live {
                t.started_at = if t.started_at.is_some() { None } else { Some(now_ms()) };
                true
            } else {
                false
            }
        };
        if toggled {
            let item = self.presentation().live_item.lock().clone();
            self.emit_live_update(item.clone());
            self.state.publish_remote(RemoteEventKind::LiveChanged, json!({ "live_item": item }), source);
        }
        Ok((MutationResult {
            snapshot: snapshot(self.state),
            committed: None,
            scene: None,
        }, toggled))
    }

    // -- Props ----------------------------------------------------------------

    /// Replaces the persistent props layer. Validates image paths and persists
    /// BEFORE mutating so a write failure never leaves the in-memory and
    /// on-disk layers diverging.
    pub fn op_set_props(&self, props: Vec<PropItem>) -> Result<MutationResult, String> {
        let _guard = lock_presentation(self.presentation());
        // Validate any image prop paths before accepting the batch.
        for p in &props {
            if let Some(path) = &p.path {
                if p.kind == "image" && !path.is_empty() {
                    validate_prop_path(path, self.state.app_data_dir())?;
                }
            }
        }
        // Persist BEFORE mutating so a write failure never leaves the
        // in-memory and on-disk layers diverging, and the caller can roll back
        // cleanly.
        self.state.save_props(&props).map_err(|e| e.to_string())?;
        self.presentation().bump_revision();
        *self.presentation().props_layer.lock() = props.clone();
        self.emit_props(&props);
        Ok(MutationResult {
            snapshot: snapshot(self.state),
            committed: None,
            scene: None,
        })
    }

    // -- Scenes ----------------------------------------------------------------

    /// Recall a scene: apply its settings, props, (optional) lower-third, and
    /// composition to the live presentation state and broadcast everything as
    /// ONE logical mutation — a single lock acquisition, a single revision
    /// bump, and every layer applied together — so no window or remote ever
    /// observes half a scene. The scene's settings/props are persisted first;
    /// a persistence failure compensates the earlier writes and aborts before
    /// any in-memory state or event is touched.
    pub fn op_apply_scene(&self, id: String) -> Result<MutationResult, String> {
        // Acquire the presentation mutation lock FIRST (P1-3) so no concurrent
        // settings/props mutation can interleave with the scene's read →
        // persist → apply sequence or its compensation. One lock, one revision,
        // one consistent state.
        let _guard = lock_presentation(self.presentation());

        let scene = self
            .state
            .list_scenes()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("Scene '{}' not found", id))?;

        let lt_payload = match (&scene.lower_third_data, &scene.lower_third_template) {
            (Some(data), Some(template)) => Some(serde_json::json!({ "data": data, "template": template })),
            _ => None,
        };

        // 1) Persist the complete payload BEFORE mutating in-memory
        //    presentation state. If any write fails, compensate the others so
        //    the disk never holds half a scene (audit: partial application on
        //    props failure).
        let previous_settings = self.state.load_settings().map_err(|e| e.to_string())?;
        self.state.save_settings(&scene.settings).map_err(|e| e.to_string())?;
        if let Err(e) = self.state.save_props(&scene.props).map_err(|e| e.to_string()) {
            let _ = self.state.save_settings(&previous_settings);
            return Err(e);
        }

        // 2) One logical mutation: single lock + single revision bump + every
        //    layer applied together. The composition (layout) or legacy camera
        //    is staged/committed inside the same transaction; a layout scene
        //    also populates the staged slot like the old op_send_live did.
        self.presentation().bump_revision();

        let mut staged_out: Option<DisplayItem> = None;
        let mut live_out: Option<DisplayItem> = None;

        if let Some(layout) = &scene.layout {
            let item = DisplayItem::SceneComposition(SceneCompositionData {
                scene_id: scene.id.clone(),
                name: scene.name.clone(),
                zones: layout.zones.clone(),
            });
            capture_previous(self.presentation());
            let mut live = self.presentation().live_item.lock();
            let merged = match &*live {
                Some(live_item) => patch_scene_zones(live_item, &item).unwrap_or(item.clone()),
                None => item.clone(),
            };
            *live = Some(merged.clone());
            drop(live);
            *self.presentation().staged_item.lock() = Some(item.clone());
            staged_out = Some(item);
            live_out = Some(merged);
        } else if let Some(cam) = &scene.camera {
            // Legacy single-camera scene: restore the camera feed that was
            // live at capture time.
            capture_previous(self.presentation());
            let mut live = self.presentation().live_item.lock();
            let merged = match &*live {
                Some(live_item) => patch_scene_zones(live_item, cam).unwrap_or(cam.clone()),
                None => cam.clone(),
            };
            *live = Some(merged.clone());
            drop(live);
            live_out = Some(merged);
        }

        *self.presentation().settings.lock() = scene.settings.clone();
        *self.presentation().props_layer.lock() = scene.props.clone();
        *self.presentation().lower_third.lock() = lt_payload.clone();

        if let Some(staged) = &staged_out {
            self.emit_staged(Some(staged));
        }
        if live_out.is_some() {
            self.emit_live_update(live_out.clone());
        }
        self.emit_settings(&scene.settings);
        self.emit_props(&scene.props);
        self.emit_lower_third(lt_payload.as_ref());

        if let Some(staged) = &staged_out {
            self.state.publish_remote(RemoteEventKind::StagedChanged, json!({ "staged_item": staged }), None);
        }
        if let Some(live) = &live_out {
            self.state.publish_remote(RemoteEventKind::LiveChanged, json!({ "live_item": live }), None);
        }

        Ok(MutationResult {
            snapshot: snapshot(self.state),
            committed: live_out,
            scene: Some(ScenePayload {
                id: scene.id,
                name: scene.name,
                settings: scene.settings,
                props: scene.props,
                lower_third_data: scene.lower_third_data,
                lower_third_template: scene.lower_third_template,
                camera: scene.camera,
                layout: scene.layout,
            }),
        })
    }

    /// Read-only rebroadcast of authoritative presentation state wrapped with
    /// the current revision (NO bump — this is not a mutation). A freshly
    /// revealed window hydrates through `set_output_visible` after registering
    /// its listeners; every event carries the same revision and consumers apply
    /// equal-revision events idempotently, so a stale reveal can never
    /// overwrite newer state that arrived while the window was hidden.
    pub fn rebroadcast(&self) {
        let revision = self.presentation().current_revision();
        let settings = self.presentation().settings.lock().clone();
        self.emit_event("settings-changed", json!({ "settings": settings, "revision": revision }));
        let live = self.presentation().live_item.lock().clone();
        self.emit_event(
            "live-item-update",
            serde_json::to_value(LiveItemUpdate { detected_item: live, revision: Some(revision) })
                .expect("LiveItemUpdate serializes"),
        );
        let lt = self.presentation().lower_third.lock().clone();
        self.emit_event("lower-third-update", json!({ "lower_third": lt, "revision": revision }));
        let props = self.presentation().props_layer.lock().clone();
        self.emit_event("props-update", json!({ "props": props, "revision": revision }));
        let staged = self.presentation().staged_item.lock().clone();
        self.emit_event("item-staged", json!({ "item": staged, "revision": revision }));
    }
}

/// Reads the current props layer, lazily hydrating it from disk when it has
/// not been touched yet (first `get_props` after startup). A pure read — it
/// does not take the mutation lock or emit.
pub fn op_get_props<B: EngineBackend>(backend: &B) -> Result<Vec<PropItem>, String> {
    let current = backend.presentation().props_layer.lock().clone();
    if current.is_empty() {
        if let Ok(loaded) = backend.load_props() {
            if !loaded.is_empty() {
                *backend.presentation().props_layer.lock() = loaded.clone();
                return Ok(loaded);
            }
        }
    }
    Ok(current)
}

/// Reject prop paths that fall outside the app data directory (or are not
/// already-relative to it). This keeps the output window from rendering
/// arbitrary files on disk and makes prop libraries portable across machines.
fn validate_prop_path(path: &str, app_data_dir: &std::path::Path) -> Result<(), String> {
    // Relative paths (stored by relativizePath on the frontend) are always OK.
    let is_absolute = path.starts_with('/')
        || (path.len() >= 2 && path.as_bytes()[1] == b'\\')
        || (path.len() >= 2 && path.as_bytes()[1] == b':');
    if !is_absolute {
        return Ok(());
    }
    let canonical = std::fs::canonicalize(path).map_err(|e| format!("Prop path not accessible: {}", e))?;
    let base = std::fs::canonicalize(app_data_dir).unwrap_or_else(|_| app_data_dir.to_path_buf());
    if canonical.starts_with(&base) {
        Ok(())
    } else {
        Err(format!("Prop path must be inside the app data folder: {}", path))
    }
}

// ---------------------------------------------------------------------------
// Adapter helpers
// ---------------------------------------------------------------------------

/// Builds the standard desktop emit sink for a Tauri `AppHandle`. Desktop
/// command adapters construct an `Engine` with this sink so engine events
/// reach `emit_checked_value` exactly like the historical direct emits.
pub fn app_emit_sink(app: &AppHandle) -> impl Fn(&str, serde_json::Value) + '_ {
    move |event, payload| crate::events::emit_checked_value(app, event, &payload)
}

/// Re-broadcast authoritative presentation state (wrapped with the current
/// revision, no bump) so a freshly-revealed window can hydrate even if it
/// missed events while hidden. Used by `set_output_visible`.
pub fn rebroadcast_presentation(app: &AppHandle, state: &AppState) {
    let sink = app_emit_sink(app);
    let engine = Engine { state, emit: &sink };
    engine.rebroadcast();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::license::LicenseManager;
    use crate::outputs::OutputManager;
    use crate::remote::RemoteControl;
    use crate::state::PresentationState;
    use crate::store::{
        BibleStore, CameraBackground, LowerThirdData, LowerThirdLyrics, LowerThirdNameplate,
        MediaScheduleStore, SceneLayout, SceneZone, TimerData, Verse,
    };
    use parking_lot::Mutex as PLMutex;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    fn verse_item(book: &str, verse: i32, text: &str) -> DisplayItem {
        DisplayItem::Verse(Verse {
            book: book.to_string(),
            chapter: 1,
            verse,
            text: text.to_string(),
            version: "test".to_string(),
            split_index: None,
            total_splits: None,
            score: None,
        })
    }

    fn camera_item(device: &str) -> DisplayItem {
        DisplayItem::Camera(CameraBackground {
            device_id: device.to_string(),
            opacity: 1.0,
            object_fit: "cover".to_string(),
            mirrored: false,
        })
    }

    fn zone(id: &str, source: Option<SceneZoneSource>, item: DisplayItem) -> SceneZone {
        SceneZone {
            id: id.to_string(),
            item,
            source,
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
            fit: "cover".to_string(),
            opacity: 1.0,
            z: 1,
            muted: None,
            label: None,
            font_size: None,
            font_family: None,
        }
    }

    fn scene(zones: Vec<SceneZone>) -> DisplayItem {
        DisplayItem::SceneComposition(SceneCompositionData {
            scene_id: "s1".to_string(),
            name: "Test".to_string(),
            zones,
        })
    }

    fn timer_item(label: &str) -> DisplayItem {
        DisplayItem::Timer(TimerData {
            timer_type: "countdown".to_string(),
            duration_secs: Some(60),
            label: Some(label.to_string()),
            started_at: None,
        })
    }

    /// Builds an AppState wired to a fresh temp data dir so engine tests never
    /// touch the real user data. The engine's emit sink is supplied per test
    /// (see `EventRecorder`); no Tauri runtime is needed.
    fn test_state() -> AppState {
        let dir = std::env::temp_dir().join(format!("wordlyte-engine-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        AppState {
            presentation: PresentationState::new(PresentationSettings::default()),
            store: Arc::new(BibleStore::empty_in_memory()),
            media_schedule: Arc::new(MediaScheduleStore::in_memory(dir.clone()).unwrap()),
            app_data_dir: dir.clone(),
            download_in_progress: Arc::new(AtomicBool::new(false)),
            startup_issues: Arc::new(PLMutex::new(Vec::new())),
            remote: Arc::new(RemoteControl::new(dir.clone(), &dir)),
            outputs: Arc::new(OutputManager::new(&dir)),
            rtmp: Arc::new(PLMutex::new(std::collections::HashMap::new())),
            cpu_sampler: Arc::new(PLMutex::new(None::<sysinfo::System>)),
            license: Arc::new(LicenseManager::new(&dir)),
        }
    }

    /// Records every event the engine broadcasts so tests can assert on the
    /// window-event surface as well as state.
    #[derive(Clone)]
    struct EventRecorder(Arc<PLMutex<Vec<(String, serde_json::Value)>>>);

    impl EventRecorder {
        fn new() -> Self {
            Self(Arc::new(PLMutex::new(Vec::new())))
        }

        /// Builds an `Engine` whose emit sink records every broadcast. The
        /// sink is leaked (test-only) so it can satisfy the engine's `&'a dyn
        /// Fn` borrow; the recorder's `Arc` keeps the buffer alive.
        fn engine<'a>(&'a self, state: &'a AppState) -> Engine<'a, AppState> {
            let events = Arc::clone(&self.0);
            let sink: &'static (dyn Fn(&str, serde_json::Value) + Sync) = Box::leak(Box::new(
                move |event: &str, payload: serde_json::Value| events.lock().push((event.to_string(), payload)),
            ));
            Engine { state, emit: sink }
        }

        fn events(&self) -> Vec<(String, serde_json::Value)> {
            self.0.lock().clone()
        }
    }

    #[test]
    fn zone_source_matches_item_kind() {
        assert_eq!(zone_source_for(&verse_item("John", 3, "For God so loved")), Some(SceneZoneSource::Verse));
        assert_eq!(zone_source_for(&camera_item("cam1")), Some(SceneZoneSource::Camera));
        assert_eq!(zone_source_for(&timer_item("t")), Some(SceneZoneSource::Timer));
        // A scene composition never feeds a zone.
        assert_eq!(zone_source_for(&scene(vec![])), None);
    }

    #[test]
    fn patch_updates_matching_pinned_zone_in_place() {
        let live = scene(vec![
            zone("cam", Some(SceneZoneSource::Camera), camera_item("cam1")),
            zone("verse", Some(SceneZoneSource::Verse), verse_item("John", 3, "old")),
        ]);
        let incoming = verse_item("John", 3, "For God so loved");
        let patched = patch_scene_zones(&live, &incoming).unwrap();

        let DisplayItem::SceneComposition(comp) = patched else { panic!("expected composition") };
        // Camera zone untouched, verse zone refreshed.
        assert_eq!(comp.zones.len(), 2);
        let cam = comp.zones.iter().find(|z| z.id == "cam").unwrap();
        let v = comp.zones.iter().find(|z| z.id == "verse").unwrap();
        assert!(matches!(&cam.item, DisplayItem::Camera(c) if c.device_id == "cam1"));
        assert!(matches!(&v.item, DisplayItem::Verse(x) if x.text == "For God so loved"));
    }

    #[test]
    fn patch_returns_none_when_no_zone_follows_incoming() {
        // Live scene has only a camera zone; a verse take must NOT patch.
        let live = scene(vec![zone("cam", Some(SceneZoneSource::Camera), camera_item("cam1"))]);
        assert!(patch_scene_zones(&live, &verse_item("John", 3, "hi")).is_none());

        // Static (unpinned) zones never patch, so the whole scene is replaced.
        let static_live = scene(vec![zone("verse", None, verse_item("John", 3, "old"))]);
        assert!(patch_scene_zones(&static_live, &verse_item("John", 3, "new")).is_none());

        // Incoming scene composition never patches.
        assert!(patch_scene_zones(&live, &scene(vec![])).is_none());
    }

    #[test]
    fn patch_preserves_scene_identity_and_geometry() {
        let live = scene(vec![
            zone("cam", Some(SceneZoneSource::Camera), camera_item("cam1")),
            zone("verse", Some(SceneZoneSource::Verse), verse_item("John", 3, "old")),
        ]);
        let patched = patch_scene_zones(&live, &verse_item("John", 3, "new")).unwrap();
        let DisplayItem::SceneComposition(comp) = patched else { panic!("expected composition") };
        assert_eq!(comp.scene_id, "s1");
        assert_eq!(comp.name, "Test");
        let v = comp.zones.iter().find(|z| z.id == "verse").unwrap();
        assert_eq!(v.x, 0.0);
        assert_eq!(v.w, 1.0);
        assert_eq!(v.source, Some(SceneZoneSource::Verse));
    }

    #[test]
    fn scene_zone_source_serde_round_trips() {
        let z = zone("verse", Some(SceneZoneSource::Verse), verse_item("John", 3, "hi"));
        let json = serde_json::to_value(&z).unwrap();
        assert_eq!(json["source"]["type"], "verse");
        let back: SceneZone = serde_json::from_value(json).unwrap();
        assert_eq!(back.source, Some(SceneZoneSource::Verse));

        // Absent source defaults to a static zone.
        let static_json = serde_json::json!({
            "id": "z", "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0,
            "fit": "cover", "opacity": 1.0, "z": 1,
            "item": { "type": "Camera", "data": { "deviceId": "d", "opacity": 1.0, "objectFit": "cover", "mirrored": false } }
        });
        let back2: SceneZone = serde_json::from_value(static_json).unwrap();
        assert_eq!(back2.source, None);
    }

    #[test]
    fn op_stage_bumps_once_and_returns_snapshot() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        let rev_before = state.presentation.current_revision();
        let result = eng.op_stage(verse_item("John", 3, "For God so loved"), None, 0).unwrap();

        // Single revision bump for one logical mutation.
        assert_eq!(state.presentation.current_revision(), rev_before + 1);
        assert_eq!(result.snapshot.revision, rev_before + 1);
        assert!(matches!(result.snapshot.staged, Some(DisplayItem::Verse(_))));
        assert!(result.snapshot.live.is_none());
        assert!(result.committed.is_none());
        assert!(result.scene.is_none());
        // The hub advanced too (StagedChanged published) and the window event
        // was broadcast through the emit sink.
        assert_eq!(state.remote.hub.current_revision(), 1);
        let events = rec.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "item-staged");
    }

    #[test]
    fn op_send_live_is_single_transaction_and_returns_committed() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        let rev_before = state.presentation.current_revision();
        let result = eng.op_send_live(verse_item("John", 3, "For God so loved"), None).unwrap();

        // Stage + commit collapse into ONE revision bump.
        assert_eq!(state.presentation.current_revision(), rev_before + 1);
        assert!(matches!(result.committed, Some(DisplayItem::Verse(_))));
        // Both live and staged slots are populated (staged = raw item).
        assert!(state.presentation.live_item.lock().is_some());
        assert!(state.presentation.staged_item.lock().is_some());
        // StagedChanged + LiveChanged = two hub events; item-staged +
        // live-item-update = two window events.
        assert_eq!(state.remote.hub.current_revision(), 2);
        let events = rec.events();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "item-staged");
        assert_eq!(events[1].0, "live-item-update");
    }

    #[test]
    fn op_commit_staged_noop_does_not_bump() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        let rev_before = state.presentation.current_revision();
        let result = eng.op_commit_staged(None).unwrap();
        assert_eq!(state.presentation.current_revision(), rev_before);
        assert!(result.committed.is_none());
        assert!(rec.events().is_empty());
    }

    #[test]
    fn op_send_live_patches_live_scene_zone_in_place() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        eng.op_send_live(scene(vec![
            zone("verse", Some(SceneZoneSource::Verse), verse_item("John", 3, "old")),
        ]), None).unwrap();
        let result = eng.op_send_live(verse_item("John", 3, "For God so loved"), None).unwrap();

        let DisplayItem::SceneComposition(comp) = result.committed.unwrap() else { panic!("expected composition") };
        let v = comp.zones.iter().find(|z| z.id == "verse").unwrap();
        assert!(matches!(&v.item, DisplayItem::Verse(x) if x.text == "For God so loved"));
        // Staged slot holds the raw verse, not the patched composition.
        assert!(matches!(&*state.presentation.staged_item.lock(), Some(DisplayItem::Verse(_))));
    }

    #[test]
    fn op_clear_all_resets_every_layer_and_is_atomic() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        eng.op_send_live(verse_item("John", 3, "For God so loved"), None).unwrap();
        eng.op_show_lower_third(
            LowerThirdData::Nameplate(LowerThirdNameplate { name: "Jane".into(), title: None }),
            None,
            None,
        ).unwrap();
        eng.op_set_props(vec![PropItem {
            id: "p1".into(),
            kind: "text".into(),
            path: None,
            text: Some("LOGO".into()),
            color: None,
            x: 0.0, y: 0.0, w: 100.0, h: 100.0,
            opacity: 1.0, visible: true,
        }]).unwrap();

        let rev_before = state.presentation.current_revision();
        let hub_before = state.remote.hub.current_revision();
        let result = eng.op_clear_all(None).unwrap();

        assert_eq!(state.presentation.current_revision(), rev_before + 1);
        assert!(result.snapshot.live.is_none());
        assert!(result.snapshot.staged.is_none());
        assert!(result.snapshot.lower_third.is_none());
        assert!(result.snapshot.props.is_empty());
        // Cleared props persisted so a restart does not resurrect them.
        assert!(state.media_schedule.load_props().unwrap().is_empty());
        // Clear-all itself publishes Live + Staged + LowerThird = three hub events.
        assert_eq!(state.remote.hub.current_revision(), hub_before + 3);
        // Window events: live-item-update + item-staged + lower-third-update + props-update.
        let events = rec.events();
        let names: Vec<&str> = events.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"live-item-update"));
        assert!(names.contains(&"item-staged"));
        assert!(names.contains(&"lower-third-update"));
        assert!(names.contains(&"props-update"));
    }

    #[test]
    fn presentation_events_carry_revision_and_wrapped_payloads() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);

        eng.op_send_live(verse_item("John", 3, "For God so loved"), None).unwrap();
        let rev = state.presentation.current_revision();

        // Every event of one mutation carries the SAME revision, and each is
        // wrapped under a named field so windows can order them against a
        // hydration snapshot.
        let events = rec.events();
        for (_, payload) in &events {
            assert_eq!(payload["revision"], rev);
        }
        let staged = events.iter().find(|(n, _)| n == "item-staged").unwrap().1.clone();
        assert_eq!(staged["item"]["type"], "Verse");
        let live = events.iter().find(|(n, _)| n == "live-item-update").unwrap().1.clone();
        assert_eq!(live["detected_item"]["type"], "Verse");

        eng.op_show_lower_third(
            LowerThirdData::Nameplate(LowerThirdNameplate { name: "Jane".into(), title: None }),
            None,
            None,
        ).unwrap();
        let rev2 = state.presentation.current_revision();
        let lt = rec.events().last().unwrap().1.clone();
        assert_eq!(lt["lower_third"]["data"]["data"]["name"], "Jane");
        assert_eq!(lt["revision"], rev2);

        eng.op_set_props(vec![PropItem {
            id: "p1".into(),
            kind: "text".into(),
            path: None,
            text: Some("LOGO".into()),
            color: None,
            x: 0.0, y: 0.0, w: 10.0, h: 10.0,
            opacity: 1.0, visible: true,
        }]).unwrap();
        let rev3 = state.presentation.current_revision();
        let props = rec.events().last().unwrap().1.clone();
        assert_eq!(props["props"][0]["text"], "LOGO");
        assert_eq!(props["revision"], rev3);

        // Clear-all null payloads keep the wrapped shape, all at the same
        // (latest) revision.
        let before = rec.events().len();
        eng.op_clear_all(None).unwrap();
        let rev4 = state.presentation.current_revision();
        for (name, payload) in &rec.events()[before..] {
            let check = match name.as_str() {
                "live-item-update" => Some(payload["detected_item"] == serde_json::Value::Null),
                "item-staged" => Some(payload["item"] == serde_json::Value::Null),
                "lower-third-update" => Some(payload["lower_third"] == serde_json::Value::Null),
                "props-update" => Some(payload["props"] == serde_json::json!([])),
                _ => None,
            };
            if let Some(ok) = check {
                assert!(ok, "unexpected payload for {}", name);
                assert_eq!(payload["revision"], rev4, "revision mismatch for {}", name);
            }
        }
    }

    #[test]
    fn rebroadcast_emits_wrapped_events_without_bumping_revision() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        eng.op_send_live(verse_item("John", 3, "For God so loved"), None).unwrap();
        let rev = state.presentation.current_revision();

        eng.rebroadcast();

        let events = rec.events();
        let expected = ["live-item-update", "settings-changed", "item-staged", "lower-third-update", "props-update"];
        let names: Vec<&str> = events.iter().map(|(n, _)| n.as_str()).collect();
        for name in expected {
            assert!(names.contains(&name), "missing {}", name);
        }
        // Rebroadcast is a read: no revision bump, every event at current rev.
        assert_eq!(state.presentation.current_revision(), rev);
        for (_, payload) in &events {
            assert_eq!(payload["revision"], rev);
        }
    }

    #[test]
    fn op_show_and_hide_lower_third_round_trip() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        eng.op_show_lower_third(
            LowerThirdData::Lyrics(LowerThirdLyrics {
                line1: "line one".into(),
                line2: None,
                section_label: None,
            }),
            Some(json!({ "accent": "#fff" })),
            None,
        ).unwrap();
        let lt = state.presentation.lower_third.lock().clone().unwrap();
        assert_eq!(lt["data"]["data"]["line1"], "line one");
        assert_eq!(lt["template"]["accent"], "#fff");

        eng.op_hide_lower_third(None).unwrap();
        assert!(state.presentation.lower_third.lock().is_none());
    }

    #[test]
    fn op_set_blackout_persists_and_bumps_once() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        let rev_before = state.presentation.current_revision();
        eng.op_set_blackout(true, None).unwrap();
        assert_eq!(state.presentation.current_revision(), rev_before + 1);
        assert!(state.presentation.settings.lock().is_blanked);
        assert!(state.media_schedule.load_settings().unwrap().is_blanked);
    }

    #[test]
    fn op_set_logo_persists_and_bumps_once() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        let rev_before = state.presentation.current_revision();
        eng.op_set_logo(true, None).unwrap();
        assert_eq!(state.presentation.current_revision(), rev_before + 1);
        assert!(state.presentation.settings.lock().show_background_logo);
        assert!(state.media_schedule.load_settings().unwrap().show_background_logo);
    }

    #[test]
    fn op_toggle_timer_only_publishes_when_timer_is_live() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        // No live timer: toggling bumps the revision (historical behavior) but
        // publishes no hub event and emits no window event.
        let rev_before = state.presentation.current_revision();
        let (_, toggled) = eng.op_toggle_timer(None).unwrap();
        assert!(!toggled);
        assert_eq!(state.presentation.current_revision(), rev_before + 1);
        assert_eq!(state.remote.hub.current_revision(), 0);
        assert!(rec.events().is_empty());

        eng.op_send_live(timer_item("countdown"), None).unwrap();
        let before_started = match &*state.presentation.live_item.lock() {
            Some(DisplayItem::Timer(t)) => t.started_at,
            _ => None,
        };
        let (_, toggled) = eng.op_toggle_timer(None).unwrap();
        assert!(toggled);
        let after_started = match &*state.presentation.live_item.lock() {
            Some(DisplayItem::Timer(t)) => t.started_at,
            _ => None,
        };
        assert_ne!(before_started, after_started);
        assert!(state.remote.hub.current_revision() >= 1);
    }

    #[test]
    fn op_apply_scene_is_one_logical_transaction() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        let scene = crate::store::Scene {
            id: "scene-1".into(),
            name: "Camera + Verse".into(),
            settings: PresentationSettings::default(),
            props: vec![],
            lower_third_data: Some(LowerThirdData::Nameplate(LowerThirdNameplate {
                name: "Pastor Jane".into(),
                title: None,
            })),
            lower_third_template: Some(json!({ "template": "modern" })),
            camera: Some(camera_item("cam1")),
            layout: None,
            created_at: 0,
        };
        state.media_schedule.save_scene(scene).unwrap();

        let rev_before = state.presentation.current_revision();
        let result = eng.op_apply_scene("scene-1".into()).unwrap();

        // ONE revision bump for the whole scene application.
        assert_eq!(state.presentation.current_revision(), rev_before + 1);
        assert!(result.scene.is_some());
        assert!(matches!(result.committed, Some(DisplayItem::Camera(_))));
        // All layers applied together.
        assert!(matches!(&*state.presentation.live_item.lock(), Some(DisplayItem::Camera(_))));
        assert!(state.presentation.lower_third.lock().is_some());
        // Persisted before mutation (settings + props on disk).
        assert!(state.media_schedule.load_settings().is_ok());
        // StagedChanged NOT published (camera scene publishes only LiveChanged).
        assert_eq!(state.remote.hub.current_revision(), 1);
        // Window events: live-item-update + settings-changed + props-update +
        // lower-third-update.
        let events = rec.events();
        let names: Vec<&str> = events.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"live-item-update"));
        assert!(names.contains(&"settings-changed"));
        assert!(names.contains(&"props-update"));
        assert!(names.contains(&"lower-third-update"));
    }

    #[test]
    fn op_apply_scene_layout_stages_composition_and_publishes_staged() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        let scene = crate::store::Scene {
            id: "scene-layout".into(),
            name: "Split".into(),
            settings: PresentationSettings::default(),
            props: vec![],
            lower_third_data: None,
            lower_third_template: None,
            camera: None,
            layout: Some(SceneLayout {
                zones: vec![zone("verse", Some(SceneZoneSource::Verse), verse_item("John", 3, "hi"))],
            }),
            created_at: 0,
        };
        state.media_schedule.save_scene(scene).unwrap();

        let result = eng.op_apply_scene("scene-layout".into()).unwrap();
        assert!(matches!(result.committed, Some(DisplayItem::SceneComposition(_))));
        assert!(matches!(&*state.presentation.staged_item.lock(), Some(DisplayItem::SceneComposition(_))));
        // Layout scene publishes StagedChanged + LiveChanged.
        assert_eq!(state.remote.hub.current_revision(), 2);
    }

    #[test]
    fn op_apply_scene_missing_scene_errors() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        assert!(eng.op_apply_scene("nope".into()).is_err());
    }

    #[test]
    fn op_set_props_rejects_paths_outside_app_data() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        let bad = PropItem {
            id: "p".into(),
            kind: "image".into(),
            path: Some("C:\\Windows\\system32\\notepad.exe".into()),
            text: None,
            color: None,
            x: 0.0, y: 0.0, w: 10.0, h: 10.0,
            opacity: 1.0, visible: true,
        };
        assert!(eng.op_set_props(vec![bad]).is_err());
        // Rejected batch must not touch the props layer.
        assert!(state.presentation.props_layer.lock().is_empty());
    }

    #[test]
    fn op_save_settings_publishes_only_changed_deltas() {
        let state = test_state();
        let rec = EventRecorder::new();
        let eng = rec.engine(&state);
        let mut settings = PresentationSettings::default();
        // First save flips nothing -> no BlackoutChanged/LogoChanged publishes.
        let rev = state.presentation.current_revision();
        eng.op_save_settings(settings.clone()).unwrap();
        assert_eq!(state.presentation.current_revision(), rev + 1);
        assert_eq!(state.remote.hub.current_revision(), 0);

        // Flipping blackout publishes exactly one BlackoutChanged.
        settings.is_blanked = true;
        eng.op_save_settings(settings.clone()).unwrap();
        assert_eq!(state.remote.hub.current_revision(), 1);
    }

    #[test]
    fn snapshot_matches_state_and_carries_schema_version() {
        let state = test_state();
        let snap = snapshot(&state);
        assert_eq!(snap.schema_version, PRESENTATION_SCHEMA_VERSION);
        assert_eq!(snap.revision, state.presentation.current_revision());
        assert!(snap.live.is_none());
        assert!(snap.settings.is_blanked == state.presentation.settings.lock().is_blanked);
    }
}