use crate::remote::RemoteControl;
use crate::store;
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[derive(Clone)]
pub struct PresentationState {
    pub live_item: Arc<Mutex<Option<store::DisplayItem>>>,
    pub staged_item: Arc<Mutex<Option<store::DisplayItem>>>,
    pub settings: Arc<Mutex<store::PresentationSettings>>,
    pub lower_third: Arc<Mutex<Option<serde_json::Value>>>,
    pub props_layer: Arc<Mutex<Vec<store::PropItem>>>,
}

#[derive(Clone)]
pub struct AppState {
    pub presentation: PresentationState,
    pub store: Arc<store::BibleStore>,
    pub media_schedule: Arc<store::MediaScheduleStore>,
    pub app_data_dir: PathBuf,
    pub download_in_progress: Arc<AtomicBool>,
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
}