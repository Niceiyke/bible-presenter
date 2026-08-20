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
pub const ENGINE_PROTOCOL_VERSION: u32 = 1;

/// Capabilities the engine offers for future negotiation (additive). A console
/// can gate UI/commands on these without breaking older engines.
pub const ENGINE_CAPABILITIES: &[&str] = &[
    "presentation",
    "output_windows",
    "recording",
    "streaming",
    "ndi",
    "preview_frames",
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
    StageItem { item: store::DisplayItem, source: Option<String> },
    /// Atomically commit the staged item to live (no-op when nothing staged).
    CommitStaged { source: Option<String> },
    /// Legacy `go_live` — commit staged.
    GoLive { source: Option<String> },
    /// Transactional stage-and-commit in one single-bump mutation.
    SendLiveItem { item: store::DisplayItem, source: Option<String> },
    /// Take a specific item live immediately (bypassing the staged slot).
    GoLiveItem { item: store::DisplayItem, source: Option<String> },
    /// Clear the live slot only (staged preserved).
    ClearLive { source: Option<String> },
    /// Clear the staged slot only.
    ClearStaged { source: Option<String> },
    /// Clear everything the audience can see (live, staged, lower-third, props).
    ClearAll { source: Option<String> },
    /// Update the live timer's started timestamp (start/stop a countdown).
    UpdateTimer { started_at: Option<u64> },
    /// Persist a full settings document and broadcast deltas.
    SaveSettings { settings: store::PresentationSettings },
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
    LiveItemUpdate { detected_item: Option<store::DisplayItem>, revision: u64 },
    /// Staged item changed (item or null clear).
    ItemStaged { item: Option<store::DisplayItem>, revision: u64 },
    /// Settings document changed.
    SettingsChanged { settings: store::PresentationSettings, revision: u64 },
    /// Lower-third overlay changed (payload `{ data, template }` or null).
    LowerThirdUpdate { lower_third: Option<serde_json::Value>, revision: u64 },
    /// Props layer replaced.
    PropsUpdate { props: Vec<store::PropItem>, revision: u64 },
    /// Output/transport lifecycle transition (phase, reason, started_at).
    OutputStateChanged { output_id: String, state: serde_json::Value },
    /// A preview frame is ready (MJPEG bytes over the binary channel).
    PreviewFrame { output_id: String, frame_index: u64 },
    /// An NDI source appeared/disappeared on the LAN.
    NdiSourceChanged { payload: serde_json::Value },
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
#[derive(Debug, Clone, Serialize)]
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
                item: store::DisplayItem::Timer(store::TimerData {
                    timer_type: "countdown".into(),
                    duration_secs: Some(60),
                    label: None,
                    started_at: None,
                }),
                source: None,
            },
        };
        let json = serde_json::to_string(&req).unwrap();
        let back: EngineRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, 7);
        match back.command {
            EngineCommand::SendLiveItem { item: store::DisplayItem::Timer(t), source } => {
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
}