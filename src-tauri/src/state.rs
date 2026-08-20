use crate::engine::backend::EngineBackend;
use crate::remote::protocol::RemoteEventKind;
use crate::remote::RemoteControl;
use crate::store;
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Clone)]
pub struct PresentationState {
    pub live_item: Arc<Mutex<Option<store::DisplayItem>>>,
    /// The item that occupied the live slot immediately before the current one
    /// (captured when a new item takes live). Mirrors the operator console's
    /// `previousItem` so a reopened window hydrates it too.
    pub previous_item: Arc<Mutex<Option<store::DisplayItem>>>,
    pub staged_item: Arc<Mutex<Option<store::DisplayItem>>>,
    pub settings: Arc<Mutex<store::PresentationSettings>>,
    pub lower_third: Arc<Mutex<Option<serde_json::Value>>>,
    pub props_layer: Arc<Mutex<Vec<store::PropItem>>>,
    /// Serializes whole presentation mutations (stage, commit, send-live,
    /// clear) so desktop and remote callers can never interleave two
    /// operations mid-transaction. All mutating `op_*` helpers take this
    /// lock first, then the per-slot locks, so ordering stays consistent.
    pub lock: Arc<Mutex<()>>,
    /// Monotonic presentation revision, incremented on every mutation. Windows
    /// use it to order a hydration snapshot against live events so stale state
    /// can never overwrite a newer transition.
    pub revision: Arc<AtomicU64>,
    /// Unix ms of the last presentation mutation (for `updated_at` on the
    /// snapshot). Written under the presentation lock alongside `revision`.
    pub last_updated: Arc<Mutex<u64>>,
}

impl PresentationState {
    pub fn new(settings: store::PresentationSettings) -> Self {
        Self {
            live_item: Arc::new(Mutex::new(None)),
            previous_item: Arc::new(Mutex::new(None)),
            staged_item: Arc::new(Mutex::new(None)),
            settings: Arc::new(Mutex::new(settings)),
            lower_third: Arc::new(Mutex::new(None)),
            props_layer: Arc::new(Mutex::new(Vec::new())),
            lock: Arc::new(Mutex::new(())),
            revision: Arc::new(AtomicU64::new(0)),
            last_updated: Arc::new(Mutex::new(0)),
        }
    }

    /// Increments and returns the next presentation revision and stamps the
    /// mutation time (called by every `op_*` under the presentation lock).
    pub fn bump_revision(&self) -> u64 {
        let rev = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        *self.last_updated.lock() = crate::engine::now_ms();
        rev
    }

    pub fn current_revision(&self) -> u64 {
        self.revision.load(Ordering::SeqCst)
    }

    /// Overwrites the presentation revision without bumping (used by the engine
    /// sidecar's `SyncPresentation` to adopt the console's revision so the two
    /// hosts agree on event ordering after a full-state sync).
    pub fn set_revision(&self, rev: u64) {
        self.revision.store(rev, Ordering::SeqCst);
    }
}

#[derive(Clone)]
pub struct AppState {
    pub presentation: PresentationState,
    pub store: Arc<store::BibleStore>,
    pub media_schedule: Arc<store::MediaScheduleStore>,
    pub app_data_dir: PathBuf,
    pub download_in_progress: Arc<AtomicBool>,
    /// Non-fatal startup problems the operator must see (e.g. the data database
    /// could not be opened and an in-memory fallback is in use). Surfaced via
    /// `get_startup_status` -> the operator banner.
    pub startup_issues: Arc<Mutex<Vec<String>>>,
    /// Remote Control server state — an Arc so Tauri state, the axum task and
    /// display commands all share one instance.
    pub remote: Arc<RemoteControl>,
    /// Configurable output surfaces (projection, stage, recorder, streamer).
    pub outputs: Arc<crate::outputs::OutputManager>,
    /// Active RTMP ingest session (ffmpeg child + writer channel). `None` when
    /// idle. Guarded by a mutex so the frontend can start/send/stop atomically.
    pub rtmp: Arc<Mutex<std::collections::HashMap<String, crate::commands::rtmp::RtmpSession>>>,
    /// Persistent `sysinfo::System` for CPU metrics. sysinfo only computes
    /// usage as a delta against a prior snapshot, so the Diagnostics poll
    /// reuses one instance across `system_metrics` calls instead of creating a
    /// fresh one each time (which reports cumulative-usage ≈ 100% and sticks).
    pub cpu_sampler: Arc<Mutex<Option<sysinfo::System>>>,
    /// License manager: machine fingerprint, persisted license record, and
    /// online validation against the Cloudflare Worker.
    pub license: Arc<crate::license::LicenseManager>,
    /// Spawned engine sidecar client (Phase A2). `None` when the sidecar is
    /// unavailable (missing binary) or during startup. The console's display
    /// commands still run locally until the Phase A rewiring.
    pub engine: Arc<Mutex<Option<crate::engine::client::EngineClient>>>,
}

impl EngineBackend for AppState {
    fn presentation(&self) -> &PresentationState {
        &self.presentation
    }

    fn app_data_dir(&self) -> &Path {
        &self.app_data_dir
    }

    fn load_settings(&self) -> Result<store::PresentationSettings, String> {
        self.media_schedule.load_settings().map_err(|e| e.to_string())
    }

    fn save_settings(&self, settings: &store::PresentationSettings) -> Result<(), String> {
        self.media_schedule.save_settings(settings).map_err(|e| e.to_string())
    }

    fn save_props(&self, props: &[store::PropItem]) -> Result<(), String> {
        self.media_schedule.save_props(props).map_err(|e| e.to_string())
    }

    fn load_props(&self) -> Result<Vec<store::PropItem>, String> {
        self.media_schedule.load_props().map_err(|e| e.to_string())
    }

    fn list_scenes(&self) -> Result<Vec<store::Scene>, String> {
        self.media_schedule.list_scenes().map_err(|e| e.to_string())
    }

    fn publish_remote(&self, kind: RemoteEventKind, payload: serde_json::Value, source: Option<String>) {
        self.remote.hub.publish(kind, payload, source);
    }
}