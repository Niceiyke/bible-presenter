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

    /// Atomically write a JSON payload to `outputs.json` (temp file + rename)
    /// so a crash mid-write can never leave a truncated file that fails to
    /// parse on next launch.
    fn write_json_atomic(&self, json: &str) -> Result<(), String> {
        if let Some(dir) = self.configs_file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.configs_file.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.configs_file).map_err(|e| e.to_string())
    }

    /// Persist an arbitrary candidate config set to disk (without touching the
    /// in-memory state). Callers swap in-memory state only after this succeeds,
    /// so a failed write never leaves the running config diverged from disk.
    fn persist_candidate(&self, configs: &[OutputConfig]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(configs).map_err(|e| e.to_string())?;
        self.write_json_atomic(&json)
    }

    pub fn persist(&self) -> Result<(), String> {
        let configs = self.configs.read().clone();
        self.persist_candidate(&configs)
    }

    pub fn list(&self) -> Vec<OutputConfig> {
        self.configs.read().clone()
    }

    pub fn get(&self, id: &str) -> Option<OutputConfig> {
        self.configs.read().iter().find(|c| c.id == id).cloned()
    }

    /// Replace-all config set. The candidate is PERSISTED FIRST; in-memory
    /// state is swapped only after the write succeeds (audit #14), so a failed
    /// persist never leaves the running config out of sync with disk.
    pub fn set_configs(&self, configs: Vec<OutputConfig>) -> Result<(), String> {
        self.persist_candidate(&configs)?;
        *self.configs.write() = configs;
        Ok(())
    }

    /// Flip one output's visibility, persisting first, then swapping in-memory.
    pub fn set_visible(&self, id: &str, visible: bool) -> Result<(), String> {
        let mut configs = self.configs.read().clone();
        let found = configs
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| format!("Output '{}' not found", id))?;
        found.visible = visible;
        self.persist_candidate(&configs)?;
        *self.configs.write() = configs;
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_app_data(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wordlyte-outputs-test-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn set_configs_persists_then_swaps() {
        let dir = temp_app_data("persist");
        let manager = OutputManager::new(&dir);
        let mut modified = manager.list();
        assert!(!modified.is_empty());
        modified[0].label = "Changed".into();
        manager.set_configs(modified.clone()).unwrap();

        // The candidate is on disk ...
        let disk: Vec<OutputConfig> =
            serde_json::from_str(&std::fs::read_to_string(dir.join("outputs.json")).unwrap()).unwrap();
        assert_eq!(disk.len(), modified.len());
        assert_eq!(disk[0].label, "Changed");
        // ... and in memory.
        assert_eq!(manager.list()[0].label, "Changed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_configs_keeps_in_memory_on_persist_failure() {
        // Make the configs_file's parent a regular file so any write must fail.
        let dir = temp_app_data("fail");
        let blocker = dir.join("not-a-dir");
        std::fs::write(&blocker, b"file").unwrap();
        let manager = OutputManager::new(&blocker);
        let before = manager.list();
        let mut modified = before.clone();
        if !modified.is_empty() {
            modified[0].label = "ShouldNotSwap".into();
        }
        assert!(manager.set_configs(modified).is_err());
        // In-memory state must be untouched after a failed persist (audit #14).
        assert_eq!(manager.list()[0].label, before[0].label);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_visible_keeps_in_memory_on_persist_failure() {
        let dir = temp_app_data("vis-fail");
        let blocker = dir.join("not-a-dir");
        std::fs::write(&blocker, b"file").unwrap();
        let manager = OutputManager::new(&blocker);
        let before = manager.list();
        let first = before.iter().find(|c| c.id == "output").expect("has output");
        assert!(manager.set_visible("output", !first.visible).is_err());
        let after_list = manager.list();
        let after = after_list.iter().find(|c| c.id == "output").unwrap();
        assert_eq!(after.visible, first.visible);
        let _ = std::fs::remove_dir_all(&dir);
    }
}