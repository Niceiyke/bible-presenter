use crate::remote::protocol::{
    RemoteControllerState, RemoteLtTemplateSummary, RemotePermissions, RemoteRole, RemoteSnapshot,
    RemoteSongSummary,
};
use crate::state::AppState;
use crate::store::Song;
use tauri::{AppHandle, Manager};

/// Ordered section labels for a song, following the canonical arrangement when
/// present and falling back to legacy `arrangement` then section order.
pub fn song_section_labels(song: &Song) -> Vec<String> {
    if let Some(steps) = &song.arrangement_steps {
        let labels: Vec<String> = steps
            .iter()
            .filter_map(|step| {
                song.sections.iter().find(|s| s.id.as_deref() == Some(step.section_id.as_str()))
            })
            .map(|s| s.label.clone())
            .collect();
        if !labels.is_empty() {
            return labels;
        }
    }
    if !song.arrangement.is_empty() {
        let labels: Vec<String> = song
            .arrangement
            .iter()
            .filter_map(|label| song.sections.iter().find(|s| s.label == *label))
            .map(|s| s.label.clone())
            .collect();
        if !labels.is_empty() {
            return labels;
        }
    }
    song.sections.iter().map(|s| s.label.clone()).collect()
}

/// Builds the authoritative read-only snapshot that a remote receives on
/// connect/reconnect. Mirrors `RemoteSnapshot` in `src/types/remote.ts`.
/// Private filesystem paths, full media library and editable settings are
/// deliberately excluded.
pub fn build_snapshot(
    app: &AppHandle,
    state: &AppState,
    role: RemoteRole,
    permissions: RemotePermissions,
    device_id: Option<String>,
    controller_state: RemoteControllerState,
) -> RemoteSnapshot {
    let presentation = &state.presentation;
    let live_item = presentation.live_item.lock().clone();
    let staged_item = presentation.staged_item.lock().clone();
    let lower_third = presentation.lower_third.lock().clone();
    let settings = presentation.settings.lock().clone();

    let bible_versions: Vec<String> = state
        .store
        .get_available_versions()
        .into_iter()
        .filter(|v| !settings.disabled_bible_versions.contains(v))
        .collect();

    let active_bible_version = if bible_versions.contains(&state.store.get_active_version()) {
        state.store.get_active_version()
    } else {
        state.store.get_available_versions().first().cloned().unwrap_or_else(|| "KJV".into())
    };

    let songs: Vec<RemoteSongSummary> = state
        .media_schedule
        .list_songs()
        .unwrap_or_default()
        .into_iter()
        .map(|s| RemoteSongSummary {
            id: s.id.clone(),
            title: s.title.clone(),
            style: s.style.clone(),
            section_labels: song_section_labels(&s),
        })
        .collect();

    let lt_templates: Vec<RemoteLtTemplateSummary> = state
        .media_schedule
        .load_lt_templates()
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|t| {
            let id = t.get("id")?.as_str()?.to_string();
            let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            Some(RemoteLtTemplateSummary { id, name })
        })
        .collect();

    let (active_service, schedule_entries) = active_service_snapshot(state);

    let output_visible = app
        .get_webview_window("output")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);

    // The "capture" window is the WGC source only when a session is running AND
    // the projector is off — while the output window is on screen a live session
    // captures the real window instead, so the phone's "capture" peer (and the
    // capture window's camera work) must be off.
    let capture_active =
        (state.recording.lock().is_some() || state.streaming.lock().is_some()) && !output_visible;

    RemoteSnapshot {
        protocol_version: crate::remote::protocol::REMOTE_PROTOCOL_VERSION,
        revision: state.remote.hub.current_revision(),
        connected: true,
        role,
        permissions,
        controller_device_id: device_id.clone(),
        controller_state,
        live_item,
        staged_item,
        active_service,
        schedule_entries,
        output_visible,
        capture_active,
        blackout: settings.is_blanked,
        background_logo: settings.show_background_logo,
        lower_third,
        bible_versions,
        active_bible_version,
        songs,
        lt_templates,
    }
}

pub(crate) fn active_service_snapshot(state: &AppState) -> (Option<crate::store::ServiceMeta>, Vec<crate::store::ScheduleEntry>) {
    let services = state.media_schedule.list_services().unwrap_or_default();
    let active_id = persisted_active_service_id(state);

    let active_meta = services
        .iter()
        .find(|s| active_id.as_deref().is_some_and(|id| s.id == id))
        .or_else(|| services.first())
        .cloned();

    let entries = match &active_meta {
        Some(meta) => state
            .media_schedule
            .load_service(&meta.id)
            .map(|s| s.items)
            .unwrap_or_default(),
        None => Vec::new(),
    };
    (active_meta, entries)
}

/// The desktop operator console persists its active service id to
/// `recovery.json` (via `save_recovery`) on every service change. There is no
/// separate backend "active service" column, so the remote resolves the id from
/// that authoritative file and falls back to the first service.
pub(crate) fn persisted_active_service_id(state: &AppState) -> Option<String> {
    let path = state.app_data_dir.join("recovery.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("activeServiceId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_follow_legacy_arrangement() {
        let song: Song = serde_json::from_str(
            r#"{
                "id": "s1",
                "title": "Amazing Grace",
                "sections": [
                    { "id": "a", "label": "Verse 1", "lines": ["x"] },
                    { "id": "b", "label": "Chorus", "lines": ["y"] }
                ],
                "arrangement": ["Chorus", "Verse 1"]
            }"#,
        )
        .unwrap();
        assert_eq!(song_section_labels(&song), vec!["Chorus", "Verse 1"]);
    }

    #[test]
    fn labels_prefer_canonical_id_arrangement() {
        let song: Song = serde_json::from_str(
            r#"{
                "id": "s2",
                "title": "How Great",
                "sections": [
                    { "id": "a", "label": "Verse 1", "lines": ["x"] },
                    { "id": "b", "label": "Chorus", "lines": ["y"] }
                ],
                "arrangement": ["Verse 1", "Chorus"],
                "arrangement_steps": [{ "section_id": "b" }, { "section_id": "a" }]
            }"#,
        )
        .unwrap();
        assert_eq!(song_section_labels(&song), vec!["Chorus", "Verse 1"]);
    }

    #[test]
    fn labels_fall_back_to_section_order() {
        let song: Song = serde_json::from_str(
            r#"{
                "id": "s3",
                "title": "SP",
                "sections": [
                    { "label": "Verse 1", "lines": ["x"] },
                    { "label": "Chorus", "lines": ["y"] }
                ]
            }"#,
        )
        .unwrap();
        assert_eq!(song_section_labels(&song), vec!["Verse 1", "Chorus"]);
    }
}