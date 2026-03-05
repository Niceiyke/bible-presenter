use anyhow::Context;
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: &'static str,
    pub filename: &'static str,
    pub size_mb: u32,
    pub min_ram_mb: u64,
    pub display_name: &'static str,
}

pub const MODEL_CATALOG: &[ModelInfo] = &[
    ModelInfo {
        id: "tiny.en",
        filename: "ggml-tiny.en.bin",
        size_mb: 39,
        min_ram_mb: 512,
        display_name: "Tiny (English)",
    },
    ModelInfo {
        id: "base.en",
        filename: "ggml-base.en.bin",
        size_mb: 74,
        min_ram_mb: 1024,
        display_name: "Base (English)",
    },
    ModelInfo {
        id: "small.en",
        filename: "ggml-small.en.bin",
        size_mb: 244,
        min_ram_mb: 2048,
        display_name: "Small (English)",
    },
    ModelInfo {
        id: "medium.en",
        filename: "ggml-medium.en.bin",
        size_mb: 769,
        min_ram_mb: 4096,
        display_name: "Medium (English)",
    },
];

const HF_BASE_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

// Semantic search index metadata
pub const SEMANTIC_INDEX_URL: &str = "https://github.com/Niceiyke/bible-presenter/releases/download/embeddings_usearch_1.0.0/all_versions_embeddings.usearch";
pub const SEMANTIC_INDEX_FILENAME: &str = "all_versions_embeddings.usearch";
pub const SEMANTIC_INDEX_SIZE_MB: u32 = 300;

// Verse index metadata
pub const VERSE_INDEX_URL: &str = "https://github.com/Niceiyke/bible-presenter/releases/download/embeddings_usearch_1.0.0/verse_index.json";
pub const VERSE_INDEX_FILENAME: &str = "verse_index.json";
pub const VERSE_INDEX_SIZE_MB: u32 = 11;

// Core Search Assets mirrored on Google Drive
pub const BGE_MODEL_URL: &str = "https://drive.google.com/uc?export=download&id=1iuzlgf9nHdE1Eiw_aO9SXfLFIL51nJeL";
pub const BGE_MODEL_FILENAME: &str = "bge-small-en-v1.5.onnx";
pub const BGE_TOKENIZER_URL: &str = "https://drive.google.com/uc?export=download&id=1yu_w6MwN2wwFgTDfn4EkyUZnChBBJgvF";
pub const BGE_TOKENIZER_FILENAME: &str = "tokenizer.json";

pub const RERANKER_MODEL_URL: &str = "https://drive.google.com/uc?export=download&id=1DYPAJEz2VxAEa2huzKdTvfyKrAUXwt9M";
pub const RERANKER_MODEL_FILENAME: &str = "reranker/model.onnx";
pub const RERANKER_TOKENIZER_URL: &str = "https://drive.google.com/uc?export=download&id=1HVZKo4SBgCDALdIhmvjmCjzQXBlpsJ5T";
pub const RERANKER_TOKENIZER_FILENAME: &str = "reranker/tokenizer.json";

pub const BIBLE_DB_URL: &str = "https://drive.google.com/uc?export=download&id=1oqkczt3IqMMVtOxVTzOc0Mgfjryeicr8";
pub const BIBLE_DB_FILENAME: &str = "super_bible.db";

// ---------------------------------------------------------------------------
// Runtime types (serialized to frontend)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
pub struct ModelStatus {
    pub id: String,
    pub display_name: String,
    pub filename: String,
    pub size_mb: u32,
    pub downloaded: bool,
    pub path: Option<String>,
    pub is_active: bool,
    pub is_recommended: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub model_id: String,
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    pub percent: f32,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct HardwareInfo {
    pub cpu_cores: usize,
    pub total_ram_mb: u64,
    pub gpu_detected: bool,
    pub gpu_name: Option<String>,
    pub recommended_model: String,
    pub recommendation_reason: String,
}

// ---------------------------------------------------------------------------
// Persisted config
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
pub struct TranscriptionConfig {
    pub active_model: Option<String>, // filename, e.g. "ggml-base.en.bin"
    pub use_gpu: bool,
    #[serde(default)]
    pub cloud_provider: Option<String>, // "deepgram"|"openai"|"assemblyai"|"google"
    #[serde(default)]
    pub cloud_api_key: Option<String>,
    /// Override API hostname (e.g. enterprise Deepgram endpoint). None = use provider default.
    #[serde(default)]
    pub cloud_hostname: Option<String>,
    /// Model to request from the cloud provider (e.g. "nova-2", "best", "whisper-1").
    #[serde(default)]
    pub cloud_model: Option<String>,
    /// BCP-47 language code (e.g. "en", "en-US"). None = provider default.
    #[serde(default)]
    pub cloud_language: Option<String>,
    /// When true, auto-project suggested verses without operator confirmation.
    #[serde(default)]
    pub auto_project: bool,
    /// Seconds to hold a projected verse before allowing auto-replace. Default 8.
    #[serde(default = "default_verse_lock_secs")]
    pub verse_lock_secs: u32,
    /// Minimum semantic similarity (0–1) to trigger auto-projection. Default 0.55.
    #[serde(default = "default_confidence_threshold")]
    pub confidence_threshold: f32,
}

fn default_verse_lock_secs() -> u32 { 8 }
fn default_confidence_threshold() -> f32 { 0.55 }

impl Default for TranscriptionConfig {
    fn default() -> Self {
        Self {
            active_model: None,
            use_gpu: false,
            cloud_provider: None,
            cloud_api_key: None,
            cloud_hostname: None,
            cloud_model: None,
            cloud_language: None,
            auto_project: false,
            verse_lock_secs: default_verse_lock_secs(),
            confidence_threshold: default_confidence_threshold(),
        }
    }
}

impl TranscriptionConfig {
    pub fn load(app_data: &Path) -> Self {
        let path = app_data.join("transcription_config.json");
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, app_data: &Path) {
        let path = app_data.join("transcription_config.json");
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let tmp_path = path.with_extension("tmp");
            if std::fs::write(&tmp_path, json).is_ok() {
                let _ = std::fs::rename(tmp_path, path);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Hardware detection
// ---------------------------------------------------------------------------

pub fn detect_hardware() -> HardwareInfo {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();

    let cpu_cores = num_cpus::get();
    let total_ram_mb = sys.total_memory() / (1024 * 1024);

    // GPU probe: try NVIDIA then AMD (Linux)
    let (gpu_detected, gpu_name) = probe_gpu();

    let (recommended_model, recommendation_reason) = if gpu_detected {
        ("medium.en".to_string(), "GPU detected".to_string())
    } else if total_ram_mb >= 8 * 1024 {
        ("small.en".to_string(), "8GB+ RAM, no GPU".to_string())
    } else if total_ram_mb >= 4 * 1024 {
        ("base.en".to_string(), "4-8GB RAM, no GPU".to_string())
    } else {
        ("tiny.en".to_string(), "Limited RAM (<4GB)".to_string())
    };

    HardwareInfo {
        cpu_cores,
        total_ram_mb,
        gpu_detected,
        gpu_name,
        recommended_model,
        recommendation_reason,
    }
}

fn probe_gpu() -> (bool, Option<String>) {
    // 1. NVIDIA via nvidia-smi
    if let Ok(out) = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader,nounits"])
        .output()
    {
        if out.status.success() {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !name.is_empty() {
                return (true, Some(name));
            }
        }
    }

    // 2. Linux NVIDIA fallback
    #[cfg(target_os = "linux")]
    if std::path::Path::new("/proc/driver/nvidia/version").exists() {
        return (true, Some("NVIDIA GPU".to_string()));
    }

    // 3. Linux AMD via DRM
    #[cfg(target_os = "linux")]
    {
        if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
            for entry in entries.flatten() {
                let driver_path = entry.path().join("device/driver");
                if let Ok(link) = std::fs::read_link(&driver_path) {
                    let link_str = link.to_string_lossy();
                    if link_str.contains("amdgpu") || link_str.contains("radeon") {
                        return (true, Some("AMD GPU".to_string()));
                    }
                }
            }
        }
    }

    (false, None)
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

pub fn user_models_dir(app_data: &Path) -> PathBuf {
    app_data.join("models")
}

pub fn user_data_dir(app_data: &Path) -> PathBuf {
    app_data.join("bible_data")
}

pub fn model_path_if_exists(app_data: &Path, filename: &str) -> Option<PathBuf> {
    let p = user_models_dir(app_data).join(filename);
    if p.exists() { Some(p) } else { None }
}

pub fn semantic_index_path(app_data: &Path, resource_path: &Path) -> Option<PathBuf> {
    let user_path = user_data_dir(app_data).join(SEMANTIC_INDEX_FILENAME);
    if user_path.exists() { return Some(user_path); }
    let bundled = resource_path.join(format!("bible_data/{}", SEMANTIC_INDEX_FILENAME));
    if bundled.exists() { return Some(bundled); }
    None
}

pub fn verse_index_path(app_data: &Path, resource_path: &Path) -> Option<PathBuf> {
    let user_path = user_data_dir(app_data).join(VERSE_INDEX_FILENAME);
    if user_path.exists() { return Some(user_path); }
    let bundled = resource_path.join(format!("bible_data/{}", VERSE_INDEX_FILENAME));
    if bundled.exists() { return Some(bundled); }
    None
}

pub fn bible_db_path(app_data: &Path, resource_path: &Path) -> PathBuf {
    let user_path = user_data_dir(app_data).join(BIBLE_DB_FILENAME);
    if user_path.exists() { return user_path; }
    resource_path.join(format!("bible_data/{}", BIBLE_DB_FILENAME))
}

pub fn bge_model_path(app_data: &Path, resource_path: &Path) -> PathBuf {
    let user_path = user_models_dir(app_data).join(BGE_MODEL_FILENAME);
    if user_path.exists() { return user_path; }
    resource_path.join(format!("models/{}", BGE_MODEL_FILENAME))
}

pub fn bge_tokenizer_path(app_data: &Path, resource_path: &Path) -> PathBuf {
    let user_path = user_models_dir(app_data).join(BGE_TOKENIZER_FILENAME);
    if user_path.exists() { return user_path; }
    resource_path.join(format!("models/{}", BGE_TOKENIZER_FILENAME))
}

pub fn reranker_model_path(app_data: &Path, resource_path: &Path) -> PathBuf {
    let user_path = user_models_dir(app_data).join(RERANKER_MODEL_FILENAME);
    if user_path.exists() { return user_path; }
    resource_path.join(format!("models/{}", RERANKER_MODEL_FILENAME))
}

pub fn reranker_tokenizer_path(app_data: &Path, resource_path: &Path) -> PathBuf {
    let user_path = user_models_dir(app_data).join(RERANKER_TOKENIZER_FILENAME);
    if user_path.exists() { return user_path; }
    resource_path.join(format!("models/{}", RERANKER_TOKENIZER_FILENAME))
}

/// Resolve the whisper model path.
/// Priority:
///   1. User-downloaded model in app_data/models/{active_model}
///   2. Legacy whisper-base.bin in resource_path/models/ (existing installs)
///   3. None
pub fn resolve_whisper_path(
    config: &TranscriptionConfig,
    app_data: &Path,
    resource_path: &Path,
) -> Option<PathBuf> {
    // 1. User model
    if let Some(filename) = &config.active_model {
        let p = user_models_dir(app_data).join(filename);
        if p.exists() {
            return Some(p);
        }
    }
    // 2. Legacy fallback
    let legacy = resource_path.join("models/whisper-base.bin");
    if legacy.exists() {
        return Some(legacy);
    }
    None
}

pub fn delete_model_file(app_data: &Path, filename: &str) -> anyhow::Result<()> {
    let p = user_models_dir(app_data).join(filename);
    std::fs::remove_file(&p)
        .with_context(|| format!("Failed to delete {:?}", p))
}

// ---------------------------------------------------------------------------
// List models with status
// ---------------------------------------------------------------------------

pub fn list_model_statuses(
    config: &TranscriptionConfig,
    app_data: &Path,
    recommended_id: &str,
) -> Vec<ModelStatus> {
    MODEL_CATALOG
        .iter()
        .map(|info| {
            let path_opt = model_path_if_exists(app_data, info.filename);
            let downloaded = path_opt.is_some();
            let is_active = config
                .active_model
                .as_deref()
                .map_or(false, |m| m == info.filename);
            ModelStatus {
                id: info.id.to_string(),
                display_name: info.display_name.to_string(),
                filename: info.filename.to_string(),
                size_mb: info.size_mb,
                downloaded,
                path: path_opt.map(|p| p.to_string_lossy().to_string()),
                is_active,
                is_recommended: info.id == recommended_id,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

pub async fn download_model<F>(
    info: &ModelInfo,
    app_data: &Path,
    cancel_flag: Arc<AtomicBool>,
    mut progress_cb: F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(DownloadProgress) + Send + 'static,
{
    let models_dir = user_models_dir(app_data);
    std::fs::create_dir_all(&models_dir)
        .with_context(|| format!("Cannot create models dir {:?}", models_dir))?;

    let url = format!("{}{}", HF_BASE_URL, info.filename);
    let tmp_path = models_dir.join(format!("{}.tmp", info.filename));
    let final_path = models_dir.join(info.filename);

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .user_agent("bible-presenter")
        .build()
        .context("Failed to build HTTP client")?;

    let response = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("GET {} failed", url))?;

    if !response.status().is_success() {
        anyhow::bail!("HTTP {} for {}", response.status(), url);
    }

    let total_bytes = response.content_length().unwrap_or(0);
    let mut bytes_downloaded: u64 = 0;
    let mut file =
        std::fs::File::create(&tmp_path).with_context(|| format!("Cannot create {:?}", tmp_path))?;

    let mut stream = response.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(&tmp_path);
            anyhow::bail!("Download cancelled");
        }
        let chunk = chunk_result.context("Stream error")?;
        use std::io::Write;
        file.write_all(&chunk).context("Write error")?;
        bytes_downloaded += chunk.len() as u64;

        let percent = if total_bytes > 0 {
            (bytes_downloaded as f32 / total_bytes as f32) * 100.0
        } else {
            0.0
        };
        progress_cb(DownloadProgress {
            model_id: info.id.to_string(),
            bytes_downloaded,
            total_bytes,
            percent,
            done: false,
            error: None,
        });
    }

    // Atomic rename
    drop(file);
    std::fs::rename(&tmp_path, &final_path)
        .with_context(|| format!("Cannot rename {:?} → {:?}", tmp_path, final_path))?;

    progress_cb(DownloadProgress {
        model_id: info.id.to_string(),
        bytes_downloaded,
        total_bytes,
        percent: 100.0,
        done: true,
        error: None,
    });

    Ok(final_path)
}

pub async fn download_semantic_index<F>(
    app_data: &Path,
    cancel_flag: Arc<AtomicBool>,
    progress_cb: F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(DownloadProgress) + Send + 'static,
{
    download_file(
        SEMANTIC_INDEX_URL,
        SEMANTIC_INDEX_FILENAME,
        "semantic_index",
        &user_data_dir(app_data),
        cancel_flag,
        progress_cb,
    ).await
}

pub async fn download_verse_index<F>(
    app_data: &Path,
    cancel_flag: Arc<AtomicBool>,
    mut progress_cb: F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(DownloadProgress) + Send + 'static,
{
    download_file(
        VERSE_INDEX_URL,
        VERSE_INDEX_FILENAME,
        "verse_index",
        &user_data_dir(app_data),
        cancel_flag,
        progress_cb,
    ).await
}

pub async fn download_bible_db<F>(
    app_data: &Path,
    cancel_flag: Arc<AtomicBool>,
    progress_cb: F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(DownloadProgress) + Send + 'static,
{
    download_file(
        BIBLE_DB_URL,
        BIBLE_DB_FILENAME,
        "bible_db",
        &user_data_dir(app_data),
        cancel_flag,
        progress_cb,
    ).await
}

pub async fn download_bge_model<F>(
    app_data: &Path,
    cancel_flag: Arc<AtomicBool>,
    progress_cb: F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(DownloadProgress) + Send + 'static,
{
    download_file(
        BGE_MODEL_URL,
        BGE_MODEL_FILENAME,
        "bge_model",
        &user_models_dir(app_data),
        cancel_flag,
        progress_cb,
    ).await
}

pub async fn download_bge_tokenizer<F>(
    app_data: &Path,
    cancel_flag: Arc<AtomicBool>,
    progress_cb: F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(DownloadProgress) + Send + 'static,
{
    download_file(
        BGE_TOKENIZER_URL,
        BGE_TOKENIZER_FILENAME,
        "bge_tokenizer",
        &user_models_dir(app_data),
        cancel_flag,
        progress_cb,
    ).await
}

pub async fn download_reranker_model<F>(
    app_data: &Path,
    cancel_flag: Arc<AtomicBool>,
    progress_cb: F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(DownloadProgress) + Send + 'static,
{
    download_file(
        RERANKER_MODEL_URL,
        RERANKER_MODEL_FILENAME,
        "reranker_model",
        &user_models_dir(app_data),
        cancel_flag,
        progress_cb,
    ).await
}

pub async fn download_reranker_tokenizer<F>(
    app_data: &Path,
    cancel_flag: Arc<AtomicBool>,
    progress_cb: F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(DownloadProgress) + Send + 'static,
{
    download_file(
        RERANKER_TOKENIZER_URL,
        RERANKER_TOKENIZER_FILENAME,
        "reranker_tokenizer",
        &user_models_dir(app_data),
        cancel_flag,
        progress_cb,
    ).await
}

pub async fn download_file<F>(
    url: &str,
    filename: &str,
    model_id: &str,
    target_dir: &Path,
    cancel_flag: Arc<AtomicBool>,
    progress_cb: F,
) -> anyhow::Result<PathBuf>
where
    F: FnMut(DownloadProgress) + Send + 'static,
{
    let mut progress_cb = progress_cb;
    std::fs::create_dir_all(target_dir)
        .with_context(|| format!("Cannot create dir {:?}", target_dir))?;

    let tmp_path = target_dir.join(format!("{}.tmp", filename.replace("/", "_")));
    let final_path = target_dir.join(filename);
    
    // Ensure parent dir exists for names like "reranker/model.onnx"
    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .user_agent("bible-presenter")
        .build()
        .context("Failed to build HTTP client")?;

    let response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("GET {} failed", url))?;

    if !response.status().is_success() {
        anyhow::bail!("HTTP {} for {}", response.status(), url);
    }

    let total_bytes = response.content_length().unwrap_or(0);
    let mut bytes_downloaded: u64 = 0;
    let mut file =
        std::fs::File::create(&tmp_path).with_context(|| format!("Cannot create {:?}", tmp_path))?;

    let mut stream = response.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(&tmp_path);
            anyhow::bail!("Download cancelled");
        }
        let chunk = chunk_result.context("Stream error")?;
        use std::io::Write;
        file.write_all(&chunk).context("Write error")?;
        bytes_downloaded += chunk.len() as u64;

        let percent = if total_bytes > 0 {
            (bytes_downloaded as f32 / total_bytes as f32) * 100.0
        } else {
            0.0
        };
        progress_cb(DownloadProgress {
            model_id: model_id.to_string(),
            bytes_downloaded,
            total_bytes,
            percent,
            done: false,
            error: None,
        });
    }

    drop(file);
    std::fs::rename(&tmp_path, &final_path)
        .with_context(|| format!("Cannot rename {:?} → {:?}", tmp_path, final_path))?;

    progress_cb(DownloadProgress {
        model_id: model_id.to_string(),
        bytes_downloaded,
        total_bytes,
        percent: 100.0,
        done: true,
        error: None,
    });

    Ok(final_path)
}
