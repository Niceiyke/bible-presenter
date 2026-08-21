//! In-engine video decode (Phase H).
//!
//! The compositor's video arms sample the latest decoded RGBA frame for a
//! playing asset through a [`MediaFrameHub`] instead of loading static bytes.
//! One decoder subprocess runs per referenced asset regardless of how many
//! surfaces consume it (output window, stage window, transport capture), keyed
//! by the asset's persisted (relativized) path.
//!
//! Decode strategy: the bundled GPL `ffmpeg.exe` emits rawvideo RGBA frames on
//! stdout, scaled down to [`MAX_VIDEO_WIDTH`]×[`MAX_VIDEO_HEIGHT`] (never
//! upsampled). The decode thread paces publication against the probed frame
//! rate × playback rate and drops late frames — readers always get the newest
//! complete frame. Audio is explicitly out of scope (`-an`) until the engine
//! audio graph lands.
//!
//! Lifecycle: decoders are spawned lazily by [`MediaFrameHub::sync`] (called
//! from every render surface each tick with the paths its resolved frame
//! references) and swept after a linger window once nothing references them.
//! A failed spawn/decode tombstones the entry and retries after a cooldown;
//! renderers see `None` and paint the safe missing-media panel. A decoder
//! death never touches presentation state.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use super::frame::{ProgramFrame, ProgramLayer};
use crate::store::BackgroundSetting;

/// Decode-output cap: sources larger than this are downscaled by the scale
/// filter so the RGBA pipe bandwidth stays bounded (~250 MB/s worst case).
pub const MAX_VIDEO_WIDTH: u32 = 1920;
pub const MAX_VIDEO_HEIGHT: u32 = 1080;

/// How long an unreferenced decoder lingers before it is stopped (render
/// surfaces re-sync every tick, so brief resolution gaps don't churn decoders).
const DEFAULT_LINGER: Duration = Duration::from_secs(3);
/// Cooldown before retrying a decoder whose spawn or decode failed.
const DEFAULT_RETRY_AFTER: Duration = Duration::from_secs(5);

/// One decoded RGBA video frame. The pixel buffer is shared, so handing the
/// newest frame to N consumers never copies it.
#[derive(Debug, Clone)]
pub struct VideoFrame {
    pub width: u32,
    pub height: u32,
    pub rgba: Arc<Vec<u8>>,
}

/// Playback options a decoder is spawned with. Persisted per asset
/// (`MediaItem.loop_playback` / `playback_rate`, `VideoBackground.*`);
/// `start_ms` is the operator seek position.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VideoOpts {
    pub loop_playback: bool,
    pub playback_rate: f64,
    pub start_ms: u64,
}

impl Default for VideoOpts {
    fn default() -> Self {
        Self { loop_playback: true, playback_rate: 1.0, start_ms: 0 }
    }
}

impl VideoOpts {
    /// Whether restarting the decoder is required for these options to apply.
    fn differs_from(&self, other: &VideoOpts) -> bool {
        self != other
    }

    fn clamped_rate(&self) -> f64 {
        if self.playback_rate > 0.05 { self.playback_rate } else { 1.0 }
    }
}

/// Operator-initiated transport control for one playing asset. Serialized over
/// the engine IPC (`EngineCommand::MediaControl`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum MediaAction {
    Pause,
    Resume,
    Seek { ms: u64 },
}

/// Lifecycle event a decoder reports into the hub's event channel.
#[derive(Debug, Clone, PartialEq)]
pub enum DecoderEvent {
    /// Non-looping playback reached the end of the asset. The last frame
    /// stays on screen (frozen) until the asset is unreferenced.
    Ended(String),
    /// The decoder could not produce frames (spawn failure, unreadable file).
    /// The entry tombstones and retries after the cooldown.
    Failed(String, String),
}

// ---------------------------------------------------------------------------
// Latest-complete frame slot
// ---------------------------------------------------------------------------

/// Shared latest-complete slot between a decoder thread (writer) and any
/// number of render threads (readers). Late frames overwrite pending ones —
/// readers never queue.
#[derive(Default)]
pub struct FrameSlot(Mutex<Option<VideoFrame>>);

impl FrameSlot {
    fn set(&self, frame: VideoFrame) {
        *self.0.lock() = Some(frame);
    }

    fn clear(&self) {
        *self.0.lock() = None;
    }

    fn get(&self) -> Option<VideoFrame> {
        self.0.lock().clone()
    }
}

// ---------------------------------------------------------------------------
// Decoder handle
// ---------------------------------------------------------------------------

struct DecoderShared {
    slot: Arc<FrameSlot>,
    paused: AtomicBool,
    killed: AtomicBool,
    child: Mutex<Option<Child>>,
    events_tx: mpsc::Sender<DecoderEvent>,
}

impl Drop for DecoderShared {
    fn drop(&mut self) {
        // Safety net: never leak an ffmpeg child, whatever the teardown order.
        self.kill_child();
    }
}

impl DecoderShared {
    fn kill_child(&self) {
        self.killed.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Handle to one running decoder. Cloning shares the same underlying decoder.
#[derive(Clone)]
pub struct VideoDecoderHandle {
    shared: Arc<DecoderShared>,
}

impl VideoDecoderHandle {
    /// Newest complete frame, if any.
    pub fn latest(&self) -> Option<VideoFrame> {
        self.shared.slot.get()
    }

    /// The decoder's frame slot (for restarts that must preserve the last
    /// displayed frame across the respawn gap).
    pub fn slot(&self) -> Arc<FrameSlot> {
        Arc::clone(&self.shared.slot)
    }

    pub fn set_paused(&self, paused: bool) {
        self.shared.paused.store(paused, Ordering::SeqCst);
    }

    pub fn is_stopped(&self) -> bool {
        self.shared.killed.load(Ordering::SeqCst)
    }

    /// Stop the decoder: kills the child (EOF ends the decode thread) and
    /// suppresses its terminal event. Idempotent.
    pub fn stop(&self) {
        self.shared.kill_child();
    }

    /// Push an event through this decoder's own channel (used for synthetic
    /// spawn-failure reports on dead handles).
    fn emit(&self, event: DecoderEvent) {
        let _ = self.shared.events_tx.send(event);
    }

/// A handle with no backing process/thread — used to tombstone failed
/// entries so the hub doesn't respawn every tick.
fn dead() -> (Self, mpsc::Receiver<DecoderEvent>) {
    let (tx, rx) = mpsc::channel();
    (
        Self {
            shared: Arc::new(DecoderShared {
                slot: Arc::new(FrameSlot::default()),
                paused: AtomicBool::new(false),
                killed: AtomicBool::new(true),
                child: Mutex::new(None),
                events_tx: tx,
            }),
        },
        rx,
    )
}
}

// ---------------------------------------------------------------------------
// Probing + argument construction (pure, unit-tested)
// ---------------------------------------------------------------------------

/// Probed source geometry: dimensions plus the frame rate used for pacing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SourceInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

/// Parse `ffprobe -of csv=p=0` output: `width,height,r_frame_rate` where the
/// rate is a fraction like `30000/1001`.
pub fn parse_probe_output(output: &str) -> Option<SourceInfo> {
    let line = output.lines().next()?.trim();
    let mut parts = line.split(',');
    let width = parts.next()?.trim().parse::<u32>().ok()?;
    let height = parts.next()?.trim().parse::<u32>().ok()?;
    let rate_raw = parts.next()?.trim();
    let fps = match rate_raw.split_once('/') {
        Some((num, den)) => {
            let n: f64 = num.trim().parse().ok()?;
            let d: f64 = den.trim().parse().ok()?;
            if d <= 0.0 { 30.0 } else { n / d }
        }
        None => rate_raw.parse::<f64>().unwrap_or(30.0),
    };
    let fps = if fps.is_finite() && fps > 0.0 { fps.min(60.0) } else { 30.0 };
    if width == 0 || height == 0 {
        return None;
    }
    Some(SourceInfo { width, height, fps })
}

/// Scale source dimensions to fit within `(max_w, max_h)` without ever
/// upscaling, rounding each side down to an even value (safer for filters).
pub fn fit_dimensions(src_w: u32, src_h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    let scale =
        1.0_f64.min(max_w as f64 / src_w.max(1) as f64).min(max_h as f64 / src_h.max(1) as f64);
    let w = ((src_w as f64 * scale).floor() as u32).max(2) & !1;
    let h = ((src_h as f64 * scale).floor() as u32).max(2) & !1;
    (w.max(2), h.max(2))
}

/// Build the decode command: rawvideo RGBA on stdout, scaled to `(w, h)`,
/// video-only (`-map 0:v:0 -an` — program audio is out of scope until the
/// engine audio graph lands). Loop/seek/rate map onto ffmpeg flags.
fn decoder_command(
    ffmpeg: &Path,
    input: &Path,
    opts: &VideoOpts,
    w: u32,
    h: u32,
) -> Command {
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner").arg("-loglevel").arg("error");
    if opts.start_ms > 0 {
        cmd.arg("-ss").arg(format!("{:.3}", opts.start_ms as f64 / 1000.0));
    }
    if opts.loop_playback {
        cmd.arg("-stream_loop").arg("-1");
    }
    cmd.arg("-i").arg(input);
    cmd.args(["-map", "0:v:0", "-an", "-sn", "-dn"]);
    cmd.args([
        "-vf",
        &format!("setpts=PTS/{:.6},scale={w}:{h}", opts.clamped_rate()),
    ]);
    cmd.args(["-pix_fmt", "rgba", "-f", "rawvideo"]);
    cmd.arg("-");
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    cmd
}

/// Run ffprobe for one media file and parse its geometry.
fn probe_source(ffprobe: &Path, input: &Path) -> Result<SourceInfo, String> {
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate",
            "-of",
            "csv=p=0",
        ])
        .arg(input)
        .output()
        .map_err(|e| format!("ffprobe failed to launch: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe failed for {}: {}",
            input.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_probe_output(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| format!("could not parse ffprobe output for {}", input.display()))
}

// ---------------------------------------------------------------------------
// Spawner
// ---------------------------------------------------------------------------

/// Spawns a decoder for `raw_path` (a persisted, possibly relative media path)
/// with `opts`. `slot` lets a restart preserve the previous decoder's last
/// frame across the respawn gap. Returns the handle plus the decoder's private
/// event receiver. Test hubs inject a fake here.
pub type DecoderSpawner = Arc<
    dyn Fn(
            &str,
            &VideoOpts,
            Option<Arc<FrameSlot>>,
        ) -> Result<(VideoDecoderHandle, mpsc::Receiver<DecoderEvent>), String>
        + Send
        + Sync,
>;

/// Resolve a persisted (relativized) media path against the app data dir —
/// mirrors `resolvePath` in `src/utils/index.ts` (`{baseDir}\media\{path}`);
/// absolute paths pass through.
pub fn resolve_media_path(app_data_dir: &Path, raw_path: &str) -> PathBuf {
    let raw = PathBuf::from(raw_path);
    if raw.is_absolute() {
        raw
    } else {
        app_data_dir.join("media").join(raw)
    }
}

/// Production spawner: probes the file, then spawns the paced decode thread.
pub fn default_spawner(
    app_data_dir: PathBuf,
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
) -> DecoderSpawner {
    Arc::new(move |raw_path, opts, slot| {
        let input = resolve_media_path(&app_data_dir, raw_path);
        if !input.exists() {
            return Err(format!("media file not found: {}", input.display()));
        }
        let info = probe_source(&ffprobe, &input)?;
        spawn_decoder(&ffmpeg, raw_path, &input, opts, info, slot)
    })
}

/// Spawn one decoder child + its pacing decode thread. Returns the handle
/// plus the decoder's private lifecycle-event receiver, which the hub adopts
/// into its entry so [`MediaFrameHub::poll_events`] can drain it.
fn spawn_decoder(
    ffmpeg: &Path,
    raw_path: &str,
    input: &Path,
    opts: &VideoOpts,
    info: SourceInfo,
    slot: Option<Arc<FrameSlot>>,
) -> Result<(VideoDecoderHandle, mpsc::Receiver<DecoderEvent>), String> {
    let (w, h) = fit_dimensions(info.width, info.height, MAX_VIDEO_WIDTH, MAX_VIDEO_HEIGHT);
    let mut child = decoder_command(ffmpeg, input, opts, w, h)
        .spawn()
        .map_err(|e| format!("ffmpeg failed to launch for {input:?}: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg stdout was not available.".to_string())?;

    let (events_tx, events_rx) = mpsc::channel::<DecoderEvent>();

    let shared = Arc::new(DecoderShared {
        slot: slot.unwrap_or_default(),
        paused: AtomicBool::new(false),
        killed: AtomicBool::new(false),
        child: Mutex::new(Some(child)),
        events_tx,
    });

    let thread_shared = Arc::clone(&shared);
    let path_for_thread = raw_path.to_string();
    let thread_opts = *opts;
    std::thread::Builder::new()
        .name(format!("video-decode:{raw_path}"))
        .spawn(move || {
            run_decode_loop(thread_shared, stdout, w, h, info.fps, thread_opts.clamped_rate(), path_for_thread);
        })
        .map_err(|e| format!("could not spawn decode thread: {e}"))?;

    Ok((VideoDecoderHandle { shared }, events_rx))
}

/// The decode loop: reads fixed-size RGBA frames from ffmpeg's stdout and
/// publishes them into the shared slot at wall-clock pace
/// (`frame duration = 1 / (probed fps × playback rate)`). While paused the
/// loop stops reading, so the OS pipe backpressures ffmpeg into a cheap stall.
/// On natural exit it reports `Ended` (frames were produced) or `Failed`.
fn run_decode_loop(
    shared: Arc<DecoderShared>,
    mut stdout: impl Read,
    w: u32,
    h: u32,
    fps: f64,
    rate: f64,
    path: String,
) {
    let frame_len = (w as usize).saturating_mul(h as usize).saturating_mul(4);
    if frame_len == 0 {
        let _ = shared.events_tx.send(DecoderEvent::Failed(path, "invalid decode geometry".into()));
        return;
    }
    let mut buf = vec![0u8; frame_len];
    let frame_dur = Duration::from_secs_f64(1.0 / (fps * rate).max(0.01));
    let mut next_due = Instant::now();
    let mut got_frame = false;

    loop {
        if shared.killed.load(Ordering::SeqCst) {
            return;
        }
        if shared.paused.load(Ordering::SeqCst) {
            // Hold the last frame; shift the schedule so resume doesn't burst.
            next_due = Instant::now();
            std::thread::sleep(Duration::from_millis(15));
            continue;
        }
        if stdout.read_exact(&mut buf).is_err() {
            break; // EOF (end of asset / loop seam) or the child died
        }
        let now = Instant::now();
        if now < next_due {
            std::thread::sleep(next_due - now);
        }
        next_due = next_due
            .checked_add(frame_dur)
            .unwrap_or_else(Instant::now)
            .max(Instant::now());
        shared.slot.set(VideoFrame {
            width: w,
            height: h,
            rgba: Arc::new(buf.clone()),
        });
        got_frame = true;
    }

    if shared.killed.load(Ordering::SeqCst) {
        return; // stopped deliberately — no terminal event
    }
    let event = if got_frame {
        DecoderEvent::Ended(path)
    } else {
        DecoderEvent::Failed(path, "no frames decoded".into())
    };
    let _ = shared.events_tx.send(event);
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

struct HubEntry {
    decoder: VideoDecoderHandle,
    /// The decoder's private lifecycle-event receiver, drained by
    /// [`MediaFrameHub::poll_events`].
    events: Mutex<mpsc::Receiver<DecoderEvent>>,
    opts: VideoOpts,
    last_seen: Instant,
    failed_at: Option<Instant>,
}

/// Registry of running video decoders, keyed by persisted media path. Owned
/// by the engine runtime and shared (Arc) with every render surface.
///
/// Contract: ONE decoder per path no matter how many surfaces consume it;
/// surfaces call [`MediaFrameHub::sync`] each rendered tick with the paths
/// their resolved frame references, and pull pixels via [`MediaFrameHub::latest`].
pub struct MediaFrameHub {
    entries: Mutex<HashMap<String, HubEntry>>,
    spawner: DecoderSpawner,
    linger: Duration,
    retry_after: Duration,
}

impl std::fmt::Debug for MediaFrameHub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let count = self.entries.lock().len();
        f.debug_struct("MediaFrameHub").field("decoders", &count).finish()
    }
}

impl Drop for MediaFrameHub {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl MediaFrameHub {
    /// Hub with the production spawner and default timings.
    pub fn new(spawner: DecoderSpawner) -> Arc<Self> {
        Self::with_timings(spawner, DEFAULT_LINGER, DEFAULT_RETRY_AFTER)
    }

    /// Hub with explicit lifecycle timings (tests inject short windows).
    pub fn with_timings(spawner: DecoderSpawner, linger: Duration, retry_after: Duration) -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            spawner,
            linger,
            retry_after,
        })
    }

    /// Per-tick lifecycle sync from a render surface: marks every referenced
    /// path seen, spawns missing decoders, restarts decoders whose options
    /// changed, retries tombstoned failures after the cooldown, and sweeps
    /// entries nothing has referenced for longer than the linger window.
    pub fn sync(&self, refs: &[(String, VideoOpts)]) {
        let now = Instant::now();
        let mut entries = self.entries.lock();

        for (path, opts) in refs {
            match entries.get_mut(path) {
                Some(entry) => {
                    entry.last_seen = now;
                    if opts.differs_from(&entry.opts) {
                        self.restart_entry(path, entry, *opts, now);
                    } else if entry.decoder.is_stopped()
                        && entry.failed_at.map(|t| now.duration_since(t) >= self.retry_after).unwrap_or(false)
                    {
                        self.respawn_entry(path, entry, *opts, now);
                    }
                }
                None => {
                    let (dead, dead_rx) = VideoDecoderHandle::dead();
                    let mut fresh = HubEntry {
                        decoder: dead,
                        events: Mutex::new(dead_rx),
                        opts: *opts,
                        last_seen: now,
                        failed_at: Some(now),
                    };
                    self.respawn_entry(path, &mut fresh, *opts, now);
                    entries.insert(path.clone(), fresh);
                }
            }
        }

        let referenced: Vec<&str> = refs.iter().map(|(p, _)| p.as_str()).collect();
        let stale: Vec<String> = entries
            .iter()
            .filter(|(path, entry)| {
                !referenced.contains(&path.as_str())
                    && now.duration_since(entry.last_seen) >= self.linger
            })
            .map(|(path, _)| path.clone())
            .collect();
        for path in stale {
            if let Some(entry) = entries.remove(&path) {
                entry.decoder.stop();
            }
        }
    }

    /// Restart because the operator changed playback options; preserves the
    /// last displayed frame across the respawn gap.
    fn restart_entry(&self, path: &str, entry: &mut HubEntry, opts: VideoOpts, now: Instant) {
        let slot = entry.decoder.slot();
        entry.decoder.stop();
        match (self.spawner)(path, &opts, Some(slot)) {
            Ok((decoder, events)) => {
                entry.decoder = decoder;
                entry.events = Mutex::new(events);
                entry.opts = opts;
                entry.failed_at = None;
            }
            Err(reason) => {
                let (dead, dead_rx) = VideoDecoderHandle::dead();
                dead.emit(DecoderEvent::Failed(path.to_string(), reason));
                entry.decoder = dead;
                entry.events = Mutex::new(dead_rx);
                entry.opts = opts;
                entry.failed_at = Some(now);
            }
        }
    }

    /// Attempt to (re)spawn the decoder for an entry, tombstoning on failure.
    fn respawn_entry(&self, path: &str, entry: &mut HubEntry, opts: VideoOpts, now: Instant) {
        match (self.spawner)(path, &opts, None) {
            Ok((decoder, events)) => {
                entry.decoder = decoder;
                entry.events = Mutex::new(events);
                entry.opts = opts;
                entry.failed_at = None;
            }
            Err(reason) => {
                // Route the failure through the entry's own (dead-handle)
                // channel so poll_events surfaces it to the console.
                entry.decoder.emit(DecoderEvent::Failed(path.to_string(), reason));
                entry.failed_at = Some(now);
            }
        }
    }

    /// Render-thread fetch: the newest complete frame for a playing asset.
    /// `None` while no decoder exists or the last attempt failed — callers
    /// paint the safe missing-media fallback.
    pub fn latest(&self, path: &str) -> Option<VideoFrame> {
        let entries = self.entries.lock();
        let entry = entries.get(path)?;
        if entry.failed_at.is_some() {
            return None;
        }
        entry.decoder.latest()
    }

    /// Operator transport control for one playing asset.
    pub fn control(&self, path: &str, action: &MediaAction) -> Result<(), String> {
        let mut entries = self.entries.lock();
        let entry = entries
            .get_mut(path)
            .ok_or_else(|| "That media is not currently playing.".to_string())?;
        match action {
            MediaAction::Pause => {
                entry.decoder.set_paused(true);
                Ok(())
            }
            MediaAction::Resume => {
                entry.decoder.set_paused(false);
                Ok(())
            }
            MediaAction::Seek { ms } => {
                let now = Instant::now();
                let mut opts = entry.opts;
                opts.start_ms = *ms;
                self.restart_entry(path, entry, opts, now);
                Ok(())
            }
        }
    }

    /// Drain decoder lifecycle events from every entry, applying their
    /// entry-side effects (freeze-on-end, tombstone-and-retry-later on
    /// failure). The runtime converts the returned events into `EngineEvent`s
    /// for the console.
    pub fn poll_events(&self) -> Vec<DecoderEvent> {
        let mut out = Vec::new();
        let now = Instant::now();
        let mut entries = self.entries.lock();
        for (path, entry) in entries.iter_mut() {
            while let Ok(event) = entry.events.lock().try_recv() {
                if let DecoderEvent::Failed(_, _) = &event {
                    entry.decoder.slot().clear();
                    entry.failed_at = Some(now);
                }
                // Ended: freeze on the last frame; no automatic retry.
                out.push(event);
            }
            let _ = path;
        }
        out
    }

    /// Stop every decoder (shutdown path).
    pub fn shutdown(&self) {
        let mut entries = self.entries.lock();
        for (_, entry) in entries.drain() {
            entry.decoder.stop();
        }
    }
}

// ---------------------------------------------------------------------------
// Frame walking
// ---------------------------------------------------------------------------

/// Collect every video path + playback options a resolved frame references
/// (background, live/staged/scene item, scene zones). First occurrence wins so
/// multiple zones referencing the same asset share one decoder.
pub fn collect_video_refs(frame: &ProgramFrame) -> Vec<(String, VideoOpts)> {
    let mut refs: Vec<(String, VideoOpts)> = Vec::new();
    let mut push = |path: &str, opts: VideoOpts| {
        if !path.trim().is_empty() && !refs.iter().any(|(p, _)| p == path) {
            refs.push((path.to_string(), opts));
        }
    };

    for layer in &frame.layers {
        match layer {
            ProgramLayer::Background { setting: BackgroundSetting::Video(v) } => push(
                &v.path,
                VideoOpts {
                    loop_playback: v.loop_video,
                    playback_rate: v.playback_rate as f64,
                    start_ms: 0,
                },
            ),
            ProgramLayer::Item { item: crate::store::DisplayItem::Media(m) }
                if matches!(m.media_type, crate::store::MediaItemType::Video) =>
            {
                push(
                    &m.path,
                    VideoOpts {
                        loop_playback: m.loop_playback,
                        playback_rate: m.playback_rate,
                        start_ms: 0,
                    },
                );
            }
            ProgramLayer::Zone { zone } => {
                if let crate::store::DisplayItem::Media(m) = &zone.item {
                    if matches!(m.media_type, crate::store::MediaItemType::Video) {
                        push(
                            &m.path,
                            VideoOpts {
                                loop_playback: m.loop_playback,
                                playback_rate: m.playback_rate,
                                start_ms: 0,
                            },
                        );
                    }
                }
            }
            _ => {}
        }
    }
    refs
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    // -- pure helpers -------------------------------------------------------

    #[test]
    fn parse_probe_output_handles_fractional_rates() {
        let info = parse_probe_output("1920,1080,30000/1001\n").expect("parses");
        assert_eq!(info.width, 1920);
        assert_eq!(info.height, 1080);
        assert!((info.fps - 29.97).abs() < 0.01);

        let plain = parse_probe_output("640,360,25/1").expect("parses");
        assert_eq!(plain.fps, 25.0);

        assert!(parse_probe_output("garbage").is_none());
        assert!(parse_probe_output("0,0,30/1").is_none());
    }

    #[test]
    fn fit_dimensions_never_upscales_and_rounds_even() {
        assert_eq!(fit_dimensions(3840, 2160, 1920, 1080), (1920, 1080));
        assert_eq!(fit_dimensions(1280, 720, 1920, 1080), (1280, 720));
        assert_eq!(fit_dimensions(853, 480, 1920, 1080), (852, 480));
        assert_eq!(fit_dimensions(100, 50, 1920, 1080), (100, 50));
    }

    #[test]
    fn decoder_command_maps_loop_seek_and_rate() {
        let dir = std::env::temp_dir();
        let input = dir.join("clip.mp4");

        let plain = decoder_command(
            Path::new("ffmpeg"),
            &input,
            &VideoOpts { loop_playback: false, playback_rate: 1.0, start_ms: 0 },
            640,
            360,
        );
        let joined = format!("{:?}", plain);
        assert!(!joined.contains("-stream_loop"));
        assert!(!joined.contains("-ss"));
        assert!(joined.contains("setpts=PTS/1.000000"));
        assert!(joined.contains("scale=640:360"));

        let opts = VideoOpts { loop_playback: true, playback_rate: 2.0, start_ms: 1500 };
        let customized = decoder_command(Path::new("ffmpeg"), &input, &opts, 640, 360);
        let joined = format!("{:?}", customized);
        assert!(joined.contains("-stream_loop"));
        assert!(joined.contains("\"-ss\" \"1.500\""));
        assert!(joined.contains("setpts=PTS/2.000000"));
        // Audio is always excluded.
        assert!(joined.contains("-an"));
    }

    #[test]
    fn resolve_media_path_joins_media_dir_for_relative_paths() {
        let base = PathBuf::from("C:\\appdata");
        assert_eq!(
            resolve_media_path(&base, "clip.mp4"),
            base.join("media").join("clip.mp4")
        );
        assert_eq!(
            resolve_media_path(&base, "C:\\elsewhere\\clip.mp4"),
            PathBuf::from("C:\\elsewhere\\clip.mp4")
        );
    }

    // -- slot ---------------------------------------------------------------

    #[test]
    fn frame_slot_keeps_only_the_latest_complete_frame() {
        let slot = Arc::new(FrameSlot::default());
        assert!(slot.get().is_none());
        slot.set(VideoFrame { width: 2, height: 2, rgba: Arc::new(vec![1; 16]) });
        slot.set(VideoFrame { width: 2, height: 2, rgba: Arc::new(vec![2; 16]) });
        let latest = slot.get().expect("has frame");
        assert_eq!(latest.rgba[0], 2);
        slot.clear();
        assert!(slot.get().is_none());
    }

    // -- hub lifecycle (fake spawner) ----------------------------------------

    type SpawnLog = Arc<(AtomicUsize, Mutex<Vec<(String, VideoOpts)>>)>;

    fn fake_spawner(log: SpawnLog, fail_paths: Vec<String>) -> DecoderSpawner {
        Arc::new(move |path, opts, slot| {
            log.0.fetch_add(1, Ordering::SeqCst);
            log.1.lock().push((path.to_string(), *opts));
            if fail_paths.iter().any(|p| p == path) {
                return Err(format!("broken: {path}"));
            }
            // A real decoder reports Ended naturally; the fake never does, so
            // tests drive lifecycle purely through sync/control.
            let (tx, rx) = mpsc::channel();
            let _ = slot;
            Ok((
                VideoDecoderHandle {
                    shared: Arc::new(DecoderShared {
                        slot: Arc::new(FrameSlot::default()),
                        paused: AtomicBool::new(false),
                        killed: AtomicBool::new(false),
                        child: Mutex::new(None),
                        events_tx: tx,
                    }),
                },
                rx,
            ))
        })
    }

    fn opts(loop_: bool, rate: f64) -> VideoOpts {
        VideoOpts { loop_playback: loop_, playback_rate: rate, start_ms: 0 }
    }

    #[test]
    fn hub_spawns_one_decoder_per_referenced_path_and_sweeps_after_linger() {
        let log: SpawnLog = Arc::new((AtomicUsize::new(0), Mutex::new(Vec::new())));
        let hub = MediaFrameHub::with_timings(fake_spawner(Arc::clone(&log), vec![]), Duration::from_millis(30), Duration::from_millis(10));

        let refs = vec![
            ("a.mp4".to_string(), opts(true, 1.0)),
            ("b.mp4".to_string(), opts(false, 1.0)),
        ];
        hub.sync(&refs);
        hub.sync(&refs);
        assert_eq!(log.0.load(Ordering::SeqCst), 2, "one spawn per path, no churn");
        assert!(hub.latest("a.mp4").is_none(), "fake produces no frames");

        // Unreferenced past the linger window → swept (stopped + removed).
        std::thread::sleep(Duration::from_millis(45));
        hub.sync(&[]);
        assert!(hub.latest("a.mp4").is_none());

        // Referenced again → both respawn.
        hub.sync(&refs);
        assert_eq!(log.0.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn hub_restarts_when_options_change_preserving_the_slot() {
        let log: SpawnLog = Arc::new((AtomicUsize::new(0), Mutex::new(Vec::new())));
        let hub = MediaFrameHub::with_timings(fake_spawner(Arc::clone(&log), vec![]), Duration::from_secs(30), Duration::from_millis(10));

        hub.sync(&[("a.mp4".to_string(), opts(true, 1.0))]);
        // Pausing is a runtime flag (no restart); seeking restarts the decoder
        // at the new position.
        hub.control("a.mp4", &MediaAction::Pause).unwrap();
        hub.sync(&[("a.mp4".to_string(), opts(true, 1.0))]);
        hub.control("a.mp4", &MediaAction::Seek { ms: 5000 }).unwrap();

        let spawns = log.1.lock();
        assert_eq!(spawns.len(), 2, "initial + seek restart");
        assert_eq!(spawns[1].1.start_ms, 5000);
        assert!(spawns[1].1.loop_playback);
    }

    #[test]
    fn hub_tombstones_failures_and_retries_after_cooldown() {
        let log: SpawnLog = Arc::new((AtomicUsize::new(0), Mutex::new(Vec::new())));
        let hub = MediaFrameHub::with_timings(
            fake_spawner(Arc::clone(&log), vec!["bad.mp4".to_string()]),
            Duration::from_secs(30),
            Duration::from_millis(20),
        );

        hub.sync(&[("bad.mp4".to_string(), opts(true, 1.0))]);
        hub.sync(&[("bad.mp4".to_string(), opts(true, 1.0))]);
        assert_eq!(log.0.load(Ordering::SeqCst), 1, "failure tombstones — no per-tick respawn spam");
        assert!(hub.latest("bad.mp4").is_none());

        let events = hub.poll_events();
        assert!(events.iter().any(|e| matches!(e, DecoderEvent::Failed(p, _) if p == "bad.mp4")));

        std::thread::sleep(Duration::from_millis(25));
        hub.sync(&[("bad.mp4".to_string(), opts(true, 1.0))]);
        assert_eq!(log.0.load(Ordering::SeqCst), 2, "retried after the cooldown");
    }

    #[test]
    fn poll_events_clears_the_slot_on_failure_but_freezes_on_end() {
        let log: SpawnLog = Arc::new((AtomicUsize::new(0), Mutex::new(Vec::new())));
        let hub = MediaFrameHub::with_timings(fake_spawner(Arc::clone(&log), vec![]), Duration::from_secs(30), Duration::from_millis(10));

        hub.sync(&[("a.mp4".to_string(), opts(true, 1.0))]);
        // Simulate a decoder that produced frames then hit its (non-loop) end.
        {
            let entries = hub.entries.lock();
            let entry = entries.get("a.mp4").unwrap();
            entry.decoder.shared.slot.set(VideoFrame { width: 2, height: 2, rgba: Arc::new(vec![9; 16]) });
            let _ = entry.decoder.shared.events_tx.send(DecoderEvent::Ended("a.mp4".into()));
        }
        let events = hub.poll_events();
        assert!(events.iter().any(|e| matches!(e, DecoderEvent::Ended(p) if p == "a.mp4")));
        assert!(hub.latest("a.mp4").is_some(), "ended playback freezes on the last frame");

        // A failure clears the slot so the renderer falls back to the panel.
        {
            let entries = hub.entries.lock();
            let entry = entries.get("a.mp4").unwrap();
            let _ = entry.decoder.shared.events_tx.send(DecoderEvent::Failed("a.mp4".into(), "boom".into()));
        }
        let _ = hub.poll_events();
        assert!(hub.latest("a.mp4").is_none());
    }

    #[test]
    fn control_errors_for_unknown_paths() {
        let log: SpawnLog = Arc::new((AtomicUsize::new(0), Mutex::new(Vec::new())));
        let hub = MediaFrameHub::with_timings(fake_spawner(Arc::clone(&log), vec![]), Duration::from_secs(30), Duration::from_millis(10));
        assert!(hub.control("nope.mp4", &MediaAction::Pause).is_err());
    }

    // -- frame walking -------------------------------------------------------

    #[test]
    fn collect_video_refs_walks_background_item_and_zones() {
        use crate::store::{DisplayItem, MediaItem, MediaItemType, SceneZone, VideoBackground};
        let media_item = |path: &str| MediaItem {
            id: "m1".into(),
            name: "clip".into(),
            path: path.into(),
            media_type: MediaItemType::Video,
            thumbnail_path: None,
            fit_mode: "contain".into(),
            tags: vec![],
            description: None,
            category: None,
            duration: None,
            width: None,
            height: None,
            content_hash: None,
            loop_playback: false,
            playback_rate: 1.5,
            volume: 1.0,
        };
        let frame = ProgramFrame {
            revision: 1,
            timestamp: 0,
            canvas: super::super::frame::CanvasGeometry { width: 320, height: 180, fps: 30 },
            source: super::super::frame::ResolvedOutputSource::Live { item: None },
            layers: vec![
                ProgramLayer::Blank,
                ProgramLayer::Background {
                    setting: BackgroundSetting::Video(VideoBackground {
                        path: "bg.mp4".into(),
                        loop_video: false,
                        muted: true,
                        object_fit: "cover".into(),
                        opacity: 1.0,
                        playback_rate: 0.5,
                    }),
                },
                ProgramLayer::Item { item: DisplayItem::Media(media_item("item.mp4")) },
                ProgramLayer::Zone {
                    zone: SceneZone {
                        id: "z".into(),
                        item: DisplayItem::Media(media_item("zone.mp4")),
                        source: None,
                        x: 0.0,
                        y: 0.0,
                        w: 1.0,
                        h: 1.0,
                        fit: "contain".into(),
                        opacity: 1.0,
                        z: 0,
                        muted: None,
                        label: None,
                        font_size: None,
                        font_family: None,
                    },
                },
                ProgramLayer::Waiting,
            ],
            background: crate::engine::compositor::frame::ResolvedBackground {
                setting: BackgroundSetting::None,
                fallback: "#000000".into(),
            },
            overlays: crate::engine::compositor::frame::ProgramOverlays {
                props: vec![],
                lower_third: None,
                logo: None,
            },
            blackout: false,
            missing: vec![],
            audio: crate::engine::compositor::frame::AudioProgramDescriptor::None,
            settings: crate::store::PresentationSettings::default(),
            colors: crate::engine::compositor::frame::ThemeColors {
                background: "#000000".into(),
                verse_text: "#ffffff".into(),
                reference_text: "#f59e0b".into(),
                waiting_text: "#3f3f46".into(),
            },
            reference_output_height: 180,
            now: 0,
            app_data_dir: None,
        };

        let refs = collect_video_refs(&frame);
        let paths: Vec<&str> = refs.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, vec!["bg.mp4", "item.mp4", "zone.mp4"]);
        assert_eq!(refs[0].1, VideoOpts { loop_playback: false, playback_rate: 0.5, start_ms: 0 });
        assert_eq!(refs[1].1, VideoOpts { loop_playback: false, playback_rate: 1.5, start_ms: 0 });
    }

    // -- real-ffmpeg integration (opt-in) ------------------------------------

    /// Locate a media binary for integration tests: the repo's fetched
    /// `src-tauri/binaries/{name}.exe` when present, otherwise the bare name
    /// for a PATH lookup (`binpaths::init()` never runs under `cargo test`).
    fn find_media_bin(name: &str) -> PathBuf {
        let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
        let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(&exe);
        if bundled.exists() {
            bundled
        } else {
            PathBuf::from(exe)
        }
    }

    /// End-to-end: a real ffmpeg decodes a lavfi-generated clip through the
    /// hub and publishes paced RGBA frames. Requires ffmpeg (bundled in
    /// `src-tauri/binaries` or on PATH); run with `cargo test -- --ignored`.
    #[test]
    #[ignore = "requires ffmpeg (bundled or on PATH)"]
    fn real_ffmpeg_decodes_lavfi_clip_through_the_hub() {
        let base = std::env::temp_dir().join(format!("wordlyte-media-it-{}", std::process::id()));
        let media_dir = base.join("media");
        std::fs::create_dir_all(&media_dir).unwrap();
        let clip = media_dir.join("clip.mp4");

        let ffmpeg = find_media_bin("ffmpeg");
        let status = std::process::Command::new(&ffmpeg)
            .args([
                "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=c=red:size=64x64:rate=10:duration=1",
                "-pix_fmt", "yuv420p",
                clip.to_str().expect("non-utf8 temp path"),
            ])
            .status()
            .expect("run ffmpeg");
        assert!(status.success(), "lavfi clip generation failed");

        let hub = MediaFrameHub::new(default_spawner(
            base.clone(),
            ffmpeg,
            find_media_bin("ffprobe"),
        ));
        hub.sync(&[("clip.mp4".to_string(), VideoOpts { loop_playback: false, playback_rate: 1.0, start_ms: 0 })]);

        let mut got = None;
        for _ in 0..100 {
            if let Some(f) = hub.latest("clip.mp4") {
                got = Some(f);
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        hub.shutdown();
        let frame = got.expect("decoder produced frames within 5s");
        assert_eq!((frame.width, frame.height), (64, 64));
        assert!(
            frame.rgba[0] > 180 && frame.rgba[1] < 80 && frame.rgba[2] < 80,
            "first pixel should be red, got {:?}", &frame.rgba[0..4]
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
