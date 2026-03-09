//! LAN Camera subsystem.
//!
//! Module layout:
//!   types    — shared data types and WS message enums
//!   session  — CameraSession + SessionRegistry + heartbeat watchdog
//!   tally    — authoritative TallyRegistry
//!   auth     — PIN rate-limiting and device token validation
//!   commands — Tauri command handlers

pub mod auth;
pub mod commands;
pub mod session;
pub mod tally;
pub mod types;

pub use auth::AuthManager;
pub use commands::{
    camera_clear_program, camera_get_status, camera_kick_device, camera_list_devices,
    camera_set_preview, camera_set_program,
};
pub use session::{CameraSession, SessionRegistry};
pub use tally::TallyRegistry;
pub use types::{
    CameraDeviceInfo, InboundMsg, OutboundEvent, QualityStats, RelayMsg, SessionState, TallyState,
};

use std::time::Duration;
use tokio::time::interval;

/// Heartbeat timeout — sessions silent for longer than this are declared dead.
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(20);
/// How often the watchdog sweeps for stale sessions.
pub const WATCHDOG_INTERVAL: Duration = Duration::from_secs(5);

/// Async heartbeat loop — sweeps `SessionRegistry` for stale sessions and
/// removes them, broadcasting a `camera_source_disconnected` event.
///
/// Caller is responsible for spawning this on the correct runtime.
/// In Tauri, use `tauri::async_runtime::spawn(camera::heartbeat_watchdog(...))`.
pub async fn heartbeat_watchdog(
    sessions: SessionRegistry,
    tally: TallyRegistry,
    broadcast_tx: tokio::sync::broadcast::Sender<String>,
) {
    let mut tick = interval(WATCHDOG_INTERVAL);
    loop {
        tick.tick().await;
        let stale = sessions.stale_ids(HEARTBEAT_TIMEOUT);
        for device_id in stale {
            eprintln!("[camera] Watchdog: session {} timed out, removing", device_id);
            sessions.remove(&device_id);
            tally.remove(&device_id);
            let msg = serde_json::json!({
                "type": "camera_source_disconnected",
                "device_id": device_id,
            })
            .to_string();
            let _ = broadcast_tx.send(msg);
        }
    }
}
