use crate::state::AppState;
use base64::Engine as _;
use serde::Serialize;
use std::io::Write;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::State;

/// RTMP ingest (Phase 6).
///
/// The frontend encodes the program-feed compositor with WebCodecs (H.264,
/// Annex-B) and streams the encoded packets here. The backend owns a long-lived
/// `ffmpeg -f h264 -i pipe:` process doing **mux-only** work (`-c copy`) — it
/// never re-encodes — and writes the encoded packets to ffmpeg's stdin on a
/// dedicated writer thread, so the UI thread never blocks on pipe backpressure.
///
/// ffmpeg is resolved from PATH (same policy as thumbnail extraction). If it is
/// not installed the commands error cleanly instead of crashing.
#[derive(Serialize)]
pub struct RtmpStatus {
    pub active: bool,
    pub url: Option<String>,
}

/// An active ffmpeg ingest: the child plus an mpsc sender drained by a writer
/// thread that owns the process stdin. Dropping the sender signals EOF.
pub struct RtmpSession {
    pub child: Child,
    pub stdin_tx: mpsc::Sender<Vec<u8>>,
    pub url: String,
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

/// Spawn the writer thread that drains the channel into ffmpeg's stdin.
fn spawn_writer(mut stdin: ChildStdin) -> mpsc::Sender<Vec<u8>> {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(data) = rx.recv() {
            if stdin.write_all(&data).is_err() {
                break; // ffmpeg closed the pipe (crash / user stop)
            }
            let _ = stdin.flush();
        }
        // Drop stdin when the channel closes -> EOF to ffmpeg.
    });
    tx
}

fn ffmpeg_available() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Start an RTMP ingest: spawn ffmpeg (mux-only H.264 -> FLV/RTMP) and keep it
/// fed from the writer thread. Errors if a session is already active.
#[tauri::command]
pub fn rtmp_start(
    state: State<'_, AppState>,
    server_url: String,
    stream_key: Option<String>,
) -> Result<(), String> {
    let mut guard = state.rtmp.lock();
    if guard.is_some() {
        return Err("An RTMP session is already running — stop it first.".into());
    }
    let url = build_rtmp_url(&server_url, stream_key.as_deref());
    if !url.starts_with("rtmp://") {
        return Err("RTMP server URL must start with rtmp://".into());
    }
    if !ffmpeg_available() {
        return Err("ffmpeg was not found on PATH — install ffmpeg to use RTMP streaming.".into());
    }

    let mut child = Command::new("ffmpeg")
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-fflags",
            "nobuffer",
            "-f",
            "h264",
            "-framerate",
            "30",
            "-i",
            "pipe:0",
            "-c:v",
            "copy",
            "-an",
            "-f",
            "flv",
            "-flvflags",
            "no_duration_filesize",
            &url,
        ])
        .stdin(Stdio::piped())
        .stderr(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "ffmpeg stdin was not available.".to_string())?;
    let stdin_tx = spawn_writer(stdin);
    *guard = Some(RtmpSession { child, stdin_tx, url });
    Ok(())
}

/// Feed one encoded H.264 packet (Annex-B, base64 over IPC) to ffmpeg's stdin.
#[tauri::command]
pub fn rtmp_send(state: State<'_, AppState>, data_base64: String) -> Result<(), String> {
    let mut guard = state.rtmp.lock();
    let session = guard.as_mut().ok_or("No active RTMP session.")?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("Invalid RTMP packet: {e}"))?;
    session
        .stdin_tx
        .send(data)
        .map_err(|_| "RTMP writer closed (ffmpeg exited).".to_string())
}

/// Stop the active ingest: signal EOF to ffmpeg, then wait (with a timeout and
/// forced kill) for it to exit so the RTMP session is torn down cleanly.
#[tauri::command]
pub fn rtmp_stop(state: State<'_, AppState>) -> Result<(), String> {
    let session = state.rtmp.lock().take();
    let Some(session) = session else { return Ok(()) };
    drop(session.stdin_tx); // EOF to ffmpeg -> flush + finalize the stream
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut child = session.child;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("ffmpeg did not exit in time; the session was killed.".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("Failed to reap ffmpeg: {e}")),
        }
    }
}

/// Runtime status of the RTMP ingest (ephemeral, not persisted).
#[tauri::command]
pub fn rtmp_status(state: State<'_, AppState>) -> RtmpStatus {
    let guard = state.rtmp.lock();
    RtmpStatus {
        active: guard.is_some(),
        url: guard.as_ref().map(|s| s.url.clone()),
    }
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
}