use crate::events::{emit_checked, LiveItemUpdate};
use crate::remote::auth::StoredDevice;
use crate::remote::protocol::{
    RemoteCommand, RemoteCommandResult, RemoteCommandType, RemoteEventKind,
    RemoteLowerThirdPayload, RemoteSongControl, RemoteSongSearch, RemoteSongSummary,
    RemoteVerseRef, RemoteRole,
};
use crate::remote::{RemoteControl, DESKTOP_CONTROLLER_ID};
use crate::state::AppState;
use crate::store::{DisplayItem, LowerThirdData, LyricSection, Schedule, ScheduleEntry, SearchResponse, Song, SongSlideData};
use serde_json::json;
use tauri::AppHandle;

const NOT_IMPLEMENTED: &str = "not_implemented";

fn err_result(command_id: &str, revision: u64, code: &str, message: &str) -> RemoteCommandResult {
    RemoteCommandResult::err(command_id, revision, code, message)
}

// ---------------------------------------------------------------------------
// Shared display operations (used by both Tauri commands and remote dispatch)
// ---------------------------------------------------------------------------

pub fn op_stage(app: &AppHandle, state: &AppState, item: DisplayItem, source: Option<String>, revision: u64) {
    *state.presentation.staged_item.lock() = Some(item.clone());
    emit_checked(app, "item-staged", &item);
    state.remote.hub.publish(RemoteEventKind::StagedChanged, json!({ "staged_item": item }), source);
    let _ = revision;
}

pub fn op_commit_staged(app: &AppHandle, state: &AppState, source: Option<String>) -> Option<DisplayItem> {
    let mut live = state.presentation.live_item.lock();
    let staged = state.presentation.staged_item.lock().clone();
    *live = staged.clone();
    drop(live);
    let update = LiveItemUpdate { detected_item: staged.clone() };
    emit_checked(app, "live-item-update", &update);
    state.remote.hub.publish(RemoteEventKind::LiveChanged, json!({ "live_item": staged }), source);
    staged
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
    *state.presentation.live_item.lock() = Some(item.clone());
    let update = LiveItemUpdate { detected_item: Some(item.clone()) };
    emit_checked(app, "live-item-update", &update);
    state.remote.hub.publish(RemoteEventKind::LiveChanged, json!({ "live_item": item }), source);
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

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

fn require_operator(device: &StoredDevice) -> Result<(), String> {
    if device.role == RemoteRole::Viewer {
        Err("Viewer role cannot mutate state".into())
    } else {
        Ok(())
    }
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
/// without a lease; mutating commands require the operator role and the
/// controller lease. The returned result carries the backend revision after
/// any mutation.
pub async fn dispatch(
    app: &AppHandle,
    state: &AppState,
    control: &RemoteControl,
    device: &StoredDevice,
    command: &RemoteCommand,
) -> RemoteCommandResult {
    // Mutating commands must pass the lease + revision gates before touching
    // authoritative state. Read-only commands skip the lease check.
    let mutating = is_mutating(command.r#type.clone());
    if mutating {
        if let Err(e) = check_revision(control, command.expected_revision) {
            return err_result(&command.command_id, control.hub.current_revision(), "stale_revision", &e);
        }
        if let Err(e) = require_operator(device) {
            return err_result(&command.command_id, control.hub.current_revision(), "forbidden", &e);
        }
        if let Err(e) = require_lease(control, device) {
            return err_result(&command.command_id, control.hub.current_revision(), "lease_required", &e);
        }
    }

    let source = Some(device.id.clone());
    let mutating_ops = match command.r#type {
        RemoteCommandType::RemotePair
        | RemoteCommandType::RemoteAuthenticate
        | RemoteCommandType::RemoteRequestControl
        | RemoteCommandType::RemoteReleaseControl
        | RemoteCommandType::RemoteRenewLease
        | RemoteCommandType::SnapshotGet
        | RemoteCommandType::BibleVersions
        | RemoteCommandType::BibleBooks
        | RemoteCommandType::BibleChapters
        | RemoteCommandType::BibleVerseNumbers
        | RemoteCommandType::BibleChapter
        | RemoteCommandType::BibleSearch
        | RemoteCommandType::ServiceList
        | RemoteCommandType::SongsSearch
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
        | RemoteCommandType::SongStage
        | RemoteCommandType::SongGoLive
        | RemoteCommandType::LowerThirdShow
        | RemoteCommandType::LowerThirdHide => true,
    };
    let _ = mutating_ops;

    match command.r#type {
        RemoteCommandType::SnapshotGet => {
            let snapshot = crate::remote::snapshot::build_snapshot(
                app,
                state,
                device.role.clone(),
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
        RemoteCommandType::LowerThirdShow => {
            let req = command_payload::<RemoteLowerThirdPayload>(command).ok();
            match req {
                Some(req) => {
                    let data_json = json!({ "kind": req.kind, "data": req.data });
                    match serde_json::from_value::<LowerThirdData>(data_json) {
                        Ok(data) => {
                            op_show_lower_third(app, state, data, req.template, source.clone());
                            RemoteCommandResult::ok(&command.command_id, control.hub.current_revision())
                        }
                        Err(e) => err_result(&command.command_id, control.hub.current_revision(), "invalid_lower_third", &e.to_string()),
                    }
                }
                None => err_result(&command.command_id, control.hub.current_revision(), "missing_payload", "Missing lower-third payload"),
            }
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
        _ => err_result(&command.command_id, control.hub.current_revision(), NOT_IMPLEMENTED, "Command not implemented in this build"),
    }
}

fn is_mutating(t: RemoteCommandType) -> bool {
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
            | RemoteCommandType::SongStage
            | RemoteCommandType::SongGoLive
            | RemoteCommandType::LowerThirdShow
            | RemoteCommandType::LowerThirdHide
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
        assert!(!is_mutating(RemoteCommandType::BibleSearch));
        assert!(!is_mutating(RemoteCommandType::SnapshotGet));
        assert!(!is_mutating(RemoteCommandType::BibleChapter));
    }
}
