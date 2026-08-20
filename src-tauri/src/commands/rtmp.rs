use crate::license::{ensure_active_tier, LicenseTier};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

/// RTMP ingest (Phase 6) — Phase D (engine transport).
///
/// Since Phase D the webview no longer encodes: the `wordlyte-engine` sidecar
/// owns the shared H.264 encoder (one ffmpeg, raw RGBA in, H.264 Annex-B out),
/// the fan-out to every destination's mux-only ffmpeg (`-c copy -f flv`), and
/// the capture/reaper threads. These commands are thin proxies over that
/// contract (`EngineCommand::RtmpStart/RtmpStop/RtmpStatus`), so the frontend
/// surface is unchanged while the pipeline moved process.
///
/// Webview audio input into the transport moved with the engine (Phase F);
/// `with_audio` now errors with a forward-looking message instead of wiring a
/// loopback AAC socket into a console-side ffmpeg.
#[derive(Serialize, Deserialize)]
pub struct RtmpStatus {
    pub id: String,
    pub active: bool,
    pub url: Option<String>,
    /// Capture frame rate this session's muxer was started with.
    pub fps: u32,
    /// Bytes currently buffered awaiting the session's writer thread.
    pub queued: usize,
    /// Bytes written to the session's muxer since it started.
    pub sent: usize,
    /// Bytes dropped by the bounded queue (queue full) since the session started.
    pub dropped: usize,
}

/// Validate a capture frame rate for transport sessions. The frontend offers
/// 24/25/30/50/60 fps, but any sane 1..=120 value is accepted so future
/// presets need no backend change; the engine's ffmpeg `-framerate` is derived
/// from it.
pub fn validate_fps(fps: u32) -> Result<(), String> {
    if !(1..=120).contains(&fps) {
        return Err("RTMP capture frame rate must be between 1 and 120 fps.".into());
    }
    Ok(())
}

/// Build the full RTMP ingest URL from a server URL + optional stream key,
/// e.g. `rtmp://host/live` + `mykey` -> `rtmp://host/live/mykey`.
pub fn build_rtmp_url(server_url: &str, stream_key: Option<&str>) -> String {
    let base = server_url.trim().trim_end_matches('/').to_string();
    let key = stream_key.unwrap_or("").trim().trim_start_matches('/').to_string();
    if key.is_empty() {
        base
    } else {
        format!("{}/{}", base, key)
    }
}

pub fn ffmpeg_available() -> bool {
    crate::binpaths::ffmpeg_available()
}

/// Start one destination's RTMP ingest inside the engine. The engine boots the
/// shared encoder when the first session starts (geometry from the stream-main
/// output config, falling back to 1920×1080) and the mux-only ffmpeg for this
/// session. Errors if that destination already has a session.
#[tauri::command]
pub async fn rtmp_start(
    state: State<'_, AppState>,
    session_id: String,
    server_url: String,
    stream_key: Option<String>,
    with_audio: bool,
    fps: Option<u32>,
) -> Result<(), String> {
    // Streaming is a paid feature (audit: tier enforcement must live on the
    // backend, not just in the UI).
    ensure_active_tier(&state, LicenseTier::Pro)?;
    let fps = fps.unwrap_or(30);
    validate_fps(fps)?;
    if with_audio {
        return Err(
            "Shared audio input moves to the engine in a later phase — start this destination without audio for now."
                .into(),
        );
    }
    let url = build_rtmp_url(&server_url, stream_key.as_deref());
    if !url.starts_with("rtmp://") {
        return Err("RTMP server URL must start with rtmp://".into());
    }
    if !ffmpeg_available() {
        return Err("ffmpeg was not found — install ffmpeg (or ship the bundled binary) to use RTMP streaming.".into());
    }
    let (width, height) = crate::commands::engine::transport_geometry(&state, (1920, 1080));
    let reply = crate::commands::engine::invoke(
        &state,
        crate::engine::ipc::EngineCommand::RtmpStart { session_id, url, fps, width, height },
    )
    .await?;
    crate::commands::engine::response_err(&reply).map_or(Ok(()), Err)
}

/// Stop one destination's ingest inside the engine: the engine drops the
/// session's feed channel (EOF to ffmpeg -> flush + finalize), reaps the muxer,
/// and tears the shared encoder down when the last session stops. Idempotent —
/// stopping an unknown/already-stopped session is a no-op.
#[tauri::command]
pub async fn rtmp_stop(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let reply = crate::commands::engine::invoke(
        &state,
        crate::engine::ipc::EngineCommand::RtmpStop { session_id },
    )
    .await?;
    crate::commands::engine::response_err(&reply).map_or(Ok(()), Err)
}

/// Runtime status of every active RTMP ingest in the engine (ephemeral, not
/// persisted). Never throws — an unreachable sidecar simply reports no sessions.
#[tauri::command]
pub async fn rtmp_status(state: State<'_, AppState>) -> Result<Vec<RtmpStatus>, String> {
    let Ok(reply) = crate::commands::engine::invoke(&state, crate::engine::ipc::EngineCommand::RtmpStatus).await else {
        return Ok(Vec::new());
    };
    let sessions = reply
        .response
        .result
        .and_then(|r| r.get("sessions").cloned())
        .and_then(|s| serde_json::from_value::<Vec<RtmpStatus>>(s).ok())
        .unwrap_or_default();
    Ok(sessions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_rtmp_url_joins_server_and_key() {
        assert_eq!(build_rtmp_url("rtmp://host/live", Some("abc")), "rtmp://host/live/abc");
        assert_eq!(build_rtmp_url("rtmp://host/live/", Some("/abc")), "rtmp://host/live/abc");
    }

    #[test]
    fn build_rtmp_url_without_key_keeps_server_url() {
        assert_eq!(build_rtmp_url("rtmp://host/live", None), "rtmp://host/live");
        assert_eq!(build_rtmp_url("rtmp://host/live", Some("")), "rtmp://host/live");
    }

    #[test]
    fn build_rtmp_url_rejects_wrong_scheme() {
        assert!(!build_rtmp_url("https://host/live", Some("k")).starts_with("rtmp://"));
    }

    #[test]
    fn validate_fps_rejects_unsupported_values() {
        assert!(validate_fps(0).is_err());
        assert!(validate_fps(121).is_err());
        assert!(validate_fps(30).is_ok());
        assert!(validate_fps(60).is_ok());
        assert!(validate_fps(24).is_ok());
    }
}