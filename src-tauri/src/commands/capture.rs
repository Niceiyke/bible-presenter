//! Tauri commands exposing the native window-capture service (Phase 4).
//!
//! These are the operator-facing entry points for capturing a window's pixels
//! via Windows Graphics Capture. The recorder/streamer prefer the audience
//! `output` window as the capture source whenever it is on screen (one real
//! WGC readback of the pixels that are actually being projected); when it is
//! off, they fall back to the dedicated off-screen `capture` window via
//! `ensure_capture_visible`/`swap_capture_source`. Recording and streaming
//! surfaces (Phases 5-7) consume frames from the same service.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::state::AppState;

/// The `capture` window is the fallback WGC source, not an `OutputConfig`.
pub const CAPTURE_WINDOW: &str = "capture";
/// The audience projection window is the preferred WGC source while visible.
pub const OUTPUT_WINDOW: &str = "output";

/// Mutable view of one recorder/streamer's current capture source, so the
/// mid-session source swap (`swap_capture_source`) is shared between the two
/// surfaces. `rx` is the frame channel the writer thread drains; swapping the
/// receiver at the end of a swap lets ffmpeg keep running across the switch
/// (the old channel's sender drops when its session is detached — harmless).
pub struct ActiveCapture {
    pub session_id: String,
    pub consumer: crate::capture::ConsumerHandle,
    /// Current source window label: `"output"` (projector on-screen) or
    /// `"capture"` (dedicated fallback window).
    pub source: String,
    pub rx: Arc<parking_lot::Mutex<crate::capture::FrameSinkRx>>,
}

/// Whether the audience projection window is currently on screen. The
/// recorder/streamer capture the real window when it is (identical pixels to
/// what the audience sees, and the dedicated `capture` window stays hidden);
/// they fall back to the `capture` window only while the projector is off.
pub fn output_window_visible(app: &AppHandle) -> bool {
    app.get_webview_window(OUTPUT_WINDOW)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// Pick the capture source at session start: the `output` window when it is on
/// screen, otherwise reveal the `capture` window (taking a hold) and target it.
/// The returned label is what the new session must bind.
pub fn initial_capture_source(app: &AppHandle, state: &AppState) -> Result<String, String> {
    if output_window_visible(app) {
        Ok(OUTPUT_WINDOW.to_string())
    } else {
        ensure_capture_visible(app, state)?;
        Ok(CAPTURE_WINDOW.to_string())
    }
}

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
        .get_webview_window(CAPTURE_WINDOW)
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
        if let Some(window) = app.get_webview_window(CAPTURE_WINDOW) {
            let _ = window.hide();
        }
    }
}

/// Move a live recorder/streamer's capture source, WITHOUT stopping it: bind a
/// fresh session on the target window, atomically hand the writer its new frame
/// receiver (ffmpeg never sees EOF, so the recording/stream continues), then
/// detach the old session. Window labels differ, so the sessions never share
/// params — the old session is torn down by `detach_consumer` once it has no
/// other consumers. The `capture`-window hold counter is balanced exactly one
/// per session currently sourcing the capture window: moving onto it takes a
/// hold (revealing it before WGC binds), moving off releases it.
#[allow(clippy::too_many_arguments)]
pub fn swap_capture_source(
    state: &AppState,
    app: &AppHandle,
    active: &mut ActiveCapture,
    target: &str,
    width: u32,
    height: u32,
    fps: u32,
    sink_capacity: usize,
    strict: bool,
) -> Result<(), String> {
    if active.source == target {
        return Ok(());
    }
    if target == CAPTURE_WINDOW {
        ensure_capture_visible(app, state)?;
        // Refresh the capture window's DOM so the freshly-bound session sees the
        // current program instead of whatever frame it last presented.
        crate::commands::outputs::rebroadcast_presentation(app, state);
    }
    let (tx, rx) = crate::capture::bounded_sink(sink_capacity);
    let (new_session_id, new_consumer) =
        match crate::capture::start_for_consumer(
            &state.capture,
            app,
            target.to_string(),
            width,
            height,
            fps,
            tx,
            strict,
        ) {
            Ok(joined) => joined,
            Err(e) => {
                // Never bound — undo the hold taken above, and leave the old
                // session untouched so the surface keeps recording/streaming.
                if target == CAPTURE_WINDOW {
                    maybe_hide_capture(app, state);
                }
                return Err(e);
            }
        };
    // Swap the writer's channel before detaching the old session, so there is
    // never a moment where ffmpeg's stdin would close.
    *active.rx.lock() = rx;
    crate::capture::detach_consumer(&state.capture, &active.session_id, active.consumer);
    active.session_id = new_session_id;
    active.consumer = new_consumer;
    active.source = target.to_string();
    if target != CAPTURE_WINDOW {
        maybe_hide_capture(app, state);
    }
    Ok(())
}

/// Move every live session (recording + broadcast) to the capture source that
/// matches the current projector state: the `output` window when it is on
/// screen, the `capture` window when it is not. Called from the single
/// authoritative `set_output_visible` path so a projector toggle can never
/// leave a session bound to a window WGC can no longer present.
pub fn sync_capture_sources(app: &AppHandle, state: &AppState, output_visible: bool) -> Result<(), String> {
    let target = if output_visible { OUTPUT_WINDOW } else { CAPTURE_WINDOW };
    if let Some(rec) = state.recording.lock().as_mut() {
        let (w, h, f) = {
            let s = rec.status.lock();
            (s.width, s.height, s.fps)
        };
        swap_capture_source(
            state,
            app,
            &mut rec.capture,
            target,
            w,
            h,
            f,
            crate::commands::recordings::SINK_CAPACITY,
            true,
        )?;
    }
    if let Some(br) = state.streaming.lock().as_mut() {
        swap_capture_source(
            state,
            app,
            &mut br.capture,
            target,
            br.width,
            br.height,
            br.fps,
            crate::commands::streaming::STREAM_SINK_CAPACITY,
            false,
        )?;
    }
    Ok(())
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
