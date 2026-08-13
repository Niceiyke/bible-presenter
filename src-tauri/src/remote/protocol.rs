use crate::store;
use serde::{Deserialize, Serialize};

/// Wire protocol version. Must stay in sync with `REMOTE_PROTOCOL_VERSION`
/// in `src/types/remote.ts`. Bump on any incompatible wire change.
pub const REMOTE_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RemoteRole {
    #[default]
    Viewer,
    Operator,
    Admin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RemoteControllerState {
    Viewing,
    Requested { device_id: String, device_name: String },
    Held { device_id: String, device_name: String, expires_at: u64 },
}

impl RemoteControllerState {
    pub fn is_held(&self) -> bool {
        matches!(self, RemoteControllerState::Held { .. })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteCommandType {
    RemotePair,
    RemoteAuthenticate,
    RemoteRequestControl,
    RemoteReleaseControl,
    RemoteRenewLease,
    SnapshotGet,
    BibleVersions,
    BibleBooks,
    BibleChapters,
    BibleVerseNumbers,
    BibleChapter,
    BibleSearch,
    BibleStage,
    BibleGoLive,
    BibleStageNext,
    BibleGoLiveNext,
    BibleStagePrevious,
    BibleGoLivePrevious,
    BibleAddToService,
    DisplayGoLive,
    DisplayStageNext,
    DisplayStagePrevious,
    DisplayClearLive,
    DisplayClearAll,
    DisplayBlackout,
    ServiceList,
    SongsSearch,
    SongStage,
    SongGoLive,
    LowerThirdShow,
    LowerThirdHide,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteCommand {
    pub command_id: String,
    #[serde(rename = "type")]
    pub r#type: RemoteCommandType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteCommandResult {
    pub command_id: String,
    pub ok: bool,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RemoteError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
}

impl RemoteCommandResult {
    pub fn ok(command_id: &str, revision: u64) -> Self {
        Self { command_id: command_id.to_string(), ok: true, revision, error: None, result: None }
    }

    pub fn ok_with(command_id: &str, revision: u64, result: serde_json::Value) -> Self {
        Self { command_id: command_id.to_string(), ok: true, revision, error: None, result: Some(result) }
    }

    pub fn err(command_id: &str, revision: u64, code: &str, message: &str) -> Self {
        Self {
            command_id: command_id.to_string(),
            ok: false,
            revision,
            error: Some(RemoteError { code: code.to_string(), message: message.to_string() }),
            result: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteEventKind {
    Snapshot,
    LiveChanged,
    StagedChanged,
    ScheduleChanged,
    LowerThirdChanged,
    OutputChanged,
    BlackoutChanged,
    ControllerChanged,
    OperatorNotice,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteEvent {
    pub kind: RemoteEventKind,
    pub revision: u64,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_device_id: Option<String>,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteVerseRef {
    pub book: String,
    pub chapter: i32,
    pub verse: i32,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteBibleSearch {
    pub query: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteBibleChapterRequest {
    pub book: String,
    pub chapter: i32,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemotePairPayload {
    pub pairing_token: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemotePairResult {
    pub device_id: String,
    pub device_token: String,
    pub role: RemoteRole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteAuthPayload {
    pub device_token: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteAuthResult {
    pub device_id: String,
    pub role: RemoteRole,
    pub controller_state: RemoteControllerState,
}

/// Compact song info sent in snapshots and song searches. Never exposes the
/// full arrangement or lyrics to every connected viewer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSongSummary {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    pub section_labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSongSearch {
    pub query: String,
    #[serde(default)]
    pub include_hymns: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSongControl {
    pub song_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteLowerThirdPayload {
    pub kind: String,
    pub data: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<serde_json::Value>,
}

/// Authoritative, read-only snapshot pushed to a connected remote. Mirrors the
/// `RemoteSnapshot` interface in `src/types/remote.ts`. Paths and settings
/// that a viewer must not see are intentionally omitted.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteSnapshot {
    pub protocol_version: u32,
    pub revision: u64,
    pub connected: bool,
    pub role: RemoteRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller_device_id: Option<String>,
    pub controller_state: RemoteControllerState,
    pub live_item: Option<store::DisplayItem>,
    pub staged_item: Option<store::DisplayItem>,
    pub active_service: Option<store::ServiceMeta>,
    pub schedule_entries: Vec<store::ScheduleEntry>,
    pub output_visible: bool,
    pub blackout: bool,
    pub lower_third: Option<serde_json::Value>,
    pub bible_versions: Vec<String>,
    pub active_bible_version: String,
    pub songs: Vec<RemoteSongSummary>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_round_trips_through_json() {
        let cmd = RemoteCommand {
            command_id: "abc".into(),
            r#type: RemoteCommandType::BibleSearch,
            payload: Some(serde_json::json!({ "query": "John 3:16", "version": "KJV" })),
            expected_revision: Some(4),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let back: RemoteCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(back.command_id, "abc");
        assert_eq!(back.r#type, RemoteCommandType::BibleSearch);
        assert_eq!(back.expected_revision, Some(4));
    }

    #[test]
    fn snapshot_serializes_without_panic() {
        let s = RemoteSnapshot {
            protocol_version: REMOTE_PROTOCOL_VERSION,
            revision: 1,
            connected: true,
            role: RemoteRole::Operator,
            controller_device_id: Some("dev-1".into()),
            controller_state: RemoteControllerState::Held {
                device_id: "dev-1".into(),
                device_name: "iPad".into(),
                expires_at: 0,
            },
            live_item: None,
            staged_item: None,
            active_service: None,
            schedule_entries: Vec::new(),
            output_visible: false,
            blackout: false,
            lower_third: None,
            bible_versions: vec!["KJV".into()],
            active_bible_version: "KJV".into(),
            songs: Vec::new(),
        };
        let json = serde_json::to_string(&s).unwrap();
        let back: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(back.get("protocol_version").and_then(|v| v.as_u64()), Some(REMOTE_PROTOCOL_VERSION as u64));
        assert_eq!(back.get("connected").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            back.get("controller_state").and_then(|v| v.get("kind")).and_then(|v| v.as_str()),
            Some("held")
        );
    }
}

