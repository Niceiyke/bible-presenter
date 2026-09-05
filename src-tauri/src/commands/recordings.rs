use crate::commands::program_audio::AudioFeed;
use crate::license::{ensure_active_tier, LicenseTier};
use crate::state::AppState;
use parking_lot::Mutex;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

/// How many raw NV12 frames may be in flight between capture and ffmpeg before
/// the capture thread blocks (natural backpressure). Each frame is ~W*H*4
/// bytes; 4 frames bounds the in-memory buffer to ~32 MB at 1080p, and blocks
/// rather than growing unbounded or silently dropping recorded frames.
const SINK_CAPACITY: usize = 8;

/// stdin-pipe buffer size for the ffmpeg child. `Stdio::piped()` uses the OS
/// default anonymous-pipe buffer (4 KB on modern Windows). A raw 1080p BGRA
/// frame is ~8 MB, so one frame fans out into ~2,000 partial 4 KB writes —
/// each a syscall + kernel copy (≈62k syscalls/s at 30 fps on the
/// recording/streaming writer thread). `CreatePipe` sizes the buffer up-front;
/// 1 MiB turns every frame into exactly one syscall while preserving full
/// blocking backpressure (the bounded capture sink is the real pacer anyway).
#[cfg(target_os = "windows")]
const FFMPEG_PIPE_CAPACITY: u32 = 1 << 20;

/// Build the child stdin plumbing for the ffmpeg ffmpeg process we spawn for a
/// recording/stream. On Windows: create our own large-buffer anonymous pipe,
/// hand the read end to the child, and return the write end as a std `File`
/// (so the writer thread keeps using `io::Write` — same syscall path as
/// `ChildStdin`; the win is purely the bigger buffer). Falls back to
/// `Stdio::piped()` if the pipe cannot be created. On non-Windows the caller
/// just takes the child's `ChildStdin` as before.
#[cfg(target_os = "windows")]
pub(crate) fn encoder_stdin_stdio() -> (Option<std::fs::File>, std::process::Stdio) {
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Pipes::CreatePipe;

    let mut read = HANDLE::default();
    let mut write = HANDLE::default();
    match unsafe { CreatePipe(&mut read, &mut write, None, FFMPEG_PIPE_CAPACITY) } {
        Ok(()) => {
            let read_owned = unsafe { OwnedHandle::from_raw_handle(read.0) };
            let write_file = unsafe { std::fs::File::from_raw_handle(write.0) };
            (Some(write_file), std::process::Stdio::from(read_owned))
        }
        Err(_) => (None, std::process::Stdio::piped()),
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn encoder_stdin_stdio() -> (Option<std::fs::File>, std::process::Stdio) {
    (None, std::process::Stdio::piped())
}

/// A saved recording file on disk.
#[derive(Debug, Clone, Serialize)]
pub struct RecordingFile {
    pub name: String,
    pub size: u64,
    /// Unix ms of last modification.
    pub modified: u64,
}

/// Resolve the recordings directory (app-data/recordings), creating it if
/// needed. MediaRecorder files live outside the SQLite data DB — they are
/// large binary assets, like the media library's files.
fn recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    let dir = base.join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create recordings dir: {}", e))?;
    Ok(dir)
}

/// Documented maximum accepted recording size. The frontend refuses to convert
/// larger blobs to base64, and the backend rejects them before decoding — an
/// unbounded IPC payload could spike memory or stall the runtime workers.
const MAX_RECORDING_BYTES: usize = 2 * 1024 * 1024 * 1024; // 2 GiB

fn safe_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Recording name is empty".into());
    }
    // Keep the extension (should be .webm) but strip any path traversal.
    let file = Path::new(name)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(name);
    Ok(file.to_string())
}

/// List saved recordings, newest first.
#[tauri::command]
pub async fn recordings_list(app: AppHandle) -> Result<Vec<RecordingFile>, String> {
    let dir = recordings_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(RecordingFile {
            name: entry.file_name().to_string_lossy().to_string(),
            size: meta.len(),
            modified,
        });
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.modified));
    Ok(out)
}

/// Persist a completed recording's bytes to the recordings dir. The frontend
/// sends the assembled WebM blob as a base64 string (same transport as
/// `save_camera_snapshot`) — large files over the IPC channel are decoded
/// off the runtime worker thread and written atomically (temp + rename), so a
/// save can never stall the command pipeline or leave a truncated file behind.
#[tauri::command]
pub async fn recording_save(
    app: AppHandle,
    state: State<'_, AppState>,
    file_name: String,
    data_base64: String,
) -> Result<RecordingFile, String> {
    // Recording is a paid feature — enforce on the backend, not just the UI.
    ensure_active_tier(&state, LicenseTier::Pro)?;

    // Reject oversized payloads BEFORE decoding: base64 of N bytes is ~4N/3
    // characters, so an oversized string cannot possibly hold a valid recording.
    let max_b64 = MAX_RECORDING_BYTES.div_ceil(3) * 4;
    if data_base64.len() > max_b64 {
        return Err(format!(
            "Recording exceeds the {} GiB limit.",
            MAX_RECORDING_BYTES / (1024 * 1024 * 1024)
        ));
    }

    let name = safe_name(&file_name)?;
    let dir = recordings_dir(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let data = base64::engine::general_purpose::STANDARD
            .decode(data_base64)
            .map_err(|e| format!("Invalid recording data: {}", e))?;
        if data.len() > MAX_RECORDING_BYTES {
            return Err(format!(
                "Recording exceeds the {} GiB limit.",
                MAX_RECORDING_BYTES / (1024 * 1024 * 1024)
            ));
        }
        let path = dir.join(&name);
        // Atomic write: temp file in the same directory, then rename over the
        // target so a crash mid-write can never leave a truncated recording.
        let tmp = dir.join(format!(".{}.part", name));
        std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok(RecordingFile {
            name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
            size: meta.len(),
            modified,
        })
    })
    .await
    .map_err(|e| format!("recording_save join error: {e}"))?
}

/// Delete a saved recording.
#[tauri::command]
pub async fn recording_delete(app: AppHandle, file_name: String) -> Result<(), String> {
    let name = safe_name(&file_name)?;
    let dir = recordings_dir(&app)?;
    let path = dir.join(name);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Reveal the recordings folder in the OS file manager.
#[tauri::command]
pub async fn recordings_open_folder(app: AppHandle) -> Result<(), String> {
    let dir = recordings_dir(&app)?;
    open_path(&dir);
    Ok(())
}

/// Best-effort platform reveal (Windows Explorer / macOS Finder / Linux).
fn open_path(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(path).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(path).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(path).spawn();
    }
}

// ---------------------------------------------------------------------------
// Phase 5: native recording (Windows Graphics Capture -> ffmpeg -> disk)
//
// Unlike the legacy MediaRecorder path (frontend blob -> base64 -> disk), a
// recording session owns the whole pipeline backend-side: the native capture
// service streams each RGBA frame into a bounded sink, a writer thread drains
// it into ffmpeg stdin (rawvideo -> libx264 -> MP4), and ffmpeg writes the file
// to disk as recording proceeds — memory stays bounded and the finished file is
// saved by simply finalizing ffmpeg and renaming a temp file.
// ---------------------------------------------------------------------------

/// Live progress of a running recording, returned to the frontend for the
/// elapsed/bytes/frames readout. `active=false` means nothing is recording.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub active: bool,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Frames written to ffmpeg, not just captured.
    pub frames_written: u64,
    /// Bytes written to disk (varies with the encoder).
    pub bytes_written: u64,
    /// Unix ms of wall-clock start, for the elapsed timer.
    pub started_ms: u64,
    pub error: Option<String>,
    /// Whether a program-audio feed (external mic / line-in) is attached and
    /// being muxed into this recording.
    pub audio_attached: bool,
}

/// The active recording backing a `RecordingStatus`. Holds the ffmpeg child,
/// the join handle for the writer thread, and the raw-bookkeeping so stop/abort
/// can finalize deterministically.
pub struct RecordingSession {
    pub capture_session_id: String,
    /// This recording's consumer handle against `capture_session_id`, used to
    /// detach from a (possibly shared) capture session on stop/abort. When the
    /// session was shared with a broadcast, detaching only removes this
    /// recording — the shared capture keeps running for the other consumers.
    pub consumer: crate::capture::ConsumerHandle,
    pub tmp_path: PathBuf,
    pub final_path: PathBuf,
    pub child: Child,
    pub writer_thread: Option<std::thread::JoinHandle<()>>,
    pub status: Arc<Mutex<RecordingStatus>>,
    /// Optional program-audio loopback feed being muxed into the recording.
    pub audio: Option<AudioFeed>,
    /// Retained ffmpeg stderr tail for failure diagnostics.
    pub stderr_tail: Arc<Mutex<Vec<u8>>>,
}

/// Bytes of ffmpeg stderr retained per child (tail) for failure diagnostics.
const STDERR_TAIL_CAP: usize = 16 * 1024;

/// Pipe + drain an ffmpeg child's stderr, returning the shared tail buffer.
/// Two reasons: (a) an undrained pipe can fill and stall ffmpeg; (b) failures
/// can then report ffmpeg's real message instead of a bare exit code like
/// `0xffffffea`. The drain thread appends until EOF and keeps only the tail.
pub(crate) fn drain_stderr_tail(child: &mut Child) -> Arc<Mutex<Vec<u8>>> {
    use std::io::Read;
    let tail: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail2 = tail.clone();
        let _ = std::thread::Builder::new()
            .name("ffmpeg-stderr-drain".to_string())
            .spawn(move || {
                let mut pipe = stderr;
                let mut chunk = [0u8; 4096];
                loop {
                    match pipe.read(&mut chunk) {
                        Ok(0) => break, // EOF: ffmpeg exited
                        Ok(n) => {
                            let mut t = tail2.lock();
                            t.extend_from_slice(&chunk[..n]);
                            let len = t.len();
                            if len > STDERR_TAIL_CAP {
                                t.drain(..len - STDERR_TAIL_CAP);
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
    }
    tail
}

/// Render a retained stderr tail for error messages: lossy UTF-8, last ~12
/// lines so failure toasts stay readable. `None` when ffmpeg said nothing.
pub(crate) fn stderr_tail_text(tail: &Arc<Mutex<Vec<u8>>>) -> Option<String> {
    let bytes = tail.lock().clone();
    if bytes.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.lines().rev().take(12).collect();
    lines.reverse();
    let msg = lines.join("\n").trim().to_string();
    if msg.is_empty() {
        None
    } else {
        Some(msg)
    }
}

/// Pick a H.264 encoder available in the resolved ffmpeg. Order favors
/// hardware/OS-shipped encoders first so the CPU-heavy libx264 encode only runs
/// when nothing better is present:
/// 1. `h264_qsv` — Intel Quick Sync (hardware), vendor-native.
/// 2. `h264_nvenc` — NVIDIA NVENC (hardware), vendor-native.
/// 3. `h264_amf` — AMD AMF (hardware), vendor-native.
/// 4. `h264_mf` — Media Foundation: uses the same-profile hardware MFT on
///    NVIDIA/AMD drivers, but silently falls back to MF's CPU encoder on
///    machines (notably some Intel iGPUs) with no hardware H.264 MFT.
/// 5. `libx264` / `libopenh264` / `mpeg4` — software fallbacks.
///
/// Each candidate is **initialized** (one 1080p frame pushed through the
/// encoder), not merely listed from `-encoders`: an encoder that is present in
/// the build but has no usable driver (nvenc without a NVIDIA driver, qsv with
/// the iGPU disabled/old driver, amf without an AMD GPU) fails the probe and
/// falls through to the next, instead of being selected and breaking the
/// recording/stream at start. This also promotes real hardware: `h264_mf`
/// init-verifies on machines where it only exists in software, while
/// QSV/NVENC/AMF claim the slot first on machines where they actually work.
///
/// Probed once and cached — the ~100–300 ms per candidate happens only on
/// first use (which `system_info` absorbs at startup).
pub(crate) fn pick_h264_encoder() -> String {
    use std::sync::OnceLock;
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let ffmpeg = crate::binpaths::ffmpeg_path();
            let out = Command::new(&ffmpeg)
                .args(["-hide_banner", "-encoders"])
                .output();
            let listed = out
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                .unwrap_or_default();
            for enc in [
                "h264_qsv", "h264_nvenc", "h264_amf", "h264_mf",
                "libx264", "libopenh264", "mpeg4",
            ] {
                if listed.contains(enc) && h264_enc_inits(&ffmpeg, enc) {
                    return enc.to_string();
                }
            }
            "libx264".to_string()
        })
        .clone()
}

/// Whether `ffmpeg` can initialize `encoder` for a 1080p30 H.264 stream right
/// now: run one 1080p frame through it to a null sink and check the exit code.
/// Frames come from lavfi (not the OS capture path) so the check is cheap and
/// self-contained; a hardware encoder that cannot reach its GPU fails here.
fn h264_enc_inits(ffmpeg: &Path, encoder: &str) -> bool {
    Command::new(ffmpeg)
        .args([
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=1920x1080:rate=30",
            "-frames:v",
            "1",
            "-c:v",
            encoder,
            "-f",
            "null",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Encoder-specific H.264 arguments that replace the generic `-preset veryfast`
/// line, keyed by the encoder name `pick_h264_encoder` returned. `gop_frames` is
/// the keyframe interval (`fps * keyframe_secs`); hardware encoders get an
/// explicit short GOP (~2s) so RTMP ingestors and players cut quickly. Software
/// encoders keep tuned defaults.
fn h264_video_args(encoder: &str, gop_frames: u32) -> Vec<String> {
    let gop = gop_frames.max(1).to_string();
    match encoder {
        // MF accepts few options; a short `-g` is allowed (harmless if ignored).
        "h264_mf" => vec!["-g".into(), gop],
        // QSV: global_quality instead of -b:v; veryfast ~ live targeting.
        "h264_qsv" => vec!["-preset".into(), "veryfast".into(), "-global_quality".into(), "24".into(), "-g".into(), gop],
        // NVENC: p5 balances speed/quality for live; VBR CQ keeps bitrate sane.
        "h264_nvenc" => vec!["-preset".into(), "p5".into(), "-rc".into(), "vbr".into(), "-cq".into(), "23".into(), "-g".into(), gop],
        // AMF: transcoding usage = sensible one-way-latency defaults for ingest.
        "h264_amf" => vec!["-usage".into(), "transcoding".into(), "-g".into(), gop],
        "libopenh264" => vec!["-b:v".into(), "3M".into()],
        // libx264 / mpeg4 / unknown: leave the generic tuning in place.
        _ => vec!["-preset".into(), "veryfast".into()],
    }
}

/// The `-c:v <encoder> ... -pix_fmt yuv420p` block shared by the recording and
/// streaming arg builders. The input is raw NV12 (converted once in the capture
/// readback), which QSV consumes natively; libx264 swaps formats internally.
/// `-pix_fmt yuv420p` after the encoder pins the encoded output format.
pub(crate) fn h264_encoder_block(encoder: &str, gop_frames: u32) -> Vec<String> {
    let mut block = vec!["-c:v".into(), encoder.to_string()];
    block.extend(h264_video_args(encoder, gop_frames));
    block.push("-pix_fmt".into());
    block.push("yuv420p".into());
    block
}

/// Build the ffmpeg argv for a recording: raw NV12 from stdin, H.264 to an MP4
/// temp file (written as it goes, purely local — never piped over IPC). When
/// `audio_port` is set, a second ADTS input (ffmpeg demuxer `aac`) pulls program
/// audio from the loopback feed and muxes it in (`-c:a copy` — no re-encode).
/// The ADTS frames are passed through `-bsf:a aac_adtstoasc` first: the MP4
/// muxer needs raw ASC, and copying ADTS-framed AAC straight in fails the mux
/// (ffmpeg exits EINVAL). Note: the demuxer is named `aac`, not `adts`.
fn record_ffmpeg_args(
    width: u32,
    height: u32,
    fps: u32,
    encoder: &str,
    tmp: &Path,
    audio_port: Option<u16>,
) -> Vec<String> {
    // ~2s keyframe interval for hardware encoders; software encoders ignore `-g`.
    let encoder_block = h264_encoder_block(encoder, fps * 2);
    let mut args = vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-f".into(),
        "rawvideo".into(),
        "-vcodec".into(),
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
    if let Some(port) = audio_port {
        args.extend([
            "-f".into(),
            "aac".into(),
            "-i".into(),
            format!("tcp://127.0.0.1:{port}"),
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "1:a:0".into(),
        ]);
        args.extend(encoder_block);
        args.extend([
            "-c:a".into(),
            "copy".into(),
            "-bsf:a".into(),
            "aac_adtstoasc".into(),
        ]);
    } else {
        args.push("-an".into());
        args.extend(encoder_block);
    }
    args.extend(["-movflags".into(), "+faststart".into(), tmp.to_string_lossy().to_string()]);
    args
}

/// Start recording the off-screen `capture` window: begin native capture
/// (streaming frames to a sink) and spawn ffmpeg to mux them to a temp MP4 on
/// disk. Only one
/// recording can be active at a time. The off-screen capture window must be
/// available (it is always created at startup, parked off-screen).
#[tauri::command]
pub fn recording_start(
    app: AppHandle,
    state: State<'_, AppState>,
    width: u32,
    height: u32,
    fps: u32,
    enable_audio: bool,
) -> Result<RecordingStatus, String> {
    ensure_active_tier(&state, LicenseTier::Pro)?;
    {
        if state.recording.lock().is_some() {
            return Err("A recording is already in progress.".into());
        }
    }
    if !crate::binpaths::ffmpeg_available() {
        return Err("ffmpeg was not found — install ffmpeg to record.".into());
    }
    let audio_feed = if enable_audio {
        ensure_active_tier(&state, LicenseTier::Premium)?;
        Some(AudioFeed::spawn()?)
    } else {
        None
    };

    let w = width.max(1);
    let h = height.max(1);
    let f = fps.clamp(1, 60);

    let dir = recordings_dir(&app)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let final_path = dir.join(format!("recording-{stamp}.mp4"));
    let tmp_path = dir.join(".recording-tmp.mp4");

    let audio_port = audio_feed.as_ref().map(|a| a.port());
    let encoder = pick_h264_encoder();
    crate::store::log_msg(
        &app,
        &format!(
            "Recording started (encoder: {}; {}x{} @ {}fps)",
            encoder, w, h, f
        ),
    );
    let (stdin_file, stdin_stdio) = encoder_stdin_stdio();
    let mut child = Command::new(crate::binpaths::ffmpeg_path())
        .args(record_ffmpeg_args(w, h, f, &encoder, &tmp_path, audio_port))
        .stdin(stdin_stdio)
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {e}"))?;
    // Drain stderr from the start: an undrained pipe can stall ffmpeg, and the
    // retained tail turns a bare exit code into ffmpeg's real error message.
    let stderr_tail = drain_stderr_tail(&mut child);

    // The child's stdin is either std's piped `ChildStdin` (non-Windows, or the
    // CreatePipe fallback) or the parent-owned write end of the large-buffer
    // pipe created above (Windows, when created).
    let stdin: Box<dyn std::io::Write + Send> = match (child.stdin.take(), stdin_file) {
        (Some(cs), _) => Box::new(cs),
        (None, Some(wf)) => Box::new(wf),
        (None, None) => return Err("ffmpeg stdin was not available.".to_string()),
    };

    let (tx, rx) = crate::capture::bounded_sink(SINK_CAPACITY);
    // Record the dedicated off-screen `capture` window (same program DOM surface
    // as `output`), so recording works even when the projection window is
    // closed. When a broadcast already captures that window at the same
    // geometry, the recorder attaches a strict consumer to the SAME session
    // instead of running a second WGC readback.
    let (capture_session_id, consumer) = match crate::capture::start_for_consumer(
        &state.capture,
        &app,
        "capture".to_string(),
        w,
        h,
        f,
        tx,
        true,
    ) {
        // If capture failed to bind the off-screen capture window, tear ffmpeg
        // down before it can linger or leave a stray temp file.
        Ok(ok) => ok,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&tmp_path);
            return Err(e);
        }
    };

    // Re-broadcast the current program so the off-screen capture window
    // converges even if it missed an earlier live/staged/settings broadcast
    // (e.g. it mounted after the operator went live). Harmless to windows
    // that are already in sync — they just re-apply identical state.
    crate::commands::outputs::rebroadcast_presentation(&app, state.inner());

    let status = Arc::new(Mutex::new(RecordingStatus {
        active: true,
        width: w,
        height: h,
        fps: f,
        frames_written: 0,
        bytes_written: 0,
        started_ms: chrono::Utc::now().timestamp_millis() as u64,
        error: None,
        audio_attached: audio_feed.is_some(),
    }));

    // Writer thread: drain captured frames into ffmpeg stdin. Dropping every
    // sink sender (done when the capture session is stopped) closes the channel
    // here, which closes stdin -> ffmpeg finalizes the MP4 footer.
    let wstatus = status.clone();
    let writer_thread = std::thread::Builder::new()
        .name("recording-writer".to_string())
        .spawn(move || {
            let mut stdin = stdin;
            let mut bytes = 0u64;
            let mut frames = 0u64;
            while let Ok(frame) = rx.recv() {
                let data: &[u8] = &frame.pixels;
                if stdin.write_all(data).is_err() {
                    break; // ffmpeg closed the pipe (crash / early exit)
                }
                let _ = stdin.flush();
                frames += 1;
                bytes += data.len() as u64;
            }
            let _ = stdin.flush();
            let mut s = wstatus.lock();
            s.frames_written = frames;
            s.bytes_written = bytes;
        })
        .map_err(|e| e.to_string())?;

    let session = RecordingSession {
        capture_session_id,
        consumer,
        tmp_path,
        final_path,
        child,
        writer_thread: Some(writer_thread),
        status: status.clone(),
        audio: audio_feed,
        stderr_tail,
    };
    *state.recording.lock() = Some(session);

    let s = status.lock();
    Ok(s.clone())
}

/// Tap the active recording's current progress (inactive status if none).
#[tauri::command]
pub fn recording_status(state: State<'_, AppState>) -> RecordingStatus {
    let guard = state.recording.lock();
    match guard.as_ref() {
        Some(s) => s.status.lock().clone(),
        None => RecordingStatus {
            active: false,
            width: 0,
            height: 0,
            fps: 0,
            frames_written: 0,
            bytes_written: 0,
            started_ms: 0,
            error: None,
            audio_attached: false,
        },
    }
}

/// Stop and save the active recording: stop capture (drops the sink -> writer
/// reaches EOF -> ffmpeg finalized), wait, then rename the temp file and return
/// the saved file. Errors if nothing is recording.
#[tauri::command]
pub async fn recording_stop_active(state: State<'_, AppState>) -> Result<RecordingFile, String> {
    let mut session = state
        .recording
        .lock()
        .take()
        .ok_or_else(|| "No recording is in progress.".to_string())?;

    crate::capture::detach_consumer(&state.capture, &session.capture_session_id, session.consumer);

    // Let the writer drain any last frames and close ffmpeg stdin (EOF), which
    // makes ffmpeg finalize the MP4 footer and exit.
    if let Some(join) = session.writer_thread {
        let _ = join.join();
    }
    // EOF the audio input too BEFORE waiting on ffmpeg: with the audio socket
    // still open, ffmpeg never sees EOF on*all* inputs, never finalizes, and
    // `child.wait()` blocks forever (the file is never closed/saved).
    if let Some(mut feed) = session.audio.take() {
        feed.close();
    }

    let mut child = session.child;
    let status_code = child.wait().map_err(|e| format!("ffmpeg finalize failed: {e}"))?;
    if !status_code.success() {
        let _ = std::fs::remove_file(&session.tmp_path);
        let detail = stderr_tail_text(&session.stderr_tail)
            .map(|t| format!(" — ffmpeg said: {t}"))
            .unwrap_or_default();
        return Err(format!("ffmpeg exited with {status_code}{detail} — recording not saved."));
    }

    std::fs::rename(&session.tmp_path, &session.final_path).map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(&session.final_path).map_err(|e| e.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(RecordingFile {
        name: session.final_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
        size: meta.len(),
        modified,
    })
}

/// Stop the active recording without saving (differs from stop-and-save in that
/// the temp file is deleted rather than renamed).
#[tauri::command]
pub async fn recording_abort(state: State<'_, AppState>) -> Result<(), String> {
    let mut session = state
        .recording
        .lock()
        .take()
        .ok_or_else(|| "No recording is in progress.".to_string())?;

    crate::capture::detach_consumer(&state.capture, &session.capture_session_id, session.consumer);
    if let Some(join) = session.writer_thread {
        let _ = join.join();
    }
    if let Some(mut feed) = session.audio.take() {
        feed.close();
    }
    let mut child = session.child;
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_file(&session.tmp_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_args_are_video_only_mp4() {
        let args = record_ffmpeg_args(1280, 720, 30, "libx264", Path::new("out.mp4"), None);
        let joined = args.join(" ");
        assert!(joined.contains("-f rawvideo") && joined.contains("-i pipe:0"));
        assert!(joined.contains("-an"));
        assert!(joined.contains("-movflags +faststart"));
        assert!(joined.ends_with("out.mp4"));
        assert!(!joined.contains("tcp://"));
    }

    #[test]
    fn record_args_with_audio_add_loopback_aac_input() {
        let args = record_ffmpeg_args(1280, 720, 30, "libx264", Path::new("out.mp4"), Some(44111));
        let joined = args.join(" ");
        assert!(joined.contains("-f aac -i tcp://127.0.0.1:44111"));
        assert!(joined.contains("-map 0:v:0 -map 1:a:0"));
        assert!(joined.contains("-c:a copy"));
        assert!(joined.contains("-bsf:a aac_adtstoasc"));
        assert!(joined.contains("-c:v ") && !joined.contains("-an"));
        assert!(joined.ends_with("out.mp4"));
    }

    #[test]
    fn encoder_block_carries_per_encoder_tuning() {
        for (enc, expect) in [
            ("h264_qsv", "-c:v h264_qsv -preset veryfast -global_quality 24 -g 60 -pix_fmt yuv420p"),
            ("h264_nvenc", "-c:v h264_nvenc -preset p5 -rc vbr -cq 23 -g 60 -pix_fmt yuv420p"),
            ("h264_amf", "-c:v h264_amf -usage transcoding -g 60 -pix_fmt yuv420p"),
            ("h264_mf", "-c:v h264_mf -g 60 -pix_fmt yuv420p"),
            ("libx264", "-c:v libx264 -preset veryfast -pix_fmt yuv420p"),
            ("libopenh264", "-c:v libopenh264 -b:v 3M -pix_fmt yuv420p"),
        ] {
            let block = h264_encoder_block(enc, 60).join(" ");
            assert_eq!(block, expect, "block args for {enc}");
        }
    }

    #[test]
    fn audio_feed_reports_its_port_and_accepts_packets() {
        let feed = AudioFeed::spawn().expect("audio feed should bind");
        assert!(feed.port() > 0);
        // A few small ADTS-like packets should enqueue without erroring. The
        // writer thread may not have a connected ffmpeg, but send() is bounded
        // drop-newest — it never blocks and returns Ok.
        for _ in 0..5 {
            let result = feed.send(vec![0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc, 0x01, 0x02]);
            assert!(result.is_ok(), "send should not fail on a warm feed");
        }
    }

    #[test]
    fn audio_feed_close_sends_eof_to_the_consumer() {
        let mut feed = AudioFeed::spawn().expect("audio feed should bind");
        let mut client = std::net::TcpStream::connect(("127.0.0.1", feed.port()))
            .expect("should connect to the feed");
        client
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .expect("read timeout");
        feed.send(vec![0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc, 0x01, 0x02])
            .expect("send on a connected feed");
        let mut buf = [0u8; 16];
        let n = std::io::Read::read(&mut client, &mut buf).expect("should receive the queued packet");
        assert_eq!(n, 9, "the ADTS packet should be delivered to the consumer");
        // Closing the feed drops the sender and joins the writer, so the socket
        // is closed deterministically: the consumer now reads 0 (EOF). This is
        // what lets ffmpeg finalize the mux on both inputs instead of hanging in
        // `child.wait()` with the audio socket never closed.
        feed.close();
        let total = match std::io::Read::read(&mut client, &mut buf) {
            Ok(n) => n as i64,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => -1,
            Err(_) => -1,
        };
        assert_eq!(total, 0, "consumer must see EOF after close");
        assert!(feed.send(vec![0x00]).is_err(), "send after close must error");
    }

    #[test]
    fn stderr_tail_text_reports_last_lines() {
        let tail = Arc::new(Mutex::new(b"line1\nline2\nline3\n".to_vec()));
        let text = stderr_tail_text(&tail).expect("tail text");
        assert!(text.contains("line3"));
        let empty = Arc::new(Mutex::new(Vec::new()));
        assert!(stderr_tail_text(&empty).is_none());
    }
}