use crate::store;
use serde::{Deserialize, Serialize};

/// Wire protocol version. Must stay in sync with `REMOTE_PROTOCOL_VERSION`
/// in `src/types/remote.ts`. Bump on any incompatible wire change.
pub const REMOTE_PROTOCOL_VERSION: u32 = 1;

/// Server feature capabilities for negotiation (Phase 10). Future clients read
/// `snapshot.capabilities` to decide which UI to offer; old clients ignore it.
pub const REMOTE_CAPABILITIES: &[&str] = &[
    "scripture",
    "songs",
    "camera",
    "lower_third",
    "presentation",
    "timer",
    "service",
    "studio",
    "permissions_realtime",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RemoteRole {
    #[default]
    Viewer,
    Operator,
    Admin,
}

impl RemoteRole {
    /// Permissions granted by each role before per-device overrides. `viewer`
    /// is read-only; `operator`/`admin` can do everything the remote exposes.
    /// Applied on pairing and whenever the role changes — the operator can then
    /// refine a device's permissions individually from Settings → Remote
    /// Control.
    pub fn preset_permissions(&self) -> RemotePermissions {
        match self {
            RemoteRole::Viewer => RemotePermissions::default(),
            RemoteRole::Operator | RemoteRole::Admin => RemotePermissions {
                scripture: true,
                song: true,
                camera: true,
                lower_third: true,
                presentation: true,
            },
        }
    }
}

/// Granular content-domain permissions a paired device may be granted. Roles
/// provide presets; the operator refines per device from the operator UI.
/// Enforced server-side per command and mirrored in the snapshot so the remote
/// UI hides controls the device cannot use.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemotePermissions {
    pub scripture: bool,
    pub song: bool,
    pub camera: bool,
    pub lower_third: bool,
    pub presentation: bool,
}

impl RemotePermissions {
    pub fn any(&self) -> bool {
        self.scripture || self.song || self.camera || self.lower_third || self.presentation
    }

    pub fn has(&self, perm: RemotePermission) -> bool {
        match perm {
            RemotePermission::Scripture => self.scripture,
            RemotePermission::Song => self.song,
            RemotePermission::Camera => self.camera,
            RemotePermission::LowerThird => self.lower_third,
            RemotePermission::Presentation => self.presentation,
        }
    }
}

/// The permission required for a single remote command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemotePermission {
    Scripture,
    Song,
    Camera,
    LowerThird,
    Presentation,
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
pub enum RemoteCommandType {
    #[serde(rename = "remote.pair")]
    RemotePair,
    #[serde(rename = "remote.authenticate")]
    RemoteAuthenticate,
    #[serde(rename = "remote.request_control")]
    RemoteRequestControl,
    #[serde(rename = "remote.release_control")]
    RemoteReleaseControl,
    #[serde(rename = "remote.renew_lease")]
    RemoteRenewLease,
    #[serde(rename = "snapshot.get")]
    SnapshotGet,
    #[serde(rename = "bible.versions")]
    BibleVersions,
    #[serde(rename = "bible.books")]
    BibleBooks,
    #[serde(rename = "bible.chapters")]
    BibleChapters,
    #[serde(rename = "bible.verse_numbers")]
    BibleVerseNumbers,
    #[serde(rename = "bible.chapter")]
    BibleChapter,
    #[serde(rename = "bible.search")]
    BibleSearch,
    #[serde(rename = "bible.stage")]
    BibleStage,
    #[serde(rename = "bible.go_live")]
    BibleGoLive,
    #[serde(rename = "bible.stage_next")]
    BibleStageNext,
    #[serde(rename = "bible.go_live_next")]
    BibleGoLiveNext,
    #[serde(rename = "bible.stage_previous")]
    BibleStagePrevious,
    #[serde(rename = "bible.go_live_previous")]
    BibleGoLivePrevious,
    #[serde(rename = "bible.add_to_service")]
    BibleAddToService,
    #[serde(rename = "display.go_live")]
    DisplayGoLive,
    #[serde(rename = "display.stage_next")]
    DisplayStageNext,
    #[serde(rename = "display.stage_previous")]
    DisplayStagePrevious,
    #[serde(rename = "display.clear_live")]
    DisplayClearLive,
    #[serde(rename = "display.clear_all")]
    DisplayClearAll,
    #[serde(rename = "display.blackout")]
    DisplayBlackout,
    #[serde(rename = "display.logo_toggle")]
    DisplayLogoToggle,
    #[serde(rename = "timer.stage")]
    TimerStage,
    #[serde(rename = "timer.go_live")]
    TimerGoLive,
    #[serde(rename = "timer.toggle")]
    TimerToggle,
    #[serde(rename = "service.list")]
    ServiceList,
    #[serde(rename = "studio.list")]
    StudioList,
    #[serde(rename = "studio.stage")]
    StudioStage,
    #[serde(rename = "studio.go_live")]
    StudioGoLive,
    #[serde(rename = "songs.search")]
    SongsSearch,
    #[serde(rename = "song.lines")]
    SongLines,
    #[serde(rename = "song.stage")]
    SongStage,
    #[serde(rename = "song.go_live")]
    SongGoLive,
    #[serde(rename = "lower_third.templates")]
    LowerThirdTemplates,
    #[serde(rename = "lower_third.show")]
    LowerThirdShow,
    #[serde(rename = "lower_third.hide")]
    LowerThirdHide,
    #[serde(rename = "camera.start")]
    CameraStart,
    #[serde(rename = "camera.stop")]
    CameraStop,
    #[serde(rename = "camera.offer")]
    CameraOffer,
    #[serde(rename = "camera.answer")]
    CameraAnswer,
    #[serde(rename = "camera.ice")]
    CameraIce,
    /// An unknown/future command type from a newer client. Kept so a NEW client
    /// talking to an OLD server gets a clear "unsupported" response instead of
    /// a hard parse failure (Phase 10).
    #[serde(other)]
    Unknown,
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
pub enum RemoteEventKind {
    #[serde(rename = "snapshot")]
    Snapshot,
    #[serde(rename = "live.changed")]
    LiveChanged,
    #[serde(rename = "staged.changed")]
    StagedChanged,
    #[serde(rename = "schedule.changed")]
    ScheduleChanged,
    #[serde(rename = "lower_third.changed")]
    LowerThirdChanged,
    #[serde(rename = "output.changed")]
    OutputChanged,
    #[serde(rename = "blackout.changed")]
    BlackoutChanged,
    #[serde(rename = "logo.changed")]
    LogoChanged,
    #[serde(rename = "controller.changed")]
    ControllerChanged,
    #[serde(rename = "operator.notice")]
    OperatorNotice,
    #[serde(rename = "camera.answer")]
    CameraAnswer,
    #[serde(rename = "camera.ice")]
    CameraIce,
    /// Pushed to a device immediately after its role/permissions change, so a
    /// revoked or permission-reduced client updates its UI without reconnecting
    /// (Phase 10). Payload is the device's new `RemotePermissions`.
    #[serde(rename = "permissions.changed")]
    PermissionsChanged,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteEvent {
    pub kind: RemoteEventKind,
    pub revision: u64,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_device_id: Option<String>,
    /// When set, only the matching connected device receives this event; when
    /// unset the event is broadcast to every connected device. Used to relay
    /// operator->phone camera signaling without leaking it to other clients.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_device_id: Option<String>,
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
    pub permissions: RemotePermissions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteAuthPayload {
    pub device_token: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteAuthResult {
    pub device_id: String,
    pub role: RemoteRole,
    pub permissions: RemotePermissions,
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

/// Read-only request for the flattened lyric lines of one song (the exact
/// `{ text, section_label }` sequence the operator's lower-third lyrics mode
/// uses). Lets the phone drive line-by-line navigation without shipping every
/// lyric line in the snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSongLinesRequest {
    pub song_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteSongControl {
    pub song_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_index: Option<usize>,
}

/// Lightweight saved lower-third template summary (id + display name) sent in
/// snapshots so the phone can offer a template picker without the full JSON.
/// The full template is resolved server-side from `template_id` on show.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteLtTemplateSummary {
    pub id: String,
    pub name: String,
}

/// Scroll override a phone can attach to a FreeText lower third. Merged onto
/// the resolved template (`scrollEnabled` / `scrollDirection` / `scrollCount`)
/// so a phone user can toggle ticker behavior without editing templates.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteLtScroll {
    pub enabled: bool,
    /// "ltr" | "rtl"
    pub direction: String,
    /// 0 = infinite
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteLowerThirdPayload {
    pub kind: String,
    pub data: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<serde_json::Value>,
    /// Saved-template id to resolve server-side. Ignored when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    /// Optional scroll override for FreeText; merged onto the resolved template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scroll: Option<RemoteLtScroll>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteCameraStartPayload {
    pub device_id: String,
    pub device_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facing_mode: Option<String>,
    /// The phone's physical screen orientation ("portrait" | "landscape") so
    /// the operator windows can auto-correct the display rotation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteTimerPayload {
    /// "countdown" | "countup" | "clock"
    pub timer_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteStudioSlidePayload {
    pub presentation_id: String,
    pub slide_index: u32,
}

/// One slide of a presentation as listed by `studio.list`. Only lightweight
/// metadata crosses the wire — the full `CustomSlide` content stays on the
/// operator machine and is rebuilt server-side when the slide is staged.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteStudioSlideInfo {
    pub index: u32,
    /// Best-effort first-line text of the slide, or empty when the slide is
    /// image-only or has no extractable text.
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteStudioPresentation {
    pub id: String,
    pub name: String,
    pub slide_count: u32,
    pub slides: Vec<RemoteStudioSlideInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteCameraOfferPayload {
    pub sdp: String,
    pub device_id: String,
    /// Which operator-side window should host the answering peer: "operator"
    /// (main window, for the operator preview) or "output" (projection window).
    #[serde(default = "default_camera_target")]
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteCameraAnswerPayload {
    pub sdp: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteCameraIcePayload {
    pub candidate: String,
    pub sdp_mid: String,
    pub sdp_m_line_index: u32,
    pub device_id: String,
    /// Mirrors the `target` of the peer this candidate belongs to so the phone
    /// can route it back to the correct connection.
    #[serde(default = "default_camera_target")]
    pub target: String,
}

fn default_camera_target() -> String {
    "operator".into()
}

/// Authoritative, read-only snapshot pushed to a connected remote. Mirrors the
/// `RemoteSnapshot` interface in `src/types/remote.ts`. Paths and settings
/// that a viewer must not see are intentionally omitted.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteSnapshot {
    pub protocol_version: u32,
    /// Server feature capability negotiation (Phase 10): a fixed list of
    /// feature strings a future client can check before offering UI. New
    /// features are added here without breaking old clients (which ignore it).
    pub capabilities: Vec<String>,
    pub revision: u64,
    pub connected: bool,
    pub role: RemoteRole,
    pub permissions: RemotePermissions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller_device_id: Option<String>,
    pub controller_state: RemoteControllerState,
    pub live_item: Option<store::DisplayItem>,
    pub staged_item: Option<store::DisplayItem>,
    pub active_service: Option<store::ServiceMeta>,
    pub schedule_entries: Vec<store::ScheduleEntry>,
    pub output_visible: bool,
    pub blackout: bool,
    pub background_logo: bool,
    pub lower_third: Option<serde_json::Value>,
    pub bible_versions: Vec<String>,
    pub active_bible_version: String,
    pub songs: Vec<RemoteSongSummary>,
    pub lt_templates: Vec<RemoteLtTemplateSummary>,
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
            capabilities: REMOTE_CAPABILITIES.iter().map(|s| s.to_string()).collect(),
            revision: 1,
            connected: true,
            role: RemoteRole::Operator,
            permissions: RemoteRole::Operator.preset_permissions(),
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
            background_logo: false,
            lower_third: None,
            bible_versions: vec!["KJV".into()],
            active_bible_version: "KJV".into(),
            songs: Vec::new(),
            lt_templates: Vec::new(),
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

