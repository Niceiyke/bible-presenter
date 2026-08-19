use crate::license::{ensure_active_tier, LicenseTier};
use crate::state::AppState;
use base64::Engine as _;
use parking_lot::Mutex;
use serde::Serialize;
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::State;

/// RTMP ingest (Phase 6).
///
/// The frontend encodes the program-feed compositor with WebCodecs (H.264,
/// Annex-B) and streams the encoded packets here. The backend owns long-lived
/// `ffmpeg -f h264 -i pipe:` processes doing **mux-only** work (`-c copy`) — they
/// never re-encode — and writes the encoded packets to each ffmpeg's stdin on a
/// dedicated writer thread, so the UI thread never blocks on pipe backpressure.
///
/// Multiple sessions can run simultaneously (multi-platform streaming): every
/// command is keyed by a `session_id` (the frontend destination id) and sessions
/// live in a `HashMap` on `AppState.rtmp`, so YouTube + Facebook + Twitch can
/// all be live from the one compositor stream at once.
///
/// Optional audio (Phase 6.1): when enabled, ffmpeg gets a second input —
/// ADTS AAC pulled from a loopback TCP socket (`-f adts -i tcp://127.0.0.1:PORT`)
/// that the backend accepts and feeds from an `rtmp_send_audio` channel, mirroring
/// the video writer. The frontend captures an input device with `getUserMedia`
/// and encodes AAC with WebCodecs, so the A/V sync is preserved mux-only.
///
/// ffmpeg is resolved from PATH (same policy as thumbnail extraction). If it is
/// not installed the commands error cleanly instead of crashing.
#[derive(Serialize)]
pub struct RtmpStatus {
    pub id: String,
    pub active: bool,
    pub url: Option<String>,
    /// Capture frame rate this session's ffmpeg was started with.
    pub fps: u32,
    /// Packets currently buffered awaiting the writer thread.
    pub queued: usize,
    /// Packets written to ffmpeg since the session started.
    pub sent: usize,
    /// Packets dropped by the bounded queue (queue full) since the session started.
    pub dropped: usize,
}

/// An active ffmpeg ingest: the child plus mpsc senders drained by writer
/// threads (video -> stdin, audio -> loopback TCP). Dropping the senders
/// signals EOF / closes the socket.
pub struct RtmpSession {
    pub child: Child,
    pub stdin_tx: mpsc::Sender<Vec<u8>>,
    pub audio_tx: Option<mpsc::Sender<Vec<u8>>>,
    /// In-flight packet counters used to bound buffering (drop-newest when the
    /// encoder outpaces ffmpeg instead of growing without bound).
    pub queued: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    pub audio_queued: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    /// Lifetime packet counters for operator-visible runtime status.
    pub sent: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    pub dropped: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    pub url: String,
    /// Capture frame rate the encoder was configured with (drives ffmpeg's
    /// `-framerate` so packet timing matches the selected capture cadence).
    pub fps: u32,
}

/// Result of a bounded enqueue: the packet was queued, dropped (queue full —
/// real-time streams self-heal, and blocking the operator UI on pipe
/// backpressure is worse than dropping a stale frame), or the writer closed
/// (ffmpeg exited and the session is gone).
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EnqueueResult {
    Queued,
    Dropped,
    Closed,
}

/// Max packets buffered per destination before the newest frame is dropped.
/// 120 packets ≈ 4s at 30 fps — enough to absorb a jitter spike, bounded
/// enough to prevent an out-of-memory cascade on a slow uplink.
const MAX_QUEUED_PACKETS: usize = 120;
/// Largest single encoded packet we accept over IPC (H.264 IDR frames and
/// ADTS AAC frames are far smaller; this only guards against runaway/malformed
/// input).
const MAX_PACKET_BYTES: usize = 8 * 1024 * 1024;

/// Validate a capture frame rate for RTMP ingest. The frontend offers 24/25/30/
/// 50/60 fps, but any sane 1..=120 value is accepted so future presets need no
/// backend change; the ffmpeg `-framerate` is derived from it.
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

/// Mux-only ffmpeg arguments. Video is H.264 Annex-B read from stdin at the
/// capture frame rate the encoder was configured with; optional audio is ADTS
/// AAC read from a loopback TCP socket (ffmpeg connects, the backend accepts).
/// Nothing is re-encoded — packets are copied straight into the FLV output.
fn ffmpeg_args(url: &str, audio_port: Option<u16>, fps: u32) -> Vec<String> {
    let mut args = vec![
        "-y".to_string(),
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-fflags".to_string(),
        "nobuffer".to_string(),
        "-f".to_string(),
        "h264".to_string(),
        "-framerate".to_string(),
        fps.to_string(),
        "-i".to_string(),
        "pipe:0".to_string(),
    ];
    if let Some(port) = audio_port {
        args.extend([
            "-f".into(),
            "adts".into(),
            "-i".into(),
            format!("tcp://127.0.0.1:{port}"),
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "1:a:0".into(),
            "-c:v".into(),
            "copy".into(),
            "-c:a".into(),
            "copy".into(),
        ]);
    } else {
        args.extend([
            "-map".into(),
            "0:v:0".into(),
            "-c:v".into(),
            "copy".into(),
        ]);
    }
    args.extend([
        "-f".into(),
        "flv".into(),
        "-flvflags".into(),
        "no_duration_filesize".into(),
        url.to_string(),
    ]);
    args
}

/// Spawn the writer thread that drains the channel into ffmpeg's stdin.
/// Returns the sender plus the live queued-packet counter and a lifetime
/// sent-packet counter the writer bumps after each successful write.
fn spawn_writer(
    mut stdin: ChildStdin,
) -> (
    mpsc::Sender<Vec<u8>>,
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let queued = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let sent = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = queued.clone();
    let sent_counter = sent.clone();
    std::thread::spawn(move || {
        use std::sync::atomic::Ordering;
        while let Ok(data) = rx.recv() {
            counter.fetch_sub(1, Ordering::SeqCst);
            if stdin.write_all(&data).is_err() {
                break; // ffmpeg closed the pipe (crash / user stop)
            }
            sent_counter.fetch_add(1, Ordering::SeqCst);
            let _ = stdin.flush();
        }
    });
    (tx, queued, sent)
}

/// Spawn the audio writer thread: accept ffmpeg's loopback TCP connection (non
/// blocking, up to ~5s, buffering anything that arrives before the handshake)
/// then drain the channel into the socket. Closing the channel tears it down.
fn spawn_audio_writer(
    listener: TcpListener,
) -> (
    mpsc::Sender<Vec<u8>>,
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
    std::sync::Arc<std::sync::atomic::AtomicUsize>,
) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let queued = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let sent = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = queued.clone();
    let sent_counter = sent.clone();
    std::thread::spawn(move || {
        use std::sync::atomic::Ordering;
        let _ = listener.set_nonblocking(true);
        let mut pending: Vec<Vec<u8>> = Vec::new();
        let mut stream: Option<TcpStream> = None;
        for _ in 0..100 {
            if let Ok((s, _)) = listener.accept() {
                stream = Some(s);
                break;
            }
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(data) => pending.push(data),
                Err(mpsc::RecvTimeoutError::Disconnected) => return, // stopped before connect
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        let Some(mut stream) = stream else {
            return; // ffmpeg never connected
        };
        for data in pending {
            counter.fetch_sub(1, Ordering::SeqCst);
            if stream.write_all(&data).is_err() {
                return;
            }
            sent_counter.fetch_add(1, Ordering::SeqCst);
        }
        while let Ok(data) = rx.recv() {
            counter.fetch_sub(1, Ordering::SeqCst);
            if stream.write_all(&data).is_err() {
                break; // ffmpeg closed the socket
            }
            sent_counter.fetch_add(1, Ordering::SeqCst);
            let _ = stream.flush();
        }
    });
    (tx, queued, sent)
}

/// Enqueue a packet with bounded drop-newest backpressure. `Queued` = accepted,
/// `Dropped` = queue full (a stale frame — real-time streams self-heal, and
/// blocking the operator UI on pipe backpressure is worse than dropping),
/// `Closed` = the writer thread already exited (ffmpeg is gone).
fn enqueue_bounded(
    tx: &mpsc::Sender<Vec<u8>>,
    queued: &std::sync::Arc<std::sync::atomic::AtomicUsize>,
    dropped: &std::sync::Arc<std::sync::atomic::AtomicUsize>,
    data: Vec<u8>,
) -> EnqueueResult {
    use std::sync::atomic::Ordering;
    if queued.load(Ordering::SeqCst) >= MAX_QUEUED_PACKETS {
        dropped.fetch_add(1, Ordering::SeqCst);
        return EnqueueResult::Dropped;
    }
    queued.fetch_add(1, Ordering::SeqCst);
    match tx.send(data) {
        Ok(()) => EnqueueResult::Queued,
        Err(_) => {
            queued.fetch_sub(1, Ordering::SeqCst);
            EnqueueResult::Closed
        }
    }
}

pub fn ffmpeg_available() -> bool {
    crate::binpaths::ffmpeg_available()
}

/// Spawns a reaper that removes a session the moment its ffmpeg child exits
/// (crash, network failure, or user stop), so the backend never retains a dead
/// session and `rtmp_start`/`rtmp_send` reflect reality. Dropping the session
/// closes the writer channels (EOF to ffmpeg). Polls non-blocking, so it never
/// blocks sends.
fn spawn_reaper(
    rtmp: Arc<Mutex<std::collections::HashMap<String, RtmpSession>>>,
    session_id: String,
) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let mut guard = rtmp.lock();
            let dead = match guard.get_mut(&session_id) {
                Some(s) => match s.child.try_wait() {
                    Ok(Some(_)) => true, // ffmpeg exited
                    Ok(None) => false,
                    Err(_) => true,
                },
                None => return, // already stopped/removed
            };
            if dead {
                // Dropping the session closes stdin/audio senders -> EOF to ffmpeg.
                guard.remove(&session_id);
                return;
            }
        }
    });
}

/// Start an RTMP ingest for one destination: spawn ffmpeg (mux-only H.264 ->
/// FLV/RTMP) and keep it fed from the writer thread. `with_audio` adds a second
/// loopback TCP input for ADTS AAC (WebCodecs-encoded by the frontend). Sessions
/// are keyed by `session_id` so several can be live simultaneously. Errors if
/// that destination already has a session.
#[tauri::command]
pub fn rtmp_start(
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
    let mut guard = state.rtmp.lock();
    if guard.contains_key(&session_id) {
        return Err("This RTMP destination is already live — stop it first.".into());
    }
    let url = build_rtmp_url(&server_url, stream_key.as_deref());
    if !url.starts_with("rtmp://") {
        return Err("RTMP server URL must start with rtmp://".into());
    }
    if !ffmpeg_available() {
        return Err("ffmpeg was not found on PATH — install ffmpeg to use RTMP streaming.".into());
    }

    let audio_listener = if with_audio {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("Failed to open the audio input socket: {e}"))?;
        Some(listener)
    } else {
        None
    };
    let audio_port = audio_listener
        .as_ref()
        .map(|l| l.local_addr().map_err(|e| e.to_string()).map(|a| a.port()))
        .transpose()?;

    let mut child = Command::new(crate::binpaths::ffmpeg_path())
        .args(ffmpeg_args(&url, audio_port, fps))
        .stdin(Stdio::piped())
        .stderr(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "ffmpeg stdin was not available.".to_string())?;
    let (stdin_tx, queued, sent) = spawn_writer(stdin);
    let (audio_tx, audio_queued, _audio_sent) = if let Some(listener) = audio_listener {
        let (tx, counter, sent_counter) = spawn_audio_writer(listener);
        (Some(tx), Some(counter), Some(sent_counter))
    } else {
        (None, None, None)
    };
    guard.insert(
        session_id.clone(),
        RtmpSession {
            child,
            stdin_tx,
            audio_tx,
            queued,
            audio_queued: audio_queued.unwrap_or_default(),
            sent,
            dropped: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            url,
            fps,
        },
    );
    drop(guard);
    // Reap the session automatically when ffmpeg exits so a crashed/stopped
    // ingest can never linger as a dead entry that blocks a retry.
    spawn_reaper(state.rtmp.clone(), session_id);
    Ok(())
}

/// Feed one encoded H.264 packet (Annex-B, base64 over IPC) to a destination's
/// ffmpeg stdin. Returns whether the packet was queued or dropped (queue full);
/// errors when the writer closed (ffmpeg exited).
#[tauri::command]
pub fn rtmp_send(
    state: State<'_, AppState>,
    session_id: String,
    data_base64: String,
) -> Result<EnqueueResult, String> {
    let mut guard = state.rtmp.lock();
    let session = guard
        .get_mut(&session_id)
        .ok_or("No active RTMP session for this destination.")?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("Invalid RTMP packet: {e}"))?;
    if data.len() > MAX_PACKET_BYTES {
        return Err("RTMP packet exceeds the size limit.".into());
    }
    match enqueue_bounded(&session.stdin_tx, &session.queued, &session.dropped, data) {
        EnqueueResult::Closed => Err("RTMP writer closed (ffmpeg exited).".into()),
        other => Ok(other),
    }
}

/// Feed one encoded AAC frame (ADTS, base64 over IPC) to a destination's
/// ffmpeg audio input.
#[tauri::command]
pub fn rtmp_send_audio(
    state: State<'_, AppState>,
    session_id: String,
    data_base64: String,
) -> Result<EnqueueResult, String> {
    // Shared audio input is a Premium feature.
    ensure_active_tier(&state, LicenseTier::Premium)?;
    let mut guard = state.rtmp.lock();
    let session = guard
        .get_mut(&session_id)
        .ok_or("No active RTMP session for this destination.")?;
    let tx = session
        .audio_tx
        .as_ref()
        .ok_or("RTMP session has no audio input (start it with audio enabled).")?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("Invalid RTMP audio packet: {e}"))?;
    if data.len() > MAX_PACKET_BYTES {
        return Err("RTMP audio packet exceeds the size limit.".into());
    }
    match enqueue_bounded(tx, &session.audio_queued, &session.dropped, data) {
        EnqueueResult::Closed => Err("RTMP audio writer closed (ffmpeg exited).".into()),
        other => Ok(other),
    }
}

/// Stop one destination's ingest: signal EOF to ffmpeg, then wait (with a
/// timeout and forced kill) for it to exit so the session is torn down cleanly.
/// Idempotent — stopping an unknown/already-stopped session is a no-op. The
/// wait loop runs off the main thread so the UI never blocks on a slow pipe.
#[tauri::command]
pub async fn rtmp_stop(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let session = state.rtmp.lock().remove(&session_id);
    let Some(session) = session else { return Ok(()) };
    drop(session.stdin_tx); // EOF to ffmpeg -> flush + finalize the stream
    drop(session.audio_tx); // close the audio socket -> ffmpeg finishes the AAC stream
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| format!("rtmp_stop join error: {e}"))?
}

/// Runtime status of every active RTMP ingest (ephemeral, not persisted).
#[tauri::command]
pub fn rtmp_status(state: State<'_, AppState>) -> Vec<RtmpStatus> {
    let guard = state.rtmp.lock();
    use std::sync::atomic::Ordering;
    guard
        .iter()
        .map(|(id, s)| RtmpStatus {
            id: id.clone(),
            active: true,
            url: Some(s.url.clone()),
            fps: s.fps,
            queued: s.queued.load(Ordering::SeqCst),
            sent: s.sent.load(Ordering::SeqCst),
            dropped: s.dropped.load(Ordering::SeqCst),
        })
        .collect()
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
    fn ffmpeg_args_video_only_has_no_audio_input() {
        let args = ffmpeg_args("rtmp://host/live/key", None, 30);
        let joined = args.join(" ");
        assert!(joined.contains("-f h264") && joined.contains("-i pipe:0"));
        assert!(joined.contains("-map 0:v:0") && joined.contains("-c:v copy"));
        assert!(!joined.contains("adts") && !joined.contains("tcp://") && !joined.contains("-c:a"));
        assert!(joined.ends_with("-f flv -flvflags no_duration_filesize rtmp://host/live/key"));
    }

    #[test]
    fn ffmpeg_args_with_audio_adds_loopback_aac_input() {
        let args = ffmpeg_args("rtmp://host/live/key", Some(44111), 30);
        let joined = args.join(" ");
        assert!(joined.contains("-f adts -i tcp://127.0.0.1:44111"));
        assert!(joined.contains("-map 0:v:0 -map 1:a:0"));
        assert!(joined.contains("-c:v copy -c:a copy"));
    }

    #[test]
    fn ffmpeg_args_uses_the_selected_capture_fps() {
        for fps in [24u32, 25, 30, 50, 60] {
            let args = ffmpeg_args("rtmp://host/live/key", None, fps);
            let joined = args.join(" ");
            assert!(
                joined.contains(&format!("-framerate {fps}")),
                "expected -framerate {fps} in {joined}"
            );
        }
    }

    #[test]
    fn validate_fps_rejects_unsupported_values() {
        assert!(validate_fps(0).is_err());
        assert!(validate_fps(121).is_err());
        assert!(validate_fps(30).is_ok());
        assert!(validate_fps(60).is_ok());
        assert!(validate_fps(24).is_ok());
    }

    #[test]
    fn enqueue_bounded_reports_queued_dropped_and_closed() {
        use std::sync::atomic::AtomicUsize;
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let queued = std::sync::Arc::new(AtomicUsize::new(0));
        let dropped = std::sync::Arc::new(AtomicUsize::new(0));
        // Queue has room -> queued.
        assert_eq!(enqueue_bounded(&tx, &queued, &dropped, vec![1]), EnqueueResult::Queued);
        assert_eq!(queued.load(std::sync::atomic::Ordering::SeqCst), 1);
        // Fill the queue beyond the cap -> dropped (and the drop counter bumps).
        for _ in 0..MAX_QUEUED_PACKETS {
            queued.store(MAX_QUEUED_PACKETS, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(enqueue_bounded(&tx, &queued, &dropped, vec![2]), EnqueueResult::Dropped);
        }
        assert_eq!(dropped.load(std::sync::atomic::Ordering::SeqCst), MAX_QUEUED_PACKETS);
        // Close the receiver -> closed.
        drop(rx);
        queued.store(0, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(enqueue_bounded(&tx, &queued, &dropped, vec![3]), EnqueueResult::Closed);
    }

    #[test]
    fn reaper_removes_session_when_child_exits() {
        use std::collections::HashMap;
        use std::sync::mpsc;
        let map: Arc<Mutex<HashMap<String, RtmpSession>>> = Arc::new(Mutex::new(HashMap::new()));
        let (tx, _rx) = mpsc::channel::<Vec<u8>>();
        let child = {
            #[cfg(windows)]
            {
                Command::new("cmd").arg("/C").arg("exit 0").spawn().unwrap()
            }
            #[cfg(not(windows))]
            {
                Command::new("true").spawn().unwrap()
            }
        };
        map.lock().insert(
            "s1".to_string(),
            RtmpSession {
                child,
                stdin_tx: tx,
                audio_tx: None,
                queued: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                audio_queued: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                sent: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                dropped: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                url: "rtmp://host/live".to_string(),
                fps: 30,
            },
        );
        spawn_reaper(map.clone(), "s1".to_string());
        // The reaper should observe the child exit and remove the dead session.
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if !map.lock().contains_key("s1") {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("reaper did not remove the dead session");
    }
}