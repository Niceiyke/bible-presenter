//! In-engine video decode (ffmpeg-next in-process).
//!
//! The compositor's video arms sample the latest decoded RGBA frame for a
//! playing asset through a [`MediaFrameHub`] instead of loading static bytes.
//! One decoder runs per referenced asset regardless of how many surfaces consume
//! it (output window, stage window, transport capture), keyed by the asset's
//! persisted (relativized) path. ffmpeg-next is the only backend — the
//! `ffmpeg.exe` pipe fallback has been removed (`default = ["ffmpeg-next"]`).

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use super::frame::{ProgramFrame, ProgramLayer};
use crate::store::BackgroundSetting;

/// Decode-output cap: sources larger than this are downscaled by the scale
/// filter so the RGBA bandwidth stays bounded (~250 MB/s worst case).
pub const MAX_VIDEO_WIDTH: u32 = 1920;
pub const MAX_VIDEO_HEIGHT: u32 = 1080;

/// How long an unreferenced decoder lingers before it is stopped (render
/// surfaces re-sync every tick, so brief resolution gaps don't churn decoders).
const DEFAULT_LINGER: Duration = Duration::from_secs(3);
/// Base cooldown before retrying a decoder whose spawn or decode failed. Each
/// consecutive failure doubles the wait (see [`MediaFrameHub::backoff_for`]).
const DEFAULT_RETRY_AFTER: Duration = Duration::from_secs(5);
/// Ceiling for the failure backoff: a persistently broken source (unplugged
/// camera, missing file) retries at most every minute instead of hammering
/// ffmpeg with spawn attempts.
const DEFAULT_RETRY_CAP: Duration = Duration::from_secs(60);

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

    pub(crate) fn clamped_rate(&self) -> f64 {
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
    paused: Arc<AtomicBool>,
    killed: Arc<AtomicBool>,
    child: Mutex<Option<Child>>,
    events_tx: mpsc::Sender<DecoderEvent>,
}

impl Drop for DecoderShared {
    fn drop(&mut self) {
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

/// Create a `VideoDecoderHandle` for an in-process (ffmpeg-next) decoder.
/// No `Child` — `stop()` just sets `killed` so the decode thread exits and
/// `poll_events` drains `Ended`/`Failed`.
pub fn make_in_process_handle(
    slot: Arc<FrameSlot>,
    events_rx: mpsc::Receiver<DecoderEvent>,
    events_tx: mpsc::Sender<DecoderEvent>,
    killed: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
) -> (VideoDecoderHandle, mpsc::Receiver<DecoderEvent>) {
    let handle = VideoDecoderHandle {
        shared: Arc::new(DecoderShared {
            slot,
            paused: Arc::clone(&paused),
            killed: Arc::clone(&killed),
            child: Mutex::new(None),
            events_tx,
        }),
    };
    (handle, events_rx)
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

    /// Stop the decoder: sets `killed` (and kills child if any). Idempotent.
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
                    paused: Arc::new(AtomicBool::new(false)),
                    killed: Arc::new(AtomicBool::new(true)),
                    child: Mutex::new(None),
                    events_tx: tx,
                }),
            },
            rx,
        )
    }
}

// ---------------------------------------------------------------------------
// Probing + geometry (pure, unit-tested)
// ---------------------------------------------------------------------------

/// Probed source geometry: dimensions plus the frame rate used for pacing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SourceInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
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

/// Production spawner: in-process ffmpeg-next (HW decode, no pipe).
pub fn default_spawner(app_data_dir: PathBuf, _ffmpeg: PathBuf, _ffprobe: PathBuf) -> DecoderSpawner {
    let _ = crate::engine::ffmpeg::init();
    crate::engine::ffmpeg::decode::ffmpeg_file_spawner(app_data_dir)
}

// ---------------------------------------------------------------------------
// Camera capture (Phase I1) — same hub, different producer
// ---------------------------------------------------------------------------

/// Default engine-side camera profile: 720p30 (the webview registry's preview
/// balance). Quality is encoded in the hub key so a future 1080p program
/// profile can coexist per consumer class.
pub const CAMERA_CAPTURE_WIDTH: u32 = 1280;
pub const CAMERA_CAPTURE_HEIGHT: u32 = 720;
pub const CAMERA_CAPTURE_FPS: f64 = 30.0;

/// Hub key for one live capture: `cam:{device}@{w}x{h}@{fps}`. The `@WxH@fps`
/// suffix keeps the dual-quality trick from the webview source registry.
pub fn format_camera_key(device: &str, w: u32, h: u32, fps: f64) -> String {
    format!("cam:{device}@{w}x{h}@{}", fps.round().max(1.0) as u32)
}

/// The I1 default profile for a device id.
pub fn camera_key_for_device(device_id: &str) -> String {
    format_camera_key(
        device_id,
        CAMERA_CAPTURE_WIDTH,
        CAMERA_CAPTURE_HEIGHT,
        CAMERA_CAPTURE_FPS,
    )
}

/// Parse a camera hub key. Parsed from the RIGHT so device names may contain
/// `@` and `x`.
pub fn parse_camera_key(key: &str) -> Option<(String, u32, u32, f64)> {
    let rest = key.strip_prefix("cam:")?;
    let (head, fps) = rest.rsplit_once('@')?;
    let fps: f64 = fps.parse().ok()?;
    let (device, geom) = head.rsplit_once('@')?;
    let (w, h) = geom.split_once('x')?;
    let (w, h): (u32, u32) = (w.parse().ok()?, h.parse().ok()?);
    if device.is_empty() || w == 0 || h == 0 || fps <= 0.0 {
        return None;
    }
    Some((device.to_string(), w, h, fps))
}

/// Spawner for `cam:` keys: libavdevice/dshow in-process.
pub fn camera_spawner(_ffmpeg: PathBuf) -> DecoderSpawner {
    crate::engine::ffmpeg::capture::ffmpeg_camera_spawner()
}

/// Production source spawner (Phase I1): `cam:` keys go to dshow capture,
/// everything else is a persisted media path decoded from disk. One hub, one
/// lifecycle — the hub never knows which producer answered.
pub fn default_source_spawner(app_data_dir: PathBuf, _ffmpeg: PathBuf, _ffprobe: PathBuf) -> DecoderSpawner {
    let _ = crate::engine::ffmpeg::init();
    crate::engine::ffmpeg::capture::ffmpeg_source_spawner(app_data_dir)
}

/// In-process spawner entry-point for `ffmpeg-next` builds.
pub fn default_source_spawner_ffmpeg(app_data_dir: PathBuf) -> DecoderSpawner {
    let _ = crate::engine::ffmpeg::init();
    crate::engine::ffmpeg::capture::ffmpeg_source_spawner(app_data_dir)
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
    /// Consecutive failures without a successful frame — drives the
    /// exponential respawn backoff (reset on any successful spawn).
    fail_streak: u32,
}

/// Registry of running video decoders, keyed by persisted media path or
/// camera capture key. Owned by the engine runtime and shared (Arc) with every
/// render surface.
///
/// Contract: ONE decoder per key no matter how many surfaces consume it;
/// surfaces call [`MediaFrameHub::sync`] each rendered tick with the keys
/// their resolved frame references, and pull pixels via [`MediaFrameHub::latest`].
/// Pinned keys ([`MediaFrameHub::pin`], Phase I1 `capture_start`) run even when
/// no frame references them. Lock order is ALWAYS `pinned` → `entries`.
pub struct MediaFrameHub {
    entries: Mutex<HashMap<String, HubEntry>>,
    /// Operator-pinned captures (Phase I1): unioned into every sync so render
    /// paths stay dumb about pre-warmed devices.
    pinned: Mutex<HashMap<String, VideoOpts>>,
    spawner: DecoderSpawner,
    linger: Duration,
    retry_after: Duration,
    retry_cap: Duration,
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
        Self::with_timings_full(spawner, linger, retry_after, DEFAULT_RETRY_CAP)
    }

    /// Hub with explicit lifecycle timings including the backoff ceiling.
    pub fn with_timings_full(
        spawner: DecoderSpawner,
        linger: Duration,
        retry_after: Duration,
        retry_cap: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            pinned: Mutex::new(HashMap::new()),
            spawner,
            linger,
            retry_after,
            retry_cap,
        })
    }

    /// Respawn cooldown after `streak` consecutive failures: base wait doubled
    /// each time, capped so a dead source retries at most once a minute.
    fn backoff_for(&self, streak: u32) -> Duration {
        let mult = 1u64 << streak.saturating_sub(1).min(16);
        self.retry_after
            .saturating_mul(mult as u32)
            .min(self.retry_cap)
    }

    /// Per-tick lifecycle sync from a render surface: marks every referenced
    /// key seen, spawns missing decoders, restarts decoders whose options
    /// changed, retries tombstoned failures after the cooldown, and sweeps
    /// entries nothing has referenced for longer than the linger window.
    /// Pinned captures count as referenced even when `refs` omits them.
    pub fn sync(&self, refs: &[(String, VideoOpts)]) {
        let mut all: Vec<(String, VideoOpts)> = {
            let pinned = self.pinned.lock();
            pinned.iter().map(|(k, o)| (k.clone(), *o)).collect()
        };
        for (path, opts) in refs {
            if !all.iter().any(|(p, _)| p == path) {
                all.push((path.clone(), *opts));
            }
        }
        self.sync_unioned(&all);
    }

    /// Pin one capture key so it runs even when no program frame references
    /// it (`capture_start`). Idempotent; spawns immediately.
    pub fn pin(&self, key: String, opts: VideoOpts) {
        self.pinned.lock().insert(key, opts);
        self.sync(&[]);
    }

    /// Release a pin (`capture_stop`). The decoder keeps running until the
    /// linger window passes without a referencing sync — unless the live
    /// program still references the key, in which case it never stops.
    pub fn unpin(&self, key: &str) {
        self.pinned.lock().remove(key);
        self.sync(&[]);
    }

    /// Which camera captures exist and whether each currently has a live
    /// decoder: pinned keys first-class, plus program-referenced `cam:` keys.
    pub fn capture_status(&self) -> Vec<(String, bool)> {
        let pinned = self.pinned.lock();
        let entries = self.entries.lock();
        let mut out: Vec<(String, bool)> = Vec::with_capacity(pinned.len());
        for key in pinned.keys() {
            let live = entries
                .get(key)
                .map(|e| e.failed_at.is_none() && !e.decoder.is_stopped())
                .unwrap_or(false);
            out.push((key.clone(), live));
        }
        for (path, entry) in entries.iter() {
            if path.starts_with("cam:") && !pinned.contains_key(path) {
                let live = entry.failed_at.is_none() && !entry.decoder.is_stopped();
                out.push((path.clone(), live));
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    fn sync_unioned(&self, refs: &[(String, VideoOpts)]) {
        let now = Instant::now();
        let mut entries = self.entries.lock();

        for (path, opts) in refs {
            match entries.get_mut(path) {
                Some(entry) => {
                    entry.last_seen = now;
                    if opts.differs_from(&entry.opts) {
                        self.restart_entry(path, entry, *opts, now);
                    } else if entry.decoder.is_stopped()
                        && entry
                            .failed_at
                            .map(|t| now.duration_since(t) >= self.backoff_for(entry.fail_streak))
                            .unwrap_or(false)
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
                        fail_streak: 0,
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
                entry.fail_streak = 0;
            }
            Err(reason) => {
                let (dead, dead_rx) = VideoDecoderHandle::dead();
                dead.emit(DecoderEvent::Failed(path.to_string(), reason));
                entry.decoder = dead;
                entry.events = Mutex::new(dead_rx);
                entry.opts = opts;
                entry.failed_at = Some(now);
                // fail_streak is incremented when poll_events drains the Failed
                // event above — every failure counts exactly once.
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
                entry.fail_streak = 0;
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
                    // The decoder ran and died — count it toward the backoff so
                    // a persistently broken source stops respawning every tick.
                    entry.fail_streak += 1;
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
/// multiple zones referencing the same asset share one decoder. Camera items /
/// backgrounds / zones emit `cam:` keys so live captures ride the same hub.
pub fn collect_video_refs(frame: &ProgramFrame) -> Vec<(String, VideoOpts)> {
    let mut refs: Vec<(String, VideoOpts)> = Vec::new();
    let mut push = |path: &str, opts: VideoOpts| {
        if !path.trim().is_empty() && !refs.iter().any(|(p, _)| p == path) {
            refs.push((path.to_string(), opts));
        }
    };
    let camera_opts = VideoOpts { loop_playback: true, playback_rate: 1.0, start_ms: 0 };

    for layer in &frame.layers {
        match layer {
            ProgramLayer::Background { setting } => match setting {
                BackgroundSetting::Video(v) => push(
                    &v.path,
                    VideoOpts {
                        loop_playback: v.loop_video,
                        playback_rate: v.playback_rate as f64,
                        start_ms: 0,
                    },
                ),
                BackgroundSetting::Camera(cb) => {
                    push(&camera_key_for_device(&cb.device_id), camera_opts);
                }
                _ => {}
            },
            ProgramLayer::Item { item } => match item {
                crate::store::DisplayItem::Media(m)
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
                crate::store::DisplayItem::Camera(c) => {
                    push(&camera_key_for_device(&c.device_id), camera_opts);
                }
                _ => {}
            },
            ProgramLayer::Zone { zone } => match &zone.item {
                crate::store::DisplayItem::Media(m)
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
                crate::store::DisplayItem::Camera(c) => {
                    push(&camera_key_for_device(&c.device_id), camera_opts);
                }
                _ => {}
            },
            _ => {}
        }
    }
    refs
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn fit_dimensions_never_upscales_and_rounds_even() {
        assert_eq!(fit_dimensions(3840, 2160, 1920, 1080), (1920, 1080));
        assert_eq!(fit_dimensions(1280, 720, 1920, 1080), (1280, 720));
        assert_eq!(fit_dimensions(853, 480, 1920, 1080), (852, 480));
        assert_eq!(fit_dimensions(100, 50, 1920, 1080), (100, 50));
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

    #[test]
    fn camera_keys_round_trip_with_spaces_and_at_signs() {
        for device in ["HD Webcam", "Elgato Cam Link 4K", "Weird @ Device x2"] {
            let key = format_camera_key(device, 1280, 720, 30.0);
            let (parsed_device, w, h, fps) = parse_camera_key(&key).expect("parses");
            assert_eq!(parsed_device, device);
            assert_eq!((w, h), (1280, 720));
            assert_eq!(fps, 30.0);
        }
        let key = format_camera_key("cam", 640, 480, 29.97);
        assert!(key.ends_with("@30"));
        assert_eq!(parse_camera_key(&key).unwrap().3, 30.0);
    }

    #[test]
    fn camera_key_parsing_rejects_garbage() {
        assert!(parse_camera_key("clip.mp4").is_none());
        assert!(parse_camera_key("cam:").is_none());
        assert!(parse_camera_key("cam:dev@bogus").is_none());
        assert!(parse_camera_key("cam:dev@0x0@30").is_none());
        assert!(parse_camera_key("cam:dev@1280x720@0").is_none());
    }

    #[test]
    fn collect_video_refs_includes_camera_items_backgrounds_and_zones() {
        use crate::store::{CameraBackground, DisplayItem, SceneZone};
        let cam = |id: &str| {
            DisplayItem::Camera(CameraBackground {
                device_id: id.to_string(),
                opacity: 1.0,
                object_fit: "cover".to_string(),
                mirrored: false,
            })
        };
        let frame = ProgramFrame {
            revision: 1,
            timestamp: 0,
            canvas: crate::engine::compositor::frame::CanvasGeometry { width: 320, height: 180, fps: 30 },
            source: crate::engine::compositor::frame::ResolvedOutputSource::Live {
                item: Some(cam("cam-a")),
            },
            layers: vec![
                ProgramLayer::Background {
                    setting: BackgroundSetting::Camera(CameraBackground {
                        device_id: "cam-b".to_string(),
                        opacity: 1.0,
                        object_fit: "cover".to_string(),
                        mirrored: true,
                    }),
                },
                ProgramLayer::Item { item: cam("cam-a") },
                ProgramLayer::Zone {
                    zone: SceneZone {
                        id: "z".into(),
                        item: cam("cam-c"),
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
        let keys: Vec<&str> = refs.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            vec![
                camera_key_for_device("cam-b").as_str(),
                camera_key_for_device("cam-a").as_str(),
                camera_key_for_device("cam-c").as_str(),
            ]
        );
    }

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

    type SpawnLog = Arc<(AtomicUsize, Mutex<Vec<(String, VideoOpts)>>)>;
    fn fake_spawner(log: SpawnLog, fail_paths: Vec<String>) -> DecoderSpawner {
        Arc::new(move |path, opts, slot| {
            log.0.fetch_add(1, Ordering::SeqCst);
            log.1.lock().push((path.to_string(), *opts));
            if fail_paths.iter().any(|p| p == path) {
                return Err(format!("broken: {path}"));
            }
            let (tx, rx) = mpsc::channel();
            let _ = slot;
            Ok((
                VideoDecoderHandle {
                    shared: Arc::new(DecoderShared {
                        slot: Arc::new(FrameSlot::default()),
                        paused: Arc::new(AtomicBool::new(false)),
                        killed: Arc::new(AtomicBool::new(false)),
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
        std::thread::sleep(Duration::from_millis(45));
        hub.sync(&[]);
        assert!(hub.latest("a.mp4").is_none());
        hub.sync(&refs);
        assert_eq!(log.0.load(Ordering::SeqCst), 4);
    }
    #[test]
    fn hub_pin_keeps_a_capture_alive_without_frame_refs() {
        let log: SpawnLog = Arc::new((AtomicUsize::new(0), Mutex::new(Vec::new())));
        let hub = MediaFrameHub::with_timings(fake_spawner(Arc::clone(&log), vec![]), Duration::from_millis(30), Duration::from_millis(10));
        let key = camera_key_for_device("cam-x");
        hub.pin(key.clone(), opts(true, 1.0));
        assert_eq!(log.0.load(Ordering::SeqCst), 1, "pin spawns now");
        assert_eq!(hub.capture_status(), vec![(key.clone(), true)]);
        std::thread::sleep(Duration::from_millis(45));
        hub.sync(&[]);
        assert_eq!(hub.capture_status(), vec![(key.clone(), true)]);
        hub.unpin(&key);
        std::thread::sleep(Duration::from_millis(45));
        hub.sync(&[]);
        assert!(
            !hub.capture_status().iter().any(|(k, _)| *k == key),
            "unpinned capture swept after linger"
        );
    }
    #[test]
    fn hub_failure_backoff_doubles_and_caps() {
        let log: SpawnLog = Arc::new((AtomicUsize::new(0), Mutex::new(Vec::new())));
        let hub = MediaFrameHub::with_timings_full(
            fake_spawner(Arc::clone(&log), vec![]),
            Duration::from_secs(30),
            Duration::from_millis(10),
            Duration::from_millis(35),
        );
        assert_eq!(hub.backoff_for(0), Duration::from_millis(10));
        assert_eq!(hub.backoff_for(1), Duration::from_millis(10), "first failure waits the base");
        assert_eq!(hub.backoff_for(2), Duration::from_millis(20));
        assert_eq!(hub.backoff_for(3), Duration::from_millis(35), "capped");
        assert_eq!(hub.backoff_for(9), Duration::from_millis(35), "still capped");
    }
}
