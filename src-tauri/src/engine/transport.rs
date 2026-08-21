//! Engine transport manager (Phase D).
//!
//! Owns the encode → fan-out → mux pipeline inside the engine sidecar:
//!
//! - ONE shared encoder: an `ffmpeg` subprocess that reads raw RGBA frames
//!   from a headless wgpu compositor (`-f rawvideo -pix_fmt rgba -i pipe:0`)
//!   and emits an H.264 Annex-B byte stream on stdout (`-f h264 pipe:1`,
//!   `repeat-headers` so every muxer can start mid-stream). Every RTMP
//!   destination and the recorder draw from this single encoder, so N
//!   destinations never create N encoders.
//! - A fan-out thread reads the encoder's stdout in chunks and broadcasts each
//!   chunk to every active session's bounded feed queue — the same bounded
//!   drop-newest backpressure as the Phase 6 console RTMP path.
//! - Mux-only session subprocesses: RTMP publish (`-c copy -f flv rtmp://…`)
//!   and MP4 recording (`-c copy -f mp4`). Nothing is re-encoded at the
//!   session layer.
//! - A capture thread renders the current live `ProgramFrame` offscreen at the
//!   transport resolution and feeds raw RGBA to the encoder at the capture
//!   cadence. It builds its own `Compositor` inside the thread (the compositor
//!   is `!Send` — it owns an `Rc` image cache — so the GPU context cannot be
//!   moved across threads) and falls back to solid-color frames when GPU
//!   initialization fails, so a transport can never crash the engine.
//!
//! Lifecycle: the encoder starts when the first session is added and stops
//! when the last session is removed; a background reaper removes sessions the
//! moment their muxer exits (crash/network failure) and tears the whole
//! pipeline down if the encoder itself dies. Session failures only ever affect
//! that session — they never touch presentation state.
//!
//! ffmpeg is resolved bundled-first via [`crate::binpaths`]; the sidecar
//! initializes it from the resource path passed as argv[2] (falls back to PATH).

use crate::engine::compositor::{
    resolve_program_frame, ProgramFrameInput, ResolverSnapshot,
};
use crate::outputs::{OutputConfig, OutputGeometry, OutputKind, OutputOverlays, OutputSource, OUTPUT_SCHEMA_VERSION};
use crate::store::{self, Scene};
use parking_lot::Mutex;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Max chunks buffered per destination before the newest data is dropped.
/// Each chunk is up to 64 KiB of encoded stream; 120 chunks ≈ a few seconds of
/// 4 Mbps H.264 — enough to absorb a jitter spike, bounded enough to prevent an
/// out-of-memory cascade on a slow uplink.
const MAX_QUEUED_CHUNKS: usize = 120;

/// One runtime transport status entry (mirrors the console's `RtmpStatus`
/// shape so the frontend contract is unchanged during migration).
#[derive(Debug, Clone, Serialize)]
pub struct TransportStatus {
    pub id: String,
    /// `"rtmp"` or `"recording"` — which surface owns the session.
    pub kind: String,
    pub active: bool,
    pub url: Option<String>,
    /// Capture frame rate the session's muxer was started with.
    pub fps: u32,
    /// Bytes currently buffered awaiting the session's writer thread.
    pub queued: usize,
    /// Bytes written to the session's muxer since it started.
    pub sent: usize,
    /// Bytes dropped by the bounded queue since the session started.
    pub dropped: usize,
}

enum SessionKind {
    Rtmp { url: String },
    Recording { path: PathBuf },
}

/// One active mux session: the mux-only `ffmpeg` child plus its feed channel,
/// drained by a writer thread into the child's stdin. Dropping the channel
/// signals EOF to ffmpeg (flush + finalize the stream).
struct Session {
    kind: SessionKind,
    child: Child,
    tx: mpsc::Sender<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    sent: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
    fps: u32,
}

/// The shared encoder and its two threads. The capture thread owns the encoder
/// stdin (moved in at spawn) and drops it on exit — that EOF is what makes the
/// encoder flush and exit. The fan thread owns the encoder stdout.
struct Encoder {
    child: Child,
    capture_thread: JoinHandle<()>,
    fan_thread: JoinHandle<()>,
    running: Arc<AtomicBool>,
}

/// Shared state between the manager, the fan/capture threads, and the reaper.
struct TransportInner {
    sessions: Arc<Mutex<std::collections::HashMap<String, Session>>>,
    encoder: Mutex<Option<Encoder>>,
    /// Latest presentation resolver snapshot for the capture thread, pushed by
    /// the runtime after every presentation mutation.
    snapshot: Arc<Mutex<Option<ResolverSnapshot>>>,
    scenes: Arc<Mutex<Option<Vec<Scene>>>>,
}

/// The engine's transport manager. Owned by `EngineRuntime` (which also owns
/// the presentation state the capture thread renders).
pub struct TransportManager {
    inner: Arc<TransportInner>,
    app_data_dir: PathBuf,
    alive: Arc<AtomicBool>,
    reaper: Option<JoinHandle<()>>,
}

impl TransportManager {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let inner = Arc::new(TransportInner {
            sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
            encoder: Mutex::new(None),
            snapshot: Arc::new(Mutex::new(None)),
            scenes: Arc::new(Mutex::new(None)),
        });
        let alive = Arc::new(AtomicBool::new(true));
        let reaper = spawn_reaper(Arc::clone(&inner), Arc::clone(&alive));
        Self { inner, app_data_dir, alive, reaper: Some(reaper) }
    }

    /// Pushes the latest presentation resolver snapshot + scenes so the
    /// capture thread renders the current live program. Called after every
    /// presentation mutation and state adoption.
    pub fn sync_state(&self, snapshot: ResolverSnapshot, scenes: Option<Vec<Scene>>) {
        *self.inner.snapshot.lock() = Some(snapshot);
        *self.inner.scenes.lock() = scenes;
    }

    /// Starts an RTMP publish session for one destination and ensures the
    /// shared encoder is running (first consumer starts it).
    pub fn start_rtmp(&self, session_id: &str, url: &str, fps: u32, width: u32, height: u32) -> Result<(), String> {
        validate_fps(fps)?;
        if !url.starts_with("rtmp://") {
            return Err("RTMP server URL must start with rtmp://".into());
        }
        self.start_session(session_id, SessionKind::Rtmp { url: url.into() }, fps, width, height)
    }

    /// Starts a recording session writing to `path` (mux-only MP4).
    pub fn start_recording(&self, session_id: &str, path: &Path, fps: u32, width: u32, height: u32) -> Result<(), String> {
        validate_fps(fps)?;
        self.start_session(session_id, SessionKind::Recording { path: path.to_path_buf() }, fps, width, height)
    }

    fn start_session(&self, session_id: &str, kind: SessionKind, fps: u32, width: u32, height: u32) -> Result<(), String> {
        let mut sessions = self.inner.sessions.lock();
        if sessions.contains_key(session_id) {
            return Err("This destination is already live — stop it first.".into());
        }
        let mut child = spawn_session_muxer(&kind, fps)?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "ffmpeg stdin was not available.".to_string())?;
        let (tx, queued, sent) = spawn_session_writer(stdin);
        let is_first = sessions.is_empty();
        sessions.insert(
            session_id.to_string(),
            Session {
                kind,
                child,
                tx,
                queued,
                sent,
                dropped: Arc::new(AtomicUsize::new(0)),
                fps,
            },
        );
        drop(sessions);
        // First consumer boots the shared encoder at the session's capture
        // geometry; later sessions inherit the running encoder's geometry.
        if is_first {
            if let Err(e) = self.ensure_encoder(width, height, fps) {
                // The muxer spawned fine but the encoder did not — kill the
                // muxer so a failed encode can never leave a phantom session.
                let mut guard = self.inner.sessions.lock();
                if let Some(s) = guard.remove(session_id) {
                    let mut child = s.child;
                    let _ = child.kill();
                    let _ = child.wait();
                }
                drop(guard);
                return Err(e);
            }
        }
        Ok(())
    }

    /// Stops one session by id: EOF to its muxer, then the reaper reaps the
    /// child once it exits. Idempotent (unknown session is a no-op).
    pub fn stop(&self, session_id: &str) -> Result<(), String> {
        let removed = self.inner.sessions.lock().remove(session_id);
        let Some(session) = removed else { return Ok(()) };
        drop(session.tx); // EOF to ffmpeg -> flush + finalize the stream
        self.ensure_encoder_stopped();
        Ok(())
    }

    /// Stops every session and the shared encoder (shutdown path).
    pub fn stop_all(&self) {
        self.inner.sessions.lock().clear();
        self.ensure_encoder_stopped();
    }

    /// Whether any transport is currently active.
    pub fn is_active(&self) -> bool {
        !self.inner.sessions.lock().is_empty() || self.inner.encoder.lock().is_some()
    }

    /// Runtime status of every active session (ephemeral, not persisted).
    pub fn status(&self) -> Vec<TransportStatus> {
        let guard = self.inner.sessions.lock();
        guard
            .iter()
            .map(|(id, s)| TransportStatus {
                id: id.clone(),
                kind: match s.kind {
                    SessionKind::Rtmp { .. } => "rtmp".into(),
                    SessionKind::Recording { .. } => "recording".into(),
                },
                active: true,
                url: match &s.kind {
                    SessionKind::Rtmp { url } => Some(url.clone()),
                    SessionKind::Recording { .. } => None,
                },
                fps: s.fps,
                queued: s.queued.load(Ordering::SeqCst),
                sent: s.sent.load(Ordering::SeqCst),
                dropped: s.dropped.load(Ordering::SeqCst),
            })
            .collect()
    }

    /// Starts the shared encoder unless one is already running. Errors bubble
    /// to the caller, which removes the just-added session (a failed encode
    /// can never leave a phantom live session).
    fn ensure_encoder(&self, width: u32, height: u32, fps: u32) -> Result<(), String> {
        let mut enc = self.inner.encoder.lock();
        if enc.is_some() {
            return Ok(());
        }
        let (child, stdin, stdout) = spawn_encoder(width, height, fps)?;
        let running = Arc::new(AtomicBool::new(true));
        let capture_thread = spawn_capture_thread(
            stdin,
            Arc::clone(&self.inner.snapshot),
            Arc::clone(&self.inner.scenes),
            width,
            height,
            fps,
            self.app_data_dir.clone(),
            Arc::clone(&running),
        );
        let fan_thread = spawn_fan_thread(stdout, Arc::clone(&self.inner.sessions), Arc::clone(&running));
        *enc = Some(Encoder {
            child,
            capture_thread,
            fan_thread,
            running,
        });
        Ok(())
    }

    /// Stops the shared encoder when the last session is gone. Idempotent.
    fn ensure_encoder_stopped(&self) {
        if !self.inner.sessions.lock().is_empty() {
            return;
        }
        stop_encoder(&self.inner);
    }
}

impl Drop for TransportManager {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
        self.stop_all();
        if let Some(reaper) = self.reaper.take() {
            let _ = reaper.join();
        }
    }
}

/// Stop and reap the shared encoder: signal the capture thread, join both
/// threads (dropping encoder stdin on exit makes ffmpeg flush and exit), then
/// wait (with a forced kill) for the encoder child.
fn stop_encoder(inner: &Arc<TransportInner>) {
    let enc = inner.encoder.lock().take();
    let Some(enc) = enc else { return };
    enc.running.store(false, Ordering::SeqCst);
    let _ = enc.capture_thread.join();
    let _ = enc.fan_thread.join();
    let mut child = enc.child;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return,
        }
    }
}

/// Validate a capture frame rate (1..=120).
fn validate_fps(fps: u32) -> Result<(), String> {
    if !(1..=120).contains(&fps) {
        return Err("Capture frame rate must be between 1 and 120 fps.".into());
    }
    Ok(())
}

/// Mux-only ffmpeg arguments for a session: H.264 Annex-B on stdin (byte
/// stream, `-f h264`) copied straight into the output container — nothing is
/// re-encoded at the session layer.
fn session_muxer_args(kind: &SessionKind, fps: u32) -> Vec<String> {
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
        "-map".to_string(),
        "0:v:0".to_string(),
        "-c:v".to_string(),
        "copy".to_string(),
    ];
    match kind {
        SessionKind::Rtmp { url } => {
            args.extend([
                "-f".into(),
                "flv".into(),
                "-flvflags".into(),
                "no_duration_filesize".into(),
                url.clone(),
            ]);
        }
        SessionKind::Recording { path } => {
            args.extend([
                "-f".into(),
                "mp4".into(),
                "-movflags".into(),
                "+frag_keyframe+empty_moov".into(),
                "-fps_mode".into(),
                "passthrough".into(),
                path.to_string_lossy().into_owned(),
            ]);
        }
    }
    args
}

/// Spawn a session's mux-only ffmpeg child (stdin piped, stdout/stderr null).
fn spawn_session_muxer(kind: &SessionKind, fps: u32) -> Result<Child, String> {
    Command::new(crate::binpaths::ffmpeg_path())
        .args(session_muxer_args(kind, fps))
        .stdin(Stdio::piped())
        .stderr(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {e}"))
}

/// Shared encoder ffmpeg arguments: raw RGBA on stdin at the capture cadence,
/// libx264 (veryfast / zerolatency, H.264 High, repeat-headers so every muxer
/// can start mid-stream) on stdout as an Annex-B byte stream.
fn encoder_args(width: u32, height: u32, fps: u32) -> Vec<String> {
    let keyint = fps * 2;
    vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-fflags".into(),
        "nobuffer".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "rgba".into(),
        "-s".into(),
        format!("{width}x{height}"),
        "-r".into(),
        fps.to_string(),
        "-i".into(),
        "pipe:0".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-tune".into(),
        "zerolatency".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-profile:v".into(),
        "high".into(),
        "-g".into(),
        keyint.to_string(),
        "-bf".into(),
        "0".into(),
        "-x264-params".into(),
        format!("keyint={keyint}:min-keyint={fps}:scenecut=-1:repeat-headers=1"),
        "-f".into(),
        "h264".into(),
        "pipe:1".into(),
    ]
}

/// Spawn the shared encoder child. On failure the caller removes the session
/// that requested it, so a missing/broken ffmpeg can never leave a phantom
/// live destination.
fn spawn_encoder(width: u32, height: u32, fps: u32) -> Result<(Child, ChildStdin, ChildStdout), String> {
    let mut child = Command::new(crate::binpaths::ffmpeg_path())
        .args(encoder_args(width, height, fps))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start the encoder: {e}"))?;
    let stdin = child.stdin.take().ok_or_else(|| "Encoder stdin was not available.".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "Encoder stdout was not available.".to_string())?;
    Ok((child, stdin, stdout))
}

/// Spawn the writer thread draining a session's feed channel into its ffmpeg
/// stdin. Returns the sender plus live queued/sent counters.
fn spawn_session_writer(
    mut stdin: ChildStdin,
) -> (mpsc::Sender<Vec<u8>>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let queued = Arc::new(AtomicUsize::new(0));
    let sent = Arc::new(AtomicUsize::new(0));
    let counter = queued.clone();
    let sent_counter = sent.clone();
    std::thread::spawn(move || {
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

/// Spawn the fan-out thread: reads the shared encoder's stdout in chunks and
/// broadcasts each chunk to every active session's bounded feed queue. When the
/// encoder exits (EOF) the running flag is cleared so the capture thread stops
/// feeding and the reaper tears the pipeline down.
fn spawn_fan_thread(
    mut stdout: ChildStdout,
    sessions: Arc<Mutex<std::collections::HashMap<String, Session>>>,
    running: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = buf[..n].to_vec();
                    let guard = sessions.lock();
                    for s in guard.values() {
                        if s.queued.load(Ordering::SeqCst) >= MAX_QUEUED_CHUNKS {
                            s.dropped.fetch_add(chunk.len(), Ordering::SeqCst);
                        } else {
                            s.queued.fetch_add(1, Ordering::SeqCst);
                            if s.tx.send(chunk.clone()).is_err() {
                                s.queued.fetch_sub(1, Ordering::SeqCst);
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
        running.store(false, Ordering::SeqCst);
    })
}

/// Build the transport's synthetic output config: the LIVE program source with
/// every overlay unmasked at the capture geometry (the same feed the webview's
/// `ProgramFeedPreview` resolved).
fn transport_config(width: u32, height: u32) -> OutputConfig {
    OutputConfig {
        schema_version: OUTPUT_SCHEMA_VERSION,
        id: "transport".into(),
        kind: OutputKind::Window,
        label: "Transport".into(),
        enabled: true,
        visible: true,
        source: OutputSource::Live,
        geometry: OutputGeometry { width, height },
        capture_fps: None,
        presentation: None,
        overlays: OutputOverlays { props: true, lower_third: true, logo: true },
        window_label: None,
        recording: None,
        streaming: None,
        stream_destinations: None,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Solid-color fallback pixels (dark slate) used when the GPU compositor is
/// unavailable, so a transport can never crash the engine.
fn fallback_pixels(width: u32, height: u32) -> Vec<u8> {
    let mut buf = vec![0u8; (width as usize) * (height as usize) * 4];
    for px in buf.chunks_exact_mut(4) {
        px.copy_from_slice(&[15, 17, 22, 255]);
    }
    buf
}

/// Spawn the capture thread: renders the current live program frame offscreen
/// at the capture resolution and feeds raw RGBA to the encoder stdin at the
/// capture cadence. Owns its own `Compositor` (created inside the thread —
/// the compositor is `!Send`) and its own `DiskMediaResolver`. Dropping the
/// encoder stdin on exit signals EOF to the encoder.
#[allow(clippy::too_many_arguments)]
fn spawn_capture_thread(
    mut stdin: ChildStdin,
    snapshot: Arc<Mutex<Option<ResolverSnapshot>>>,
    scenes: Arc<Mutex<Option<Vec<Scene>>>>,
    width: u32,
    height: u32,
    fps: u32,
    app_data_dir: PathBuf,
    running: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let frame_interval = Duration::from_micros(1_000_000 / fps.max(1) as u64);
        let mut compositor = crate::engine::compositor::Compositor::new(width, height).ok();
        let mut media = crate::engine::windows::DiskMediaResolver { app_data_dir };
        let mut next = Instant::now();
        while running.load(Ordering::SeqCst) {
            let frame = {
                let snap = snapshot
                    .lock()
                    .clone()
                    .unwrap_or_else(empty_snapshot);
                let sc = scenes.lock().clone();
                let input = ProgramFrameInput {
                    config: transport_config(width, height),
                    snapshot: snap,
                    scenes: sc,
                    colors: None,
                    timestamp: Some(now_ms()),
                    fps: Some(fps),
                };
                resolve_program_frame(input)
            };
            let pixels = match &mut compositor {
                Some(c) => match c.render(&frame, &mut media) {
                    Ok(()) => c.read_pixels().2,
                    Err(_) => fallback_pixels(width, height),
                },
                None => fallback_pixels(width, height),
            };
            if stdin.write_all(&pixels).is_err() {
                break; // encoder gone — stop feeding
            }
            let _ = stdin.flush();
            next += frame_interval;
            std::thread::sleep(next.saturating_duration_since(Instant::now()));
        }
        // Dropping `stdin` here signals EOF to the encoder (flush + exit).
    })
}

/// An empty resolver snapshot (no live item, default settings) used before the
/// console's first state push — resolves to a safe waiting frame.
fn empty_snapshot() -> ResolverSnapshot {
    ResolverSnapshot {
        live: None,
        staged: None,
        settings: store::PresentationSettings::default(),
        props: vec![],
        lower_third: None,
        revision: 0,
    }
}

/// Background reaper: every ~500ms it removes sessions whose muxer exited and,
/// if the shared encoder died (crash / user kill), tears the whole pipeline
/// down so starved sessions can never linger as phantom live destinations.
fn spawn_reaper(inner: Arc<TransportInner>, alive: Arc<AtomicBool>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        while alive.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(500));

            // 1. Remove dead mux sessions (dropping their channels EOFs ffmpeg).
            let mut dead = Vec::new();
            {
                let mut sessions = inner.sessions.lock();
                for (id, s) in sessions.iter_mut() {
                    match s.child.try_wait() {
                        Ok(Some(_)) => dead.push(id.clone()),
                        Ok(None) => {}
                        Err(_) => dead.push(id.clone()),
                    }
                }
                for id in &dead {
                    sessions.remove(id);
                }
            }

            // 2. If the encoder is gone, stop its threads and drop every
            //    remaining session (they are starved of encoded data).
            let encoder_dead = {
                let mut enc = inner.encoder.lock();
                match enc.as_mut() {
                    Some(e) => {
                        !e.running.load(Ordering::SeqCst)
                            || matches!(e.child.try_wait(), Ok(Some(_)))
                    }
                    None => false,
                }
            };
            if encoder_dead {
                stop_encoder(&inner);
                inner.sessions.lock().clear();
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> TransportManager {
        TransportManager::new(std::env::temp_dir().join("wordlyte-transport-test"))
    }

    /// Registers a session without spawning ffmpeg (the injected muxer child
    /// is a `cmd exit 0` that the reaper cleans up). Lets tests exercise the
    /// session keying/duplicate logic on machines without ffmpeg.
    fn insert_fake_session(m: &TransportManager, id: &str) {
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
        m.inner.sessions.lock().insert(
            id.to_string(),
            Session {
                kind: SessionKind::Rtmp { url: "rtmp://host/live".into() },
                child,
                tx,
                queued: Arc::new(AtomicUsize::new(0)),
                sent: Arc::new(AtomicUsize::new(0)),
                dropped: Arc::new(AtomicUsize::new(0)),
                fps: 30,
            },
        );
    }

    #[test]
    fn validate_fps_rejects_out_of_range() {
        assert!(validate_fps(0).is_err());
        assert!(validate_fps(121).is_err());
        assert!(validate_fps(30).is_ok());
        assert!(validate_fps(60).is_ok());
    }

    #[test]
    fn rtmp_start_rejects_non_rtmp_urls() {
        let m = manager();
        let err = m.start_rtmp("s1", "https://host/live", 30, 1920, 1080).unwrap_err();
        assert!(err.contains("rtmp://"));
        assert!(!m.is_active());
    }

    #[test]
    fn duplicate_session_id_is_rejected() {
        let m = manager();
        insert_fake_session(&m, "s1");
        let err = m.start_rtmp("s1", "rtmp://host/live", 30, 1920, 1080).unwrap_err();
        assert!(err.contains("already live"));
    }

    #[test]
    fn stop_unknown_session_is_a_no_op() {
        let m = manager();
        assert!(m.stop("nope").is_ok());
    }

    #[test]
    fn session_muxer_args_build_rtmp_flv_output() {
        let kind = SessionKind::Rtmp { url: "rtmp://host/live/key".into() };
        let joined = session_muxer_args(&kind, 30).join(" ");
        assert!(joined.contains("-f h264"));
        assert!(joined.contains("-i pipe:0"));
        assert!(joined.contains("-c:v copy"));
        assert!(joined.ends_with("-f flv -flvflags no_duration_filesize rtmp://host/live/key"));
    }

    #[test]
    fn session_muxer_args_build_fragmented_mp4_recording() {
        let kind = SessionKind::Recording { path: PathBuf::from("C:/data/rec.mp4") };
        let joined = session_muxer_args(&kind, 30).join(" ");
        assert!(joined.contains("-c:v copy"));
        assert!(joined.contains("+frag_keyframe+empty_moov"));
        assert!(joined.ends_with("C:/data/rec.mp4"));
    }

    #[test]
    fn encoder_args_use_capture_geometry_and_repeat_headers() {
        let args = encoder_args(1920, 1080, 30);
        let joined = args.join(" ");
        assert!(joined.contains("-f rawvideo"));
        assert!(joined.contains("-pix_fmt rgba"));
        assert!(joined.contains("-s 1920x1080"));
        assert!(joined.contains("-r 30"));
        assert!(joined.contains("-c:v libx264"));
        assert!(joined.contains("-f h264 pipe:1"));
        assert!(joined.contains("repeat-headers=1"));
        assert!(joined.contains("keyint=60"));
    }

    #[test]
    fn transport_config_is_live_with_all_overlays() {
        let cfg = transport_config(1280, 720);
        assert!(matches!(cfg.source, OutputSource::Live));
        assert_eq!(cfg.geometry.width, 1280);
        assert_eq!(cfg.geometry.height, 720);
        assert!(cfg.overlays.props && cfg.overlays.lower_third && cfg.overlays.logo);
    }

    #[test]
    fn empty_snapshot_has_default_settings_and_no_live() {
        let snap = empty_snapshot();
        assert!(snap.live.is_none());
        assert_eq!(snap.revision, 0);
    }

    #[test]
    fn sync_state_and_status_round_trip() {
        let m = manager();
        m.sync_state(empty_snapshot(), None);
        assert!(m.status().is_empty());
        assert!(!m.is_active());
    }

    #[test]
    fn fallback_pixels_fills_every_pixel() {
        let px = fallback_pixels(4, 3);
        assert_eq!(px.len(), 4 * 3 * 4);
        assert_eq!(&px[0..4], &[15, 17, 22, 255]);
        assert_eq!(&px[px.len() - 4..], &[15, 17, 22, 255]);
    }
}
