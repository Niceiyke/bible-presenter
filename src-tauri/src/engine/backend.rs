//! Engine backend abstraction (Phase A1).
//!
//! The broadcast engine's `op_*` methods in `presentation.rs` are the single
//! authoritative owner of program state. To let that exact code run in a
//! standalone engine process (the Rust video engine), the ops must not depend
//! on the Tauri `AppState` bundle. [`EngineBackend`] is the narrow seam: it
//! exposes the presentation state plus the persistence and remote-sink side
//! effects the ops need.
//!
//! - The Tauri process implements it with `AppState` (`impl EngineBackend for
//!   AppState`).
//! - The standalone engine process will implement it with its own
//!   `EngineRuntime` (same `PresentationState`, its own persistence + event
//!   sink).
//!
//! Every backend method mirrors an existing `MediaScheduleStore`/`RemoteHub`
//! call so the migration is mechanical and the engine contract tests stay
//! identical for both backends.

use crate::remote::protocol::RemoteEventKind;
use crate::state::PresentationState;
use crate::store::{PresentationSettings, PropItem, Scene};
use std::path::Path;

/// Everything the engine ops need from their host beyond the pure
/// `PresentationState` itself. Implemented by `AppState` today; the standalone
/// engine process implements it with its own runtime.
pub trait EngineBackend {
    /// The authoritative presentation state (slots, lock, revision).
    fn presentation(&self) -> &PresentationState;

    /// App data directory, used to validate prop paths.
    fn app_data_dir(&self) -> &Path;

    // -- Persistence (mirrors MediaScheduleStore) --------------------------

    fn load_settings(&self) -> Result<PresentationSettings, String>;
    fn save_settings(&self, settings: &PresentationSettings) -> Result<(), String>;
    fn save_props(&self, props: &[PropItem]) -> Result<(), String>;
    fn load_props(&self) -> Result<Vec<PropItem>, String>;
    fn list_scenes(&self) -> Result<Vec<Scene>, String>;

    // -- Remote sink (mirrors RemoteHub::publish) --------------------------

    /// Broadcast an event to connected remote control devices.
    fn publish_remote(&self, kind: RemoteEventKind, payload: serde_json::Value, source: Option<String>);
}