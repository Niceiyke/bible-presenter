use crate::store::DisplayItem;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use parking_lot::RwLock;

/// A configurable output surface subscribing to a program source. Outputs never
/// mutate engine state — they only subscribe. Persisted to `outputs.json`
/// under the app data dir (operator hardware/preference state, not content).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputConfig {
    pub id: String,
    pub kind: OutputKind,
    pub label: String,
    pub enabled: bool,
    pub visible: bool,
    pub source: OutputSource,
    pub geometry: OutputGeometry,
    /// Recorder/streamer capture frame rate. Window outputs ignore it; when
    /// absent the frontend falls back to 30.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_fps: Option<u32>,
    pub presentation: Option<OutputPresentation>,
    pub overlays: OutputOverlays,
    /// Window-specific: Tauri window label this output binds to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_label: Option<String>,
    /// Recorder-specific.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording: Option<OutputRecording>,
    /// Streamer-specific.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub streaming: Option<OutputStreaming>,
    /// Streamer-specific: multi-destination hub config (one entry per platform).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_destinations: Option<Vec<StreamDestination>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OutputKind {
    Window,
    Recorder,
    Streamer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum OutputSource {
    Live,
    Staged,
    Scene { scene_id: String },
    Item { item: Box<DisplayItem> },
    Blank,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputPresentation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_output_height: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<crate::store::BackgroundSetting>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blanked: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputOverlays {
    pub props: bool,
    pub lower_third: bool,
    pub logo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputGeometry {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputRecording {
    pub format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputStreaming {
    pub mode: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_key: Option<String>,
}

/// One streaming destination in the multi-platform hub: a platform preset
/// (youtube / facebook / twitch / custom-rtmp / custom-whip) plus the resolved
/// ingest endpoint and whether it joins the master transport. Persisted with the
/// `stream-main` output; the operator edits these in the Streaming workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamDestination {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub mode: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_key: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub audio: bool,
}

fn default_true() -> bool {
    true
}

/// Ephemeral runtime status of an output (not persisted).
#[derive(Debug, Clone, Serialize)]
pub struct OutputState {
    pub id: String,
    pub visible: bool,
    pub rendering: bool,
    pub fps: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct OutputManager {
    pub configs: Arc<RwLock<Vec<OutputConfig>>>,
    pub runtime: Arc<RwLock<std::collections::HashMap<String, OutputState>>>,
    configs_file: PathBuf,
}

impl OutputManager {
    pub fn new(app_data_dir: &Path) -> Self {
        let configs_file = app_data_dir.join("outputs.json");
        let configs = Self::load(&configs_file).unwrap_or_else(|_| default_outputs());
        let mut runtime = std::collections::HashMap::new();
        for c in &configs {
            runtime.insert(
                c.id.clone(),
                OutputState {
                    id: c.id.clone(),
                    visible: c.visible,
                    rendering: c.enabled,
                    fps: 0,
                    error: None,
                },
            );
        }
        Self {
            configs: Arc::new(RwLock::new(configs)),
            runtime: Arc::new(RwLock::new(runtime)),
            configs_file,
        }
    }

    fn load(path: &Path) -> Result<Vec<OutputConfig>, String> {
        let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let mut configs: Vec<OutputConfig> =
            serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        // Merge any new default outputs (e.g. a future "overflow") into a
        // persisted set so forward migration is additive.
        let mut have: std::collections::HashSet<String> =
            configs.iter().map(|c| c.id.clone()).collect();
        for d in default_outputs() {
            if have.insert(d.id.clone()) {
                configs.push(d);
            }
        }
        Ok(configs)
    }

    pub fn persist(&self) -> Result<(), String> {
        let configs = self.configs.read().clone();
        let json = serde_json::to_string_pretty(&configs).map_err(|e| e.to_string())?;
        if let Some(dir) = self.configs_file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        // Atomic write: serialize to a temp file in the same directory then
        // rename over the target, so a crash mid-write can never leave a
        // truncated `outputs.json` that fails to parse on next launch
        // (audit: persistence must be crash-safe).
        let tmp = self.configs_file.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.configs_file).map_err(|e| e.to_string())
    }

    pub fn list(&self) -> Vec<OutputConfig> {
        self.configs.read().clone()
    }

    pub fn get(&self, id: &str) -> Option<OutputConfig> {
        self.configs.read().iter().find(|c| c.id == id).cloned()
    }

    pub fn set_configs(&self, configs: Vec<OutputConfig>) -> Result<(), String> {
        *self.configs.write() = configs;
        self.persist()
    }

    pub fn set_visible(&self, id: &str, visible: bool) -> Result<(), String> {
        let mut guard = self.configs.write();
        let Some(c) = guard.iter_mut().find(|c| c.id == id) else {
            return Err(format!("Output '{}' not found", id));
        };
        c.visible = visible;
        drop(guard);
        self.persist()
    }

    pub fn update_state(&self, id: &str, visible: bool, rendering: bool, fps: u32, error: Option<String>) {
        let mut guard = self.runtime.write();
        let entry = guard.entry(id.to_string()).or_insert_with(|| OutputState {
            id: id.to_string(),
            visible,
            rendering,
            fps,
            error: None,
        });
        entry.visible = visible;
        entry.rendering = rendering;
        entry.fps = fps;
        entry.error = error;
    }

    pub fn state(&self, id: &str) -> Option<OutputState> {
        self.runtime.read().get(id).cloned()
    }

    pub fn all_states(&self) -> Vec<OutputState> {
        self.runtime.read().values().cloned().collect()
    }
}

/// Default output set — identical to the pre-manager behavior (projection +
/// stage confidence monitor). Recorder/streamer surfaces are disabled until
/// explicitly enabled, but present so the manager model is visible.
pub fn default_outputs() -> Vec<OutputConfig> {
    vec![
        OutputConfig {
            id: "output".into(),
            kind: OutputKind::Window,
            label: "Projection".into(),
            enabled: true,
            visible: false,
            source: OutputSource::Live,
            geometry: OutputGeometry { width: 1920, height: 1080 },
            capture_fps: None,
            presentation: None,
            overlays: OutputOverlays { props: true, lower_third: true, logo: true },
            window_label: Some("output".into()),
            recording: None,
            streaming: None,
            stream_destinations: None,
        },
        OutputConfig {
            id: "stage".into(),
            kind: OutputKind::Window,
            label: "Stage Monitor".into(),
            enabled: true,
            visible: false,
            source: OutputSource::Live,
            geometry: OutputGeometry { width: 1280, height: 720 },
            capture_fps: None,
            presentation: None,
            overlays: OutputOverlays { props: false, lower_third: true, logo: false },
            window_label: Some("stage".into()),
            recording: None,
            streaming: None,
            stream_destinations: None,
        },
        OutputConfig {
            id: "overflow".into(),
            kind: OutputKind::Window,
            label: "Overflow".into(),
            enabled: false,
            visible: false,
            source: OutputSource::Live,
            geometry: OutputGeometry { width: 1920, height: 1080 },
            capture_fps: None,
            presentation: None,
            overlays: OutputOverlays { props: true, lower_third: true, logo: true },
            window_label: None,
            recording: None,
            streaming: None,
            stream_destinations: None,
        },
        OutputConfig {
            id: "record-main".into(),
            kind: OutputKind::Recorder,
            label: "Record Program".into(),
            enabled: false,
            visible: false,
            source: OutputSource::Live,
            geometry: OutputGeometry { width: 1920, height: 1080 },
            capture_fps: Some(30),
            presentation: None,
            overlays: OutputOverlays { props: true, lower_third: true, logo: true },
            window_label: None,
            recording: Some(OutputRecording { format: "webm".into(), directory: None }),
            streaming: None,
            stream_destinations: None,
        },
        OutputConfig {
            id: "stream-main".into(),
            kind: OutputKind::Streamer,
            label: "Stream Program".into(),
            enabled: false,
            visible: false,
            source: OutputSource::Live,
            geometry: OutputGeometry { width: 1920, height: 1080 },
            capture_fps: Some(30),
            presentation: None,
            overlays: OutputOverlays { props: true, lower_third: true, logo: true },
            window_label: None,
            recording: None,
            streaming: Some(OutputStreaming { mode: "whip".into(), url: String::new(), stream_key: None }),
            stream_destinations: None,
        },
    ]
}