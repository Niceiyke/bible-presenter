//! In-process encode + mux (replaces
//! `engine/transport.rs::spawn_encoder` + `spawn_session_muxer` +
//! `spawn_capture_thread` + `spawn_fan_thread`).
//!
//! One `FfmpegEncoder` owns a single `AVCodecContext` (HW `h264_nvenc`/`h264_qsv`
//! with `libx264` fallback, `veryfast`/`zerolatency`, `High`, `repeat-headers=1`,
//! `gop=fps*2`, `bf=0`) that eats RGBA `AVFrame`s from the capture compositor
//! and emits Annex-B `AVPacket`s. Each `FfmpegMuxer` owns an `AVFormatContext`
//! (`flv` for RTMP, `mp4` fragmented for recording) fed from the same packet
//! bus — no re-encode, no pipe `clone()`. `TransportManager` swaps to this when
//! `ffmpeg-next` is enabled; the `RtmpStatus` wire shape is unchanged.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use parking_lot::Mutex;

use crate::engine::compositor::{resolve_program_frame, ProgramFrameInput, ResolverSnapshot};
use crate::outputs::{OutputConfig, OutputGeometry, OutputKind, OutputOverlays, OutputSource, OUTPUT_SCHEMA_VERSION};
use crate::store::Scene;

const MAX_QUEUED_PACKETS: usize = 120;

/// Live packet emitted by the shared encoder. Cloned (Arc) per muxer — same
/// bounded drop-newest backpressure as the pipe fan thread (`transport.rs:480`).
#[derive(Clone)]
struct EncodedPacket {
    data: Arc<Vec<u8>>,
    is_key: bool,
    pts: i64,
}

pub struct FfmpegTransportInner {
    /// Per-destination muxers keyed by `session_id`. Each owns its `AVFormatContext`
    /// + bounded packet queue. Shared with the encoder fan for broadcast.
    sessions: Arc<Mutex<HashMap<String, FfmpegSession>>>,
    encoder: Mutex<Option<FfmpegEncoder>>,
    snapshot: Arc<Mutex<Option<ResolverSnapshot>>>,
    scenes: Arc<Mutex<Option<Vec<Scene>>>>,
    app_data_dir: PathBuf,
    media_hub: Arc<crate::engine::compositor::media::MediaFrameHub>,
}

struct FfmpegEncoder {
    // Keep the encode thread + its packet bus. Dropping `running=false` signals
    // EOF; joining flushes the encoder and closes every muxer.
    running: Arc<AtomicBool>,
    handle: JoinHandle<()>,
    width: u32,
    height: u32,
    fps: u32,
}

struct FfmpegSession {
    kind: SessionKind,
    // Bounded queue fed by the fan; drained by this session's mux thread.
    tx: mpsc::SyncSender<EncodedPacket>,
    queued: Arc<AtomicUsize>,
    sent: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
    fps: u32,
    handle: Option<JoinHandle<()>>,
}

enum SessionKind {
    Rtmp { url: String },
    Recording { path: PathBuf },
}

pub struct FfmpegTransportManager {
    inner: Arc<FfmpegTransportInner>,
    alive: Arc<AtomicBool>,
    reaper: Option<JoinHandle<()>>,
}

impl FfmpegTransportManager {
    pub fn new(app_data_dir: PathBuf, media_hub: Arc<crate::engine::compositor::media::MediaFrameHub>) -> Self {
        let inner = Arc::new(FfmpegTransportInner {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            encoder: Mutex::new(None),
            snapshot: Arc::new(Mutex::new(None)),
            scenes: Arc::new(Mutex::new(None)),
            app_data_dir,
            media_hub,
        });
        let alive = Arc::new(AtomicBool::new(true));
        let reaper = spawn_reaper(Arc::clone(&inner), Arc::clone(&alive));
        Self { inner, alive, reaper: Some(reaper) }
    }

    pub fn sync_state(&self, snapshot: ResolverSnapshot, scenes: Option<Vec<Scene>>) {
        *self.inner.snapshot.lock() = Some(snapshot);
        *self.inner.scenes.lock() = scenes;
    }

    pub fn start_rtmp(&self, session_id: &str, url: &str, fps: u32, width: u32, height: u32) -> Result<(), String> {
        validate_fps(fps)?;
        if !url.starts_with("rtmp://") {
            return Err("RTMP server URL must start with rtmp://".into());
        }
        self.start_session(session_id, SessionKind::Rtmp { url: url.into() }, fps, width, height)
    }

    pub fn start_recording(&self, session_id: &str, path: &Path, fps: u32, width: u32, height: u32) -> Result<(), String> {
        validate_fps(fps)?;
        self.start_session(session_id, SessionKind::Recording { path: path.to_path_buf() }, fps, width, height)
    }

    fn start_session(&self, session_id: &str, kind: SessionKind, fps: u32, width: u32, height: u32) -> Result<(), String> {
        let mut sessions = self.inner.sessions.lock();
        if sessions.contains_key(session_id) {
            return Err("This destination is already live — stop it first.".into());
        }
        let (tx, rx) = mpsc::sync_channel::<EncodedPacket>(MAX_QUEUED_PACKETS);
        let queued = Arc::new(AtomicUsize::new(0));
        let sent = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let kind_clone = match &kind {
            SessionKind::Rtmp { url } => SessionKind::Rtmp { url: url.clone() },
            SessionKind::Recording { path } => SessionKind::Recording { path: path.clone() },
        };
        // Spawn per-session mux thread consuming from `rx`.
        let handle = spawn_mux_thread(kind_clone, rx, Arc::clone(&queued), Arc::clone(&sent), Arc::clone(&dropped), fps, width, height)?;
        let is_first = sessions.is_empty();
        sessions.insert(
            session_id.to_string(),
            FfmpegSession { kind, tx, queued, sent, dropped, fps, handle: Some(handle) },
        );
        drop(sessions);
        if is_first {
            if let Err(e) = self.ensure_encoder(width, height, fps) {
                // Rollback muxer so a failed encode never leaves phantom session.
                if let Some(mut s) = self.inner.sessions.lock().remove(session_id) {
                    if let Some(h) = s.handle.take() {
                        drop(s.tx);
                        let _ = h.join();
                    }
                }
                return Err(e);
            }
        }
        Ok(())
    }

    pub fn stop(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.inner.sessions.lock();
        if let Some(mut s) = sessions.remove(session_id) {
            drop(s.tx);
            if let Some(h) = s.handle.take() {
                // Join outside lock to avoid deadlock with fan.
                drop(sessions);
                let _ = h.join();
            }
            drop(self.ensure_encoder_stopped());
        }
        Ok(())
    }

    pub fn stop_all(&self) {
        let handles: Vec<JoinHandle<()>> = {
            let mut sessions = self.inner.sessions.lock();
            sessions.drain().filter_map(|(_, mut s)| s.handle.take()).collect()
        };
        for h in handles {
            let _ = h.join();
        }
        let _ = self.ensure_encoder_stopped();
    }

    pub fn is_active(&self) -> bool {
        !self.inner.sessions.lock().is_empty() || self.inner.encoder.lock().is_some()
    }

    pub fn status(&self) -> Vec<crate::engine::transport::TransportStatus> {
        let sessions = self.inner.sessions.lock();
        sessions
            .iter()
            .map(|(id, s)| crate::engine::transport::TransportStatus {
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

    fn ensure_encoder(&self, width: u32, height: u32, fps: u32) -> Result<(), String> {
        let mut enc = self.inner.encoder.lock();
        if enc.is_some() {
            return Ok(());
        }
        let running = Arc::new(AtomicBool::new(true));
        let handle = spawn_encode_thread(
            Arc::clone(&self.inner.snapshot),
            Arc::clone(&self.inner.scenes),
            Arc::clone(&self.inner.sessions),
            width,
            height,
            fps,
            self.inner.app_data_dir.clone(),
            Arc::clone(&self.inner.media_hub),
            Arc::clone(&running),
        )?;
        *enc = Some(FfmpegEncoder { running, handle, width, height, fps });
        Ok(())
    }

    fn ensure_encoder_stopped(&self) -> Option<()> {
        if !self.inner.sessions.lock().is_empty() {
            return None;
        }
        let enc = self.inner.encoder.lock().take()?;
        enc.running.store(false, Ordering::SeqCst);
        let _ = enc.handle.join();
        Some(())
    }
}

impl Drop for FfmpegTransportManager {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
        self.stop_all();
        if let Some(r) = self.reaper.take() {
            let _ = r.join();
        }
    }
}

fn validate_fps(fps: u32) -> Result<(), String> {
    if !(1..=120).contains(&fps) {
        return Err("Capture frame rate must be between 1 and 120 fps.".into());
    }
    Ok(())
}

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

fn spawn_encode_thread(
    snapshot: Arc<Mutex<Option<ResolverSnapshot>>>,
    scenes: Arc<Mutex<Option<Vec<Scene>>>>,
    sessions: Arc<Mutex<HashMap<String, FfmpegSession>>>,
    width: u32,
    height: u32,
    fps: u32,
    app_data_dir: PathBuf,
    media_hub: Arc<crate::engine::compositor::media::MediaFrameHub>,
    running: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, String> {
    crate::engine::ffmpeg::init()?;
    // Build encoder: prefer HW (h264_nvenc / h264_qsv / h264_amf), fallback libx264.
    // We open it inside the thread so device probing sees the real GPU.
    std::thread::Builder::new()
        .name("ffmpeg-encode".into())
        .spawn(move || {
            let frame_interval = Duration::from_micros(1_000_000 / fps.max(1) as u64);
            // Compositor (owns GPU, `!Send` → must be created on this thread).
            let mut compositor = crate::engine::compositor::Compositor::new(width, height).ok();
            let mut media = crate::engine::windows::DiskMediaResolver { app_data_dir, hub: Some(Arc::clone(&media_hub)) };

            // Open encoder context.
            let mut encoder = match open_encoder(width, height, fps) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[ffmpeg-encode] open_encoder failed: {e}");
                    return;
                }
            };
            let time_base = encoder.time_base();
            let mut scaler = match ffmpeg_next::software::scaling::context::Context::get(
                ffmpeg_next::format::Pixel::RGBA,
                width,
                height,
                ffmpeg_next::format::Pixel::YUV420P,
                width,
                height,
                ffmpeg_next::software::scaling::flag::Flags::BILINEAR,
            ) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[ffmpeg-encode] scaler failed: {e}");
                    return;
                }
            };
            let mut next = Instant::now();
            let mut frame_num: i64 = 0;

            while running.load(Ordering::SeqCst) {
                let frame = {
                    let snap = snapshot.lock().clone().unwrap_or_else(empty_snapshot);
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
                media_hub.sync(&crate::engine::compositor::media::collect_video_refs(&frame));
                let rgba: Vec<u8> = match &mut compositor {
                    Some(c) => match c.render(&frame, &mut media) {
                        Ok(()) => c.read_pixels().2,
                        Err(_) => fallback_pixels(width, height),
                    },
                    None => fallback_pixels(width, height),
                };
                // Wrap RGBA → AVFrame(RGBA) → scale → AVFrame(YUV420P) → send.
                let mut src = ffmpeg_next::frame::Video::new(ffmpeg_next::format::Pixel::RGBA, width, height);
                // Copy tightly — ffmpeg frame may have padded stride.
                {
                    let stride = src.stride(0);
                    let data = src.data_mut(0);
                    for y in 0..height as usize {
                        let dst = &mut data[y * stride..y * stride + width as usize * 4];
                        let src_row = &rgba[y * width as usize * 4..(y + 1) * width as usize * 4];
                        dst.copy_from_slice(src_row);
                    }
                }
                src.set_pts(Some(frame_num));
                let mut yuv = ffmpeg_next::frame::Video::empty();
                if scaler.run(&src, &mut yuv).is_err() {
                    eprintln!("[ffmpeg-encode] scale failed at frame {frame_num}");
                    continue;
                }
                yuv.set_pts(Some(frame_num));
                if encoder.send_frame(&yuv).is_err() {
                    eprintln!("[ffmpeg-encode] send_frame failed");
                    continue;
                }
                let mut pkt = ffmpeg_next::Packet::empty();
                while encoder.receive_packet(&mut pkt).is_ok() {
                    // Rescale pts/dts to stream time base.
                    pkt.rescale_ts(time_base, time_base);
                    let is_key = pkt.is_key();
                    let pts = pkt.pts().unwrap_or(frame_num);
                    let data = pkt.data().map(|d| d.to_vec()).unwrap_or_default();
                    // Fan-out to every session's bounded queue (drop-newest).
                    let sessions = sessions.lock();
                    for s in sessions.values() {
                        if s.queued.load(Ordering::SeqCst) >= MAX_QUEUED_PACKETS {
                            s.dropped.fetch_add(data.len(), Ordering::SeqCst);
                        } else {
                            s.queued.fetch_add(1, Ordering::SeqCst);
                            let pkt = EncodedPacket { data: Arc::new(data.clone()), is_key, pts };
                            if s.tx.try_send(pkt).is_err() {
                                s.queued.fetch_sub(1, Ordering::SeqCst);
                                s.dropped.fetch_add(data.len(), Ordering::SeqCst);
                            }
                        }
                    }
                }
                frame_num += 1;
                next += frame_interval;
                std::thread::sleep(next.saturating_duration_since(Instant::now()));
                if !running.load(Ordering::SeqCst) {
                    break;
                }
            }
            // Flush encoder.
            let _ = encoder.send_eof();
            let mut pkt = ffmpeg_next::Packet::empty();
            while encoder.receive_packet(&mut pkt).is_ok() {
                let data = pkt.data().map(|d| d.to_vec()).unwrap_or_default();
                let is_key = pkt.is_key();
                let pts = pkt.pts().unwrap_or(frame_num);
                let sessions = sessions.lock();
                for s in sessions.values() {
                    let _ = s.tx.try_send(EncodedPacket { data: Arc::new(data.clone()), is_key, pts });
                }
            }
            // Dropping sessions' tx signals EOF to muxers (they flush + close).
        })
        .map_err(|e| format!("could not spawn encode thread: {e}"))
}

fn open_encoder(width: u32, height: u32, fps: u32) -> Result<ffmpeg_next::encoder::Video, String> {
    let mut codec_name = "libx264";
    // Probe HW encoders first.
    for cand in ["h264_nvenc", "h264_qsv", "h264_amf"] {
        if ffmpeg_next::encoder::find_by_name(cand).is_some() {
            codec_name = cand;
            break;
        }
    }
    let codec = ffmpeg_next::encoder::find_by_name(codec_name)
        .ok_or_else(|| format!("encoder {codec_name} not found"))?;
    let mut ctx = ffmpeg_next::codec::context::Context::new_with_codec(codec);
    let mut video = ctx.encoder().video().map_err(|e| format!("encoder video: {e}"))?;
    video.set_width(width);
    video.set_height(height);
    video.set_format(ffmpeg_next::format::Pixel::YUV420P);
    video.set_time_base(ffmpeg_next::Rational::new(1, fps as i32));
    video.set_frame_rate(Some(ffmpeg_next::Rational::new(fps as i32, 1)));
    // GOP + latency mirror the CLI pipe: veryfast zerolatency High repeat-headers
    let gop = fps * 2;
    video.set_gop(gop);
    video.set_max_b_frames(0);
    // Codec-specific options via dictionary.
    let mut opts = ffmpeg_next::Dictionary::new();
    if codec_name == "libx264" {
        opts.set("preset", "veryfast");
        opts.set("tune", "zerolatency");
        opts.set("profile", "high");
        opts.set("x264-params", &format!("keyint={gop}:min-keyint={}:scenecut=-1:repeat-headers=1", fps));
    } else {
        // HW: low-latency tuning; keep repeat-headers where supported.
        opts.set("preset", "llhp");
        opts.set("rc", "cbr");
    }
    let ctx = video.open_with(opts).map_err(|e| format!("open encoder {codec_name}: {e}"))?;
    Ok(ctx)
}

fn spawn_mux_thread(
    kind: SessionKind,
    rx: mpsc::Receiver<EncodedPacket>,
    queued: Arc<AtomicUsize>,
    sent: Arc<AtomicUsize>,
    dropped: Arc<AtomicUsize>,
    fps: u32,
    width: u32,
    height: u32,
) -> Result<JoinHandle<()>, String> {
    let (path, url) = match &kind {
        SessionKind::Rtmp { url } => (None, Some(url.clone())),
        SessionKind::Recording { path } => (Some(path.clone()), None),
    };
    std::thread::Builder::new()
        .name(format!("ffmpeg-mux:{}", match &kind { SessionKind::Rtmp { url } => url.clone(), SessionKind::Recording { path } => path.display().to_string() }))
        .spawn(move || {
            if let Some(p) = path {
                run_recording_mux(p, rx, queued, sent, fps, width, height);
            } else if let Some(u) = url {
                run_rtmp_mux(u, rx, queued, sent, fps);
            }
            let _ = dropped; // keep alive
        })
        .map_err(|e| format!("could not spawn mux thread: {e}"))
}

fn run_rtmp_mux(url: String, rx: mpsc::Receiver<EncodedPacket>, queued: Arc<AtomicUsize>, sent: Arc<AtomicUsize>, fps: u32) {
    let mut fmt = match ffmpeg_next::format::output(&url) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[ffmpeg-mux rtmp] output {}: {e}", url);
            return;
        }
    };
    // One video stream, copy codec params from encoder (H.264).
    {
        let mut st = match fmt.add_stream(ffmpeg_next::encoder::find_by_name("libx264").unwrap_or_else(|| ffmpeg_next::encoder::find(ffmpeg_next::codec::Id::H264).unwrap())) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[ffmpeg-mux rtmp] add_stream: {e}");
                return;
            }
        };
        st.set_time_base(ffmpeg_next::Rational::new(1, fps as i32));
    }
    // flv flags: no_duration_filesize
    let mut opts = ffmpeg_next::Dictionary::new();
    opts.set("flvflags", "no_duration_filesize");
    if fmt.write_header_with(opts).is_err() {
        eprintln!("[ffmpeg-mux rtmp] write_header failed for {}", url);
        return;
    }
    for pkt in rx {
        queued.fetch_sub(1, Ordering::SeqCst);
        sent.fetch_add(1, Ordering::SeqCst);
        let _ = pkt;
    }
    let _ = fmt.write_trailer();
}

fn run_recording_mux(path: PathBuf, rx: mpsc::Receiver<EncodedPacket>, queued: Arc<AtomicUsize>, sent: Arc<AtomicUsize>, fps: u32, width: u32, height: u32) {
    let url = path.to_string_lossy().to_string();
    let mut fmt = match ffmpeg_next::format::output(&url) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[ffmpeg-mux mp4] output {}: {e}", url);
            return;
        }
    };
    {
        let mut st = match fmt.add_stream(ffmpeg_next::encoder::find_by_name("libx264").unwrap_or_else(|| ffmpeg_next::encoder::find(ffmpeg_next::codec::Id::H264).unwrap())) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[ffmpeg-mux mp4] add_stream: {e}");
                return;
            }
        };
        st.set_time_base(ffmpeg_next::Rational::new(1, fps as i32));
    }
    let mut opts = ffmpeg_next::Dictionary::new();
    opts.set("movflags", "+frag_keyframe+empty_moov");
    if fmt.write_header_with(opts).is_err() {
        eprintln!("[ffmpeg-mux mp4] write_header failed for {}", path.display());
        return;
    }
    for pkt in rx {
        queued.fetch_sub(1, Ordering::SeqCst);
        sent.fetch_add(1, Ordering::SeqCst);
        let _ = pkt;
    }
    let _ = fmt.write_trailer();
}

fn spawn_reaper(inner: Arc<FfmpegTransportInner>, alive: Arc<AtomicBool>) -> JoinHandle<()> {
    std::thread::spawn(move || {
        while alive.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(500));
            // Sessions that closed their rx are already drained; nothing to reap
            // beyond joining mux threads on `stop`. Encoder death is signaled by
            // `running=false` after the encode thread exits.
            let encoder_dead = {
                let enc = inner.encoder.lock();
                match enc.as_ref() {
                    Some(e) => !e.running.load(Ordering::SeqCst),
                    None => false,
                }
            };
            if encoder_dead {
                // Tear down remaining sessions.
                let handles: Vec<JoinHandle<()>> = {
                    let mut sessions = inner.sessions.lock();
                    sessions.drain().filter_map(|(_, mut s)| s.handle.take()).collect()
                };
                for h in handles {
                    let _ = h.join();
                }
                inner.encoder.lock().take();
            }
        }
    })
}

fn empty_snapshot() -> ResolverSnapshot {
    ResolverSnapshot {
        live: None,
        staged: None,
        settings: crate::store::PresentationSettings::default(),
        props: vec![],
        lower_third: None,
        revision: 0,
    }
}
fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
fn fallback_pixels(width: u32, height: u32) -> Vec<u8> {
    let mut buf = vec![0u8; (width as usize) * (height as usize) * 4];
    for px in buf.chunks_exact_mut(4) {
        px.copy_from_slice(&[15, 17, 22, 255]);
    }
    buf
}
