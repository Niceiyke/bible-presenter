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
}