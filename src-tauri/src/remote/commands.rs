use crate::events::{emit_checked, LiveItemUpdate};
use crate::remote::auth::StoredDevice;
use crate::remote::protocol::{
    RemoteCameraIcePayload, RemoteCameraOfferPayload, RemoteCameraStartPayload,
    RemoteCommand, RemoteCommandResult, RemoteCommandType, RemoteEventKind,
    RemoteLowerThirdPayload, RemotePermission, RemoteSongControl, RemoteSongLinesRequest,
    RemoteSongSearch, RemoteSongSummary, RemoteStudioPresentation, RemoteStudioSlideInfo,
    RemoteStudioSlidePayload, RemoteTimerPayload, RemoteVerseRef,
};
use crate::remote::{RemoteControl, DESKTOP_CONTROLLER_ID};
use crate::state::AppState;
use crate::store::{CustomSlideData, DisplayItem, LowerThirdData, LyricSection, SceneCompositionData, SceneZone, SceneZoneSource, Schedule, ScheduleEntry, SearchResponse, Song, SongSlideData};
use serde_json::json;
use tauri::AppHandle;

const NOT_IMPLEMENTED: &str = "not_implemented";

fn err_result(command_id: &str, revision: u64, code: &str, message: &str) -> RemoteCommandResult {
    RemoteCommandResult::err(command_id, revision, code, message)
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Broadcast the current phone-camera list so every window's Camera tab stays
/// in sync when a phone starts/stops a camera or disconnects.
async fn emit_phone_cameras(app: &AppHandle, control: &RemoteControl) {
    let cameras = control.list_phone_cameras().await;
    emit_checked(app, "phone-cameras-changed", &json!({ "cameras": cameras }));
}

// ---------------------------------------------------------------------------
// Shared display operations (used by both Tauri commands and remote dispatch)
// ---------------------------------------------------------------------------

/// Map an incoming display item to the `SceneZoneSource` bus class that would
/// consume it inside a scene composition. `SceneComposition` items never
/// follow a zone (a zone can't host a nested scene) so they return `None`.
fn zone_source_for(item: &DisplayItem) -> Option<SceneZoneSource> {
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
fn patch_scene_zones(live: &DisplayItem, incoming: &DisplayItem) -> Option<DisplayItem> {
    let DisplayItem::SceneComposition(comp) = live else { return None };
    let source = zone_source_for(incoming)?;
    let mut patched = false;
    let zones: Vec<SceneZone> = comp.zones.iter().map(|z| {
        if z.source.as_ref() == Some(&source) {
            patched = true;
            let mut z2 = z.clone();
            z2.item = incoming.clone();
            z2
        } else {
            z.clone()
        }
    }).collect();
    if !patched {
        return None;
    }
    Some(DisplayItem::SceneComposition(SceneCompositionData {
        scene_id: comp.scene_id.clone(),
        name: comp.name.clone(),
        zones,
    }))
}

pub fn op_stage(app: &AppHandle, state: &AppState, item: DisplayItem, source: Option<String>, revision: u64) {
    *state.presentation.staged_item.lock() = Some(item.clone());
    emit_checked(app, "item-staged", &item);
    state.remote.hub.publish(RemoteEventKind::StagedChanged, json!({ "staged_item": item }), source);
    let _ = revision;
}

/// Commit the staged item as live, patching pinned scene-zone buses when the
/// current live item is a composition that follows the staged content class.
pub fn op_commit_staged(app: &AppHandle, state: &AppState, source: Option<String>) -> Option<DisplayItem> {
    let mut live = state.presentation.live_item.lock();
    let staged = state.presentation.staged_item.lock().clone();
    let committed = match (&*live, &staged) {
        (Some(live_item), Some(staged_item)) => {
            Some(patch_scene_zones(live_item, staged_item).unwrap_or_else(|| staged_item.clone()))
        }
        _ => staged.clone(),
    };
    *live = committed.clone();
    drop(live);
    let update = LiveItemUpdate { detected_item: committed.clone() };
    emit_checked(app, "live-item-update", &update);
    state.remote.hub.publish(RemoteEventKind::LiveChanged, json!({ "live_item": committed }), source);
    committed
}

pub fn op_clear_live(app: &AppHandle, state: &AppState, source: Option<String>) {
    *state.presentation.live_item.lock() = None;
    emit_checked(app, "live-item-update", &LiveItemUpdate { detected_item: None });
    let staged = state.presentation.staged_item.lock().clone();
    emit_checked(app, "item-staged", &staged);
    state.remote.hub.publish(RemoteEventKind::LiveChanged, json!({ "live_item": null }), source.clone());
    state.remote.hub.publish(RemoteEventKind::StagedChanged, json!({ "staged_item": staged }), source);
}

pub fn op_go_live_item(app: &AppHandle, state: &AppState, item: DisplayItem, source: Option<String>) {
    let mut live = state.presentation.live_item.lock();
    let committed = match &*live {
        // Phase 5: when a scene composition is live and the sent item matches
        // a pinned zone bus, refresh that zone in place instead of replacing
        // the whole scene (e.g. remote "camera.send_live" into a camera zone).
        Some(live_item) => patch_scene_zones(live_item, &item).unwrap_or(item.clone()),
        None => item.clone(),
    };
    *live = Some(committed.clone());
    drop(live);
    let update = LiveItemUpdate { detected_item: Some(committed.clone()) };
    emit_checked(app, "live-item-update", &update);
    state.remote.hub.publish(RemoteEventKind::LiveChanged, json!({ "live_item": committed }), source);
}

pub fn op_clear_all(app: &AppHandle, state: &AppState, source: Option<String>) {
    *state.presentation.live_item.lock() = None;
    *state.presentation.staged_item.lock() = None;
    *state.presentation.lower_third.lock() = None;
    state.presentation.props_layer.lock().clear();

    emit_checked(app, "live-item-update", &LiveItemUpdate { detected_item: None });
    emit_checked(app, "item-staged", &Option::<DisplayItem>::None);
    emit_checked(app, "lower-third-update", &Option::<serde_json::Value>::None);
    emit_checked(app, "props-update", &Vec::<crate::store::PropItem>::new());

    state.remote.hub.publish(RemoteEventKind::LiveChanged, json!({ "live_item": null }), source.clone());
    state.remote.hub.publish(RemoteEventKind::StagedChanged, json!({ "staged_item": null }), source.clone());
    state.remote.hub.publish(RemoteEventKind::LowerThirdChanged, json!({ "lower_third": null }), source);
}

pub fn op_set_blackout(app: &AppHandle, state: &AppState, on: bool, source: Option<String>) -> Result<(), String> {
    let mut settings = state.presentation.settings.lock().clone();
    settings.is_blanked = on;
    state.media_schedule.save_settings(&settings).map_err(|e| e.to_string())?;
    *state.presentation.settings.lock() = settings.clone();
    emit_checked(app, "settings-changed", &settings);
    state.remote.hub.publish(RemoteEventKind::BlackoutChanged, json!({ "blackout": on }), source);
    Ok(())
}

/// Transactional send-live: stage the resolved item, then commit only if
/// staging succeeded. On commit failure the previous staged item is restored.
pub fn op_send_live(app: &AppHandle, state: &AppState, item: DisplayItem, source: Option<String>) -> Result<DisplayItem, String> {
    let previous_staged = state.presentation.staged_item.lock().clone();
    op_stage(app, state, item.clone(), source.clone(), 0);
    let committed = match op_commit_staged(app, state, source) {
        Some(c) => c,
        None => {
            *state.presentation.staged_item.lock() = previous_staged.clone();
            emit_checked(app, "item-staged", &previous_staged);
            return Err("Could not commit staged item".into());
        }
    };
    Ok(committed)
}

// ---------------------------------------------------------------------------
// Verse resolution
// ---------------------------------------------------------------------------

pub fn resolve_verse(state: &AppState, r: &RemoteVerseRef) -> Result<DisplayItem, String> {
    let verse = state
        .store
        .get_verse(&r.book, r.chapter, r.verse, &r.version)
        .map_err(|e: anyhow::Error| e.to_string())?
        .ok_or_else(|| format!("Verse {} {}:{} not found in {}", r.book, r.chapter, r.verse, r.version))?;
    Ok(DisplayItem::Verse(verse))
}

pub fn resolve_next_verse(state: &AppState, r: &RemoteVerseRef) -> Result<DisplayItem, String> {
    let verse = state
        .store
        .get_next_verse(&r.book, r.chapter, r.verse, &r.version)
        .map_err(|e: anyhow::Error| e.to_string())?
        .ok_or_else(|| "No next verse".to_string())?;
    Ok(DisplayItem::Verse(verse))
}

pub fn resolve_prev_verse(state: &AppState, r: &RemoteVerseRef) -> Result<DisplayItem, String> {
    let verse = state
        .store
        .get_prev_verse(&r.book, r.chapter, r.verse, &r.version)
        .map_err(|e: anyhow::Error| e.to_string())?
        .ok_or_else(|| "No previous verse".to_string())?;
    Ok(DisplayItem::Verse(verse))
}

#[cfg_attr(test, allow(dead_code))]
pub fn resolve_bible_versions(state: &AppState) -> Vec<String> {
    let settings = state.presentation.settings.lock().clone();
    state
        .store
        .get_available_versions()
        .into_iter()
        .filter(|v| !settings.disabled_bible_versions.contains(v))
        .collect()
}

pub fn search_bible(state: &AppState, query: &str, version: &str) -> Result<SearchResponse, String> {
    state.store.search_all(query, version).map_err(|e: anyhow::Error| e.to_string())
}

// ---------------------------------------------------------------------------
// Song resolution
// ---------------------------------------------------------------------------

/// Canonical song section sequence: `arrangement_steps` (id-based) → legacy
/// `arrangement` (labels) → section order. Mirrors the frontend
/// `getSongSequence` in `src/utils/song.ts`.
pub fn song_sequence(song: &Song) -> Vec<&LyricSection> {
    if let Some(steps) = &song.arrangement_steps {
        let out: Vec<&LyricSection> = steps
            .iter()
            .filter_map(|step| song.sections.iter().find(|s| s.id.as_deref() == Some(step.section_id.as_str())))
            .collect();
        if !out.is_empty() {
            return out;
        }
    }
    if !song.arrangement.is_empty() {
        let out: Vec<&LyricSection> = song
            .arrangement
            .iter()
            .filter_map(|label| song.sections.iter().find(|s| s.label == *label))
            .collect();
        if !out.is_empty() {
            return out;
        }
    }
    song.sections.iter().collect()
}

/// Builds a full-screen `Song` display item for a sequence index (clamped to a
/// valid slide), carrying the display mode and per-song styling so stage and
/// commit never drop the full-screen vs overlay distinction.
pub fn build_song_slide(song: &Song, index: usize, style: Option<String>) -> Result<DisplayItem, String> {
    let sequence = song_sequence(song);
    if sequence.is_empty() {
        return Err("Song has no sections".into());
    }
    let idx = if index < sequence.len() { index } else { 0 };
    let section = sequence[idx];
    Ok(DisplayItem::Song(SongSlideData {
        song_id: song.id.clone(),
        title: song.title.clone(),
        author: song.author.clone(),
        section_label: section.label.clone(),
        lines: section.lines.clone(),
        slide_index: idx as u32,
        total_slides: sequence.len() as u32,
        style: style.or_else(|| song.style.clone()),
        font: song.font.clone(),
        font_size: song.font_size,
        font_weight: song.font_weight.clone(),
        color: song.color.clone(),
        background: song.background.clone(),
        lt_template_id: song.lt_template_id.clone(),
    }))
}

/// Finds a song by id in the user library, falling back to the bundled hymn
/// library.
pub async fn resolve_song(app: &AppHandle, state: &AppState, id: &str) -> Option<Song> {
    if let Some(song) = state.media_schedule.list_songs().ok()?.into_iter().find(|s| s.id == id) {
        return Some(song);
    }
    if let Ok(hymns) = crate::commands::misc::get_hymn_library(app.clone()).await {
        return hymns.into_iter().find(|s| s.id == id);
    }
    None
}

pub fn song_summary(song: &Song) -> RemoteSongSummary {
    RemoteSongSummary {
        id: song.id.clone(),
        title: song.title.clone(),
        style: song.style.clone(),
        section_labels: crate::remote::snapshot::song_section_labels(song),
    }
}

/// Searchable lowercase text for a song (title, author, key) plus every lyric
/// line so a volunteer can find songs by content.
fn song_searchable(song: &Song) -> String {
    let mut parts = vec![song.title.clone()];
    if let Some(a) = &song.author {
        parts.push(a.clone());
    }
    if let Some(k) = &song.key {
        parts.push(k.clone());
    }
    for section in &song.sections {
        parts.push(section.label.clone());
        parts.extend(section.lines.iter().cloned());
    }
    parts.join(" ").to_lowercase()
}

// ---------------------------------------------------------------------------
// Studio presentation helpers
// ---------------------------------------------------------------------------

/// Best-effort first-line text of a slide for the phone list. Prefers the text
/// element carrying the "title" role, otherwise the first non-empty text
/// element. Falls back to "Slide N" for image-only slides.
fn slide_title(slide: &crate::store::CustomSlide, index: usize) -> String {
    let mut first_text: Option<String> = None;
    for el in &slide.elements {
        if el.kind != "text" {
            continue;
        }
        let mut runs: Vec<String> = Vec::new();
        collect_text(&el.content, &mut runs);
        let compact = runs.join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
        if compact.is_empty() {
            continue;
        }
        if el.role.as_deref() == Some("title") {
            return truncate_title(&compact);
        }
        if first_text.is_none() {
            first_text = Some(compact);
        }
    }
    first_text
        .map(|t| truncate_title(&t))
        .unwrap_or_else(|| format!("Slide {}", index + 1))
}

/// Recursively collect text runs from a ProseMirror JSON doc. The legacy
/// HTML-string escape hatch is stripped of tags before it is returned.
fn collect_text(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => {
            if s.contains('<') {
                let stripped = strip_html(s);
                if !stripped.trim().is_empty() {
                    out.push(stripped);
                }
            } else if !s.trim().is_empty() {
                out.push(s.clone());
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(t) = map.get("text").and_then(|v| v.as_str()) {
                if !t.trim().is_empty() {
                    out.push(t.to_string());
                }
            }
            if let Some(arr) = map.get("content").and_then(|v| v.as_array()) {
                for child in arr {
                    collect_text(child, out);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for child in arr {
                collect_text(child, out);
            }
        }
        _ => {}
    }
}

fn strip_html(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn truncate_title(t: &str) -> String {
    const MAX: usize = 48;
    let t = t.trim();
    if t.chars().count() <= MAX {
        t.to_string()
    } else {
        format!("{}…", t.chars().take(MAX).collect::<String>())
    }
}

// ---------------------------------------------------------------------------
// Service queue helpers
// ---------------------------------------------------------------------------

/// Appends `item` to the active service through the shared schedule persistence
/// path and broadcasts the new queue to all remotes.
pub fn op_add_to_service(state: &AppState, item: DisplayItem, source: Option<String>) -> Result<(), String> {
    let services = state.media_schedule.list_services().map_err(|e| e.to_string())?;
    let id = crate::remote::snapshot::persisted_active_service_id(state)
        .or_else(|| services.first().map(|s| s.id.clone()))
        .ok_or_else(|| "No service available".to_string())?;

    let mut schedule = match state.media_schedule.load_service(&id) {
        Ok(s) => s,
        Err(_) => Schedule {
            id: id.clone(),
            name: services.iter().find(|s| s.id == id).map(|s| s.name.clone()).unwrap_or_else(|| "Service".into()),
            items: Vec::new(),
        },
    };
    schedule.items.push(ScheduleEntry { id: uuid::Uuid::new_v4().to_string(), item });
    state.media_schedule.save_service(&schedule).map_err(|e| e.to_string())?;

    let (meta, entries) = crate::remote::snapshot::active_service_snapshot(state);
    state.remote.hub.publish(
        RemoteEventKind::ScheduleChanged,
        json!({ "active_service": meta, "entries": entries }),
        source,
    );
    Ok(())
}

/// Stages the next/previous entry of the active service queue relative to the
/// current live item (falling back to the first/last entry).
pub fn op_stage_queue_neighbor(app: &AppHandle, state: &AppState, dir: i32, source: Option<String>) -> Result<(), String> {
    let (_meta, entries) = crate::remote::snapshot::active_service_snapshot(state);
    if entries.is_empty() {
        return Err("No service entries".into());
    }
    let live = state.presentation.live_item.lock().clone();
    let live_json = live.as_ref().and_then(|i| serde_json::to_value(i).ok());
    let current_idx = live_json.as_ref().and_then(|lv| entries.iter().position(|e| serde_json::to_value(&e.item).ok().as_ref() == Some(lv)));
    let idx = match current_idx {
        Some(i) => (i as i32 + dir).clamp(0, entries.len() as i32 - 1) as usize,
        None if dir > 0 => 0,
        None => entries.len() - 1,
    };
    op_stage(app, state, entries[idx].item.clone(), source, 0);
    Ok(())
}

// ---------------------------------------------------------------------------
// Lower third helpers
// ---------------------------------------------------------------------------

/// Shows a lower-third overlay through the authoritative presentation state.
pub fn op_show_lower_third(app: &AppHandle, state: &AppState, data: LowerThirdData, template: Option<serde_json::Value>, source: Option<String>) {
    let payload = json!({ "data": data, "template": template.unwrap_or_else(|| json!({})) });
    *state.presentation.lower_third.lock() = Some(payload.clone());
    emit_checked(app, "lower-third-update", &Some(payload.clone()));
    state.remote.hub.publish(RemoteEventKind::LowerThirdChanged, json!({ "lower_third": payload }), source);
}

/// Hides any lower-third overlay and propagates the null change.
pub fn op_hide_lower_third(app: &AppHandle, state: &AppState, source: Option<String>) {
    *state.presentation.lower_third.lock() = None;
    emit_checked(app, "lower-third-update", &Option::<serde_json::Value>::None);
    state.remote.hub.publish(RemoteEventKind::LowerThirdChanged, json!({ "lower_third": null }), source);
}

/// Resolves the full lower-third template the remote wants to project. A
/// `template_id` referencing a saved template wins; otherwise the raw
/// `template` JSON is used as-is; otherwise an empty object (renders with
/// defaults). A FreeText `scroll` override is merged onto the resolved
/// template so phone users can toggle ticker behavior without editing
/// templates on the operator machine.
fn resolve_lt_template(
    state: &AppState,
    raw: Option<serde_json::Value>,
    template_id: Option<String>,
    scroll: Option<crate::remote::protocol::RemoteLtScroll>,
) -> Option<serde_json::Value> {
    let mut tpl = match &template_id {
        Some(id) => state
            .media_schedule
            .load_lt_templates()
            .ok()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .find(|t| t.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
            .or(raw),
        None => raw,
    };
    if let Some(scroll) = scroll {
        let mut obj = tpl.unwrap_or_else(|| serde_json::json!({}));
        if let Some(map) = obj.as_object_mut() {
            map.insert("scrollEnabled".into(), json!(scroll.enabled));
            map.insert("scrollDirection".into(), json!(scroll.direction));
            map.insert("scrollCount".into(), json!(scroll.count));
        }
        tpl = Some(obj);
    }
    tpl
}

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

fn require_permission(control: &RemoteControl, device: &StoredDevice, perm: RemotePermission) -> Result<(), String> {
    // Read the *live* permissions from the token store rather than the cached
    // socket copy so a device demoted/revoked by the operator is restricted
    // immediately.
    let permissions = control
        .tokens
        .device(&device.id)
        .map(|d| d.permissions)
        .unwrap_or_else(|| device.permissions);
    if permissions.has(perm) {
        Ok(())
    } else {
        Err("This device is not granted that permission — ask the operator to allow it".into())
    }
}

/// The content permission a mutating command requires, or `None` for
/// lease/control lifecycle commands (which are gated separately).
fn required_permission(t: RemoteCommandType) -> Option<RemotePermission> {
    use RemoteCommandType::*;
    Some(match t {
        BibleStage
        | BibleGoLive
        | BibleStageNext
        | BibleGoLiveNext
        | BibleStagePrevious
        | BibleGoLivePrevious
        | BibleAddToService => RemotePermission::Scripture,
        SongStage | SongGoLive => RemotePermission::Song,
        LowerThirdShow | LowerThirdHide => RemotePermission::LowerThird,
        CameraStart | CameraStop => RemotePermission::Camera,
        DisplayGoLive
        | DisplayStageNext
        | DisplayStagePrevious
        | DisplayClearLive
        | DisplayClearAll
        | DisplayBlackout
        | DisplayLogoToggle
        | TimerStage
        | TimerGoLive
        | TimerToggle
        | StudioStage
        | StudioGoLive => RemotePermission::Presentation,
        _ => return None,
    })
}

fn require_lease(control: &RemoteControl, device: &StoredDevice) -> Result<(), String> {
    if device.id == DESKTOP_CONTROLLER_ID {
        return Ok(());
    }
    if !control.lease.is_held_by(&device.id) {
        return Err("No controller lease — request control first".into());
    }
    Ok(())
}

fn check_revision(control: &RemoteControl, expected: Option<u64>) -> Result<(), String> {
    if let Some(expected) = expected {
        let current = control.hub.current_revision();
        if expected < current {
            return Err(format!(
                "Stale client (expected revision {}, current {})",
                expected, current
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Handles one authenticated command from a connected remote. All reads run
/// without a lease; mutating commands require the device's content permission
/// and the controller lease. The returned result carries the backend revision
/// after any mutation.
pub async fn dispatch(
    app: &AppHandle,
    state: &AppState,
    control: &RemoteControl,
    device: &StoredDevice,
    command: &RemoteCommand,
) -> RemoteCommandResult {
    // Camera start/stop are register-only for the phone feed (the operator
    // picks which feed to stage in the Camera tab), so they deliberately do
    // NOT require the controller lease — a phone may stream a camera without
    // taking over presentation control. They are also exempt from the revision
    // gate: re-registering on rotation (to report the new physical
    // orientation) must never be dropped just because the phone's
    // `expected_revision` raced with an unrelated hub event, or the projected
    // feed would keep the stale orientation until the revision caught up.
    let camera_register = matches!(
        command.r#type,
        RemoteCommandType::CameraStart | RemoteCommandType::CameraStop
    );

    // Mutating commands must pass the revision + permission gates before
    // touching authoritative state. Read-only commands skip the lease check.
    if is_mutating(command.r#type.clone()) {
        if !camera_register {
            if let Err(e) = check_revision(control, command.expected_revision) {
                return err_result(&command.command_id, control.hub.current_revision(), "stale_revision", &e);
            }
        }
        // `RemoteRequestControl` is what *acquires* the lease, so it bypasses
        // the lease gate but still needs at least one content permission to be
        // meaningful (a read-only viewer cannot take control).
        if command.r#type == RemoteCommandType::RemoteRequestControl {
            let permissions = control
                .tokens
                .device(&device.id)
                .map(|d| d.permissions)
                .unwrap_or_else(|| device.permissions);
            if !permissions.any() {
                return err_result(
                    &command.command_id,
                    control.hub.current_revision(),
                    "forbidden",
                    "This device has no control permissions — the operator must grant one first",
                );
            }
        } else {
            // Content commands need their specific permission; lease lifecycle
            // commands (release/renew) skip the permission check.
            if let Some(perm) = required_permission(command.r#type.clone()) {
                if let Err(e) = require_permission(control, device, perm) {
                    return err_result(&command.command_id, control.hub.current_revision(), "forbidden", &e);
                }
            }
            // Camera start/stop are register-only for the phone feed, so they
            // deliberately do NOT require the controller lease — a phone may
            // stream a camera without taking over presentation control.
            if !camera_register {
                if let Err(e) = require_lease(control, device) {
                    return err_result(&command.command_id, control.hub.current_revision(), "lease_required", &e);
                }
            }
        }
    }

    let source = Some(device.id.clone());

    match command.r#type {
        RemoteCommandType::SnapshotGet => {
            let permissions = control
                .tokens
                .device(&device.id)
                .map(|d| d.permissions)
                .unwrap_or_else(|| device.permissions);
            let snapshot = crate::remote::snapshot::build_snapshot(
                app,
                state,
                device.role.clone(),
                permissions,
                Some(device.id.clone()),
                control.lease.state(),
            );
            RemoteCommandResult::ok_with(&command.command_id, control.hub.current_revision(), json!(snapshot))
        }
        RemoteCommandType::BibleVersions => {
            RemoteCommandResult::ok_with(&command.command_id, control.hub.current_revision(), json!(resolve_bible_versions(state)))
        }
        RemoteCommandType::BibleBooks => {
            let version = payload_str(command, "version").unwrap_or_default();
            let books = state.store.get_books(&version).map_err(|e: anyhow::Error| e.to_string());
            result_from(&command.command_id, control.hub.current_revision(), books.and_then(|b| serde_json::to_value(b).map_err(|e| e.to_string())))
        }
        RemoteCommandType::BibleChapters => {
            let book = payload_str(command, "book").unwrap_or_default();
            let version = payload_str(command, "version").unwrap_or_default();
            let chapters = state.store.get_chapters(&book, &version).map_err(|e: anyhow::Error| e.to_string());
            result_from(&command.command_id, control.hub.current_revision(), chapters.and_then(|c| serde_json::to_value(c).map_err(|e| e.to_string())))
        }
        RemoteCommandType::BibleVerseNumbers => {
            let book = payload_str(command, "book").unwrap_or_default();
            let chapter = payload_u32(command, "chapter");
            let version = payload_str(command, "version").unwrap_or_default();
            let counts = state.store.get_verses_count(&book, chapter, &version).map_err(|e: anyhow::Error| e.to_string());
            result_from(&command.command_id, control.hub.current_revision(), counts.and_then(|c| serde_json::to_value(c).map_err(|e| e.to_string())))
        }
        RemoteCommandType::BibleChapter => {
            let req = command_payload::<crate::remote::protocol::RemoteBibleChapterRequest>(command).ok();
            let resp = match req {
                Some(r) => state.store.get_chapter_verses(&r.book, r.chapter, &r.version).map_err(|e: anyhow::Error| e.to_string()),
                None => Err("Missing book/chapter/version".to_string()),
            };
            result_from(&command.command_id, control.hub.current_revision(), resp.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())))
        }
        RemoteCommandType::BibleSearch => {
            let req = command_payload::<crate::remote::protocol::RemoteBibleSearch>(command).ok();
            let resp = match req {
                Some(r) => search_bible(state, &r.query, &r.version),
                None => Err("Missing query/version".to_string()),
            };
            result_from(&command.command_id, control.hub.current_revision(), resp.and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string())))
        }
        RemoteCommandType::BibleStage => {
            let r = command_payload::<RemoteVerseRef>(command).ok();
            let resp = match r {
                Some(r) => resolve_verse(state, &r).map(|item| op_stage(app, state, item, source.clone(), control.hub.current_revision())),
                None => Err("Missing verse reference".into()),
            };
            match resp {
                Ok(()) => RemoteCommandResult::ok(&command.command_id, control.hub.current_revision()),
                Err(e) => err_result(&command.command_id, control.hub.current_revision(), "stage_failed", &e),
            }
        }
        RemoteCommandType::BibleGoLive => {
            let r = command_payload::<RemoteVerseRef>(command).ok();
            let resp = match r {
                Some(r) => resolve_verse(state, &r).and_then(|item| op_send_live(app, state, item, source.clone())),
                None => Err("Missing verse reference".into()),
            };
            match resp {
                Ok(_) => RemoteCommandResult::ok(&command.command_id, control.hub.current_revision()),
                Err(e) => err_result(&command.command_id, control.hub.current_revision(), "go_live_failed", &e),
            }
        }
        RemoteCommandType::BibleStageNext | RemoteCommandType::BibleStagePrevious => {
            let r = command_payload::<RemoteVerseRef>(command).ok();
            let next = if command.r#type == RemoteCommandType::BibleStageNext {
                r.as_ref().and_then(|r| resolve_next_verse(state, r).ok())
            } else {
                r.as_ref().and_then(|r| resolve_prev_verse(state, r).ok())
            };
            match next {
                Some(item) => {
                    op_stage(app, state, item, source.clone(), control.hub.current_revision());
                    RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
                }
                None => err_result(&command.command_id, control.hub.current_revision(), "no_next_verse", "No next/previous verse"),
            }
        }
        RemoteCommandType::BibleGoLiveNext | RemoteCommandType::BibleGoLivePrevious => {
            let r = command_payload::<RemoteVerseRef>(command).ok();
            let next = if command.r#type == RemoteCommandType::BibleGoLiveNext {
                r.as_ref().and_then(|r| resolve_next_verse(state, r).ok())
            } else {
                r.as_ref().and_then(|r| resolve_prev_verse(state, r).ok())
            };
            match next {
                Some(item) => {
                    let _ = op_send_live(app, state, item, source.clone());
                    RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
                }
                None => err_result(&command.command_id, control.hub.current_revision(), "no_next_verse", "No next/previous verse"),
            }
        }
        RemoteCommandType::DisplayGoLive => {
            match op_commit_staged(app, state, source.clone()) {
                Some(_) => RemoteCommandResult::ok(&command.command_id, control.hub.current_revision()),
                None => err_result(&command.command_id, control.hub.current_revision(), "nothing_staged", "No staged item to go live"),
            }
        }
        RemoteCommandType::DisplayClearLive => {
            op_clear_live(app, state, source.clone());
            RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
        }
        RemoteCommandType::DisplayClearAll => {
            op_clear_all(app, state, source.clone());
            RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
        }
        RemoteCommandType::DisplayBlackout => {
            let on = command_payload::<serde_json::Value>(command).map(|v| v.get("on").and_then(|v| v.as_bool()).unwrap_or(true)).unwrap_or(true);
            match op_set_blackout(app, state, on, source.clone()) {
                Ok(()) => RemoteCommandResult::ok(&command.command_id, control.hub.current_revision()),
                Err(e) => err_result(&command.command_id, control.hub.current_revision(), "blackout_failed", &e),
            }
        }
        RemoteCommandType::RemoteRequestControl => {
            let name = device.name.clone();
            let acquired = control.lease.request(&device.id, &name);
            control.hub.publish(RemoteEventKind::ControllerChanged, json!({ "controller_state": control.lease.state() }), None);
            if acquired {
                control.hub.publish(
                    RemoteEventKind::OperatorNotice,
                    json!({ "message": format!("{} is now controlling the presentation", name) }),
                    None,
                );
            }
            let rev = control.hub.current_revision();
            if acquired {
                RemoteCommandResult::ok_with(&command.command_id, rev, json!({ "controller_state": control.lease.state() }))
            } else {
                err_result(&command.command_id, rev, "lease_busy", "Another device holds control")
            }
        }
        RemoteCommandType::RemoteReleaseControl => {
            control.lease.release(&device.id);
            control.hub.publish(RemoteEventKind::ControllerChanged, json!({ "controller_state": control.lease.state() }), None);
            RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
        }
        RemoteCommandType::RemoteRenewLease => {
            let renewed = control.lease.renew(&device.id);
            if renewed {
                control.hub.publish(RemoteEventKind::ControllerChanged, json!({ "controller_state": control.lease.state() }), Some(device.id.clone()));
            }
            RemoteCommandResult::ok_with(&command.command_id, control.hub.current_revision(), json!({ "renewed": renewed }))
        }
        RemoteCommandType::ServiceList => {
            let (meta, entries) = crate::remote::snapshot::active_service_snapshot(state);
            RemoteCommandResult::ok_with(
                &command.command_id,
                control.hub.current_revision(),
                json!({ "active_service": meta, "entries": entries }),
            )
        }
        RemoteCommandType::BibleAddToService => {
            let r = command_payload::<RemoteVerseRef>(command).ok();
            let resp = match r {
                Some(r) => resolve_verse(state, &r).and_then(|item| op_add_to_service(state, item, source.clone())),
                None => Err("Missing verse reference".into()),
            };
            match resp {
                Ok(()) => RemoteCommandResult::ok(&command.command_id, control.hub.current_revision()),
                Err(e) => err_result(&command.command_id, control.hub.current_revision(), "add_to_service_failed", &e),
            }
        }
        RemoteCommandType::StudioList => {
            let mut result: Vec<RemoteStudioPresentation> = Vec::new();
            if let Ok(summaries) = state.media_schedule.list_studio_presentations() {
                for s in summaries {
                    let slides = state
                        .media_schedule
                        .load_studio_presentation(&s.id)
                        .map(|p| {
                            p.slides
                                .iter()
                                .enumerate()
                                .map(|(i, sl)| RemoteStudioSlideInfo {
                                    index: i as u32,
                                    title: slide_title(sl, i),
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    result.push(RemoteStudioPresentation {
                        id: s.id,
                        name: s.name,
                        slide_count: s.slide_count,
                        slides,
                    });
                }
            }
            RemoteCommandResult::ok_with(&command.command_id, control.hub.current_revision(), json!(result))
        }
        RemoteCommandType::StudioStage | RemoteCommandType::StudioGoLive => {
            let req = command_payload::<RemoteStudioSlidePayload>(command).ok();
            let resp = match req {
                Some(req) => match state.media_schedule.load_studio_presentation(&req.presentation_id) {
                    Ok(pres) => match pres.slides.get(req.slide_index as usize) {
                        Some(slide) => {
                            let item = DisplayItem::CustomSlide(CustomSlideData {
                                presentation_id: pres.id,
                                presentation_name: pres.name,
                                slide_index: req.slide_index,
                                slide_count: pres.slides.len() as u32,
                                background: slide.background.clone(),
                                background_color: None,
                                background_image: None,
                                background_video: None,
                                background_video_loop: None,
                                background_video_muted: None,
                                header_enabled: None,
                                header_height_pct: None,
                                header: None,
                                body: None,
                                elements: slide.elements.clone(),
                                theme: pres.theme.clone(),
                                notes: slide.notes.clone(),
                            });
                            if command.r#type == RemoteCommandType::StudioGoLive {
                                op_go_live_item(app, state, item, source.clone());
                            } else {
                                op_stage(app, state, item, source.clone(), control.hub.current_revision());
                            }
                            Ok(())
                        }
                        None => Err(format!("Slide index {} out of range", req.slide_index)),
                    },
                    Err(e) => Err(format!("Presentation not found: {}", e)),
                },
                None => Err("Missing slide payload".into()),
            };
            match resp {
                Ok(()) => RemoteCommandResult::ok(&command.command_id, control.hub.current_revision()),
                Err(e) => err_result(&command.command_id, control.hub.current_revision(), "studio_failed", &e),
            }
        }
        RemoteCommandType::SongsSearch => {
            let req = command_payload::<RemoteSongSearch>(command).ok();
            if let Some(req) = req {
                let mut all: Vec<Song> = state.media_schedule.list_songs().unwrap_or_default();
                if req.include_hymns {
                    if let Ok(hymns) = crate::commands::misc::get_hymn_library(app.clone()).await {
                        all.extend(hymns);
                    }
                }
                let query = req.query.to_lowercase();
                let matched: Vec<RemoteSongSummary> = if query.trim().is_empty() {
                    all.iter().take(50).map(song_summary).collect()
                } else {
                    all.into_iter()
                        .filter(|s| song_searchable(s).contains(&query))
                        .take(50)
                        .map(|s| song_summary(&s))
                        .collect()
                };
                RemoteCommandResult::ok_with(&command.command_id, control.hub.current_revision(), json!(matched))
            } else {
                err_result(&command.command_id, control.hub.current_revision(), "missing_payload", "Missing song search query")
            }
        }
        RemoteCommandType::SongLines => {
            let req = command_payload::<RemoteSongLinesRequest>(command).ok();
            match req {
                Some(req) => match resolve_song(app, state, &req.song_id).await {
                    Some(song) => {
                        let show_section_labels = {
                            let settings = state.presentation.settings.lock();
                            settings.show_song_section_labels
                        };
                        let lines: Vec<serde_json::Value> = song_sequence(&song)
                            .iter()
                            .flat_map(|sec| {
                                sec.lines.iter().map(move |line| {
                                    json!({
                                        "text": line,
                                        "section_label": if show_section_labels { sec.label.clone() } else { String::new() },
                                    })
                                })
                            })
                            .collect();
                        RemoteCommandResult::ok_with(&command.command_id, control.hub.current_revision(), json!(lines))
                    }
                    None => err_result(&command.command_id, control.hub.current_revision(), "song_not_found", "Song not found"),
                },
                None => err_result(&command.command_id, control.hub.current_revision(), "missing_payload", "Missing song id"),
            }
        }
        RemoteCommandType::SongStage | RemoteCommandType::SongGoLive => {
            let req = command_payload::<RemoteSongControl>(command).ok();
            let resp = match req {
                Some(req) => match resolve_song(app, state, &req.song_id).await {
                    Some(song) => match build_song_slide(&song, req.section_index.unwrap_or(0), req.style.clone()) {
                        Ok(item) => {
                            if command.r#type == RemoteCommandType::SongGoLive {
                                op_send_live(app, state, item, source.clone()).map(|_| ())
                            } else {
                                op_stage(app, state, item, source.clone(), control.hub.current_revision());
                                Ok(())
                            }
                        }
                        Err(e) => Err(e),
                    },
                    None => Err("Song not found".into()),
                },
                None => Err("Missing song payload".into()),
            };
            match resp {
                Ok(()) => RemoteCommandResult::ok(&command.command_id, control.hub.current_revision()),
                Err(e) => err_result(&command.command_id, control.hub.current_revision(), "song_failed", &e),
            }
        }
        RemoteCommandType::TimerStage | RemoteCommandType::TimerGoLive => {
            let req = command_payload::<RemoteTimerPayload>(command).ok();
            match req {
                Some(req) => {
                    let timer = crate::store::TimerData {
                        timer_type: req.timer_type,
                        duration_secs: req.duration_secs,
                        label: req.label,
                        started_at: if command.r#type == RemoteCommandType::TimerGoLive { Some(now_ms()) } else { None },
                    };
                    let item = DisplayItem::Timer(timer);
                    if command.r#type == RemoteCommandType::TimerGoLive {
                        op_go_live_item(app, state, item, source.clone());
                    } else {
                        op_stage(app, state, item, source.clone(), control.hub.current_revision());
                    }
                    RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
                }
                None => err_result(&command.command_id, control.hub.current_revision(), "missing_payload", "Missing timer payload"),
            }
        }
        RemoteCommandType::TimerToggle => {
            let toggled = {
                let mut live = state.presentation.live_item.lock();
                if let Some(DisplayItem::Timer(ref mut t)) = *live {
                    t.started_at = if t.started_at.is_some() { None } else { Some(now_ms()) };
                    true
                } else {
                    false
                }
            };
            if toggled {
                let item = state.presentation.live_item.lock().clone();
                emit_checked(app, "live-item-update", &LiveItemUpdate { detected_item: item.clone() });
                state.remote.hub.publish(RemoteEventKind::LiveChanged, json!({ "live_item": item }), source);
            }
            RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
        }
        RemoteCommandType::LowerThirdShow => {
            let req = command_payload::<RemoteLowerThirdPayload>(command).ok();
            match req {
                Some(req) => {
                    let data_json = json!({ "kind": req.kind, "data": req.data });
                    match serde_json::from_value::<LowerThirdData>(data_json) {
                        Ok(data) => {
                            let template = resolve_lt_template(state, req.template, req.template_id, req.scroll);
                            op_show_lower_third(app, state, data, template, source.clone());
                            RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
                        }
                        Err(e) => err_result(&command.command_id, control.hub.current_revision(), "invalid_lower_third", &e.to_string()),
                    }
                }
                None => err_result(&command.command_id, control.hub.current_revision(), "missing_payload", "Missing lower-third payload"),
            }
        }
        RemoteCommandType::LowerThirdTemplates => {
            let templates = state
                .media_schedule
                .load_lt_templates()
                .ok()
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default();
            let summaries: Vec<serde_json::Value> = templates
                .iter()
                .filter_map(|t| {
                    let id = t.get("id")?.as_str()?.to_string();
                    let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    Some(json!({ "id": id, "name": name }))
                })
                .collect();
            RemoteCommandResult::ok_with(&command.command_id, control.hub.current_revision(), json!(summaries))
        }
        RemoteCommandType::LowerThirdHide => {
            op_hide_lower_third(app, state, source.clone());
            RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
        }
        RemoteCommandType::DisplayStageNext | RemoteCommandType::DisplayStagePrevious => {
            let dir = if command.r#type == RemoteCommandType::DisplayStageNext { 1 } else { -1 };
            match op_stage_queue_neighbor(app, state, dir, source.clone()) {
                Ok(()) => RemoteCommandResult::ok(&command.command_id, control.hub.current_revision()),
                Err(e) => err_result(&command.command_id, control.hub.current_revision(), "queue_stage_failed", &e),
            }
        }
        RemoteCommandType::DisplayLogoToggle => {
            let mut settings = state.presentation.settings.lock().clone();
            let next = !settings.show_background_logo;
            settings.show_background_logo = next;
            if state.media_schedule.save_settings(&settings).is_err() {
                return err_result(&command.command_id, control.hub.current_revision(), "settings_failed", "Failed to save logo settings");
            }
            *state.presentation.settings.lock() = settings.clone();
            emit_checked(app, "settings-changed", &settings);
            state.remote.hub.publish(RemoteEventKind::LogoChanged, json!({ "logo": next }), source.clone());
            RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
        }
        RemoteCommandType::CameraStart => {
            let req = command_payload::<RemoteCameraStartPayload>(command).ok();
            match req {
                Some(req) => {
                    let device_id = format!("phone-camera-{}", req.device_id);
                    // Register-only: the operator picks which feed to stage in
                    // the Camera tab, so a phone starting a camera must not
                    // steal the staged slot from another phone or from the
                    // operator's staged content.
                    control.register_phone_camera(&device_id, &req.device_id, &req.device_name, &device.id, req.orientation.clone()).await;
                    crate::store::log_msg(app, &format!("Remote camera: registered {} (\"{}\") owned by {}", device_id, req.device_name, device.id));
                    emit_phone_cameras(app, control).await;
                    RemoteCommandResult::ok_with(&command.command_id, control.hub.current_revision(), json!({ "device_id": device_id }))
                }
                None => err_result(&command.command_id, control.hub.current_revision(), "missing_payload", "Missing camera start payload"),
            }
        }
        RemoteCommandType::CameraStop => {
            let device_id = command_payload::<serde_json::Value>(command)
                .ok()
                .and_then(|v| v.get("device_id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .unwrap_or_default();
            if !device_id.is_empty() {
                let prefixed = format!("phone-camera-{}", device_id);
                control.unregister_phone_camera(&prefixed).await;
                emit_phone_cameras(app, control).await;
                // Tell the operator windows to tear down the answering peers.
                emit_checked(app, "phone-camera-stop", &json!({ "device_id": prefixed }));
            }
            RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
        }
        RemoteCommandType::CameraOffer => {
            let req = command_payload::<RemoteCameraOfferPayload>(command).ok();
            match req {
                Some(req) => {
                    // Phone (offerer) -> relay its SDP offer to the matching
                    // operator-side window ("operator" main window or "output"
                    // projection window), which hosts the answering peer.
                    let prefixed = format!("phone-camera-{}", req.device_id);
                    crate::store::log_msg(app, &format!("Remote camera: relaying offer for {} target {}", prefixed, req.target));
                    emit_checked(app, "phone-camera-offer", &json!({ "device_id": prefixed, "device_name": req.device_id, "sdp": req.sdp, "target": req.target }));
                    RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
                }
                None => err_result(&command.command_id, control.hub.current_revision(), "missing_payload", "Missing camera offer payload"),
            }
        }
        RemoteCommandType::CameraAnswer => {
            // Reserved: the operator is the answerer in this design, so a
            // phone-originated answer is unexpected. No-op for safety.
            RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
        }
        RemoteCommandType::CameraIce => {
            let req = command_payload::<RemoteCameraIcePayload>(command).ok();
            match req {
                Some(req) => {
                    // Phone's local ICE candidate -> relay to the matching
                    // operator-side window's peer.
                    let prefixed = format!("phone-camera-{}", req.device_id);
                    crate::store::log_msg(app, &format!("Remote camera: relaying ICE for {} target {}", prefixed, req.target));
                    emit_checked(app, "phone-camera-ice", &json!({
                        "device_id": prefixed,
                        "candidate": req.candidate,
                        "sdp_mid": req.sdp_mid,
                        "sdp_m_line_index": req.sdp_m_line_index,
                        "target": req.target,
                    }));
                    RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
                }
                None => err_result(&command.command_id, control.hub.current_revision(), "missing_payload", "Missing camera ICE payload"),
            }
        }
        _ => err_result(&command.command_id, control.hub.current_revision(), NOT_IMPLEMENTED, "Command not implemented in this build"),
    }
}

/// Commands that change authoritative state. These are gated on the device's
/// content permissions (see `required_permission`), the controller lease, and
/// a fresh revision, and are rate-limited per device. Read-only commands and
/// *signaling relays* are not mutating.
///
/// Notably `camera.offer` / `camera.answer` / `camera.ice` are deliberately
/// NOT mutating: they only forward WebRTC signaling to the operator window and
/// never touch presentation state. Gating them on the lease/revision would
/// make a session fail mid-handshake whenever the phone's revision went stale
/// or ICE candidate bursts tripped the command rate limiter. `camera.start` /
/// `camera.stop` remain mutating (permission + revision + rate limit apply)
/// but are exempt from the controller lease in `dispatch` because they only
/// register the phone feed.
pub(crate) fn is_mutating(t: RemoteCommandType) -> bool {
    matches!(
        t,
        RemoteCommandType::RemoteRequestControl
            | RemoteCommandType::RemoteReleaseControl
            | RemoteCommandType::RemoteRenewLease
            | RemoteCommandType::BibleStage
            | RemoteCommandType::BibleGoLive
            | RemoteCommandType::BibleStageNext
            | RemoteCommandType::BibleGoLiveNext
            | RemoteCommandType::BibleStagePrevious
            | RemoteCommandType::BibleGoLivePrevious
            | RemoteCommandType::BibleAddToService
            | RemoteCommandType::DisplayGoLive
            | RemoteCommandType::DisplayStageNext
            | RemoteCommandType::DisplayStagePrevious
            | RemoteCommandType::DisplayClearLive
            | RemoteCommandType::DisplayClearAll
            | RemoteCommandType::DisplayBlackout
            | RemoteCommandType::DisplayLogoToggle
            | RemoteCommandType::SongStage
            | RemoteCommandType::SongGoLive
            | RemoteCommandType::TimerStage
            | RemoteCommandType::TimerGoLive
            | RemoteCommandType::TimerToggle
            | RemoteCommandType::StudioStage
            | RemoteCommandType::StudioGoLive
            | RemoteCommandType::LowerThirdShow
            | RemoteCommandType::LowerThirdHide
            | RemoteCommandType::CameraStart
            | RemoteCommandType::CameraStop
    )
}

fn command_payload<T: serde::de::DeserializeOwned>(command: &RemoteCommand) -> Result<T, String> {
    match &command.payload {
        Some(v) => serde_json::from_value(v.clone()).map_err(|e| format!("Invalid payload: {}", e)),
        None => Err("Missing payload".to_string()),
    }
}

fn payload_str(command: &RemoteCommand, key: &str) -> Option<String> {
    command
        .payload
        .as_ref()
        .and_then(|v| v.get(key))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn payload_u32(command: &RemoteCommand, key: &str) -> i32 {
    command
        .payload
        .as_ref()
        .and_then(|v| v.get(key))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .unwrap_or(0)
}

fn result_from(command_id: &str, revision: u64, result: Result<serde_json::Value, String>) -> RemoteCommandResult {
    match result {
        Ok(v) => RemoteCommandResult::ok_with(command_id, revision, v),
        Err(e) => RemoteCommandResult::err(command_id, revision, "command_failed", &e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_check_accepts_fresh_or_newer_clients() {
        let control = RemoteControl::new(std::path::PathBuf::new(), &std::path::PathBuf::new());
        control.hub.publish(RemoteEventKind::Snapshot, json!({}), None); // rev 1
        assert!(check_revision(&control, Some(1)).is_ok());
        assert!(check_revision(&control, Some(2)).is_ok());
        assert!(check_revision(&control, Some(0)).is_err());
        assert!(check_revision(&control, None).is_ok());
    }

    #[test]
    fn mutating_commands_are_classified() {
        assert!(is_mutating(RemoteCommandType::BibleGoLive));
        assert!(is_mutating(RemoteCommandType::DisplayClearAll));
        assert!(is_mutating(RemoteCommandType::DisplayBlackout));
        assert!(is_mutating(RemoteCommandType::DisplayLogoToggle));
        assert!(is_mutating(RemoteCommandType::TimerStage));
        assert!(is_mutating(RemoteCommandType::TimerGoLive));
        assert!(is_mutating(RemoteCommandType::TimerToggle));
        assert!(is_mutating(RemoteCommandType::StudioStage));
        assert!(is_mutating(RemoteCommandType::StudioGoLive));
        assert!(!is_mutating(RemoteCommandType::StudioList));
        assert!(is_mutating(RemoteCommandType::CameraStart));
        assert!(!is_mutating(RemoteCommandType::BibleSearch));
        assert!(!is_mutating(RemoteCommandType::SnapshotGet));
        assert!(!is_mutating(RemoteCommandType::BibleChapter));
    }

    #[test]
    fn content_commands_map_to_the_right_permission() {
        use RemoteCommandType::*;
        assert_eq!(required_permission(BibleStage), Some(RemotePermission::Scripture));
        assert_eq!(required_permission(BibleGoLive), Some(RemotePermission::Scripture));
        assert_eq!(required_permission(BibleAddToService), Some(RemotePermission::Scripture));
        assert_eq!(required_permission(SongGoLive), Some(RemotePermission::Song));
        assert_eq!(required_permission(LowerThirdShow), Some(RemotePermission::LowerThird));
        assert_eq!(required_permission(CameraStart), Some(RemotePermission::Camera));
        assert_eq!(required_permission(DisplayGoLive), Some(RemotePermission::Presentation));
        assert_eq!(required_permission(DisplayClearAll), Some(RemotePermission::Presentation));
        assert_eq!(required_permission(DisplayBlackout), Some(RemotePermission::Presentation));
        assert_eq!(required_permission(DisplayLogoToggle), Some(RemotePermission::Presentation));
        assert_eq!(required_permission(TimerStage), Some(RemotePermission::Presentation));
        assert_eq!(required_permission(TimerGoLive), Some(RemotePermission::Presentation));
        assert_eq!(required_permission(TimerToggle), Some(RemotePermission::Presentation));
        assert_eq!(required_permission(StudioStage), Some(RemotePermission::Presentation));
        assert_eq!(required_permission(StudioGoLive), Some(RemotePermission::Presentation));
        // Read-only presentation listing needs no permission.
        assert_eq!(required_permission(StudioList), None);
        // Lease lifecycle commands are not content-gated.
        assert_eq!(required_permission(RemoteRequestControl), None);
        assert_eq!(required_permission(RemoteRenewLease), None);
        assert_eq!(required_permission(BibleSearch), None);
    }

    fn text_el(content: serde_json::Value, role: Option<String>) -> crate::store::SlideElement {
        crate::store::SlideElement {
            id: "el".into(),
            kind: "text".into(),
            x: 0.0,
            y: 0.0,
            w: 100.0,
            h: 40.0,
            z_index: 0,
            rotation: None,
            flip_x: None,
            flip_y: None,
            entrance: None,
            content,
            font_size: None,
            font_family: None,
            color: None,
            align: None,
            v_align: None,
            bold: None,
            italic: None,
            opacity: None,
            locked: None,
            shadow: None,
            shadow_color: None,
            group_id: None,
            loop_video: None,
            muted: None,
            role,
            auto_size: None,
            shape: None,
            fill_color: None,
            stroke_color: None,
            stroke_width: None,
            border_radius: None,
            object_fit: None,
            object_position: None,
            filter: None,
            filter_value: None,
            border: None,
        }
    }

    fn make_slide(elements: Vec<crate::store::SlideElement>) -> crate::store::CustomSlide {
        crate::store::CustomSlide {
            id: "slide".into(),
            background: None,
            background_color: String::new(),
            background_image: None,
            background_video: None,
            background_video_loop: None,
            background_video_muted: None,
            elements,
            notes: None,
            group_id: None,
            header_enabled: None,
            header_height_pct: None,
            header: None,
            body: None,
            master_ref: None,
        }
    }

    #[test]
    fn slide_title_prefers_title_role_and_falls_back_to_slide_number() {
        let doc = serde_json::json!({
            "type": "doc",
            "content": [
                { "type": "paragraph", "content": [
                    { "type": "text", "text": "The Good News" }
                ]}
            ]
        });
        let slide = make_slide(vec![text_el(doc, Some("title".into()))]);
        assert_eq!(slide_title(&slide, 0), "The Good News");

        // No text elements -> fall back to "Slide N".
        let empty = make_slide(vec![]);
        assert_eq!(slide_title(&empty, 2), "Slide 3");

        // Legacy HTML-string escape hatch is stripped of tags.
        let html = make_slide(vec![text_el(serde_json::json!("<p>Welcome <b>Home</b></p>"), None)]);
        assert_eq!(slide_title(&html, 0), "Welcome Home");

        // First text element wins when no title role exists.
        let multi = make_slide(vec![
            text_el(serde_json::json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "text": "Intro" }] }] }), None),
            text_el(serde_json::json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "text": "Body" }] }] }), Some("body".into())),
        ]);
        assert_eq!(slide_title(&multi, 0), "Intro");
    }

    fn verse_item(book: &str, verse: i32, text: &str) -> DisplayItem {
        DisplayItem::Verse(crate::store::Verse {
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
        DisplayItem::Camera(crate::store::CameraBackground {
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
        }
    }

    fn scene(zones: Vec<SceneZone>) -> DisplayItem {
        DisplayItem::SceneComposition(SceneCompositionData {
            scene_id: "s1".to_string(),
            name: "Test".to_string(),
            zones,
        })
    }

    #[test]
    fn zone_source_matches_item_kind() {
        assert_eq!(zone_source_for(&verse_item("John", 3, "For God so loved")), Some(SceneZoneSource::Verse));
        assert_eq!(zone_source_for(&camera_item("cam1")), Some(SceneZoneSource::Camera));
        assert_eq!(
            zone_source_for(&DisplayItem::Timer(crate::store::TimerData { timer_type: "clock".into(), duration_secs: None, label: None, started_at: None })),
            Some(SceneZoneSource::Timer)
        );
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
}
