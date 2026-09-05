use crate::commands::rtmp::build_rtmp_url;
use crate::license::{ensure_active_tier, LicenseTier};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use tauri::{AppHandle, State};

/// How many raw NV12 frames the broadcast's bounded queue can hold in flight
/// before the capture side drops the newest frame. Because the capture fan-out
/// uses try_send (drop-newest), a congested broadcast never stalls capture or
/// a recording. Each frame is ~W*H*1.5 bytes, so this bounds buffering.
pub(crate) const STREAM_SINK_CAPACITY: usize = 8;

/// One destination as configured by the operator (persisted on the `stream-main`
/// output as `stream_destinations`). `enabled` joins the master Go Live; when the
/// broadcast captures a native audio device, the same mix rides every tee target.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamDest {
    pub id: String,
    pub label: String,
    pub url: String,
    #[serde(default)]
    pub stream_key: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub audio: bool,
}

fn default_true() -> bool {
    true
}

/// Per-destination runtime status surfaced to the Streaming hub.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamDestinationStatus {
    pub id: String,
    pub label: String,
    pub active: bool,
    pub url: Option<String>,
    /// Frames written into the broadcast's ffmpeg stdin.
    pub frames: u64,
    /// Bytes written over the pipe (pre-encode, raw NV12).
    pub bytes: u64,
    pub error: Option<String>,
    /// Whether program audio (external mic / line-in) is attached to this
    /// destination and being muxed into its stream.
    pub audio_attached: bool,
}

/// Broadcast-level status with every destination's individual state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamingStatus {
    pub active: bool,
    pub capture_session_id: Option<String>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Unix ms of wall-clock start, for the elapsed timer.
    pub started_ms: u64,
    pub destinations: Vec<StreamDestinationStatus>,
}

fn idle_status() -> StreamingStatus {
    StreamingStatus {
        active: false,
        capture_session_id: None,
        width: 0,
        height: 0,
        fps: 0,
        started_ms: 0,
        destinations: Vec::new(),
    }
}

/// One destination as tracked inside a live broadcast. Destinations no longer
/// own their own ffmpeg process: a single broadcast process encodes the program
/// once and fans the encoded stream out to every destination via ffmpeg's
/// `tee` muxer, so N streams cost one encode (plus one cheap `-c copy` flv mux
/// each). Status of every destination mirrors the shared process.
pub struct StreamDestinationSession {
    pub id: String,
    pub label: String,
    pub url: String,
    /// Whether this destination expects program audio in its stream (== the
    /// broadcast-wide program-audio toggle; audio is all-or-none under tee).
    pub audio: bool,
}

/// An active broadcast: one shared capture session of the program surface
/// (the `output` window when it is on-screen, the dedicated `capture` window
/// otherwise) feeds one ffmpeg process that encodes once and `tee`s the stream
/// to N RTMP ingests. Stopping the broadcast detaches the consumer (closes the
/// channel -> stdin EOF) so ffmpeg finalizes cleanly.
pub struct BroadcastSession {
    /// This broadcast's live capture source (window label, session id, consumer
    /// handle, and the writer's frame channel), swappable mid-session when the
    /// projector window toggles via `sync_capture_sources`.
    pub capture: crate::commands::capture::ActiveCapture,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub started_ms: u64,
    pub destinations: Vec<StreamDestinationSession>,
    /// The single tee ffmpeg child shared by every destination.
    pub child: Child,
    pub writer_thread: Option<std::thread::JoinHandle<()>>,
    pub frames: Arc<std::sync::atomic::AtomicU64>,
    pub bytes: Arc<std::sync::atomic::AtomicU64>,
    /// The directshow audio device name captured natively by ffmpeg (if any)
    /// and muxed as AAC into every destination's stream.
    pub audio_device: Option<String>,
    /// This broadcast's private relay onto the shared audio feed (when audio is
    /// enabled). Dropping it before the ffmpeg wait lets the broadcast's ffmpeg
    /// see audio EOF and finalize cleanly even while a recording keeps the feed
    /// alive.
    pub audio: Option<crate::commands::program_audio::AudioRelay>,
    /// Retained ffmpeg stderr tail for failure diagnostics.
    pub stderr_tail: Arc<parking_lot::Mutex<Vec<u8>>>,
}

/// Build the ffmpeg argv for the whole broadcast: raw NV12 from stdin, ONE
/// H.264 encode, fanned out with ffmpeg's `tee` muxer to every RTMP ingest
/// (`-f tee '[f=flv:onfail=ignore]url1|[f=flv:onfail=ignore]url2'`). Each tee
/// target is a normal FLV mux writing the same encoded packets, so N
/// destinations cost one encode + one cheap `-c copy` mux each.
///
/// When `audio_feed_port` is set, the consumer reads AAC/ADTS from the shared
/// `AudioFeed` TCP socket (`-f aac -i tcp://127.0.0.1:PORT` — `aac` is the
/// raw-ADTS demuxer name) rather than opening the dshow device directly.  The
/// feed captured and encoded the device once; the consumer copies the stream
/// without re-encoding (`-c:a copy`).
/// Every `-map` is emitted only AFTER all inputs are declared — ffmpeg's
/// parser rejects a `-map` that directly follows an input.
fn stream_tee_args(
    width: u32,
    height: u32,
    fps: u32,
    encoder: &str,
    urls: &[String],
    audio_feed_port: Option<u16>,
) -> Vec<String> {
    // ~2s keyframe interval for hardware encoders; software encoders ignore `-g`.
    let encoder_block = crate::commands::recordings::h264_encoder_block(encoder, fps * 2);
    let spec: String = urls
        .iter()
        .map(|u| format!("[f=flv:onfail=ignore]{u}"))
        .collect::<Vec<_>>()
        .join("|");
    let has_audio = audio_feed_port.is_some();
    let mut args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "nv12".into(),
        "-s".into(),
        format!("{width}x{height}"),
        "-r".into(),
        fps.to_string(),
        "-i".into(),
        "pipe:0".into(),
    ];
    if let Some(port) = audio_feed_port {
        args.extend([
            "-f".into(),
            "aac".into(),
            "-i".into(),
            format!("tcp://127.0.0.1:{port}"),
        ]);
    } else {
        args.push("-an".into());
    }
    args.extend(encoder_block);
    if has_audio {
        // Feed already encoded AAC; copy without re-encoding.
        args.extend(["-c:a".into(), "copy".into()]);
    }
    args.push("-map".into());
    args.push("0:v:0".into());
    if has_audio {
        args.push("-map".into());
        args.push("1:a:0".into());
    }
    args.extend([
        "-flvflags".into(),
        "no_duration_filesize".into(),
        "-f".into(),
        "tee".into(),
        spec,
    ]);
    args
}

/// Start an RTMP broadcast of the program to every enabled destination. ONE
/// ffmpeg process encodes once (`-f tee`) and fans the encoded stream out to
/// each RTMP ingest, so N destinations cost a single encode. Only one
/// broadcast can be live at a time. The source is the audience `output` window
/// while it is on screen; when it is off, the hidden-by-default `capture`
/// window is revealed for the session (WGC requires an on-screen, presenting
/// window).
/// When `audio_device` names a DirectShow input device, ffmpeg
/// captures it natively and encodes it to AAC for every destination.
#[tauri::command]
pub fn stream_rtmp_start(
    app: AppHandle,
    state: State<'_, AppState>,
    destinations: Vec<StreamDest>,
    width: u32,
    height: u32,
    fps: u32,
    audio_device: Option<String>,
) -> Result<StreamingStatus, String> {
    ensure_active_tier(&state, LicenseTier::Pro)?;
    if audio_device.is_some() {
        ensure_active_tier(&state, LicenseTier::Premium)?;
    }
    {
        if state.streaming.lock().is_some() {
            return Err("A broadcast is already live — stop it first.".into());
        }
    }
    if !crate::binpaths::ffmpeg_available() {
        return Err("ffmpeg was not found — install ffmpeg to stream.".into());
    }
    let audio_device = audio_device.filter(|d| !d.trim().is_empty());
    // Capture the device ONCE via the shared AudioFeed, then open a private
    // relay for THIS broadcast.  Both this broadcast and a concurrent recording
    // subscribe to the same feed instead of opening dshow twice — two ffmpeg
    // processes competing for the same dshow pin disrupted both pipelines under
    // QSV load.
    let relay = if let Some(device) = &audio_device {
        Some(crate::commands::program_audio::subscribe_feed(device)?)
    } else {
        None
    };
    let audio_feed_port = relay.as_ref().map(|r| r.port());

    let enabled: Vec<StreamDest> = destinations.into_iter().filter(|d| d.enabled).collect();
    if enabled.is_empty() {
        return Err("No enabled destinations to stream to.".into());
    }

    let w = width.max(1);
    let h = height.max(1);
    let f = fps.clamp(1, 60);

    // Resolve and validate every destination URL up front. Errors before any
    // side effects (no ffmpeg spawned) so a typo'd URL cannot orphan processes.
    let mut urls: Vec<String> = Vec::new();
    for dest in &enabled {
        let url = build_rtmp_url(&dest.url, dest.stream_key.as_deref());
        if !url.starts_with("rtmp://") {
            return Err(format!(
                "Destination '{}' has a non-RTMP URL: {}",
                dest.label, url
            ));
        }
        urls.push(url);
    }

    // One bounded (tx, rx) pair feeding the single tee ffmpeg. try_send
    // (drop-newest) under congestion never stalls capture or a concurrent
    // recording.
    let (tx, rx) = crate::capture::bounded_sink(STREAM_SINK_CAPACITY);
    let encoder = crate::commands::recordings::pick_h264_encoder();
    // Large-buffer stdin (Windows): std's `Stdio::piped()` is a 4 KB pipe; a raw
    // 1080p NV12 frame is ~4 MB, so the write end alone would churn ~1,000
    // partial writes (syscall + kernel copy each) per frame.
    let (stdin_file, stdin_stdio) = crate::commands::recordings::encoder_stdin_stdio();
    let args = stream_tee_args(w, h, f, &encoder, &urls, audio_feed_port);
    let mut child = match Command::new(crate::binpaths::ffmpeg_path())
        .args(&args)
        .stdin(stdin_stdio)
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return Err(format!("Failed to start ffmpeg: {e}")),
    };

    // Prefer the audience `output` window as the WGC source while it is on
    // screen (one real readback of the projected pixels); fall back to the
    // dedicated `capture` window when the projector is off.
    let capture_source = match crate::commands::capture::initial_capture_source(&app, state.inner())
    {
        Ok(s) => s,
        Err(e) => {
            // ffmpeg is already alive at this point; tear it down on a reveal
            // failure so it cannot linger.
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    crate::commands::outputs::rebroadcast_presentation(&app, state.inner());

    // Attach the single bounded sink to a shared capture session on the chosen
    // window. When a recording is already capturing that window at the same
    // geometry, the broadcast joins that SAME session (one WGC readback);
    // otherwise it starts a fresh session.
    let (capture_session_id, consumer) =
        match crate::capture::start_for_consumer(
            &state.capture,
            &app,
            capture_source.clone(),
            w,
            h,
            f,
            tx,
            false,
        ) {
            Ok(joined) => joined,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                // No session bound; restore the window (unless a recording still
                // needs it) when the capture window was our source.
                if capture_source == crate::commands::capture::CAPTURE_WINDOW {
                    crate::commands::capture::maybe_hide_capture(&app, state.inner());
                }
                return Err(e);
            }
        };

    crate::store::log_msg(
        &app,
        &format!(
            "Broadcast started (encoder: {}; {}x{} @ {}fps; {} destination(s); audio: {}; source: {})",
            encoder,
            w,
            h,
            f,
            enabled.len(),
            audio_device.as_deref().unwrap_or("off"),
            capture_source
        ),
    );

    let started_ms = chrono::Utc::now().timestamp_millis() as u64;

    // The writer thread drains the bounded rx into ffmpeg's stdin. Detaching this
    // broadcast's consumer (on stop) closes the channel -> stdin EOF -> ffmpeg
    // finalizes every tee target.
    let stdin: Box<dyn std::io::Write + Send> = match (child.stdin.take(), stdin_file) {
        (Some(cs), _) => Box::new(cs),
        (None, Some(wf)) => Box::new(wf),
        (None, None) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("ffmpeg stdin was not available.".to_string());
        }
    };
    // Drain stderr from the start: an undrained pipe can stall ffmpeg, and the
    // retained tail turns a bare exit code into ffmpeg's real message.
    let stderr_tail = crate::commands::recordings::drain_stderr_tail(&mut child);
    let frames = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let bytes = Arc::new(std::sync::atomic::AtomicU64::new(0));
    // The receiver lives behind a mutex so a mid-session source swap can hand
    // the writer a fresh channel without ever closing ffmpeg's stdin.
    let active_rx: Arc<parking_lot::Mutex<crate::capture::FrameSinkRx>> =
        Arc::new(parking_lot::Mutex::new(rx));
    let fcounter = frames.clone();
    let bcounter = bytes.clone();
    let writer_rx = active_rx.clone();
    let writer_thread = std::thread::Builder::new()
        .name("stream-writer".to_string())
        .spawn(move || {
            let mut stdin = stdin;
            let mut n = 0u64;
            let mut b = 0u64;
            loop {
                let frame = {
                    let guard = writer_rx.lock();
                    match guard.recv_timeout(std::time::Duration::from_millis(20)) {
                        Ok(f) => Some(f),
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                    }
                };
                let Some(frame) = frame else { continue; };
                let data: &[u8] = &frame.pixels;
                if stdin.write_all(data).is_err() {
                    break; // ffmpeg closed the pipe (crash / uplink failure)
                }
                let _ = stdin.flush();
                n += 1;
                b += data.len() as u64;
            }
            let _ = stdin.flush();
            fcounter.store(n, std::sync::atomic::Ordering::SeqCst);
            bcounter.store(b, std::sync::atomic::Ordering::SeqCst);
        })
        .map_err(|e| e.to_string())?;

    let sessions: Vec<StreamDestinationSession> = enabled
        .into_iter()
        .zip(urls)
        .map(|(d, url)| StreamDestinationSession {
            id: d.id,
            label: d.label,
            url,
            audio: audio_device.is_some(),
        })
        .collect();

    let broadcast = BroadcastSession {
        capture: crate::commands::capture::ActiveCapture {
            session_id: capture_session_id,
            consumer,
            source: capture_source,
            rx: active_rx,
        },
        width: w,
        height: h,
        fps: f,
        started_ms,
        destinations: sessions,
        child,
        writer_thread: Some(writer_thread),
        frames,
        bytes,
        audio_device,
        audio: relay,
        stderr_tail,
    };
    *state.streaming.lock() = Some(broadcast);
    crate::commands::outputs::publish_capture_active(&app, &state);

    let mut guard = state.streaming.lock();
    Ok(streaming_status_locked(&mut guard))
}

/// Build the live status from the current broadcast. Detects ffmpeg death in
/// flight: when the single tee process has exited while the broadcast is live,
/// every destination is reported as failed (active=false + stderr detail)
/// instead of a stale "live".
fn streaming_status_locked(guard: &mut parking_lot::MutexGuard<Option<BroadcastSession>>) -> StreamingStatus {
    match guard.as_mut() {
        None => idle_status(),
        Some(b) => {
            let frames = b.frames.load(std::sync::atomic::Ordering::SeqCst);
            let bytes = b.bytes.load(std::sync::atomic::Ordering::SeqCst);
            let audio_attached = b.audio_device.is_some();
            // None = ffmpeg still running (all destinations mirror it as live).
            let shared_error: Option<String> = match b.child.try_wait() {
                Ok(None) => None,
                Ok(Some(st)) => {
                    let detail = crate::commands::recordings::stderr_tail_text(&b.stderr_tail)
                        .map(|t| format!(" — ffmpeg said: {t}"))
                        .unwrap_or_default();
                    Some(if st.success() {
                        "ffmpeg stopped unexpectedly while live.".into()
                    } else {
                        format!("ffmpeg exited with {st}{detail}")
                    })
                }
                Err(e) => Some(format!("Could not check ffmpeg state: {e}")),
            };
            let destinations = b
                .destinations
                .iter()
                .map(|d| StreamDestinationStatus {
                    id: d.id.clone(),
                    label: d.label.clone(),
                    active: shared_error.is_none(),
                    url: Some(d.url.clone()),
                    frames,
                    bytes,
                    error: shared_error.clone(),
                    audio_attached,
                })
                .collect();
            StreamingStatus {
                active: true,
                capture_session_id: Some(b.capture.session_id.clone()),
                width: b.width,
                height: b.height,
                fps: b.fps,
                started_ms: b.started_ms,
                destinations,
            }
        }
    }
}

/// Tap the current broadcast status (idle status if none).
#[tauri::command]
pub fn stream_rtmp_status(state: State<'_, AppState>) -> StreamingStatus {
    let mut guard = state.streaming.lock();
    streaming_status_locked(&mut guard)
}

/// Stop the live broadcast: detach the single consumer (drops the capture
/// sender -> the writer sees EOF -> ffmpeg stdin closes -> the tee finalizes
/// every destination), join the writer, close the audio feed BEFORE waiting on
/// ffmpeg (otherwise ffmpeg never sees EOF on the audio socket and never
/// finalizes the mux), then wait for ffmpeg to exit (killing it if it hangs).
/// Destinations are fire-and-forget — nothing is saved locally.
#[tauri::command]
pub async fn stream_rtmp_stop(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let mut broadcast = state
        .streaming
        .lock()
        .take()
        .ok_or_else(|| "No broadcast is live.".to_string())?;

    crate::commands::outputs::publish_capture_active(&app, &state);

    // Detach this broadcast's sink from the shared capture session. The last
    // consumer to detach (recorder or this broadcast) stops and removes the
    // session; detaching alongside a live recording leaves the shared capture
    // running for it.
    crate::capture::detach_consumer(
        &state.capture,
        &broadcast.capture.session_id,
        broadcast.capture.consumer,
    );
    // With this broadcast's consumer detached, release its hold on the capture
    // window (only when it was the capture source) so the window hides once no
    // other session needs it.
    if broadcast.capture.source == crate::commands::capture::CAPTURE_WINDOW {
        crate::commands::capture::maybe_hide_capture(&app, state.inner());
    }
    if let Some(join) = broadcast.writer_thread.take() {
        let _ = join.join();
    }
    // Close this broadcast's relay onto the shared audio feed BEFORE waiting on
    // ffmpeg. The stream's audio input is the relay's TCP socket, not a dshow
    // device ffmpeg owns, so ffmpeg only sees audio EOF once the relay drops.
    // (A concurrent recording keeps the feed itself alive via its own relay.)
    broadcast.audio = None;

    let timeout = std::time::Instant::now() + std::time::Duration::from_secs(5);
    // Only a child that exited ON ITS OWN with a failure counts: a
    // timeout-kill below is our own doing and must stay silent.
    let mut natural_failure: Option<std::process::ExitStatus> = None;
    loop {
        match broadcast.child.try_wait() {
            Ok(Some(st)) => {
                if !st.success() {
                    natural_failure = Some(st);
                }
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() >= timeout {
                    let _ = broadcast.child.kill();
                    let _ = broadcast.child.wait();
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => {
                let _ = broadcast.child.kill();
                let _ = broadcast.child.wait();
                break;
            }
        }
    }

    let failure = match natural_failure {
        Some(st) => {
            let detail = crate::commands::recordings::stderr_tail_text(&broadcast.stderr_tail)
                .map(|t| format!(" — ffmpeg said: {t}"))
                .unwrap_or_default();
            Some(format!("ffmpeg exited with {st}{detail}"))
        }
        None => None,
    };
    drop(broadcast);

    if let Some(failure) = failure {
        // Persist the failure in the system log so the operator can read it
        // after the transient stop toast disappears.
        crate::store::log_msg(&app, &format!("Streaming stopped with errors: {failure}"));
        return Err(failure);
    }
    crate::store::log_msg(&app, "Streaming stopped");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tee_args_are_video_only_multi_target() {
        let urls = vec!["rtmp://host/a/key".to_string(), "rtmp://host/b/key".to_string()];
        let args = stream_tee_args(1280, 720, 30, "libx264", &urls, None);
        let joined = args.join(" ");
        assert!(joined.contains("-f rawvideo") && joined.contains("-i pipe:0"));
        assert!(joined.contains("-map 0:v:0"));
        assert!(joined.contains("-an"));
        assert!(joined.contains("[f=flv:onfail=ignore]rtmp://host/a/key"));
        assert!(joined.contains("rtmp://host/b/key"));
        assert!(joined.contains("-f tee"));
        assert!(joined.contains("-flvflags no_duration_filesize"));
        assert!(!joined.contains("tcp://"));
    }

    #[test]
    fn tee_args_with_audio_feed_tcp_input() {
        let urls = vec!["rtmp://host/live/key".to_string()];
        let args = stream_tee_args(1280, 720, 30, "libx264", &urls, Some(43210));
        let joined = args.join(" ");
        assert!(joined.contains("-f aac"));
        assert!(joined.contains("-i tcp://127.0.0.1:43210"));
        assert!(joined.contains("-map 0:v:0"));
        assert!(joined.contains("-map 1:a:0"));
        assert!(joined.contains("-c:a copy"));
        assert!(!joined.contains("-c:a aac"));
        assert!(!joined.contains("-an"));
        assert!(!joined.contains("-f dshow"));
        assert!(!joined.contains("-f adts"));
        assert!(joined.contains("-f tee"));
        assert!(joined.contains("[f=flv:onfail=ignore]rtmp://host/live/key"));
    }

    #[test]
    fn tee_args_never_place_map_directly_after_an_input_url() {
        // Regression: ffmpeg rejects a `-map` that immediately follows an input
        // URL (`Option map cannot be applied to input url tcp://...`), so every
        // `-map` must come after all `-i <url>` declarations.
        let urls = vec!["rtmp://host/live/key".to_string()];
        let args = stream_tee_args(1280, 720, 30, "libx264", &urls, Some(43210));
        let mut i = 0;
        while i < args.len() {
            if args[i] == "-i" {
                let after_url = i + 2;
                if after_url < args.len() {
                    assert_ne!(
                        args[after_url],
                        "-map",
                        "-map directly after an -i URL (token {after_url})"
                    );
                }
                i += 2;
            } else {
                i += 1;
            }
        }
    }

    #[test]
    fn idle_status_is_inactive() {
        let s = idle_status();
        assert!(!s.active);
        assert!(s.capture_session_id.is_none());
        assert!(s.destinations.is_empty());
    }

    #[test]
    fn status_reports_all_destinations_failed_when_tee_child_exits() {
        // A completed child (exit 0) reaped mid-broadcast must NOT be reported
        // as "live" — the hub would otherwise keep showing dead destinations as
        // live. Use cmd.exe /C exit 0 as a fake child that exits immediately (no
        // external ffmpeg dependency in unit tests).
        let mut child = Command::new("cmd.exe")
            .arg("/C")
            .arg("exit 0")
            .spawn()
            .expect("spawn cmd child");
        let _ = child.wait();

        let broadcast = BroadcastSession {
            capture: crate::commands::capture::ActiveCapture {
                session_id: "cap".into(),
                consumer: crate::capture::ConsumerHandle { id: 1, strict: false },
                source: crate::commands::capture::CAPTURE_WINDOW.to_string(),
                rx: Arc::new(parking_lot::Mutex::new(
                    crate::capture::bounded_sink(8).1,
                )),
            },
            width: 1280,
            height: 720,
            fps: 30,
            started_ms: 0,
            destinations: vec![
                StreamDestinationSession {
                    id: "d1".into(),
                    label: "A".into(),
                    url: "rtmp://host/a/key".into(),
                    audio: false,
                },
                StreamDestinationSession {
                    id: "d2".into(),
                    label: "B".into(),
                    url: "rtmp://host/b/key".into(),
                    audio: false,
                },
            ],
            child,
            writer_thread: None,
            frames: Arc::new(std::sync::atomic::AtomicU64::new(42)),
            bytes: Arc::new(std::sync::atomic::AtomicU64::new(42)),
            audio_device: None,
            audio: None,
            stderr_tail: Arc::new(parking_lot::Mutex::new(Vec::new())),
        };
        let guard = parking_lot::Mutex::new(Some(broadcast));
        let mut lock = guard.lock();
        let status = streaming_status_locked(&mut lock);
        assert!(status.active, "broadcast itself is still active");
        assert_eq!(status.destinations.len(), 2);
        for d in &status.destinations {
            assert!(!d.active, "dead tee must not report live");
            assert!(d.error.is_some(), "dead tee must carry an error");
            assert_eq!(d.frames, 42, "frames mirror the shared process");
            assert_eq!(d.bytes, 42, "bytes mirror the shared process");
        }
    }
}
