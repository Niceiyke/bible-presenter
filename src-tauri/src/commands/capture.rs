//! Tauri commands exposing the native window-capture service (Phase 4).
//!
//! These are the operator-facing entry points for capturing a window's pixels
//! via Windows Graphics Capture. The default target is the audience `output`
//! window; the recorder/streamer use the dedicated off-screen `capture` window
//! instead. Recording and streaming surfaces (Phases 5-7) consume frames from
//! the same service.

use tauri::{AppHandle, State};

use crate::state::AppState;

/// Start a native capture session for a window (defaults to `output`).
#[tauri::command]
pub fn program_capture_start(
    app: AppHandle,
    state: State<'_, AppState>,
    window_label: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<u32>,
) -> Result<String, String> {
    crate::capture::start(
        &state.capture,
        &app,
        window_label.unwrap_or_else(|| "output".to_string()),
        width.unwrap_or(0),
        height.unwrap_or(0),
        fps.unwrap_or(30),
    )
}

/// Stop a running capture session.
#[tauri::command]
pub fn program_capture_stop(state: State<'_, AppState>, session_id: String) {
    crate::capture::stop(&state.capture, &session_id);
}

/// Snapshot the runtime status of a capture session.
#[tauri::command]
pub fn program_capture_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Option<crate::capture::CaptureStatus> {
    crate::capture::status(&state.capture, &session_id)
}
