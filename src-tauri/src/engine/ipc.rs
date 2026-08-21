//! Engine IPC contract (Phase A1).
//!
//! Wire contract between the Tauri operator console and the standalone Rust
//! video engine process (`docs/RUST_VIDEO_ENGINE_PLAN.md`). The engine will own
//! authoritative presentation state and every video/transport surface; the
//! console is a command/control + content client that speaks this contract over
//! newline-delimited JSON-RPC on the sidecar's stdio.
//!
//! Contract rules (mirror `docs/UNIFIED_PRODUCTION_SUITE_PLAN.md` §8):
//! - One versioned contract. Bump [`ENGINE_PROTOCOL_VERSION`] together with the
//!   TypeScript mirror (`ENGINE_PROTOCOL_VERSION` in `src/types/engine.ts`) on
//!   any incompatible wire change.
//! - Commands are additive and typed. Unknown commands/events are tolerated via
//!   `#[serde(other)] Unknown` so a NEW client talking to an OLD engine gets a
//!   clear "unsupported" response instead of a hard parse failure (same rule as
//!   the remote protocol).
//! - Every presentation command carries/returns the engine's revision; events
//!   carry the presentation revision so the console's `PresentationSync` guard
//!   applies them safely.
//! - The engine is the ONLY writer of program state. The console never mutates
//!   live state locally.

use crate::store;
use serde::{Deserialize, Serialize};

/// Wire protocol version for the engine IPC. Must stay in sync with
/// `ENGINE_PROTOCOL_VERSION` in `src/types/engine.ts`.
///
/// v6 (Phase H): added `MediaControl` plus the `media_ended`/`media_failed`
/// events for the engine's in-process video decoders.
///
/// v7 (Phase I1): added camera-capture commands (`capture_list_devices`,
/// `capture_start`, `capture_stop`, `capture_status`) plus
/// `capture_device_lost` for live dshow sources.
pub const ENGINE_PROTOCOL_VERSION: u32 = 7;

/// Capabilities the engine offers for future negotiation (additive). A console
/// can gate UI/commands on these without breaking older engines.
pub const ENGINE_CAPABILITIES: &[&str] = &[
    "presentation",
    "output_windows",
    "recording",
    "streaming",
    "ndi",
    "preview_frames",
    "video_playback",
    "camera_capture",
];

/// A command the console sends to the engine. Mirrors the current Tauri command
/// surface so the frontend contract is unchanged during migration; the engine
/// becomes the authoritative owner of each mutation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum EngineCommand {
    /// Health probe. The engine replies `ok` with its version + capabilities.
    Ping,
    /// Graceful shutdown request (flush persistence, stop transports, exit 0).
    Shutdown,
    /// Fetch the authoritative presentation snapshot (hydration).
    PresentationSnapshot,
    /// Stage an item. `source` identifies the caller (desktop vs a remote
    /// device id) for attribution on remote hub events.
    StageItem { item: Box<store::DisplayItem>, source: Option<String> },
    /// Atomically commit the staged item to live (no-op when nothing staged).
    CommitStaged { source: Option<String> },
    /// Legacy `go_live` — commit staged.
    GoLive { source: Option<String> },
    /// Transactional stage-and-commit in one single-bump mutation.
    SendLiveItem { item: Box<store::DisplayItem>, source: Option<String> },
    /// Take a specific item live immediately (bypassing the staged slot).
    GoLiveItem { item: Box<store::DisplayItem>, source: Option<String> },
    /// Clear the live slot only (staged preserved).
    ClearLive { source: Option<String> },
    /// Clear the staged slot only.
    ClearStaged { source: Option<String> },
    /// Clear everything the audience can see (live, staged, lower-third, props).
    ClearAll { source: Option<String> },
    /// Update the live timer's started timestamp (start/stop a countdown).
    UpdateTimer { started_at: Option<u64> },
    /// Persist a full settings document and broadcast deltas.
    SaveSettings { settings: Box<store::PresentationSettings> },
    /// Toggle blackout on/off (persisted).
    SetBlackout { on: bool, source: Option<String> },
    /// Toggle the background-logo overlay (persisted).
    SetLogo { on: bool, source: Option<String> },
    /// Show a lower-third overlay.
    ShowLowerThird {
        data: store::LowerThirdData,
        template: Option<serde_json::Value>,
        source: Option<String>,
    },
    /// Hide any lower-third overlay.
    HideLowerThird { source: Option<String> },
    /// Replace the persistent props layer.
    SetProps { props: Vec<store::PropItem> },
    /// Read the current props layer (lazy-loads from disk).
    GetProps,
    /// Apply a scene as one logical transaction.
    ApplyScene { id: String },
    /// Read the current live item.
    GetCurrentItem,
    /// Read the current staged item.
    GetStagedItem,
    /// Read the current settings document.
    GetSettings,
    // ---- Engine-owned output/stage windows (Phase C2) ----
    /// Show (or create) a window on the engine's winit host. `label` names the
    /// window (e.g. `"output"`, `"stage"`); `preferred_monitor` names the
    /// monitor to place it on (falls back to the primary monitor).
    OutputWindowShow {
        label: String,
        style: crate::engine::windows::WindowStyle,
        preferred_monitor: Option<String>,
        width: u32,
        height: u32,
    },
    /// Hide a window on the engine's winit host.
    OutputWindowHide { label: String },
    /// Move a window onto the named monitor.
    OutputWindowSetMonitor { label: String, monitor: String },
    /// Resize a window.
    OutputWindowResize { label: String, width: u32, height: u32 },
    /// Register a window output's config with the engine so it can resolve and
    /// render that window's program frame (source, presentation overrides,
    /// overlay masks, geometry).
    OutputWindowSetConfig { label: String, config: Box<crate::outputs::OutputConfig> },
    /// Enumerate the monitors the engine's winit host sees.
    ListMonitors,
    /// Adopt the console's authoritative presentation state wholesale. The
    /// engine's own presentation store starts empty and only tracks the
    /// mutations it performs, so the console (which owns the authoritative
    /// `AppState` during Phase C) pushes its snapshot after every presentation
    /// event and whenever a window is revealed (Phase C4). The engine validates
    /// `schema_version` and adopts the revision verbatim so both hosts agree on
    /// event ordering.
    SyncPresentation { snapshot: Box<crate::engine::presentation::PresentationSnapshot> },
    // ---- Engine-owned transports (Phase D) ----
    /// Start an RTMP publish session for one destination on the shared encoder.
    /// `url` is the full `rtmp://host/app/key` ingest URL; `width`/`height`/
    /// `fps` are the capture geometry the shared encoder renders at (the first
    /// session to start the encoder fixes the geometry for its lifetime).
    RtmpStart {
        session_id: String,
        url: String,
        fps: u32,
        width: u32,
        height: u32,
    },
    /// Stop one RTMP session (idempotent for unknown ids).
    RtmpStop { session_id: String },
    /// Runtime status of every active RTMP session.
    RtmpStatus,
    /// Start a recording session (mux-only MP4) writing to `path`.
    RecordingStart {
        session_id: String,
        path: String,
        fps: u32,
        width: u32,
        height: u32,
    },
    /// Stop one recording session (idempotent for unknown ids).
    RecordingStop { session_id: String },
    /// Runtime status of every active recording session.
    RecordingStatus,
    // ---- Engine-owned video playback (Phase H) ----
    /// Operator transport control for one playing asset, keyed by its
    /// persisted media path. Errors when nothing is playing for that path.
    MediaControl {
        path: String,
        action: crate::engine::compositor::media::MediaAction,
    },
    // ---- Engine-owned camera capture (Phase I1) ----
    /// Enumerate video capture devices (webcams + UVC cards) via Media
    /// Foundation. Returns `{ devices: [{ name }] }`.
    CaptureListDevices,
    /// Pre-warm one live capture by hub key (`cam:{device}@WxH@fps`) so it
    /// runs even before a program frame references it. Idempotent.
    CaptureStart { key: String },
    /// Release a pinned capture started with `CaptureStart`. Captures that are
    /// still referenced by the live program keep running.
    CaptureStop { key: String },
    /// Which camera captures currently have live decoders, plus which keys the
    /// console has pinned.
    CaptureStatus,
    /// An unknown/future command from a newer console. The engine replies
    /// `unsupported` instead of failing to parse the frame.
    #[serde(other)]
    Unknown,
}

/// A window/output event the engine emits to the console. Presentation events
/// carry the presentation revision so the console's `PresentationSync` guard
/// drops stale broadcasts; output/transport events carry their own lifecycle
/// semantics.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum EngineEvent {
    /// Live item changed (item or null clear). Payload mirrors the current
    /// `live-item-update` Tauri event.
    LiveItemUpdate { detected_item: Option<Box<store::DisplayItem>>, revision: u64 },
    /// Staged item changed (item or null clear).
    ItemStaged { item: Option<Box<store::DisplayItem>>, revision: u64 },
    /// Settings document changed.
    SettingsChanged { settings: Box<store::PresentationSettings>, revision: u64 },
    /// Lower-third overlay changed (payload `{ data, template }` or null).
    LowerThirdUpdate { lower_third: Option<serde_json::Value>, revision: u64 },
    /// Props layer replaced.
    PropsUpdate { props: Vec<store::PropItem>, revision: u64 },
    /// Output/transport lifecycle transition (phase, reason, started_at).
    OutputStateChanged { output_id: String, state: serde_json::Value },
    /// A preview frame is ready. The MJPEG bytes are base64-encoded inline so the
    /// frame rides the same JSON event channel (no separate binary pipe); the
    /// console decodes and renders it. `frame_index` is per-window and monotonic.
    PreviewFrame {
        output_id: String,
        frame_index: u64,
        width: u32,
        height: u32,
        image_base64: String,
    },
    /// An NDI source appeared/disappeared on the LAN.
    NdiSourceChanged { payload: serde_json::Value },
    /// A non-looping video finished playing (Phase H). The engine freezes on
    /// the last frame until the asset is no longer referenced.
    MediaEnded { path: String },
    /// A video decoder failed to spawn or produced no frames (Phase H). The
    /// affected surfaces fall back to the missing-media panel; the hub retries
    /// after a cooldown while the asset stays referenced.
    MediaFailed { path: String, reason: String },
    /// A live camera capture ended or failed (Phase I1): device unplug, dshow
    /// error, or device loss. Affected surfaces degrade to the placeholder;
    /// the hub retries while the source stays referenced.
    CaptureDeviceLost { key: String },
    /// Unknown/future event from a newer engine. The console ignores it
    /// (structural typing falls through to a `default` branch).
    #[serde(other)]
    Unknown,
}

/// One request frame on the stdio channel: an id that correlates the response
/// plus the command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineRequest {
    /// Caller-supplied correlation id echoed back on the response.
    pub id: u64,
    pub command: EngineCommand,
}

/// One response frame. `ok` + `result` on success, `ok: false` + `error` on
/// failure; `revision` rides along so the console can advance its sync guard
/// even when the mutation's events were also delivered.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineResponse {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<EngineError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
}

impl EngineResponse {
    pub fn ok(id: u64, revision: u64) -> Self {
        Self { id, ok: true, revision: Some(revision), error: None, result: None }
    }

    pub fn ok_with(id: u64, revision: u64, result: serde_json::Value) -> Self {
        Self { id, ok: true, revision: Some(revision), error: None, result: Some(result) }
    }

    pub fn err(id: u64, revision: u64, code: &str, message: &str) -> Self {
        Self {
            id,
            ok: false,
            revision: Some(revision),
            error: Some(EngineError { code: code.to_string(), message: message.to_string() }),
            result: None,
        }
    }

    pub fn unsupported(id: u64) -> Self {
        Self::err(id, 0, "unsupported", "The engine does not support this command.")
    }
}

/// Structured error returned by the engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineError {
    pub code: String,
    pub message: String,
}

/// One event frame the engine pushes to the console (no correlation id).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineEventFrame {
    pub event: EngineEvent,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_round_trips_through_json() {
        let req = EngineRequest {
            id: 7,
            command: EngineCommand::SendLiveItem {
                item: Box::new(store::DisplayItem::Timer(store::TimerData {
                    timer_type: "countdown".into(),
                    duration_secs: Some(60),
                    label: None,
                    started_at: None,
                })),
                source: None,
            },
        };
        let json = serde_json::to_string(&req).unwrap();
        let back: EngineRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, 7);
        match back.command {
            EngineCommand::SendLiveItem { item, source } => {
                let store::DisplayItem::Timer(t) = *item else {
                    panic!("wrong item variant");
                };
                assert_eq!(t.timer_type, "countdown");
                assert_eq!(source, None);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn response_serializes_ok_and_error_shapes() {
        let ok = EngineResponse::ok_with(1, 5, serde_json::json!({ "live": null }));
        let ok_json = serde_json::to_value(&ok).unwrap();
        assert_eq!(ok_json["ok"], true);
        assert_eq!(ok_json["revision"], 5);

        let err = EngineResponse::err(2, 5, "clear_failed", "persist failed");
        let err_json = serde_json::to_value(&err).unwrap();
        assert_eq!(err_json["ok"], false);
        assert_eq!(err_json["error"]["code"], "clear_failed");
        assert!(err_json.get("result").is_none());
    }

    #[test]
    fn unknown_command_round_trips_as_unknown() {
        let req = EngineRequest { id: 1, command: EngineCommand::Unknown };
        let json = serde_json::to_string(&req).unwrap();
        let back: EngineRequest = serde_json::from_str(&json).unwrap();
        assert!(matches!(back.command, EngineCommand::Unknown));
    }

    #[test]
    fn presentation_events_carry_revision() {
        let ev = EngineEvent::LiveItemUpdate { detected_item: None, revision: 42 };
        let json = serde_json::to_value(ev).unwrap();
        assert_eq!(json["event"], "live_item_update");
        assert_eq!(json["revision"], 42);
    }

    #[test]
    fn preview_frame_event_round_trips_through_json() {
        let ev = EngineEvent::PreviewFrame {
            output_id: "output".into(),
            frame_index: 9,
            width: 480,
            height: 270,
            image_base64: "aGVsbG8=".into(),
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["event"], "preview_frame");
        assert_eq!(json["output_id"], "output");
        assert_eq!(json["frame_index"], 9);
        assert_eq!(json["width"], 480);
        assert_eq!(json["height"], 270);
        assert_eq!(json["image_base64"], "aGVsbG8=");

        let back: EngineEvent = serde_json::from_value(json).unwrap();
        match back {
            EngineEvent::PreviewFrame { output_id, frame_index, width, height, image_base64 } => {
                assert_eq!(output_id.as_str(), "output");
                assert_eq!(frame_index, 9);
                assert_eq!(width, 480);
                assert_eq!(height, 270);
                assert_eq!(image_base64.as_str(), "aGVsbG8=");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn output_window_commands_round_trip_through_json() {
        let req = EngineRequest {
            id: 9,
            command: EngineCommand::OutputWindowShow {
                label: "output".into(),
                style: crate::engine::windows::WindowStyle {
                    decorations: false,
                    transparent: true,
                    always_on_top: true,
                    resizable: false,
                },
                preferred_monitor: Some("DELL U2720Q".into()),
                width: 1920,
                height: 1080,
            },
        };
        let json = serde_json::to_string(&req).unwrap();
        let back: EngineRequest = serde_json::from_str(&json).unwrap();
        match back.command {
            EngineCommand::OutputWindowShow { label, style, preferred_monitor, width, height } => {
                assert_eq!(label, "output");
                assert!(!style.decorations);
                assert!(style.transparent);
                assert_eq!(preferred_monitor.as_deref(), Some("DELL U2720Q"));
                assert_eq!((width, height), (1920, 1080));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn sync_presentation_round_trips_through_json() {
        let req = EngineRequest {
            id: 12,
            command: EngineCommand::SyncPresentation {
                snapshot: Box::new(crate::engine::presentation::PresentationSnapshot {
                    schema_version: crate::engine::presentation::PRESENTATION_SCHEMA_VERSION,
                    live: None,
                    previous: None,
                    staged: None,
                    settings: crate::store::PresentationSettings::default(),
                    lower_third: None,
                    props: vec![],
                    active_scene_id: None,
                    revision: 42,
                    updated_at: 123,
                }),
            },
        };
        let json = serde_json::to_string(&req).unwrap();
        let back: EngineRequest = serde_json::from_str(&json).unwrap();
        match back.command {
            EngineCommand::SyncPresentation { snapshot } => {
                assert_eq!(snapshot.revision, 42);
                assert_eq!(
                    snapshot.schema_version,
                    crate::engine::presentation::PRESENTATION_SCHEMA_VERSION
                );
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn list_monitors_and_set_monitor_round_trip() {
        let req = EngineRequest { id: 10, command: EngineCommand::ListMonitors };
        let back: EngineRequest = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert!(matches!(back.command, EngineCommand::ListMonitors));

        let req = EngineRequest {
            id: 11,
            command: EngineCommand::OutputWindowSetMonitor {
                label: "stage".into(),
                monitor: "Primary".into(),
            },
        };
        let back: EngineRequest = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        match back.command {
            EngineCommand::OutputWindowSetMonitor { label, monitor } => {
                assert_eq!(label, "stage");
                assert_eq!(monitor, "Primary");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn media_control_round_trips_through_json() {
        for action in [
            crate::engine::compositor::media::MediaAction::Pause,
            crate::engine::compositor::media::MediaAction::Resume,
            crate::engine::compositor::media::MediaAction::Seek { ms: 12_500 },
        ] {
            let req = EngineRequest {
                id: 13,
                command: EngineCommand::MediaControl { path: "clip.mp4".into(), action },
            };
            let json = serde_json::to_string(&req).unwrap();
            let back: EngineRequest = serde_json::from_str(&json).unwrap();
            match back.command {
                EngineCommand::MediaControl { path, action } => {
                    assert_eq!(path, "clip.mp4");
                    if let crate::engine::compositor::media::MediaAction::Seek { ms } = action {
                        assert_eq!(ms, 12_500);
                    }
                }
                other => panic!("wrong variant: {other:?}"),
            }
        }
    }

    #[test]
    fn media_lifecycle_events_round_trip_through_json() {
        let ended = EngineEvent::MediaEnded { path: "clip.mp4".into() };
        let json = serde_json::to_value(&ended).unwrap();
        assert_eq!(json["event"], "media_ended");
        assert_eq!(json["path"], "clip.mp4");

        let failed = EngineEvent::MediaFailed { path: "bad.mp4".into(), reason: "no frames decoded".into() };
        let json = serde_json::to_value(&failed).unwrap();
        assert_eq!(json["event"], "media_failed");
        assert_eq!(json["reason"], "no frames decoded");

        let back: EngineEvent = serde_json::from_value(json).unwrap();
        assert!(matches!(back, EngineEvent::MediaFailed { .. }));
    }

    #[test]
    fn capture_commands_round_trip_through_json() {
        let req = EngineRequest { id: 14, command: EngineCommand::CaptureListDevices };
        let back: EngineRequest = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert!(matches!(back.command, EngineCommand::CaptureListDevices));

        let req = EngineRequest {
            id: 15,
            command: EngineCommand::CaptureStart { key: "cam:HD Cam@1280x720@30".into() },
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["command"]["cmd"], "capture_start");
        assert_eq!(json["command"]["key"], "cam:HD Cam@1280x720@30");

        let req = EngineRequest {
            id: 16,
            command: EngineCommand::CaptureStop { key: "cam:HD Cam@1280x720@30".into() },
        };
        let back: EngineRequest = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        match back.command {
            EngineCommand::CaptureStop { key } => assert_eq!(key, "cam:HD Cam@1280x720@30"),
            other => panic!("wrong variant: {other:?}"),
        }

        let req = EngineRequest { id: 17, command: EngineCommand::CaptureStatus };
        let back: EngineRequest = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert!(matches!(back.command, EngineCommand::CaptureStatus));
    }

    #[test]
    fn capture_device_lost_event_round_trips_through_json() {
        let event = EngineEvent::CaptureDeviceLost { key: "cam:HD Cam@1280x720@30".into() };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["event"], "capture_device_lost");
        assert_eq!(json["key"], "cam:HD Cam@1280x720@30");

        let back: EngineEvent = serde_json::from_value(json).unwrap();
        assert!(matches!(back, EngineEvent::CaptureDeviceLost { .. }));
    }
}