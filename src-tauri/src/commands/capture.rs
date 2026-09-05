//! Tauri commands exposing the native window-capture service (Phase 4).
//!
//! These are the operator-facing entry points for capturing a window's pixels
//! via Windows Graphics Capture. The default target is the audience `output`
//! window; the recorder/streamer use the dedicated off-screen `capture` window
//! instead. Recording and streaming surfaces (Phases 5-7) consume frames from
//! the same service.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, State};

use crate::state::AppState;

/// Claim a hold on the dedicated `capture` window for a recording/broadcast
/// session and reveal it.
///
/// Windows Graphics Capture only delivers new frames while the window is
/// on-screen and presenting; binding a session to a hidden (or fully
/// off-screen) window freezes capture on its first stale frame. The webview is
/// mounted and hydrated even while hidden, so `show()` immediately produces a
/// present WGC can catch. The window is hidden by default; a hold-counter (not
/// mere session presence) guarantees a concurrent stop of the OTHER surface can
/// never hide it mid-bind, and every stop/abort/error path releases the hold via
/// `maybe_hide_capture`.
pub fn ensure_capture_visible(app: &AppHandle, state: &AppState) -> Result<(), String> {
    // First holder reveals the window; later holders just bump the count.
    if state.capture_window_users.fetch_add(1, Ordering::SeqCst) != 0 {
        return Ok(());
    }
    let window = app
        .get_webview_window("capture")
        .ok_or_else(|| "No capture window bound.".to_string())?;
    // On a show failure, release the hold so the count stays balanced.
    if let Err(e) = window.show() {
        state.capture_window_users.fetch_sub(1, Ordering::SeqCst);
        return Err(e.to_string());
    }
    Ok(())
}

/// Release this surface's hold on the `capture` window, hiding it only when the
/// last holder is gone. Recording and streaming share the one capture window
/// (and usually one WGC session), so stopping one surface releases only its own
/// hold while the other keeps the window up. Hide failure is benign (e.g. app
/// shutdown).
pub fn maybe_hide_capture(app: &AppHandle, state: &AppState) {
    let prev = state.capture_window_users.fetch_sub(1, Ordering::SeqCst);
    // A 0 would underflow — defensive guard for imbalanced callers.
    if prev == 0 {
        state.capture_window_users.store(0, Ordering::SeqCst);
        return;
    }
    if prev == 1 {
        if let Some(window) = app.get_webview_window("capture") {
            let _ = window.hide();
        }
    }
}

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
