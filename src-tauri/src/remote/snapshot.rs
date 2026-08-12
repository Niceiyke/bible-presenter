use crate::remote::protocol::{
    RemoteControllerState, RemoteRole, RemoteSnapshot, RemoteSongSummary,
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

    let (active_service, schedule_entries) = active_service_snapshot(state);

    let output_visible = app
        .get_webview_window("output")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);

    RemoteSnapshot {
        protocol_version: crate::remote::protocol::REMOTE_PROTOCOL_VERSION,
        revision: state.remote.hub.current_revision(),
        connected: true,
        role,
        controller_device_id: device_id.clone(),
        controller_state,
        live_item,
        staged_item,
        active_service,
        schedule_entries,
        output_visible,
        blackout: settings.is_blanked,
        lower_third,
        bible_versions,
        active_bible_version,
        songs,
    }
}

fn active_service_snapshot(state: &AppState) -> (Option<crate::store::ServiceMeta>, Vec<crate::store::ScheduleEntry>) {
    let services = state.media_schedule.list_services().unwrap_or_default();
    let active_id = state.media_schedule.get_active_service_id();

    let active_meta = services
        .iter()
        .find(|s| Some(&s.id) == active_id.as_ref())
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