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
/// Fields are consumed when the mux threads write packet payloads; until then
/// they are intentionally carried.
#[allow(dead_code)]
#[derive(Clone)]
struct EncodedPacket {
    data: Arc<Vec<u8>>,
    is_key: bool,
    pts: i64,
    dts: Option<i64>,
}

/// Codec parameters the mux threads must have before they can write a valid
/// container header — the encoder opens asynchronously inside its own thread,
/// so they block on this slot instead of writing a header with `codec none`.
#[derive(Clone)]
struct EncoderParams {
    width: u32,
    height: u32,
    fps: u32,
    /// SPS/PPS from `GLOBAL_HEADER`: MP4 needs it for avcC, FLV for metadata.
    extradata: Vec<u8>,
    /// Encoded pixel format — muxers must publish a matching codecpar.
    pix_fmt: i32,
}

type EncoderResultSlot = Arc<Mutex<Option<Result<EncoderParams, String>>>>;

fn wait_for_encoder_params(slot: &EncoderResultSlot) -> Result<EncoderParams, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(res) = slot.lock().clone() {
            return res;
        }
        if Instant::now() >= deadline {
            return Err("shared encoder did not open in time".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub struct FfmpegTransportInner {
    /// Per-destination muxers keyed by `session_id`. Each owns its `AVFormatContext`
    /// + bounded packet queue. Shared with the encoder fan for broadcast.
    sessions: Arc<Mutex<HashMap<String, FfmpegSession>>>,
    encoder: Mutex<Option<FfmpegEncoder>>,
    /// Result of the last encoder open — mux threads block on this before
    /// writing their container header (see `EncoderParams`).
    encoder_params: EncoderResultSlot,
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
}

/// Program geometry + rate the shared encoder was opened with.
struct EncoderSpec {
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
            encoder_params: Arc::new(Mutex::new(None)),
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
        let handle = spawn_mux_thread(
            kind_clone,
            rx,
            Arc::clone(&queued),
            Arc::clone(&sent),
            Arc::clone(&self.inner.encoder_params),
        )?;
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
            let _ = self.ensure_encoder_stopped();
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
        *self.inner.encoder_params.lock() = None;
        let handle = spawn_encode_thread(
            Arc::clone(&self.inner.snapshot),
            Arc::clone(&self.inner.scenes),
            Arc::clone(&self.inner.sessions),
            EncoderSpec { width, height, fps },
            self.inner.app_data_dir.clone(),
            Arc::clone(&self.inner.media_hub),
            Arc::clone(&running),
            Arc::clone(&self.inner.encoder_params),
        )?;
        *enc = Some(FfmpegEncoder { running, handle });
        Ok(())
    }

    fn ensure_encoder_stopped(&self) -> Option<()> {
        if !self.inner.sessions.lock().is_empty() {
            return None;
        }
        let enc = self.inner.encoder.lock().take()?;
        *self.inner.encoder_params.lock() = None;
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

#[allow(clippy::too_many_arguments)]
fn spawn_encode_thread(
    snapshot: Arc<Mutex<Option<ResolverSnapshot>>>,
    scenes: Arc<Mutex<Option<Vec<Scene>>>>,
    sessions: Arc<Mutex<HashMap<String, FfmpegSession>>>,
    spec: EncoderSpec,
    app_data_dir: PathBuf,
    media_hub: Arc<crate::engine::compositor::media::MediaFrameHub>,
    running: Arc<AtomicBool>,
    encoder_params: EncoderResultSlot,
) -> Result<JoinHandle<()>, String> {
    crate::engine::ffmpeg::init()?;
    // Build encoder: prefer HW (h264_nvenc / h264_qsv / h264_amf), fallback libx264.
    // We open it inside the thread so device probing sees the real GPU.
    std::thread::Builder::new()
        .name("ffmpeg-encode".into())
        .spawn(move || {
            let EncoderSpec { width, height, fps } = spec;
            let frame_interval = Duration::from_micros(1_000_000 / fps.max(1) as u64);
            // Compositor (owns GPU, `!Send` → must be created on this thread).
            let mut compositor = crate::engine::compositor::Compositor::new(width, height).ok();
            let mut media = crate::engine::windows::DiskMediaResolver { app_data_dir, hub: Some(Arc::clone(&media_hub)) };

            // Open encoder context. Also learn which input pixel format the
            // chosen encoder accepts — QSV wants NV12, the rest YUV420P.
            let (mut encoder, input_pix) = match open_encoder(width, height, fps) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[ffmpeg-encode] open_encoder failed: {e}");
                    *encoder_params.lock() = Some(Err(e));
                    return;
                }
            };
            // Publish the codec parameters (incl. SPS/PPS extradata from
            // GLOBAL_HEADER) so waiting mux threads can write valid headers.
            {
                let extradata = unsafe {
                    let c = encoder.as_ptr();
                    let size = (*c).extradata_size.max(0) as usize;
                    if size > 0 && !(*c).extradata.is_null() {
                        std::slice::from_raw_parts((*c).extradata, size).to_vec()
                    } else {
                        Vec::new()
                    }
                };
                *encoder_params.lock() = Some(Ok(EncoderParams {
                    width,
                    height,
                    fps,
                    extradata,
                    pix_fmt: pix_fmt_ffi(input_pix),
                }));
            }
            let time_base = encoder.time_base();
            let mut scaler = match ffmpeg_next::software::scaling::context::Context::get(
                ffmpeg_next::format::Pixel::RGBA,
                width,
                height,
                input_pix,
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
                // Wrap RGBA → AVFrame(RGBA) → scale → AVFrame(input_pix) → send.
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
                    let dts = pkt.dts();
                    let data = pkt.data().map(|d| d.to_vec()).unwrap_or_default();
                    // Fan-out to every session's bounded queue (drop-newest).
                    let sessions = sessions.lock();
                    for s in sessions.values() {
                        if s.queued.load(Ordering::SeqCst) >= MAX_QUEUED_PACKETS {
                            s.dropped.fetch_add(data.len(), Ordering::SeqCst);
                        } else {
                            s.queued.fetch_add(1, Ordering::SeqCst);
                            let pkt = EncodedPacket { data: Arc::new(data.clone()), is_key, pts, dts };
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
                let dts = pkt.dts();
                let sessions = sessions.lock();
                for s in sessions.values() {
                    let _ = s.tx.try_send(EncodedPacket { data: Arc::new(data.clone()), is_key, pts, dts });
                }
            }
            // Dropping sessions' tx signals EOF to muxers (they flush + close).
        })
        .map_err(|e| format!("could not spawn encode thread: {e}"))
}

fn open_encoder(
    width: u32,
    height: u32,
    fps: u32,
) -> Result<(ffmpeg_next::encoder::Video, ffmpeg_next::format::Pixel), String> {
    // Probe HW encoders in preference order. `find_by_name` only proves the
    // codec is compiled into libav — the nvcuda/QuickSync/AMF runtimes may
    // still be missing on this machine — so each candidate must actually
    // OPEN. DXGI vendor detection (gpu.rs) skips candidates whose hardware is
    // absent entirely; when detection itself fails we try every candidate as
    // before.
    const VENDOR_FOR_ENCODER: &[(&str, u32)] = &[
        ("h264_nvenc", super::gpu::VENDOR_NVIDIA),
        ("h264_qsv", super::gpu::VENDOR_INTEL),
        ("h264_amf", super::gpu::VENDOR_AMD),
    ];
    let vendors = match super::gpu::detected_gpu_vendors() {
        Ok(v) => {
            let hex: Vec<String> = v.iter().map(|id| format!("{id:#06x}")).collect();
            eprintln!("[ffmpeg-encode] detected GPUs: {}", if hex.is_empty() { "none".into() } else { hex.join(", ") });
            Some(v)
        }
        Err(e) => {
            eprintln!("[ffmpeg-encode] gpu detection unavailable ({e}) — probing all HW encoders");
            None
        }
    };
    let candidates: Vec<&str> = VENDOR_FOR_ENCODER
        .iter()
        .filter(|(name, vendor)| match &vendors {
            Some(v) => v.contains(vendor) && ffmpeg_next::encoder::find_by_name(name).is_some(),
            None => ffmpeg_next::encoder::find_by_name(name).is_some(),
        })
        .map(|(name, _)| *name)
        .collect();
    let mut last_hw_err = String::new();
    for cand in candidates {
        match try_open_encoder(cand, width, height, fps) {
            Ok((v, pix)) => {
                eprintln!("[ffmpeg-encode] using hardware encoder {cand}");
                return Ok((v, pix));
            }
            Err(e) => {
                eprintln!("[ffmpeg-encode] {cand} unavailable ({e}) — trying next");
                last_hw_err = format!("{cand}: {e}");
            }
        }
    }
    try_open_encoder("libx264", width, height, fps).map_err(|e| {
        if last_hw_err.is_empty() {
            format!("open encoder libx264: {e}")
        } else {
            format!("no usable h264 encoder — HW failed ({last_hw_err}), libx264: {e}")
        }
    })
}

fn try_open_encoder(
    codec_name: &str,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<(ffmpeg_next::encoder::Video, ffmpeg_next::format::Pixel), String> {
    let codec = ffmpeg_next::encoder::find_by_name(codec_name)
        .ok_or_else(|| format!("encoder {codec_name} not found"))?;
    let ctx = ffmpeg_next::codec::context::Context::new_with_codec(codec);
    let mut video = ctx.encoder().video().map_err(|e| format!("encoder video: {e}"))?;
    video.set_width(width);
    video.set_height(height);
    video.set_format(codec_input_format(codec_name));
    video.set_time_base(ffmpeg_next::Rational::new(1, fps as i32));
    video.set_frame_rate(Some(ffmpeg_next::Rational::new(fps as i32, 1)));
    // GOP + latency mirror the CLI pipe: veryfast zerolatency High repeat-headers
    let gop = fps * 2;
    video.set_gop(gop);
    video.set_max_b_frames(0);
    // Muxers consume the extradata via the shared EncoderParams slot, so ask
    // for a global header regardless of which container opens first.
    video.set_flags(ffmpeg_next::codec::flag::Flags::GLOBAL_HEADER);
    // Codec-specific options via dictionary. Each encoder has its own option
    // vocabulary — the p1–p7 preset scale is NVENC-only (FFmpeg 9 removed the
    // legacy llhp names); QSV speaks the x264-style scale; AMF uses
    // quality=speed and rejects `preset` outright.
    let mut opts = ffmpeg_next::Dictionary::new();
    match codec_name {
        "libx264" => {
            opts.set("preset", "veryfast");
            opts.set("tune", "zerolatency");
            opts.set("profile", "high");
            opts.set("x264-params", &format!("keyint={gop}:min-keyint={}:scenecut=-1", fps));
        }
        "h264_nvenc" => {
            // Low-latency tuning; FFmpeg 9 only accepts the p1–p7 scale here.
            opts.set("preset", "p4");
            opts.set("rc", "cbr");
        }
        "h264_qsv" => {
            opts.set("preset", "veryfast");
            // Shallow async pipeline for latency parity with the CLI pipe.
            opts.set("async_depth", "1");
        }
        "h264_amf" => {
            opts.set("quality", "speed");
        }
        other => {
            return Err(format!("no option profile for encoder {other}"));
        }
    }
    video.open_with(opts)
        .map(|v| (v, codec_input_format(codec_name)))
        .map_err(|e| format!("open encoder {codec_name}: {e}"))
}

/// Input pixel format each encoder accepts: QSV requires NV12, while
/// x264/NVENC take planar YUV420P.
fn codec_input_format(codec_name: &str) -> ffmpeg_next::format::Pixel {
    match codec_name {
        "h264_qsv" => ffmpeg_next::format::Pixel::NV12,
        _ => ffmpeg_next::format::Pixel::YUV420P,
    }
}

fn pix_fmt_ffi(pix: ffmpeg_next::format::Pixel) -> i32 {
    use ffmpeg_next::ffi::AVPixelFormat;
    match pix {
        ffmpeg_next::format::Pixel::NV12 => AVPixelFormat::AV_PIX_FMT_NV12 as i32,
        _ => AVPixelFormat::AV_PIX_FMT_YUV420P as i32,
    }
}

fn spawn_mux_thread(
    kind: SessionKind,
    rx: mpsc::Receiver<EncodedPacket>,
    queued: Arc<AtomicUsize>,
    sent: Arc<AtomicUsize>,
    params_slot: EncoderResultSlot,
) -> Result<JoinHandle<()>, String> {
    let (path, url) = match &kind {
        SessionKind::Rtmp { url } => (None, Some(url.clone())),
        SessionKind::Recording { path } => (Some(path.clone()), None),
    };
    std::thread::Builder::new()
        .name(format!("ffmpeg-mux:{}", match &kind { SessionKind::Rtmp { url } => url.clone(), SessionKind::Recording { path } => path.display().to_string() }))
        .spawn(move || {
            if let Some(p) = path {
                run_recording_mux(p, rx, queued, sent, params_slot);
            } else if let Some(u) = url {
                run_rtmp_mux(u, rx, queued, sent, params_slot);
            }
        })
        .map_err(|e| format!("could not spawn mux thread: {e}"))
}

/// Add one H.264 video stream to a fresh output context and populate its
/// codec parameters. Without this the stream's codec id stays NONE and every
/// container rejects the header ("Could not find tag for codec none").
fn add_video_stream(
    fmt: &mut ffmpeg_next::format::context::Output,
    p: &EncoderParams,
) -> Result<(), String> {
    let codec = ffmpeg_next::encoder::find_by_name("libx264")
        .or_else(|| ffmpeg_next::encoder::find(ffmpeg_next::codec::Id::H264))
        .ok_or_else(|| "h264 encoder/codec not found".to_string())?;
    let mut st = fmt.add_stream(codec).map_err(|e| format!("add_stream: {e}"))?;
    st.set_time_base(ffmpeg_next::Rational::new(1, p.fps as i32));
    st.set_rate(ffmpeg_next::Rational::new(p.fps as i32, 1));
    unsafe {
        let par = (*st.as_mut_ptr()).codecpar;
        (*par).codec_type = ffmpeg_next::ffi::AVMediaType::AVMEDIA_TYPE_VIDEO;
        (*par).codec_id = ffmpeg_next::ffi::AVCodecID::AV_CODEC_ID_H264;
        (*par).width = p.width as i32;
        (*par).height = p.height as i32;
        (*par).format = p.pix_fmt;
        if !p.extradata.is_empty() {
            let len = p.extradata.len();
            let pad = ffmpeg_next::ffi::AV_INPUT_BUFFER_PADDING_SIZE as usize;
            (*par).extradata =
                ffmpeg_next::ffi::av_mallocz(len + pad) as *mut u8;
            if (*par).extradata.is_null() {
                return Err("extradata allocation failed".into());
            }
            std::ptr::copy_nonoverlapping(p.extradata.as_ptr(), (*par).extradata, len);
            (*par).extradata_size = len as i32;
        }
    }
    Ok(())
}

/// Wrap one fanned-out packet for writing: same time base as the stream
/// (encoder tb == 1/fps), single video stream, keyframe flag preserved.
fn packet_for_stream(pkt: &EncodedPacket, fps: u32) -> ffmpeg_next::Packet {
    let mut out = ffmpeg_next::Packet::copy(&pkt.data);
    out.set_stream(0);
    out.set_time_base(ffmpeg_next::Rational::new(1, fps as i32));
    out.set_pts(Some(pkt.pts));
    out.set_dts(pkt.dts.or(Some(pkt.pts)));
    if pkt.is_key {
        out.set_flags(ffmpeg_next::codec::packet::flag::Flags::KEY);
    }
    out
}

fn run_rtmp_mux(
    url: String,
    rx: mpsc::Receiver<EncodedPacket>,
    queued: Arc<AtomicUsize>,
    sent: Arc<AtomicUsize>,
    params_slot: EncoderResultSlot,
) {
    let params = match wait_for_encoder_params(&params_slot) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[ffmpeg-mux rtmp] aborted before header ({url}): {e}");
            for _ in rx {}
            return;
        }
    };
    let mut fmt = match ffmpeg_next::format::output(&url) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[ffmpeg-mux rtmp] output {}: {e}", url);
            return;
        }
    };
    if let Err(e) = add_video_stream(&mut fmt, &params) {
        eprintln!("[ffmpeg-mux rtmp] {e}");
        return;
    }
    // flv flags: no_duration_filesize
    let mut opts = ffmpeg_next::Dictionary::new();
    opts.set("flvflags", "no_duration_filesize");
    if let Err(e) = fmt.write_header_with(opts) {
        eprintln!("[ffmpeg-mux rtmp] write_header failed for {url}: {e}");
        return;
    }
    for pkt in rx {
        queued.fetch_sub(1, Ordering::SeqCst);
        sent.fetch_add(1, Ordering::SeqCst);
        let out = packet_for_stream(&pkt, params.fps);
        if let Err(e) = out.write_interleaved(&mut fmt) {
            eprintln!("[ffmpeg-mux rtmp] write_interleaved failed: {e}");
        }
    }
    let _ = fmt.write_trailer();
}

fn run_recording_mux(
    path: PathBuf,
    rx: mpsc::Receiver<EncodedPacket>,
    queued: Arc<AtomicUsize>,
    sent: Arc<AtomicUsize>,
    params_slot: EncoderResultSlot,
) {
    let url = path.to_string_lossy().to_string();
    let params = match wait_for_encoder_params(&params_slot) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[ffmpeg-mux mp4] aborted before header ({}): {e}", path.display());
            for _ in rx {}
            return;
        }
    };
    let mut fmt = match ffmpeg_next::format::output(&url) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("[ffmpeg-mux mp4] output {}: {e}", url);
            return;
        }
    };
    if let Err(e) = add_video_stream(&mut fmt, &params) {
        eprintln!("[ffmpeg-mux mp4] {e}");
        return;
    }
    // Fragmented MP4: the moov is written immediately, so a crash or an
    // operator kill still leaves a playable file.
    let mut opts = ffmpeg_next::Dictionary::new();
    opts.set("movflags", "+frag_keyframe+empty_moov");
    if let Err(e) = fmt.write_header_with(opts) {
        eprintln!("[ffmpeg-mux mp4] write_header failed for {}: {e}", path.display());
        return;
    }
    for pkt in rx {
        queued.fetch_sub(1, Ordering::SeqCst);
        sent.fetch_add(1, Ordering::SeqCst);
        let out = packet_for_stream(&pkt, params.fps);
        if let Err(e) = out.write_interleaved(&mut fmt) {
            eprintln!("[ffmpeg-mux mp4] write_interleaved failed: {e}");
        }
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
                *inner.encoder_params.lock() = None;
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
