// Wordlyte Main Entry Point
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod camera;
mod remote;
mod ndi;

use wordlyte_lib::{audio, engine, store};
use store::log_msg;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use rubato::Resampler;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use engine::model_manager::{
    self, detect_hardware, download_model, list_model_statuses, model_path_if_exists,
    resolve_whisper_path, user_models_dir, DownloadProgress, HardwareInfo, ModelStatus,
    TranscriptionConfig,
};
use tauri::{AppHandle, Emitter, Manager, State};

// ---------------------------------------------------------------------------
// Semantic Index management
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
struct SemanticIndexStatus {
    downloaded: bool,
    path: Option<String>,
    size_mb: u32,
}

#[derive(Clone, Serialize, Deserialize)]
struct VerseIndexStatus {
    downloaded: bool,
    path: Option<String>,
    size_mb: u32,
}

#[tauri::command]
async fn get_semantic_index_status(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<SemanticIndexStatus, String> {
    let resource_path = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
    
    let path = engine::model_manager::semantic_index_path(&state.app_data_dir, &resource_path);
    let downloaded = path.is_some();
    
    Ok(SemanticIndexStatus {
        downloaded,
        path: path.map(|p| p.to_string_lossy().to_string()),
        size_mb: 300,
    })
}

#[tauri::command]
async fn get_verse_index_status(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<VerseIndexStatus, String> {
    let resource_path = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
    
    let path = engine::model_manager::verse_index_path(&state.app_data_dir, &resource_path);
    let downloaded = path.is_some();
    
    Ok(VerseIndexStatus {
        downloaded,
        path: path.map(|p| p.to_string_lossy().to_string()),
        size_mb: 11,
    })
}

#[tauri::command]
async fn download_bible_db_cmd(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    log_msg(&app, "Command received: download_bible_db_cmd");
    if state.download_in_progress.load(Ordering::Relaxed) {
        return Err("Another download is already in progress.".into());
    }
    state.download_in_progress.store(true, Ordering::SeqCst);
    let app_data = state.app_data_dir.clone();
    let cancel_flag = state.download_in_progress.clone();
    let app_handle = app.clone();

    tokio::spawn(async move {
        let res = engine::model_manager::download_and_extract_zip(
            engine::model_manager::BIBLE_DATA_ZIP_URL,
            "bible_db",
            &engine::model_manager::user_data_dir(&app_data),
            cancel_flag.clone(),
            {
                let app_handle = app_handle.clone();
                move |progress| {
                    let _ = app_handle.emit("download-progress", progress);
                }
            },
        ).await;

        cancel_flag.store(false, Ordering::SeqCst);
        match res {
            Ok(_) => {
                log_msg(&app_handle, "Bible data ZIP downloaded and extracted successfully.");
                let path = engine::model_manager::user_data_dir(&app_data).join(engine::model_manager::BIBLE_DB_FILENAME);
                let _ = app_handle.emit("bible-db-ready", path.to_string_lossy());
            }
            Err(e) => {
                log_msg(&app_handle, &format!("Bible data ZIP download failed: {}", e));
                let _ = app_handle.emit("download-error", e.to_string());
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn download_core_search_models_cmd(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    log_msg(&app, "Command received: download_core_search_models_cmd");
    if state.download_in_progress.load(Ordering::Relaxed) {
        return Err("Another download is already in progress.".into());
    }
    state.download_in_progress.store(true, Ordering::SeqCst);
    let app_data = state.app_data_dir.clone();
    let cancel_flag = state.download_in_progress.clone();
    let app_handle = app.clone();

    tokio::spawn(async move {
        let res = engine::model_manager::download_and_extract_zip(
            engine::model_manager::MODELS_ZIP_URL,
            "core_models",
            &engine::model_manager::user_models_dir(&app_data),
            cancel_flag.clone(),
            {
                let app_handle = app_handle.clone();
                move |progress| {
                    let _ = app_handle.emit("download-progress", progress);
                }
            },
        ).await;

        cancel_flag.store(false, Ordering::SeqCst);
        match res {
            Ok(_) => {
                log_msg(&app_handle, "Core search models ZIP downloaded and extracted successfully.");
                let _ = app_handle.emit("core-models-ready", true);
            }
            Err(e) => {
                log_msg(&app_handle, &format!("Core models ZIP download failed: {}", e));
                let _ = app_handle.emit("download-error", e.to_string());
            }
        }
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared event payloads
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct TranscriptionUpdate {
    text: String,
    detected_item: Option<store::DisplayItem>,
    /// Cosine similarity score 0.0–1.0. 1.0 = explicit reference match.
    confidence: f32,
    /// "auto" = from live transcription pipeline; "manual" = operator-triggered via go_live
    source: String,
    /// true = partial transcript (live text display only, no verse projection)
    /// false = final transcript (verse detection ran, suggestedItem may be set)
    is_partial: bool,
}

/// A single segment of the session's full transcript log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    pub text: String,
    pub timestamp_ms: u64,
    pub is_final: bool,
    pub source: String, // "deepgram" | "assemblyai" | "local"
}

/// Emitted on every session lifecycle change so the frontend can update its UI.
/// status values: "loading" | "running" | "stopped" | "error"
#[derive(Clone, Serialize)]
struct SessionStatus {
    status: String,
    message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MonitorInfo {
    name: String,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    is_primary: bool,
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

/// Metadata for a connected non-mobile WS remote client.
#[derive(Debug, Clone)]
pub struct OperatorMeta {
    pub name: String,
    pub role: String, // "operator" | "presenter" | "viewer"
}

/// An item staged by a remote operator, pending approval by the main desktop operator.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct RemoteProposal {
    pub operator_key: String,
    pub operator_name: String,
    pub item: store::DisplayItem,
    pub staged_at_ms: u64,
}

pub struct AppState {
    operator_audio: Arc<Mutex<audio::AudioEngine>>,
    preacher_audio: Arc<Mutex<audio::AudioEngine>>,
    studio_audio: Arc<Mutex<audio::AudioEngine>>,
    operator_ptt_active: Arc<AtomicBool>,
    /// C5: Engine is None until the user first clicks START LIVE.
    /// Wrapped in Mutex so start_session can populate it after the fact.
    engine: Arc<Mutex<Option<Arc<engine::TranscriptionEngine>>>>,
    pub store: Arc<store::BibleStore>,
    pub media_schedule: Arc<store::MediaScheduleStore>,
    /// Persisted transcription configuration (active model filename, GPU toggle).
    pub transcription_config: Arc<Mutex<TranscriptionConfig>>,
    /// Resolved whisper model path — updated when user selects a downloaded model.
    pub whisper_path: Arc<Mutex<Option<PathBuf>>>,
    /// ONNX embedding model path (bundled, stays fixed).
    pub embedding_model_path: PathBuf,
    /// HuggingFace tokenizer path (bundled, stays fixed).
    pub tokenizer_path: PathBuf,
    /// Cross-Encoder reranker model path (bundled, stays fixed).
    pub reranker_model_path: PathBuf,
    /// Reranker tokenizer path (bundled, stays fixed).
    pub reranker_tokenizer_path: PathBuf,
    /// App data directory — used by download commands to write into models/.
    pub app_data_dir: PathBuf,
    /// Set to true while a download is in progress; cancel signal for the task.
    pub download_in_progress: Arc<AtomicBool>,
    /// C3: Prevents duplicate sessions if START LIVE is clicked twice.
    is_running: Arc<Mutex<bool>>,
    /// Current display items (what is staged and what is live).
    pub live_item: Arc<Mutex<Option<store::DisplayItem>>>,
    pub staged_item: Arc<Mutex<Option<store::DisplayItem>>>,
    /// Persisted presentation settings (theme, reference position, etc.)
    settings: Arc<Mutex<store::PresentationSettings>>,
    /// Active lower third overlay as a combined {data, template} JSON value (None = hidden).
    pub lower_third: Arc<Mutex<Option<serde_json::Value>>>,
    /// Broadcast channel: every WS client subscribes to receive state updates.
    pub broadcast_tx: tokio::sync::broadcast::Sender<String>,
    /// Tauri AppHandle stored after setup so the remote module can emit events.
    pub app_handle: Arc<OnceLock<tauri::AppHandle>>,
    /// 6-digit PIN displayed in Settings tab; required for WS auth. Mutable so it can be regenerated.
    pub remote_pin: Arc<Mutex<String>>,
    /// Audio window fed to Whisper per inference call, in samples at 16 kHz.
    /// 8000 = 0.5 s (most responsive, highest CPU); 48000 = 3 s (lowest CPU, most latency).
    transcription_window: Arc<Mutex<usize>>,
    /// Per-client WebRTC signaling channels.
    /// Key: client identifier ("window:main", "window:output", "mobile:{device_id}").
    /// Value: unbounded sender for direct point-to-point message delivery.
    pub signaling_clients: Arc<Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<String>>>>,
    /// When true, the transcription pipeline drains its buffer without calling Whisper.
    /// Set by the operator when LAN cameras are active to free CPU for video decode.
    pub transcription_paused: Arc<AtomicBool>,
    pub operator_muted: Arc<AtomicBool>,
    pub preacher_muted: Arc<AtomicBool>,
    /// Limits concurrent local-Whisper inference to 1 slot (operator + preacher share it).
    /// Cloud REST/WS paths skip this semaphore — those calls are remote and non-blocking.
    pub inference_semaphore: Arc<tokio::sync::Semaphore>,
    /// Persistent props layer — graphics that survive slide changes (logos, clocks).
    pub props_layer: Arc<Mutex<Vec<store::PropItem>>>,
    /// Currently connected LAN camera clients: device_id → device_name.
    pub connected_cameras: Arc<tokio::sync::Mutex<HashMap<String, String>>>,
    /// Typed camera session registry (replaces raw signaling_clients for mobile devices).
    pub camera_sessions: camera::SessionRegistry,
    /// Authoritative tally state machine (Off / Preview / Program per device).
    pub camera_tally: camera::TallyRegistry,
    /// Full transcript log for the current service session.
    pub session_transcript: Arc<Mutex<Vec<TranscriptSegment>>>,
    /// Rolling last-3 final-segment context buffer used to improve semantic
    /// verse detection by giving the embedding model more text context.
    pub context_buffer: Arc<Mutex<Vec<String>>>,
    /// Handle to the active cloud WebSocket stream (Deepgram / AssemblyAI).
    /// None when local Whisper or REST cloud mode is active.
    pub operator_cloud_stream_handle: Arc<Mutex<Option<engine::cloud_stream::CloudStreamHandle>>>,
    pub preacher_cloud_stream_handle: Arc<Mutex<Option<engine::cloud_stream::CloudStreamHandle>>>,
    /// IP-based auth throttling to prevent PIN brute-force.
    pub auth_throttles: Arc<Mutex<HashMap<std::net::IpAddr, (u8, std::time::Instant)>>>,
    /// Valid session tokens issued on WS auth_ok, checked by REST endpoints.
    pub session_tokens: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Self-signed TLS certificate for the embedded HTTPS/WSS server.
    pub app_cert: std::sync::Arc<camera::AppCert>,
    /// HMAC-signed device tokens for camera clients (avoids re-entering PIN).
    pub device_tokens: std::sync::Arc<camera::DeviceTokenManager>,
    /// NDI Streaming Manager.
    pub ndi_manager: Arc<ndi::NdiManager>,
    /// Whether the operator recording pipeline is currently active.
    pub operator_is_active: Arc<AtomicBool>,
    /// Whether the preacher recording pipeline is currently active.
    pub preacher_is_active: Arc<AtomicBool>,
    /// Whether the studio recording pipeline is currently active.
    pub studio_is_active: Arc<AtomicBool>,
    /// Session start timestamp (ms since epoch). Set by start_session and read
    /// by start_preacher_recording so relative timestamps stay consistent.
    pub session_start_ms: Arc<Mutex<u64>>,
    /// Registry of connected non-mobile remote operators: client_key → OperatorMeta.
    pub remote_operators: Arc<Mutex<HashMap<String, OperatorMeta>>>,
    /// Pending staging proposals from remote operators: client_key → RemoteProposal.
    /// Each remote operator has at most one active proposal; the main operator chooses which to send live.
    pub remote_proposals: Arc<Mutex<HashMap<String, RemoteProposal>>>,
}

impl Clone for AppState {
    fn clone(&self) -> Self {
        Self {
            operator_audio: self.operator_audio.clone(),
            preacher_audio: self.preacher_audio.clone(),
            studio_audio: self.studio_audio.clone(),
            operator_ptt_active: self.operator_ptt_active.clone(),
            engine: self.engine.clone(),
            store: self.store.clone(),
            media_schedule: self.media_schedule.clone(),
            transcription_config: self.transcription_config.clone(),
            whisper_path: self.whisper_path.clone(),
            embedding_model_path: self.embedding_model_path.clone(),
            tokenizer_path: self.tokenizer_path.clone(),
            reranker_model_path: self.reranker_model_path.clone(),
            reranker_tokenizer_path: self.reranker_tokenizer_path.clone(),
            app_data_dir: self.app_data_dir.clone(),
            download_in_progress: self.download_in_progress.clone(),
            is_running: self.is_running.clone(),
            live_item: self.live_item.clone(),
            staged_item: self.staged_item.clone(),
            settings: self.settings.clone(),
            lower_third: self.lower_third.clone(),
            broadcast_tx: self.broadcast_tx.clone(),
            app_handle: self.app_handle.clone(),
            remote_pin: self.remote_pin.clone(),
            transcription_window: self.transcription_window.clone(),
            signaling_clients: self.signaling_clients.clone(),
            transcription_paused: self.transcription_paused.clone(),
            operator_muted: self.operator_muted.clone(),
            preacher_muted: self.preacher_muted.clone(),
            inference_semaphore: self.inference_semaphore.clone(),
            props_layer: self.props_layer.clone(),
            connected_cameras: self.connected_cameras.clone(),
            camera_sessions: self.camera_sessions.clone(),
            camera_tally: self.camera_tally.clone(),
            session_transcript: self.session_transcript.clone(),
            context_buffer: self.context_buffer.clone(),
            operator_cloud_stream_handle: self.operator_cloud_stream_handle.clone(),
            preacher_cloud_stream_handle: self.preacher_cloud_stream_handle.clone(),
            auth_throttles: self.auth_throttles.clone(),
            session_tokens: self.session_tokens.clone(),
            app_cert: self.app_cert.clone(),
            device_tokens: self.device_tokens.clone(),
            ndi_manager: self.ndi_manager.clone(),
            operator_is_active: self.operator_is_active.clone(),
            preacher_is_active: self.preacher_is_active.clone(),
            studio_is_active: self.studio_is_active.clone(),
            session_start_ms: self.session_start_ms.clone(),
            remote_operators: self.remote_operators.clone(),
            remote_proposals: self.remote_proposals.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn is_hallucination(text: &str) -> bool {
    let lower = text.trim().to_lowercase();
    if lower.is_empty() { return true; }
    const GARBAGE: &[&str] = &[
        "[blank_audio]", "[silence]", "[music]",
        "[inaudible]", "(silence)", "[ silence ]",
    ];
    if GARBAGE.iter().any(|g| lower.contains(g)) { return true; }
    
    // Some common Whisper hallucinations
    if lower == "thank you." || lower == "thank you" || lower.starts_with("subtitles by") || lower.contains("amara.org") {
        return true;
    }

    let words: Vec<&str> = lower.split_whitespace().collect();
    let total_words = words.len();
    if total_words >= 6 {
        // Whitelist common religious repetitions that are NOT hallucinations
        const RELIGIOUS_WHITELIST: &[&str] = &["amen", "hallelujah", "holy", "jesus", "lord"];
        
        let mut word_counts = std::collections::HashMap::new();
        for word in &words {
            let clean = word.trim_matches(|c: char| !c.is_alphanumeric());
            if !RELIGIOUS_WHITELIST.contains(&clean) {
                *word_counts.entry(clean).or_insert(0) += 1;
            }
        }
        for count in word_counts.values() {
            if *count > total_words / 2 {
                return true;
            }
        }
        
        // Check for exact repeating phrases
        for seq_len in 1..=4 {
            if total_words >= seq_len * 3 {
                let seq = &words[0..seq_len];
                let mut all_match = true;
                for i in 1..3 {
                    if &words[i*seq_len..(i+1)*seq_len] != seq {
                        all_match = false;
                        break;
                    }
                }
                if all_match {
                    // Only filter if not a whitelisted word
                    let first_word = seq[0].trim_matches(|c: char| !c.is_alphanumeric());
                    if !RELIGIOUS_WHITELIST.contains(&first_word) {
                        return true;
                    }
                }
            }
        }
    }
    
    false
}

impl AppState {
    pub fn log(&self, message: &str) {
        if let Some(app) = self.app_handle.get() {
            log_msg(app, message);
        } else {
            println!("{}", message);
        }
    }

    pub async fn get_or_init_engine(&self, app: &tauri::AppHandle) -> Result<Arc<engine::TranscriptionEngine>, String> {
        let engine = { self.engine.lock().clone() };
        if let Some(e) = engine {
            return Ok(e);
        }

        let whisper_path_opt = self.whisper_path.lock().clone();
        let use_gpu = self.transcription_config.lock().use_gpu;
        let embedding_path = self.embedding_model_path.to_str().unwrap_or("").to_string();
        let tokenizer_path = self.tokenizer_path.to_str().unwrap_or("").to_string();
        let reranker_model_path = self.reranker_model_path.to_str().unwrap_or("").to_string();
        let reranker_tokenizer_path = self.reranker_tokenizer_path.to_str().unwrap_or("").to_string();

        let whisper_str: Option<String> = whisper_path_opt.map(|p| p.to_str().unwrap_or("").to_string());
        let engine_mutex = self.engine.clone();

        log_msg(app, "Lazy-loading AI engine for semantic search...");

        match tokio::task::spawn_blocking(move || {
            engine::TranscriptionEngine::new(
                whisper_str.as_deref(),
                &embedding_path,
                &tokenizer_path,
                &reranker_model_path,
                &reranker_tokenizer_path,
                use_gpu,
            )
        })
        .await
        {
            Ok(Ok(e)) => {
                let e = Arc::new(e);
                *engine_mutex.lock() = Some(e.clone());
                log_msg(app, "AI engine loaded successfully.");
                Ok(e)
            }
            Ok(Err(e)) => {
                log_msg(app, &format!("AI engine failed to load: {}", e));
                Err(format!("AI models failed to load: {}", e))
            }
            Err(e) => {
                log_msg(app, &format!("AI engine loading task panicked: {}", e));
                Err(format!("Model loading task panicked: {}", e))
            }
        }
    }

    pub async fn search_bible(&self, app: &tauri::AppHandle, query: &str) -> Result<store::SearchResponse, String> {
        // 1. Try direct reference match first
        let ref_results = self.store.detect_verses_by_ref(query);
        if !ref_results.is_empty() {
            return Ok(store::SearchResponse {
                results: ref_results,
                method: "reference".to_string(),
            });
        }

        // 2. Hybrid Search (Semantic + FTS5 Keyword)
        let fts_results = self.store.search_manual_all_versions(query).unwrap_or_default();
        let mut semantic_results = Vec::new();

        match self.get_or_init_engine(app).await {
            Ok(engine) => {
                log_msg(app, &format!("Generating embedding for query: '{}'...", query));
                match engine.embed(query) {
                    Ok(embedding) => {
                        log_msg(app, "Embedding generated. Searching USearch index...");
                        // Get a bit more for semantic to ensure good fusion overlap
                        semantic_results = self.store.search_top_n_semantic(app, &embedding, 50);
                    }
                    Err(e) => log_msg(app, &format!("Embedding error: {}", e)),
                }
            }
            Err(e) => log_msg(app, &format!("Failed to lazy-load engine for semantic search: {}", e)),
        }

        if semantic_results.is_empty() && fts_results.is_empty() {
            return Ok(store::SearchResponse {
                results: Vec::new(),
                method: "hybrid".to_string(),
            });
        }

        // Merging via Reciprocal Rank Fusion (RRF)
        let mut rrf_scores: std::collections::HashMap<(String, i32, i32), (f32, store::Verse)> = std::collections::HashMap::new();
        let k = 60.0;

        for (rank, verse) in fts_results.into_iter().enumerate() {
            let key = (verse.book.clone(), verse.chapter, verse.verse);
            let score = 1.0 / (k + rank as f32 + 1.0);
            rrf_scores.insert(key, (score, verse));
        }

        for (rank, verse) in semantic_results.into_iter().enumerate() {
            let key = (verse.book.clone(), verse.chapter, verse.verse);
            let score = 1.0 / (k + rank as f32 + 1.0);
            
            let entry = rrf_scores.entry(key).or_insert((0.0, verse.clone()));
            entry.0 += score;
            
            // Preserve semantic score if available, otherwise it stays as the one from FTS
            if entry.1.score.is_none() || (verse.score.is_some() && verse.score > entry.1.score) {
                 entry.1.score = verse.score; 
            }
        }

        let mut final_results: Vec<(f32, store::Verse)> = rrf_scores.into_values().collect();
        // Sort by RRF score descending
        final_results.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        // Map back to Verses and take top 50 for reranking
        let mut candidates: Vec<store::Verse> = final_results.into_iter().take(50).map(|(_, v)| v).collect();

        // 3. Precision Reranking (Cross-Encoder)
        if !candidates.is_empty() {
            if let Ok(engine) = self.get_or_init_engine(app).await {
                log_msg(app, &format!("Reranking {} candidates...", candidates.len()));
                let passages: Vec<String> = candidates.iter().map(|v| v.text.clone()).collect();
                match engine.rerank(query, &passages) {
                    Ok(scores) => {
                        for (i, score) in scores.into_iter().enumerate() {
                            candidates[i].score = Some(score);
                        }
                        // Sort by reranker score descending
                        candidates.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
                        log_msg(app, "Reranking complete.");
                    }
                    Err(e) => log_msg(app, &format!("Reranking error: {}", e)),
                }
            }
        }

        let results: Vec<store::Verse> = candidates.into_iter().take(20).collect();

        Ok(store::SearchResponse {
            results,
            method: "hybrid".to_string(),
        })
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn start_session(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut running = state.is_running.lock();
        if *running {
            return Err("A session is already running. Click STOP first.".to_string());
        }
        *running = true;
    }

    state.session_transcript.lock().clear();
    state.context_buffer.lock().clear();

    // Pre-load AI engine so the first REC click is instant.
    if let Err(e) = state.get_or_init_engine(&app).await {
        *state.is_running.lock() = false;
        let _ = app.emit("session-status", SessionStatus { status: "error".to_string(), message: format!("AI models failed to load: {}", e) });
        return Err(e);
    }

    let session_start_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    *state.session_start_ms.lock() = session_start_ms;

    let _ = app.emit("session-status", SessionStatus { status: "running".to_string(), message: "Live session started".to_string() });
    Ok(())
}

/// Start the operator mic + PTT pipeline independently.
#[tauri::command]
async fn start_operator_recording(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if !*state.is_running.lock() {
        return Err("No active session. Start the session first.".to_string());
    }
    if state.operator_is_active.load(Ordering::Relaxed) {
        return Err("Operator recording is already active.".to_string());
    }

    let engine = match state.get_or_init_engine(&app).await {
        Ok(e) => e,
        Err(e) => return Err(format!("AI models failed to load: {}", e)),
    };

    let (op_audio_tx, mut op_audio_rx) = tokio::sync::mpsc::channel::<Vec<f32>>(128);
    let (op_error_tx, mut op_error_rx) = tokio::sync::mpsc::channel::<String>(10);
    let (op_level_tx, mut op_level_rx) = tokio::sync::mpsc::channel::<f32>(50);

    {
        let op_device = state.operator_audio.lock().selected_device().map(|s| s.to_string()).unwrap_or_else(|| "system default".to_string());
        if let Err(e) = state.operator_audio.lock().start_capturing(op_audio_tx, op_error_tx, Some(op_level_tx), 16000.0) {
            return Err(format!("Operator mic error: {}", e));
        }
        log_msg(&app, &format!("[Operator] Recording started — device: \"{}\"", op_device));
    }

    let app_err = app.clone();
    tokio::spawn(async move { while let Some(msg) = op_error_rx.recv().await { let _ = app_err.emit("audio-error", format!("Operator: {}", msg)); } });
    let app_level = app.clone();
    tokio::spawn(async move { while let Some(level) = op_level_rx.recv().await { let _ = app_level.emit("operator-audio-level", level); } });

    state.operator_is_active.store(true, Ordering::Relaxed);
    let _ = app.emit("operator-recording-status", serde_json::json!({"active": true}));

    let config = state.transcription_config.lock().clone();
    let operator_mode = config.operator_mode.clone().unwrap_or_else(|| "local".to_string());
    let cloud_provider = config.cloud_provider.clone();
    let cloud_api_key = config.cloud_api_key.clone();
    let cloud_model = config.cloud_model.clone();
    let cloud_rest_model = config.cloud_rest_model.clone().or_else(|| cloud_model.clone());
    let cloud_language = config.cloud_language.clone();

    let session_start_ms = *state.session_start_ms.lock();
    let store = state.store.clone();
    let context_buffer = state.context_buffer.clone();
    let transcription_window = state.transcription_window.clone();
    let transcription_paused = state.transcription_paused.clone();
    let operator_muted = state.operator_muted.clone();
    let operator_ptt_active = state.operator_ptt_active.clone();
    let inference_semaphore = state.inference_semaphore.clone();
    let session_transcript = state.session_transcript.clone();
    let op_active = state.operator_is_active.clone();
    let bcast_tx_op = state.broadcast_tx.clone();

    let app_op = app.clone();
    tokio::spawn(async move {
        let mut buffer = Vec::with_capacity(48000 * 3);
        const OVERLAP: usize = 4000;
        const MIN_SAMPLES: usize = 8000; // 0.5s
        let is_cloud = operator_mode == "cloud" && cloud_provider.is_some() && cloud_api_key.is_some();
        let provider_name = if is_cloud { cloud_provider.clone().unwrap() } else { "local".to_string() };
        let mut was_ptt_active = false;
        let mut first_chunk = true;

        while let Some(chunk) = op_audio_rx.recv().await {
            if first_chunk {
                log_msg(&app_op, &format!("[Operator] PTT pipeline ready ({})", provider_name));
                first_chunk = false;
            }
            let window_size = *transcription_window.lock();
            let is_ptt_active = operator_ptt_active.load(std::sync::atomic::Ordering::Relaxed);
            let is_paused = transcription_paused.load(std::sync::atomic::Ordering::Relaxed);
            let is_muted = operator_muted.load(std::sync::atomic::Ordering::Relaxed);

            if is_muted { buffer.clear(); was_ptt_active = false; continue; }
            buffer.extend_from_slice(&chunk);

            let trigger_on_release = was_ptt_active && !is_ptt_active && buffer.len() >= MIN_SAMPLES;
            let trigger_on_window = is_ptt_active && buffer.len() >= window_size;

            if !is_paused && (trigger_on_release || trigger_on_window) {
                let buf_samples = buffer.len();
                let buf_ms = buf_samples * 1000 / 16000;
                let trigger_reason = if trigger_on_release { "PTT released" } else { "window full" };

                let maybe_permit = if !is_cloud {
                    match Arc::clone(&inference_semaphore).try_acquire_owned() {
                        Ok(p) => Some(p),
                        Err(_) => {
                            log_msg(&app_op, &format!("[Operator] Inference busy — window dropped ({} samples / {}ms)", buf_samples, buf_ms));
                            buffer.clear();
                            was_ptt_active = is_ptt_active;
                            continue;
                        }
                    }
                } else { None };

                log_msg(&app_op, &format!("[Operator] Voice search triggered: {} — {}ms via {}", trigger_reason, buf_ms, provider_name));

                let b_clone = buffer.clone();
                let e_clone = engine.clone();
                let s_clone = store.clone();
                let ctx_buf = context_buffer.clone();
                let op_p = cloud_provider.clone();
                let op_k = cloud_api_key.clone();
                let op_l = cloud_language.clone();
                let op_m = cloud_rest_model.clone();
                let app_op_inner = app_op.clone();
                let p_name = provider_name.clone();
                let tx_log = session_transcript.clone();
                let bcast_inner = bcast_tx_op.clone();

                tokio::spawn(async move {
                    let _permit = maybe_permit;
                    let t0 = std::time::Instant::now();
                    let result: Option<(String, Option<store::DisplayItem>, f32)> = if is_cloud {
                        if let Ok(text) = engine::cloud::transcribe_cloud(&b_clone, op_p.as_ref().unwrap(), op_k.as_ref().unwrap(), op_m.as_deref()).await {
                            log_msg(&app_op_inner, &format!("[Operator] Cloud transcription ({} ms): \"{}\"", t0.elapsed().as_millis(), &text[..text.len().min(80)]));
                            let t1 = std::time::Instant::now();
                            let result = tokio::task::spawn_blocking(move || {
                                let combined = { let mut buf = ctx_buf.lock(); buf.push(text.clone()); if buf.len() > 3 { buf.remove(0); } buf.join(" ") };
                                let embedding = e_clone.embed(&combined).ok();
                                let (verse, confidence) = s_clone.detect_verse_hybrid(&combined, embedding);
                                Some((text, verse.map(store::DisplayItem::Verse), confidence))
                            }).await.ok().flatten();
                            log_msg(&app_op_inner, &format!("[Operator] Verse detection ({} ms)", t1.elapsed().as_millis()));
                            result
                        } else {
                            log_msg(&app_op_inner, &format!("[Operator] Cloud transcription failed after {} ms", t0.elapsed().as_millis()));
                            None
                        }
                    } else {
                        let app_blk = app_op_inner.clone();
                        tokio::task::spawn_blocking(move || {
                            let t_whisper = std::time::Instant::now();
                            let text = match e_clone.transcribe(&b_clone, op_l.as_deref()) {
                                Ok(t) => t,
                                Err(e) => { log_msg(&app_blk, &format!("[Operator] Whisper error after {} ms: {}", t_whisper.elapsed().as_millis(), e)); return None; }
                            };
                            log_msg(&app_blk, &format!("[Operator] Whisper ({} ms): \"{}\"", t_whisper.elapsed().as_millis(), &text[..text.len().min(80)]));
                            let t_detect = std::time::Instant::now();
                            let combined = { let mut buf = ctx_buf.lock(); buf.push(text.clone()); if buf.len() > 3 { buf.remove(0); } buf.join(" ") };
                            let embedding = e_clone.embed(&combined).ok();
                            let (verse, confidence) = s_clone.detect_verse_hybrid(&combined, embedding);
                            log_msg(&app_blk, &format!("[Operator] Verse detection ({} ms): {}", t_detect.elapsed().as_millis(),
                                match &verse {
                                    Some(v) => format!("MATCH {} {}:{} (conf={:.2})", v.book, v.chapter, v.verse, confidence),
                                    None => format!("no match (conf={:.2})", confidence),
                                }
                            ));
                            Some((text, verse.map(store::DisplayItem::Verse), confidence))
                        }).await.ok().flatten()
                    };

                    if let Some((text, item, confidence)) = result {
                        if is_hallucination(&text) {
                            log_msg(&app_op_inner, &format!("[Operator] Hallucination filtered: \"{}\"", &text[..text.len().min(60)]));
                        } else {
                            let word_count = text.split_whitespace().count();
                            if word_count < 3 && item.is_none() {
                                log_msg(&app_op_inner, &format!("[Operator] Voice search skipped (too short, {} word(s)): \"{}\"", word_count, &text));
                            } else {
                                let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                                tx_log.lock().push(TranscriptSegment { text: text.clone(), timestamp_ms: now_ms.saturating_sub(session_start_ms), is_final: true, source: p_name.clone() });
                                log_msg(&app_op_inner, &format!("[Operator] Voice search done ({} ms) — emitting result", t0.elapsed().as_millis()));
                                let _ = app_op_inner.emit("operator-transcription-update", TranscriptionUpdate { text: text.clone(), detected_item: item, confidence, source: p_name, is_partial: false });
                                let _ = bcast_inner.send(serde_json::json!({ "type": "transcription", "text": text }).to_string());
                            }
                        }
                    }
                });

                if trigger_on_release || is_cloud { buffer.clear(); } else {
                    if buffer.len() > window_size * 2 { let to_drain = buffer.len() - (window_size + OVERLAP); buffer.drain(0..to_drain); }
                    else { let remaining = buffer.len().saturating_sub(OVERLAP); buffer = buffer[remaining..].to_vec(); }
                }
            }

            if !is_ptt_active && !trigger_on_release {
                if buffer.len() > 8000 { buffer.drain(0..buffer.len() - 8000); }
            }
            was_ptt_active = is_ptt_active;
        }
        op_active.store(false, Ordering::Relaxed);
        let _ = app_op.emit("operator-recording-status", serde_json::json!({"active": false}));
    });

    Ok(())
}

/// Stop the operator mic + PTT pipeline without stopping the whole session.
#[tauri::command]
async fn stop_operator_recording(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(handle) = state.operator_cloud_stream_handle.lock().take() {
        handle.stop();
    }
    state.operator_audio.lock().stop();
    state.operator_is_active.store(false, Ordering::Relaxed);
    log_msg(&app, "[Operator] Recording stopped");
    let _ = app.emit("operator-recording-status", serde_json::json!({"active": false}));
    Ok(())
}

/// C3: Stops the running session cleanly.
/// Dropping the CPAL stream closes the audio channel, which causes
/// the processing loop to exit on its next recv() call.
#[tauri::command]
async fn stop_session(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Signal the frontend immediately so the UI switches to "stopping" state.
    let _ = app.emit("session-status", SessionStatus {
        status: "stopping".to_string(),
        message: "Stopping session…".to_string(),
    });

    // Close cloud WebSocket streams first (graceful FIN before dropping audio channels).
    if let Some(handle) = state.operator_cloud_stream_handle.lock().take() {
        handle.stop();
    }
    if let Some(handle) = state.preacher_cloud_stream_handle.lock().take() {
        handle.stop();
    }

    // Dropping the CPAL stream closes the audio mpsc channel, which causes
    // the processing loops to exit on their next recv() → None.
    state.operator_audio.lock().stop();
    state.preacher_audio.lock().stop();
    *state.is_running.lock() = false;
    state.operator_is_active.store(false, Ordering::Relaxed);
    state.preacher_is_active.store(false, Ordering::Relaxed);

    // Auto-save the session transcript to disk
    let transcript = state.session_transcript.lock().clone();
    if !transcript.is_empty() {
        let transcripts_dir = state.app_data_dir.join("transcripts");
        let _ = fs::create_dir_all(&transcripts_dir);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let path = transcripts_dir.join(format!("{}.json", ts));
        if let Ok(json) = serde_json::to_string_pretty(&transcript) {
            let _ = atomic_write(&path, json);
        }
    }

    let _ = app.emit("session-status", SessionStatus {
        status: "stopped".to_string(),
        message: "Session stopped".to_string(),
    });
    Ok(())
}

/// Start the preacher mic + transcription pipeline independently of start_session.
/// Call this after start_session when you want the pastor feed to begin recording.
#[tauri::command]
async fn start_preacher_recording(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if !*state.is_running.lock() {
        return Err("No active session. Start the session first.".to_string());
    }
    if state.preacher_is_active.load(Ordering::Relaxed) {
        return Err("Preacher recording is already active.".to_string());
    }

    let op_dev = state.operator_audio.lock().selected_device().map(str::to_string);
    let pr_dev = state.preacher_audio.lock().selected_device().map(str::to_string);
    if pr_dev.is_none() {
        return Err("No preacher microphone selected. Choose a device in Settings.".to_string());
    }
    if pr_dev == op_dev {
        return Err("Preacher device is the same as the operator device. Select a separate microphone.".to_string());
    }

    let engine = match state.get_or_init_engine(&app).await {
        Ok(e) => e,
        Err(e) => return Err(format!("AI models failed to load: {}", e)),
    };

    let (pr_audio_tx, pr_audio_rx) = tokio::sync::mpsc::channel::<Vec<f32>>(128);
    let (pr_error_tx, mut pr_error_rx) = tokio::sync::mpsc::channel::<String>(10);
    let (pr_level_tx, mut pr_level_rx) = tokio::sync::mpsc::channel::<f32>(50);

    let pr_device = state.preacher_audio.lock().selected_device().map(|s| s.to_string()).unwrap_or_default();
    if let Err(e) = state.preacher_audio.lock().start_capturing(pr_audio_tx, pr_error_tx, Some(pr_level_tx), 16000.0) {
        return Err(format!("Preacher mic error: {}", e));
    }
    log_msg(&app, &format!("[Preacher] Recording started — device: \"{}\"", pr_device));

    let app_err = app.clone();
    tokio::spawn(async move { while let Some(msg) = pr_error_rx.recv().await { let _ = app_err.emit("audio-error", format!("Preacher: {}", msg)); } });
    let app_level = app.clone();
    tokio::spawn(async move { while let Some(level) = pr_level_rx.recv().await { let _ = app_level.emit("preacher-audio-level", level); } });

    state.preacher_is_active.store(true, Ordering::Relaxed);
    let _ = app.emit("preacher-recording-status", serde_json::json!({"active": true}));

    let config = state.transcription_config.lock().clone();
    let preacher_mode = config.preacher_mode.clone().unwrap_or_else(|| "cloud".to_string());
    let cloud_provider = config.cloud_provider.clone();
    let cloud_api_key = config.cloud_api_key.clone();
    let cloud_hostname = config.cloud_hostname.clone();
    let cloud_model = config.cloud_model.clone();
    let cloud_language = config.cloud_language.clone();

    let session_start_ms = *state.session_start_ms.lock();
    let preacher_muted = state.preacher_muted.clone();
    let session_transcript = state.session_transcript.clone();
    let context_buffer = state.context_buffer.clone();
    let transcription_window = state.transcription_window.clone();
    let transcription_paused = state.transcription_paused.clone();
    let inference_semaphore = state.inference_semaphore.clone();
    let preacher_is_active = state.preacher_is_active.clone();
    let store = state.store.clone();

    let preacher_use_stream = preacher_mode == "cloud"
        && cloud_provider.as_deref().map(engine::cloud_stream::provider_supports_streaming).unwrap_or(false)
        && cloud_api_key.is_some();

    let pr_provider_fb = cloud_provider.clone();
    let pr_api_key_fb = cloud_api_key.clone();
    let mut pr_audio_rx_fallback: Option<tokio::sync::mpsc::Receiver<Vec<f32>>> = None;

    if preacher_use_stream {
        let provider = cloud_provider.unwrap();
        let api_key = cloud_api_key.unwrap();
        log_msg(&app, &format!("[Preacher] Starting {} WebSocket stream (model={:?}, host={:?})", provider, cloud_model, cloud_hostname));
        let stream_result = engine::cloud_stream::start_stream(&app, &provider, &api_key, cloud_hostname.as_deref(), cloud_model.as_deref(), cloud_language.as_deref()).await;

        match stream_result {
            Ok((stream_handle, mut transcript_rx)) => {
                log_msg(&app, "[Preacher] Cloud WS stream connected — audio pump starting");
                *state.preacher_cloud_stream_handle.lock() = Some(stream_handle);
                let handle_arc = state.preacher_cloud_stream_handle.clone();
                let pr_muted_pump = preacher_muted.clone();
                let mut pr_audio_rx = pr_audio_rx;

                let app_pump = app.clone();
                tokio::spawn(async move {
                    let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    let mut first_chunk = true;
                    loop {
                        tokio::select! {
                            res = pr_audio_rx.recv() => {
                                if let Some(chunk) = res {
                                    if first_chunk {
                                        log_msg(&app_pump, "[Preacher] First audio chunk received — VAD active, streaming to cloud");
                                        first_chunk = false;
                                    }
                                    let is_muted = pr_muted_pump.load(Ordering::Relaxed);
                                    let bytes: Vec<u8> = chunk.iter()
                                        .map(|&s| if is_muted { 0i16 } else { (s.clamp(-1.0, 1.0) * 32767.0) as i16 })
                                        .flat_map(|s| s.to_le_bytes())
                                        .collect();
                                    if let Some(ref h) = *handle_arc.lock() {
                                        if h.audio_tx.send(bytes).is_err() { break; }
                                    } else { break; }
                                } else { break; }
                            }
                            _ = interval.tick() => {
                                let silence = vec![0u8; 320];
                                if let Some(ref h) = *handle_arc.lock() {
                                    if h.audio_tx.send(silence).is_err() { break; }
                                }
                            }
                        }
                    }
                });

                let app_pr = app.clone();
                let tx_log_pr = session_transcript.clone();
                let provider_name = provider.clone();
                let handle_arc_stop = state.preacher_cloud_stream_handle.clone();
                let engine_ws = engine.clone();
                let store_ws = store.clone();
                let ctx_buf_ws = context_buffer.clone();
                let pr_active = preacher_is_active.clone();

                tokio::spawn(async move {
                    while let Some(seg) = transcript_rx.recv().await {
                        let text = seg.text.trim().to_string();
                        if !seg.is_final || is_hallucination(&text) || text.is_empty() { continue; }
                        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                        tx_log_pr.lock().push(TranscriptSegment { text: text.clone(), timestamp_ms: now_ms.saturating_sub(session_start_ms), is_final: true, source: provider_name.clone() });
                        let word_count = text.split_whitespace().count();
                        let (detected_item, confidence) = if word_count >= 3 {
                            let e = engine_ws.clone();
                            let s = store_ws.clone();
                            let ctx = ctx_buf_ws.clone();
                            let t = text.clone();
                            tokio::task::spawn_blocking(move || {
                                let combined = { let mut buf = ctx.lock(); buf.push(t.clone()); if buf.len() > 3 { buf.remove(0); } buf.join(" ") };
                                let embedding = e.embed(&combined).ok();
                                let (verse, conf) = s.detect_verse_hybrid(&combined, embedding);
                                (verse.map(store::DisplayItem::Verse), conf)
                            }).await.unwrap_or((None, 0.0))
                        } else if let Some(verse) = store_ws.detect_verse_by_ref(&text) {
                            (Some(store::DisplayItem::Verse(verse)), 1.0)
                        } else {
                            log_msg(&app_pr, &format!("[Session] Final skipped (too short, {} word(s)): \"{}\"", word_count, &text));
                            (None, 0.0)
                        };
                        if let Some(store::DisplayItem::Verse(ref v)) = detected_item {
                            log_msg(&app_pr, &format!("[Session] Verse detected: {} {}:{} (conf={:.2})", v.book, v.chapter, v.verse, confidence));
                        } else if word_count >= 3 {
                            log_msg(&app_pr, &format!("[Session] Final transcript — no verse match (conf={:.2}): \"{}\"", confidence, &text[..text.len().min(60)]));
                        }
                        let _ = app_pr.emit("preacher-transcription-update", TranscriptionUpdate { text: text.clone(), detected_item, confidence, source: provider_name.clone(), is_partial: false });
                    }
                    *handle_arc_stop.lock() = None;
                    pr_active.store(false, Ordering::Relaxed);
                    let _ = app_pr.emit("preacher-recording-status", serde_json::json!({"active": false}));
                });
            }
            Err(e) => {
                log_msg(&app, &format!("[Preacher] Cloud WS failed: {}. Falling back to local/REST.", e));
                let _ = app.emit("audio-error", format!("Preacher cloud stream failed: {}. Using local transcription.", e));
                pr_audio_rx_fallback = Some(pr_audio_rx);
            }
        }
    } else {
        pr_audio_rx_fallback = Some(pr_audio_rx);
    }

    if let Some(mut pr_audio_rx) = pr_audio_rx_fallback {
        let app_pr = app.clone();
        let engine_pr = engine.clone();
        let pr_provider = pr_provider_fb;
        let pr_api_key = pr_api_key_fb;
        let pr_language = cloud_language.clone();
        let pr_model = cloud_model.clone();
        let pr_active = preacher_is_active.clone();

        tokio::spawn(async move {
            let mut buffer = Vec::with_capacity(48000 * 3);
            const OVERLAP: usize = 4000;
            let is_cloud = preacher_mode == "cloud" && pr_provider.is_some() && pr_api_key.is_some();
            let provider_name = if is_cloud { pr_provider.clone().unwrap() } else { "local".to_string() };

            while let Some(chunk) = pr_audio_rx.recv().await {
                let is_muted = preacher_muted.load(Ordering::Relaxed);
                if is_muted { buffer.clear(); continue; }

                buffer.extend_from_slice(&chunk);

                let window_size = *transcription_window.lock();
                let paused = transcription_paused.load(std::sync::atomic::Ordering::Relaxed);
                if paused {
                    if buffer.len() > window_size { let keep = buffer.len().min(8000); buffer.drain(0..buffer.len() - keep); }
                    continue;
                }

                if buffer.len() >= window_size {
                    let maybe_permit = if !is_cloud {
                        match Arc::clone(&inference_semaphore).try_acquire_owned() {
                            Ok(p) => Some(p),
                            Err(_) => { let keep = buffer.len().min(OVERLAP); buffer.drain(0..buffer.len() - keep); continue; }
                        }
                    } else { None };

                    let b_clone = buffer.clone();
                    let e_clone = engine_pr.clone();
                    let pr_m = pr_model.clone();
                    let lang_opt = pr_language.clone();
                    let prov = pr_provider.clone();
                    let key = pr_api_key.clone();
                    let tx_log = session_transcript.clone();
                    let app_pr_inner = app_pr.clone();
                    let p_name = provider_name.clone();

                    tokio::spawn(async move {
                        let _permit = maybe_permit;
                        let text_opt: Option<String> = if is_cloud {
                            engine::cloud::transcribe_cloud(&b_clone, prov.as_ref().unwrap(), key.as_ref().unwrap(), pr_m.as_deref()).await.ok()
                        } else {
                            tokio::task::spawn_blocking(move || { e_clone.transcribe(&b_clone, lang_opt.as_deref()).ok() }).await.ok().flatten()
                        };

                        if let Some(text) = text_opt {
                            if !is_hallucination(&text) {
                                let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                                tx_log.lock().push(TranscriptSegment { text: text.clone(), timestamp_ms: now_ms.saturating_sub(session_start_ms), is_final: true, source: p_name.clone() });
                                let _ = app_pr_inner.emit("preacher-transcription-update", TranscriptionUpdate { text: text.clone(), detected_item: None, confidence: 1.0, source: p_name, is_partial: false });
                            }
                        }
                    });

                    if is_cloud { buffer.clear(); } else {
                        if buffer.len() > window_size * 2 { let to_drain = buffer.len() - (window_size + OVERLAP); buffer.drain(0..to_drain); } else { let remaining = buffer.len().saturating_sub(OVERLAP); buffer = buffer[remaining..].to_vec(); }
                    }
                }
            }
            pr_active.store(false, Ordering::Relaxed);
            let _ = app_pr.emit("preacher-recording-status", serde_json::json!({"active": false}));
        });
    }

    Ok(())
}

/// Stop the preacher mic + transcription pipeline without stopping the whole session.
#[tauri::command]
async fn stop_preacher_recording(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(handle) = state.preacher_cloud_stream_handle.lock().take() {
        handle.stop();
    }
    state.preacher_audio.lock().stop();
    state.preacher_is_active.store(false, Ordering::Relaxed);
    log_msg(&app, "[Preacher] Recording stopped by operator");
    let _ = app.emit("preacher-recording-status", serde_json::json!({"active": false}));
    Ok(())
}

#[tauri::command]
async fn toggle_output_window(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("output") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e: tauri::Error| e.to_string())?;
        } else {
            // Use preferred_monitor from settings if set; fall back to first secondary.
            let preferred = state.settings.lock().preferred_monitor.clone();
            let monitors = window
                .available_monitors()
                .map_err(|e: tauri::Error| e.to_string())?;
            if monitors.len() > 1 {
                if let Some(primary) = window
                    .primary_monitor()
                    .map_err(|e: tauri::Error| e.to_string())?
                {
                    let target = monitors.iter().find(|m| {
                        preferred.as_deref().map_or(false, |p| {
                            m.name().map_or(false, |n| n == p)
                        })
                    }).or_else(|| monitors.iter().find(|m| m.name() != primary.name()));
                    if let Some(mon) = target {
                        let pos = mon.position();
                        window
                            .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                                x: pos.x,
                                y: pos.y,
                            }))
                            .map_err(|e: tauri::Error| e.to_string())?;
                        window
                            .set_fullscreen(true)
                            .map_err(|e: tauri::Error| e.to_string())?;
                    }
                }
            }
            let _ = window.set_ignore_cursor_events(true);
            window.show().map_err(|e: tauri::Error| e.to_string())?;
            window
                .set_focus()
                .map_err(|e: tauri::Error| e.to_string())?;

            // Sync settings so the output window uses the current theme/position.
            let current_settings = state.settings.lock().clone();
            let _ = app.emit("settings-changed", current_settings);

            // Sync the current live item so the output window doesn't show
            // "Waiting for projection..." when re-opened after being hidden.
            let live = state.live_item.lock().clone();
            if let Some(item) = live {
                let update = TranscriptionUpdate {
                    text: item.to_label(),
                    detected_item: Some(item),
                    confidence: 1.0,
                    source: "manual".to_string(),
                    is_partial: false,
                };
                let _ = app.emit("operator-transcription-update", &update);
                let _ = app.emit("preacher-transcription-update", &update);
            }

            // Sync lower third so it reappears if active when window was hidden.
            let lt = state.lower_third.lock().clone();
            let _ = app.emit("lower-third-update", lt);

            // Sync props layer.
            let props = state.props_layer.lock().clone();
            let _ = app.emit("props-update", &props);

            // Sync staged item.
            let staged = state.staged_item.lock().clone();
            let _ = app.emit("item-staged", staged.as_ref());
        }
    }
    Ok(())
}

#[tauri::command]
async fn get_audio_devices(
    state: State<'_, AppState>,
) -> Result<Vec<(String, String)>, String> {
    let audio = state.operator_audio.lock();
    audio
        .list_devices()
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn toggle_ndi(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    let mut config = state.ndi_manager.config.lock();
    config.enabled = enabled;
    Ok(())
}

#[tauri::command]
async fn get_ndi_config(state: State<'_, AppState>) -> Result<ndi::NdiConfig, String> {
    Ok(state.ndi_manager.config.lock().clone())
}

#[tauri::command]
async fn set_operator_device(
    state: State<'_, AppState>,
    device_name: String,
) -> Result<(), String> {
    if *state.is_running.lock() {
        state.operator_audio.lock()
            .hot_swap_device(&device_name)
            .map_err(|e: anyhow::Error| e.to_string())
    } else {
        state.operator_audio.lock()
            .select_device(&device_name)
            .map_err(|e: anyhow::Error| e.to_string())
    }
}

#[tauri::command]
async fn set_preacher_device(
    app: AppHandle,
    state: State<'_, AppState>,
    device_name: String,
) -> Result<(), String> {
    let is_running = *state.is_running.lock();
    let is_active = state.preacher_audio.lock().session_active();

    if is_running && is_active {
        // Hot-swap: preacher pipeline already running → swap to new device
        state.preacher_audio.lock()
            .hot_swap_device(&device_name)
            .map_err(|e: anyhow::Error| e.to_string())
    } else if is_running && !is_active {
        // Preacher pipeline not started this session — takes effect on next session start
        state.preacher_audio.lock()
            .select_device(&device_name)
            .map_err(|e: anyhow::Error| e.to_string())?;
        let _ = app.emit("session-toast", "Preacher mic change takes effect on next session start");
        Ok(())
    } else {
        state.preacher_audio.lock()
            .select_device(&device_name)
            .map_err(|e: anyhow::Error| e.to_string())
    }
}

#[tauri::command]
async fn set_operator_ptt(state: State<'_, AppState>, active: bool) -> Result<(), String> {
    state.operator_ptt_active.store(active, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn split_verse(verse: store::Verse, threshold: Option<usize>) -> Vec<store::Verse> {
    let limit = threshold.unwrap_or(200);
    let text = verse.text.trim();
    if text.len() <= limit {
        return vec![verse];
    }

    let mut slides = Vec::new();
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut current_text = String::new();
    
    for word in words {
        if !current_text.is_empty() && current_text.len() + word.len() + 1 > limit {
            slides.push(current_text.trim().to_string());
            current_text = String::new();
        }
        if !current_text.is_empty() {
            current_text.push(' ');
        }
        current_text.push_str(word);
    }
    if !current_text.is_empty() {
        slides.push(current_text.trim().to_string());
    }

    let total = slides.len();
    slides.into_iter().enumerate().map(|(i, t)| {
        let mut v = verse.clone();
        v.text = t;
        v.split_index = Some(i);
        v.total_splits = Some(total);
        v
    }).collect()
}

#[tauri::command]
async fn get_bible_versions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.store.get_available_versions())
}

#[tauri::command]
async fn set_bible_version(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    version: String,
) -> Result<(), String> {
    state.store.set_active_version(&app, &version);
    Ok(())
}

#[tauri::command]
async fn search_manual(
    state: State<'_, AppState>,
    query: String,
    version: String,
) -> Result<Vec<store::Verse>, String> {
    state
        .store
        .search_manual(&query, &version)
        .map_err(|e: anyhow::Error| e.to_string())
}

/// Hybrid search across all versions using ONNX embedding + keyword search with RRF.
#[tauri::command]
async fn search_semantic_query(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    query: String,
) -> Result<store::SearchResponse, String> {
    state.search_bible(&app, &query).await
}

/// Read a file from disk and return its contents as a base64 string.
/// Path is restricted to the application's local data directory for security.
#[tauri::command]
async fn read_file_base64(app: tauri::AppHandle, path: String) -> Result<String, String> {
    use base64::Engine as _;
    let data_dir = app.path().app_local_data_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;

    let requested_path = std::path::PathBuf::from(&path);

    // Canonicalize to resolve .. and symlinks BEFORE the security check
    let canonical = std::fs::canonicalize(&requested_path)
        .map_err(|_| "Access denied: path could not be resolved".to_string())?;
    let canonical_data_dir = std::fs::canonicalize(&data_dir).unwrap_or(data_dir);

    if !canonical.starts_with(&canonical_data_dir) {
        return Err("Access denied: path is outside of authorized data directory".to_string());
    }

    let bytes = std::fs::read(&canonical).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
async fn get_books(state: State<'_, AppState>, version: String) -> Result<Vec<String>, String> {
    state
        .store
        .get_books(&version)
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_chapters(
    state: State<'_, AppState>,
    book: String,
    version: String,
) -> Result<Vec<i32>, String> {
    state
        .store
        .get_chapters(&book, &version)
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_verses_count(
    state: State<'_, AppState>,
    book: String,
    chapter: i32,
    version: String,
) -> Result<Vec<i32>, String> {
    state
        .store
        .get_verses_count(&book, chapter, &version)
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_chapter(
    state: State<'_, AppState>,
    book: String,
    chapter: i32,
    version: String,
) -> Result<Vec<store::Verse>, String> {
    state
        .store
        .get_chapter_verses(&book, chapter, &version)
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn get_verse(
    state: State<'_, AppState>,
    book: String,
    chapter: i32,
    verse: i32,
    version: String,
) -> Result<Option<store::Verse>, String> {
    state
        .store
        .get_verse(&book, chapter, verse, &version)
        .map_err(|e: anyhow::Error| e.to_string())
}

/// Called by the output window on mount to retrieve the last live item,
/// ensuring it shows current content even if it missed earlier events.
#[tauri::command]
async fn get_current_item(
    state: State<'_, AppState>,
) -> Result<Option<store::DisplayItem>, String> {
    Ok(state.live_item.lock().clone())
}

#[tauri::command]
async fn get_staged_item(
    state: State<'_, AppState>,
) -> Result<Option<store::DisplayItem>, String> {
    Ok(state.staged_item.lock().clone())
}

#[tauri::command]
async fn get_remote_proposals(
    state: State<'_, AppState>,
) -> Result<Vec<RemoteProposal>, String> {
    Ok(state.remote_proposals.lock().values().cloned().collect())
}

#[tauri::command]
async fn dismiss_remote_proposal(
    state: State<'_, AppState>,
    operator_key: String,
) -> Result<(), String> {
    state.remote_proposals.lock().remove(&operator_key);
    
    // Notify the specific client that their proposal was handled (accepted or dismissed)
    remote::send_to(&state, &operator_key, json!({ "type": "proposal_handled" }).to_string());

    // Broadcast update to all clients and Tauri windows
    remote::broadcast_remote_proposals(&state);
    Ok(())
}

#[tauri::command]
async fn stage_item(
    app: AppHandle,
    state: State<'_, AppState>,
    item: store::DisplayItem,
) -> Result<(), String> {
    *state.staged_item.lock() = Some(item.clone());
    let _ = app.emit("item-staged", &item);
    // Notify stage display window
    let _ = app.emit("stage-update", Some(&item));
    Ok(())
}

#[tauri::command]
async fn save_recovery(state: State<'_, AppState>, data: serde_json::Value) -> Result<(), String> {
    let path = state.app_data_dir.join("recovery.json");
    if let Ok(json) = serde_json::to_string_pretty(&data) {
        let _ = atomic_write(&path, json);
    }
    Ok(())
}

#[tauri::command]
async fn load_recovery(state: State<'_, AppState>) -> Result<Option<serde_json::Value>, String> {
    let path = state.app_data_dir.join("recovery.json");
    if !path.exists() {
        return Ok(None);
    }
    let json = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let data: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(Some(data))
}

#[tauri::command]
async fn clear_recovery(state: State<'_, AppState>) -> Result<(), String> {
    let path = state.app_data_dir.join("recovery.json");
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

#[tauri::command]
async fn go_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let staged = state.staged_item.lock().clone();
    if let Some(item) = staged {
        go_live_item(app, state, item).await?;
    }
    Ok(())
}

#[tauri::command]
async fn go_live_item(
    app: AppHandle,
    state: State<'_, AppState>,
    item: store::DisplayItem,
) -> Result<(), String> {
    *state.live_item.lock() = Some(item.clone());
    
    let mut is_media = false;
    if let store::DisplayItem::Media(ref m) = item {
        if matches!(m.media_type, store::MediaItemType::Video) { is_media = true; }
    }
    state.operator_audio.lock().media_playing.store(is_media, std::sync::atomic::Ordering::Relaxed);
    state.preacher_audio.lock().media_playing.store(is_media, std::sync::atomic::Ordering::Relaxed);
    
    use tauri::Emitter;
    let update = TranscriptionUpdate {
        text: item.to_label(),
        detected_item: Some(item.clone()),
        confidence: 1.0,
        source: "manual".to_string(),
        is_partial: false,
    };
    let _ = app.emit("operator-transcription-update", &update);
    let _ = app.emit("preacher-transcription-update", &update);
    // Broadcast to WS remote clients
    let _ = state.broadcast_tx.send(
        serde_json::json!({ "type": "state", "live_item": item }).to_string()
    );
    Ok(())
}

#[tauri::command]
async fn clear_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    *state.live_item.lock() = None;
    state.operator_audio.lock().media_playing.store(false, std::sync::atomic::Ordering::Relaxed);
    state.preacher_audio.lock().media_playing.store(false, std::sync::atomic::Ordering::Relaxed);
    let update = TranscriptionUpdate {
        text: "".to_string(),
        detected_item: None,
        confidence: 1.0,
        source: "manual".to_string(),
        is_partial: false,
    };
    let _ = app.emit("operator-transcription-update", &update);
    let _ = app.emit("preacher-transcription-update", &update);
    // Broadcast to WS remote clients
    let _ = state.broadcast_tx.send(
        serde_json::json!({ "type": "state", "live_item": null }).to_string()
    );
    // Clear stage display
    let _ = app.emit("stage-update", Option::<store::DisplayItem>::None);
    Ok(())
}

/// Updates the `started_at` timestamp on the currently-live timer item and re-emits it
/// so both windows tick from the same reference point.
#[tauri::command]
async fn update_timer(
    app: AppHandle,
    state: State<'_, AppState>,
    started_at: Option<u64>,
) -> Result<(), String> {
    let mut live = state.live_item.lock();
    if let Some(store::DisplayItem::Timer(ref mut t)) = *live {
        t.started_at = started_at;
        let item = live.clone().unwrap();
        drop(live);
        let update = TranscriptionUpdate {
            text: item.to_label(),
            detected_item: Some(item),
            confidence: 1.0,
            source: "manual".to_string(),
            is_partial: false,
        };
        let _ = app.emit("operator-transcription-update", &update);
        let _ = app.emit("preacher-transcription-update", &update);
    }
    Ok(())
}

/// Shows or hides the stage display window.
#[tauri::command]
async fn toggle_stage_window(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("stage") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e: tauri::Error| e.to_string())?;
        } else {
            window.show().map_err(|e: tauri::Error| e.to_string())?;
            window.set_focus().map_err(|e: tauri::Error| e.to_string())?;

            // Re-sync live and staged items so stage display is correct after re-open.
            let live = state.live_item.lock().clone();
            if let Some(item) = live {
                let update = TranscriptionUpdate {
                    text: item.to_label(),
                    detected_item: Some(item),
                    confidence: 1.0,
                    source: "manual".to_string(),
                    is_partial: false,
                };
                let _ = app.emit("operator-transcription-update", &update);
                let _ = app.emit("preacher-transcription-update", &update);
            }
            let staged = state.staged_item.lock().clone();
            let _ = app.emit("item-staged", staged.as_ref());
        }
    }
    Ok(())
}

/// Shows or hides the Design Hub window.
#[tauri::command]
async fn toggle_design_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("design") {
        if window.is_visible().unwrap_or(false) {
            window.hide().map_err(|e: tauri::Error| e.to_string())?;
        } else {
            window.show().map_err(|e: tauri::Error| e.to_string())?;
            window.set_focus().map_err(|e: tauri::Error| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn toggle_studio_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("studio") {
        let is_visible = window.is_visible().unwrap_or(false);
        if is_visible {
            window.hide().map_err(|e: tauri::Error| e.to_string())?;
        } else {
            window.show().map_err(|e: tauri::Error| e.to_string())?;
            window.set_focus().map_err(|e: tauri::Error| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn set_studio_device(state: State<'_, AppState>, device_name: String) -> Result<(), String> {
    let mut audio = state.studio_audio.lock();
    audio.select_device(&device_name).map_err(|e| e.to_string())?;
    // If a recording session is active, hot-swap the device
    if state.studio_is_active.load(Ordering::Relaxed) {
        audio.hot_swap_device(&device_name).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
struct StudioRecording {
    id: String,
    name: String,
    path: String,
    size_mb: f32,
    date: String,
    duration: String,
    transcribed: bool,
}

#[derive(Serialize)]
struct RecordingPeaks {
    peaks: Vec<f32>,
    duration: f32,
}

/// Read a studio recording's WAV file and return waveform peak amplitudes.
/// Returns n_peaks values (default 1000) in [0.0, 1.0] plus the duration in seconds.
/// This lets the frontend render the waveform WITHOUT calling AudioContext.decodeAudioData,
/// which fails on Linux/WebKitGTK for 16 kHz mono WAV files.
#[tauri::command]
async fn get_recording_peaks(
    state: State<'_, AppState>,
    id: String,
    n_peaks: Option<usize>,
) -> Result<RecordingPeaks, String> {
    let path = state.app_data_dir.join("recordings").join(format!("{}.wav", id));
    tauri::async_runtime::spawn_blocking(move || {
        let reader = hound::WavReader::open(&path).map_err(|e| e.to_string())?;
        let spec = reader.spec();
        let total_samples = reader.duration() as usize;
        let duration = total_samples as f32 / spec.sample_rate as f32;

        let n = n_peaks.unwrap_or(1000).clamp(100, 8000);
        let window = (total_samples / n).max(1);

        let all_samples: Vec<f32> = reader
            .into_samples::<i16>()
            .filter_map(|s| s.ok())
            .map(|s| s as f32 / i16::MAX as f32)
            .collect();

        let peaks: Vec<f32> = all_samples
            .chunks(window)
            .map(|chunk| chunk.iter().map(|s| s.abs()).fold(0.0f32, f32::max))
            .collect();

        Ok(RecordingPeaks { peaks, duration })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_studio_recordings(state: State<'_, AppState>) -> Result<Vec<StudioRecording>, String> {
    let recordings_dir = state.app_data_dir.join("recordings");
    if !recordings_dir.exists() {
        fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?;
        return Ok(vec![]);
    }

    let mut list = Vec::new();
    let entries = fs::read_dir(recordings_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.is_file() && path.extension().map_or(false, |ext| ext == "wav") {
                let metadata = entry.metadata().map_err(|e| e.to_string())?;
                let id = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                let name = id.clone();
                let size_bytes = metadata.len();
                let size_mb = size_bytes as f32 / 1024.0 / 1024.0;
                let date = metadata.modified().map(|m| {
                    chrono::DateTime::<chrono::Local>::from(m).format("%Y-%m-%d %H:%M").to_string()
                }).unwrap_or_default();
                
                let duration = hound::WavReader::open(&path).map(|r| {
                    let secs = r.duration() / r.spec().sample_rate;
                    format!("{}:{:02}", secs / 60, secs % 60)
                }).unwrap_or_else(|_| {
                    let secs = size_bytes / (16000 * 2);
                    format!("{}:{:02}", secs / 60, secs % 60)
                });
                
                let transcribed = state.app_data_dir.join("recordings").join(format!("{}.txt", id)).exists();

                list.push(StudioRecording {
                    id,
                    name,
                    path: path.to_string_lossy().to_string(),
                    size_mb,
                    date,
                    duration,
                    transcribed,
                });
            }
        }
    }
    
    // Sort by date descending
    list.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(list)
}

#[tauri::command]
async fn delete_studio_recording(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let path = state.app_data_dir.join("recordings").join(format!("{}.wav", id));
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    // Also remove transcription if exists
    let txt_path = state.app_data_dir.join("recordings").join(format!("{}.txt", id));
    if txt_path.exists() {
        let _ = fs::remove_file(txt_path);
    }
    Ok(())
}

#[tauri::command]
async fn rename_studio_recording(state: State<'_, AppState>, id: String, new_name: String) -> Result<(), String> {
    // Strip .wav if the user included it manually
    let clean_name = if new_name.to_lowercase().ends_with(".wav") {
        &new_name[..new_name.len() - 4]
    } else {
        &new_name
    };

    if clean_name.contains('/') || clean_name.contains('\\') || clean_name.contains("..") {
        return Err("Invalid recording name".to_string());
    }

    let old_path = state.app_data_dir.join("recordings").join(format!("{}.wav", id));
    let new_path = state.app_data_dir.join("recordings").join(format!("{}.wav", clean_name));
    if old_path.exists() {
        fs::rename(old_path, new_path).map_err(|e| e.to_string())?;
    }
    // Also rename transcription if exists
    let old_txt = state.app_data_dir.join("recordings").join(format!("{}.txt", id));
    let new_txt = state.app_data_dir.join("recordings").join(format!("{}.txt", clean_name));
    if old_txt.exists() {
        let _ = fs::rename(old_txt, new_txt);
    }
    Ok(())
}

#[tauri::command]
async fn get_studio_recording_transcript(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let txt_path = state.app_data_dir.join("recordings").join(format!("{}.txt", id));
    if txt_path.exists() {
        fs::read_to_string(txt_path).map_err(|e| e.to_string())
    } else {
        Ok("".to_string())
    }
}

#[tauri::command]
async fn transcribe_studio_recording(app: AppHandle, state: State<'_, AppState>, id: String, mode: Option<String>) -> Result<String, String> {
    let path = state.app_data_dir.join("recordings").join(format!("{}.wav", id));
    if !path.exists() {
        return Err("Recording not found".to_string());
    }

    let config = state.transcription_config.lock().clone();
    let selected_mode = mode.unwrap_or_else(|| "local".to_string());

    // Load audio from WAV
    let mut reader = hound::WavReader::open(&path).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => reader.samples::<i16>()
            .map(|s| s.unwrap_or(0) as f32 / i16::MAX as f32)
            .collect(),
        hound::SampleFormat::Float => reader.samples::<f32>()
            .map(|s| s.unwrap_or(0.0))
            .collect(),
    };

    if samples.is_empty() {
        return Err("Audio file is empty".to_string());
    }

    let _ = app.emit("studio-transcription-status", serde_json::json!({"id": id, "status": "processing"}));

    let result = if selected_mode == "cloud" {
        let provider = config.cloud_provider.clone().ok_or("No cloud provider configured in Settings")?;
        let api_key = config.cloud_api_key.clone().ok_or("No cloud API key configured")?;
        let model = config.cloud_rest_model.clone().or(config.cloud_model.clone());

        engine::cloud::transcribe_cloud(&samples, &provider, &api_key, model.as_deref())
            .await
            .map_err(|e| format!("Cloud transcription failed: {}", e))?
    } else {
        let engine = state.get_or_init_engine(&app).await?;
        tauri::async_runtime::spawn_blocking(move || {
            engine.transcribe(&samples, None)
        }).await.map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
    };

    // Save transcription next to the audio file
    let txt_path = state.app_data_dir.join("recordings").join(format!("{}.txt", id));
    fs::write(txt_path, &result).map_err(|e| e.to_string())?;

    let _ = app.emit("studio-transcription-status", serde_json::json!({"id": id, "status": "complete", "text": result.clone()}));

    Ok(result)
}

#[tauri::command]
async fn trim_studio_recording(state: State<'_, AppState>, id: String, start_sec: f32, end_sec: f32, new_id: Option<String>, fade_in_sec: Option<f32>, fade_out_sec: Option<f32>) -> Result<(), String> {
    let path = state.app_data_dir.join("recordings").join(format!("{}.wav", id));
    if !path.exists() {
        return Err("Recording not found".to_string());
    }

    let target_id = new_id.unwrap_or_else(|| id.clone());
    let target_path = state.app_data_dir.join("recordings").join(format!("{}.wav", target_id));

    // Run heavy file I/O on a blocking thread to avoid stalling the Tokio executor.
    tauri::async_runtime::spawn_blocking(move || {
        let mut reader = hound::WavReader::open(&path).map_err(|e| e.to_string())?;
        let spec = reader.spec();
        let sample_rate = spec.sample_rate as f32;
        let channels = spec.channels as usize;

        let start_sample = (start_sec * sample_rate) as u32 * channels as u32;
        let end_sample = (end_sec * sample_rate) as u32 * channels as u32;

        let samples: Vec<i16> = reader.samples::<i16>()
            .map(|s| s.unwrap_or(0))
            .collect();

        // Drop reader so we can overwrite the file if target_path == path
        drop(reader);

        if start_sample >= end_sample || end_sample as usize > samples.len() {
            return Err("Invalid trim range".to_string());
        }

        // Convert trimmed slice to f32 for fade processing
        let mut faded: Vec<f32> = samples[start_sample as usize..end_sample as usize]
            .iter()
            .map(|&s| s as f32 / 32768.0)
            .collect();

        // Apply linear fade-in
        if let Some(fi) = fade_in_sec {
            if fi > 0.0 {
                let fi_frames = ((fi * sample_rate).round() as usize * channels).min(faded.len());
                for i in 0..fi_frames {
                    faded[i] *= i as f32 / fi_frames as f32;
                }
            }
        }

        // Apply linear fade-out
        if let Some(fo) = fade_out_sec {
            if fo > 0.0 {
                let fo_frames = ((fo * sample_rate).round() as usize * channels).min(faded.len());
                let start_idx = faded.len().saturating_sub(fo_frames);
                for i in 0..fo_frames {
                    faded[start_idx + i] *= 1.0 - (i as f32 / fo_frames as f32);
                }
            }
        }

        let mut writer = hound::WavWriter::create(&target_path, spec).map_err(|e| e.to_string())?;
        for s in faded {
            let sample = (s * 32767.0).clamp(-32768.0, 32767.0) as i16;
            writer.write_sample(sample).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn start_studio_recording(app: AppHandle, state: State<'_, AppState>, sample_rate: Option<u32>) -> Result<(), String> {
    if state.studio_is_active.load(Ordering::Relaxed) {
        return Err("Recording already in progress".to_string());
    }
    let sample_rate = sample_rate.unwrap_or(44100).clamp(8000, 192000);

    let recordings_dir = state.app_data_dir.join("recordings");
    if !recordings_dir.exists() {
        fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?;
    }

    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let filename = format!("rec_{}.wav", timestamp);
    let path = recordings_dir.join(&filename);

    let (audio_tx, mut audio_rx) = tokio::sync::mpsc::channel::<Vec<f32>>(100);
    let (error_tx, mut error_rx) = tokio::sync::mpsc::channel::<String>(10);
    let (level_tx, mut level_rx) = tokio::sync::mpsc::channel::<f32>(50);

    state.studio_is_active.store(true, Ordering::Relaxed);
    let is_active = state.studio_is_active.clone();
    
    // Start capturing in the studio_audio engine
    {
        let mut audio = state.studio_audio.lock();
        audio.start_capturing(audio_tx, error_tx, Some(level_tx), sample_rate as f64).map_err(|e| e.to_string())?;
    }

    let path_clone = path.clone();
    // Spawn task to write to file
    tauri::async_runtime::spawn(async move {
        let stem = path_clone.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = match hound::WavWriter::create(path_clone, spec) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("Failed to create WavWriter: {}", e);
                is_active.store(false, Ordering::Relaxed);
                return;
            }
        };

        while is_active.load(Ordering::Relaxed) {
            tokio::select! {
                res = audio_rx.recv() => {
                    if let Some(samples) = res {
                        for s in samples {
                            let sample = (s * std::i16::MAX as f32).clamp(-32768.0, 32767.0) as i16;
                            if let Err(e) = writer.write_sample(sample) {
                                eprintln!("Failed to write sample: {}", e);
                                is_active.store(false, Ordering::Relaxed);
                                break;
                            }
                        }
                    } else {
                        break;
                    }
                }
                res = level_rx.recv() => {
                    if let Some(level) = res {
                        let _ = app.emit("studio-audio-level", level);
                    } else {
                        break;
                    }
                }
                res = error_rx.recv() => {
                    if let Some(err) = res {
                        let _ = app.emit("studio-audio-error", err);
                    } else {
                        break;
                    }
                }
            }
        }
        let _ = writer.finalize();
        let _ = app.emit("studio-recording-saved", stem);
    });

    Ok(())
}

#[tauri::command]
async fn stop_studio_recording(state: State<'_, AppState>) -> Result<(), String> {
    state.studio_is_active.store(false, Ordering::Relaxed);
    state.studio_audio.lock().stop();
    Ok(())
}

#[tauri::command]
async fn import_studio_audio(app: AppHandle, state: State<'_, AppState>, path: String, sample_rate: Option<u32>) -> Result<(), String> {
    let source_path = PathBuf::from(path);
    if !source_path.exists() {
        return Err("File not found".to_string());
    }

    let recordings_dir = state.app_data_dir.join("recordings");
    if !recordings_dir.exists() {
        fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?;
    }

    let stem = source_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let target_filename = format!("{}_imported.wav", stem);
    let target_path = recordings_dir.join(target_filename);

    let sample_rate = sample_rate.unwrap_or(44100).clamp(8000, 192000);

    // Run transcoding in a separate thread
    tauri::async_runtime::spawn_blocking(move || {
        let res = (|| -> Result<(), String> {
            log_msg(&app, &format!("[Studio] Importing audio from: {:?}", source_path));
            let file = fs::File::open(&source_path).map_err(|e| e.to_string())?;
            let mss = MediaSourceStream::new(Box::new(file), Default::default());
            
            let mut hint = Hint::new();
            if let Some(ext) = source_path.extension().and_then(|s| s.to_str()) {
                hint.with_extension(ext);
            }

            let meta_opts = MetadataOptions::default();
            let fmt_opts = FormatOptions::default();
            
            let probed = symphonia::default::get_probe().format(&hint, mss, &fmt_opts, &meta_opts)
                .map_err(|e| e.to_string())?;
            
            let mut format = probed.format;
            let track = format.tracks().iter().find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
                .ok_or_else(|| "No supported audio track found".to_string())?;
            
            let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())
                .map_err(|e| e.to_string())?;

            let track_id = track.id;
            let source_rate = track.codec_params.sample_rate.unwrap_or(44100) as f64;
            let source_channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);
            let target_rate = sample_rate as f64;

            let spec = hound::WavSpec {
                channels: 1,
                sample_rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = hound::WavWriter::create(target_path, spec).map_err(|e| e.to_string())?;

            // Setup resampler if rate differs
            let mut resampler = if (source_rate - target_rate).abs() > 0.1 {
                let params = rubato::SincInterpolationParameters {
                    sinc_len: 256,
                    f_cutoff: 0.95,
                    interpolation: rubato::SincInterpolationType::Linear,
                    window: rubato::WindowFunction::BlackmanHarris2,
                    oversampling_factor: 256,
                };
                Some(rubato::SincFixedIn::<f32>::new(target_rate / source_rate, 2.0, params, 1024, source_channels).map_err(|e| e.to_string())?)
            } else {
                None
            };

            let mut sample_buf = None;

            loop {
                let packet = match format.next_packet() {
                    Ok(p) => p,
                    Err(symphonia::core::errors::Error::IoError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                    Err(e) => return Err(e.to_string()),
                };

                if packet.track_id() != track_id { continue; }
                
                let decoded = decoder.decode(&packet).map_err(|e| e.to_string())?;

                if sample_buf.is_none() {
                    let spec = *decoded.spec();
                    let duration = decoded.capacity() as u64;
                    sample_buf = Some(symphonia::core::audio::SampleBuffer::<f32>::new(duration, spec));
                }

                if let Some(buf) = sample_buf.as_mut() {
                    buf.copy_interleaved_ref(decoded);
                    let samples = buf.samples();
                    
                    // Convert interleaved samples to planar for rubato or mono conversion
                    let mut planar = vec![vec![0.0f32; samples.len() / source_channels]; source_channels];
                    for (i, &s) in samples.iter().enumerate() {
                        planar[i % source_channels][i / source_channels] = s;
                    }

                    let mono_samples = if let Some(ref mut rs) = resampler {
                        let output = rs.process(&planar, None).map_err(|e: rubato::ResampleError| e.to_string())?;
                        let out_len = output[0].len();
                        let mut mono = vec![0.0f32; out_len];
                        for chan_data in output {
                            for (i, s) in chan_data.iter().enumerate() {
                                mono[i] += *s;
                            }
                        }
                        for s in &mut mono { *s /= source_channels as f32; }
                        mono
                    } else {
                        let out_len = planar[0].len();
                        let mut mono = vec![0.0f32; out_len];
                        for chan_data in planar {
                            for (i, s) in chan_data.iter().enumerate() {
                                mono[i] += *s;
                            }
                        }
                        for s in &mut mono { *s /= source_channels as f32; }
                        mono
                    };

                    for s in mono_samples {
                        let sample = (s * std::i16::MAX as f32).clamp(-32768.0, 32767.0) as i16;
                        writer.write_sample(sample).map_err(|e| e.to_string())?;
                    }
                }
            }
            writer.finalize().map_err(|e| e.to_string())?;
            log_msg(&app, "[Studio] Import complete.");
            Ok(())
        })();

        match res {
            Ok(_) => { let _ = app.emit("studio-import-complete", stem); }
            Err(e) => { let _ = app.emit("studio-import-error", e); }
        }
    });

    Ok(())
}

#[tauri::command]
async fn get_available_monitors(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let win = app.get_webview_window("main").ok_or("no main window")?;
    let primary_name = win
        .primary_monitor()
        .map_err(|e: tauri::Error| e.to_string())?
        .and_then(|m| m.name().map(|s| s.to_string()));
    let monitors = win.available_monitors().map_err(|e: tauri::Error| e.to_string())?;
    Ok(monitors
        .into_iter()
        .map(|m| {
            let name = m.name().map(|s| s.to_string()).unwrap_or_default();
            let is_primary = Some(&name) == primary_name.as_ref();
            MonitorInfo {
                name,
                width: m.size().width,
                height: m.size().height,
                x: m.position().x,
                y: m.position().y,
                is_primary,
            }
        })
        .collect())
}

#[tauri::command]
async fn list_media(state: State<'_, AppState>) -> Result<Vec<store::MediaItem>, String> {
    state.media_schedule.list_media().map_err(|e| e.to_string())
}

#[tauri::command]
async fn add_media(
    state: State<'_, AppState>,
    path: String,
) -> Result<store::MediaItem, String> {
    state.media_schedule.add_media(PathBuf::from(path)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_media(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.media_schedule.delete_media(id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_media_fit(
    state: State<'_, AppState>,
    id: String,
    fit_mode: String,
) -> Result<(), String> {
    state.media_schedule.set_media_fit(&id, &fit_mode).map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_media_metadata(
    state: State<'_, AppState>,
    id: String,
    description: Option<String>,
    tags: Vec<String>,
    category: Option<String>,
) -> Result<(), String> {
    state.media_schedule.update_media_metadata(&id, description, tags, category).map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_media_existence(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).exists())
}

#[tauri::command]
async fn bulk_delete_media(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<(), String> {
    state.media_schedule.bulk_delete_media(ids).map_err(|e| e.to_string())
}

#[tauri::command]
async fn bulk_update_media(
    state: State<'_, AppState>,
    ids: Vec<String>,
    tags_to_add: Vec<String>,
    tags_to_remove: Vec<String>,
    category: Option<String>,
) -> Result<(), String> {
    state.media_schedule.bulk_update_media(ids, tags_to_add, tags_to_remove, category).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_schedule(
    state: State<'_, AppState>,
    schedule: store::Schedule,
) -> Result<(), String> {
    state.media_schedule.save_schedule(schedule).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_schedule(state: State<'_, AppState>) -> Result<store::Schedule, String> {
    state.media_schedule.load_schedule().map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_next_verse(
    state: State<'_, AppState>,
    book: String,
    chapter: i32,
    verse: i32,
    version: String,
) -> Result<Option<store::Verse>, String> {
    state
        .store
        .get_next_verse(&book, chapter, verse, &version)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_prev_verse(
    state: State<'_, AppState>,
    book: String,
    chapter: i32,
    verse: i32,
    version: String,
) -> Result<Option<store::Verse>, String> {
    state
        .store
        .get_prev_verse(&book, chapter, verse, &version)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<store::PresentationSettings, String> {
    Ok(state.settings.lock().clone())
}

#[tauri::command]
async fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: store::PresentationSettings,
) -> Result<(), String> {
    state
        .media_schedule
        .save_settings(&settings)
        .map_err(|e| e.to_string())?;
    *state.settings.lock() = settings.clone();
    // Broadcast to both windows so the output screen updates live
    let _ = app.emit("settings-changed", settings);
    Ok(())
}

#[tauri::command]
async fn list_studio_presentations(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    state.media_schedule.list_studio_presentations().map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_studio_presentation(
    state: State<'_, AppState>,
    presentation: store::CustomPresentation,
) -> Result<(), String> {
    state.media_schedule.save_studio_presentation(&presentation).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_studio_presentation(
    state: State<'_, AppState>,
    id: String,
) -> Result<store::CustomPresentation, String> {
    state.media_schedule.load_studio_presentation(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_studio_presentation(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.media_schedule.delete_studio_presentation(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_scenes(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    state.media_schedule.list_scenes().map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_scene(
    state: State<'_, AppState>,
    scene: serde_json::Value,
) -> Result<(), String> {
    state.media_schedule.save_scene(&scene).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_scene(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.media_schedule.delete_scene(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_connected_cameras(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let cameras = state.connected_cameras.lock().await;
    Ok(cameras.iter().map(|(id, name)| {
        serde_json::json!({ "device_id": id, "device_name": name })
    }).collect())
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_songs(state: State<'_, AppState>) -> Result<Vec<store::Song>, String> {
    state.media_schedule.list_songs().map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_song(state: State<'_, AppState>, song: store::Song) -> Result<store::Song, String> {
    state.media_schedule.save_song(song).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_song(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.media_schedule.delete_song(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Lower third
// ---------------------------------------------------------------------------

#[tauri::command]
async fn show_lower_third(
    app: AppHandle,
    state: State<'_, AppState>,
    data: store::LowerThirdData,
    template: serde_json::Value,
) -> Result<(), String> {
    let payload = serde_json::json!({ "data": data, "template": template });
    *state.lower_third.lock() = Some(payload.clone());
    let _ = app.emit("lower-third-update", Some(payload.clone()));
    // Broadcast to WS remote clients
    let _ = state.broadcast_tx.send(
        serde_json::json!({ "type": "lt_update", "payload": payload }).to_string()
    );
    Ok(())
}

#[tauri::command]
async fn hide_lower_third(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    *state.lower_third.lock() = None;
    let _ = app.emit("lower-third-update", Option::<serde_json::Value>::None);
    // Broadcast to WS remote clients
    let _ = state.broadcast_tx.send(
        serde_json::json!({ "type": "lt_update", "payload": null }).to_string()
    );
    Ok(())
}

#[tauri::command]
async fn save_lt_templates(
    state: State<'_, AppState>,
    templates: Vec<serde_json::Value>,
) -> Result<(), String> {
    state
        .media_schedule
        .save_lt_templates(&serde_json::Value::Array(templates))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_lt_templates(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state
        .media_schedule
        .load_lt_templates()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Lower third presets
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_lt_presets(
    state: State<'_, AppState>,
) -> Result<Vec<store::LtPreset>, String> {
    state.media_schedule.list_lt_presets().map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_lt_preset(
    state: State<'_, AppState>,
    preset: store::LtPreset,
) -> Result<Vec<store::LtPreset>, String> {
    state.media_schedule.save_lt_preset(preset).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_lt_preset(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<store::LtPreset>, String> {
    state.media_schedule.delete_lt_preset(&id).map_err(|e| e.to_string())
}

/// Activate a saved preset by id, optionally overriding the LT style template.
#[tauri::command]
async fn show_lt_preset(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    template: Option<serde_json::Value>,
) -> Result<(), String> {
    let presets = state.media_schedule.list_lt_presets().map_err(|e| e.to_string())?;
    let preset = presets.into_iter().find(|p| p.id == id)
        .ok_or_else(|| format!("Preset '{}' not found", id))?;
    
    let mut tpl = template.unwrap_or(serde_json::json!({}));
    
    // If no template provided and preset has one, try to load it
    if tpl.as_object().map_or(true, |o| o.is_empty()) {
        if let Some(tpl_id) = &preset.template_id {
            if let Ok(all_tpls) = state.media_schedule.load_lt_templates() {
                if let Some(arr) = all_tpls.as_array() {
                    if let Some(found) = arr.iter().find(|t| t.get("id").and_then(|v| v.as_str()) == Some(tpl_id)) {
                        tpl = found.clone();
                    }
                }
            }
        }
    }

    let payload = serde_json::json!({ "data": preset.data, "template": tpl });
    *state.lower_third.lock() = Some(payload.clone());
    let _ = app.emit("lower-third-update", Some(payload.clone()));
    let _ = state.broadcast_tx.send(
        serde_json::json!({ "type": "lt_update", "payload": payload }).to_string()
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Remote control info
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct RemoteInfo {
    url: String,
    lan_urls: Vec<(String, String)>,
    pin: String,
    port: u16,
    /// Some("https://100.x.x.x:port") when Tailscale is running; None otherwise.
    tailscale_url: Option<String>,
    /// SHA-256 fingerprint of the self-signed TLS cert, colon-hex (AA:BB:…).
    /// Display this in the QR code or settings so users can verify the cert.
    cert_fingerprint: String,
}

/// Try `tailscale ip -4` to get the Tailscale IPv4 address.
/// Returns None if Tailscale is not installed or not connected.
fn get_tailscale_ip() -> Option<String> {
    let output = std::process::Command::new("tailscale")
        .args(["ip", "-4"])
        .output()
        .ok()?;
    if output.status.success() {
        let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
        // Tailscale uses the 100.64.0.0/10 CGNAT range
        if !ip.is_empty() && ip.starts_with("100.") {
            return Some(ip);
        }
    }
    None
}

#[tauri::command]
async fn get_current_lower_third(
    state: State<'_, AppState>,
) -> Result<Option<serde_json::Value>, String> {
    Ok(state.lower_third.lock().clone())
}

#[tauri::command]
async fn get_remote_info(state: State<'_, AppState>) -> Result<RemoteInfo, String> {
    let port = state.settings.lock().remote_port;
    let lan_ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "localhost".to_string());

    // Collect all local IPv4 addresses (excluding loopback)
    let mut lan_urls: Vec<(String, String)> = Vec::new();
    if let Ok(ifas) = local_ip_address::list_afinet_netifas() {
        for (name, ip) in ifas {
            if let std::net::IpAddr::V4(ipv4) = ip {
                if !ipv4.is_loopback() {
                    lan_urls.push((name, format!("https://{}:{}", ipv4, port)));
                }
            }
        }
    }
    lan_urls.sort_by(|a: &(String, String), b: &(String, String)| a.0.cmp(&b.0));

    // Run tailscale CLI in a blocking thread so we don't stall the async runtime
    let tailscale_url = tokio::task::spawn_blocking(get_tailscale_ip)
        .await
        .ok()
        .flatten()
        .map(|ip| format!("https://{}:{}", ip, port));

    let primary_url = format!("https://{}:{}", lan_ip, port);
    let pin = state.remote_pin.lock().clone();
    let cert_fingerprint = state.app_cert.fingerprint.clone();

    Ok(RemoteInfo {
        url: primary_url,
        lan_urls,
        pin,
        port,
        tailscale_url,
        cert_fingerprint,
    })
}

#[tauri::command]
async fn set_transcription_window(
    state: State<'_, AppState>,
    samples: usize,
) -> Result<(), String> {
    // Clamp to 0.5 s – 3 s at 16 kHz
    *state.transcription_window.lock() = samples.clamp(8_000, 48_000);
    Ok(())
}

#[tauri::command]
async fn set_transcription_paused(
    state: State<'_, AppState>,
    paused: bool,
) -> Result<(), String> {
    state.transcription_paused.store(paused, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn set_operator_muted(
    state: State<'_, AppState>,
    muted: bool,
) -> Result<(), String> {
    state.operator_muted.store(muted, Ordering::Relaxed);
    state.operator_audio.lock().is_muted.store(muted, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn set_preacher_muted(
    state: State<'_, AppState>,
    muted: bool,
) -> Result<(), String> {
    state.preacher_muted.store(muted, Ordering::Relaxed);
    state.preacher_audio.lock().is_muted.store(muted, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn regenerate_remote_pin(state: State<'_, AppState>) -> Result<String, String> {
    let new_pin = format!("{:06}", rand::random::<u32>() % 1000000);
    *state.remote_pin.lock() = new_pin.clone();
    // Persist so the new PIN survives the next restart
    if let Some(handle) = state.app_handle.get() {
        let dir = handle.path().app_local_data_dir()
            .or_else(|_| handle.path().app_data_dir())
            .map_err(|e| e.to_string())?;
        std::fs::write(dir.join("remote_pin.txt"), &new_pin)
            .map_err(|e| e.to_string())?;
    }
    Ok(new_pin)
}

// ---------------------------------------------------------------------------
// Named services
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_services(state: State<'_, AppState>) -> Result<Vec<store::ServiceMeta>, String> {
    state.media_schedule.list_services().map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_service(state: State<'_, AppState>, schedule: store::Schedule) -> Result<(), String> {
    state.media_schedule.save_service(&schedule).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_service(state: State<'_, AppState>, id: String) -> Result<store::Schedule, String> {
    state.media_schedule.load_service(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_service(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.media_schedule.delete_service(&id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Props layer
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_props(state: State<'_, AppState>) -> Result<Vec<store::PropItem>, String> {
    let current = state.props_layer.lock().clone();
    if current.is_empty() {
        // Try to load from disk (e.g. first call after restart)
        if let Ok(loaded) = state.media_schedule.load_props() {
            if !loaded.is_empty() {
                *state.props_layer.lock() = loaded.clone();
                return Ok(loaded);
            }
        }
    }
    Ok(current)
}

#[tauri::command]
async fn set_props(
    app: AppHandle,
    state: State<'_, AppState>,
    props: Vec<store::PropItem>,
) -> Result<(), String> {
    *state.props_layer.lock() = props.clone();
    let _ = app.emit("props-update", &props);
    // Persist to disk so props survive app restarts
    let _ = state.media_schedule.save_props(&props);
    Ok(())
}

#[tauri::command]
async fn get_hymn_library(app: AppHandle) -> Result<Vec<store::Song>, String> {
    let resolver = app.path();
    // Re-resolve the resource directory as we do in setup
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = resolver.resource_dir() { candidates.push(p); }
    if let Ok(exe) = std::env::current_exe() { if let Some(dir) = exe.parent() { candidates.push(dir.to_path_buf()); } }
    if let Ok(cwd) = std::env::current_dir() { candidates.push(cwd); }

    let chosen = candidates.iter().find(|p| p.join("bible_data/hymns.json").exists())
        .or_else(|| candidates.first())
        .cloned();

    if let Some(p) = chosen {
        let path = p.join("bible_data/hymns.json");
        if path.exists() {
            let json = fs::read_to_string(path).map_err(|e| e.to_string())?;
            let hymns: Vec<store::Song> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            return Ok(hymns);
        }
    }
    Ok(Vec::new())
}

#[tauri::command]
async fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    app.path().app_local_data_dir()
        .or_else(|_| app.path().app_data_dir())
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Whisper Model Manager commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_whisper_models(state: State<'_, AppState>) -> Result<Vec<ModelStatus>, String> {
    let config = state.transcription_config.lock().clone();
    let hw = tokio::task::spawn_blocking(detect_hardware)
        .await
        .map_err(|e| e.to_string())?;
    Ok(list_model_statuses(&config, &state.app_data_dir, &hw.recommended_model))
}

#[tauri::command]
async fn get_hardware_info() -> Result<HardwareInfo, String> {
    tokio::task::spawn_blocking(detect_hardware)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn download_whisper_model(
    app: AppHandle,
    state: State<'_, AppState>,
    model_id: String,
) -> Result<(), String> {
    log_msg(&app, &format!("Command received: download_whisper_model id={}", model_id));
    // Find the catalog entry
    let info = model_manager::MODEL_CATALOG
        .iter()
        .find(|m| m.id == model_id)
        .cloned()
        .ok_or_else(|| format!("Unknown model id: {}", model_id))?;

    // Mark download as in progress
    if state
        .download_in_progress
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("A download is already in progress".to_string());
    }

    let cancel_flag = state.download_in_progress.clone();
    let app_data_dir = state.app_data_dir.clone();
    let app_clone = app.clone();

    tokio::spawn(async move {
        log_msg(&app_clone, &format!("Starting download for model: {}", info.id));
        let result = download_model(&info, &app_data_dir, cancel_flag.clone(), {
            let app_clone = app_clone.clone();
            move |progress| {
                let _ = app_clone.emit("download-progress", &progress);
            }
        })
        .await;

        // Clear the flag when done (whether success or failure)
        cancel_flag.store(false, Ordering::SeqCst);

        match result {
            Ok(path) => {
                log_msg(&app_clone, &format!("Whisper model {} downloaded successfully to {:?}", info.id, path));
            }
            Err(e) => {
                log_msg(&app_clone, &format!("Whisper model {} download failed: {}", info.id, e));
                let _ = app.emit(
                    "download-progress",
                    DownloadProgress {
                        model_id: info.id.to_string(),
                        bytes_downloaded: 0,
                        total_bytes: 0,
                        percent: 0.0,
                        done: true,
                        error: Some(e.to_string()),
                    },
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn cancel_whisper_download(state: State<'_, AppState>) -> Result<(), String> {
    state.download_in_progress.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn set_active_whisper_model(
    state: State<'_, AppState>,
    filename: String,
) -> Result<(), String> {
    // Validate the file exists in the user models dir
    let path = model_path_if_exists(&state.app_data_dir, &filename)
        .ok_or_else(|| format!("Model file not found: {}", filename))?;

    {
        let mut config = state.transcription_config.lock();
        config.active_model = Some(filename);
        config.save(&state.app_data_dir);
    }
    *state.whisper_path.lock() = Some(path);

    // Unload engine so the next START LIVE picks up the new model
    *state.engine.lock() = None;

    Ok(())
}

#[tauri::command]
async fn set_gpu_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    {
        let mut config = state.transcription_config.lock();
        config.use_gpu = enabled;
        config.save(&state.app_data_dir);
    }
    // Unload engine so next START LIVE rebuilds with new GPU flag
    *state.engine.lock() = None;
    Ok(())
}

#[tauri::command]
async fn delete_whisper_model(
    state: State<'_, AppState>,
    filename: String,
) -> Result<(), String> {
    // Reject if this is the currently active model
    let active = state.transcription_config.lock().active_model.clone();
    if active.as_deref() == Some(&filename) {
        return Err("Cannot delete the active model. Select a different model first.".to_string());
    }
    model_manager::delete_model_file(&state.app_data_dir, &filename)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_transcription_config(state: State<'_, AppState>) -> Result<TranscriptionConfig, String> {
    Ok(state.transcription_config.lock().clone())
}

#[tauri::command]
async fn set_cloud_config(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    provider: Option<String>,
    api_key: Option<String>,
    hostname: Option<String>,
    model: Option<String>,
    rest_model: Option<String>,
    language: Option<String>,
    operator_mode: Option<String>,
    preacher_mode: Option<String>,
    auto_project: Option<bool>,
    verse_lock_secs: Option<u32>,
    confidence_threshold: Option<f32>,
) -> Result<(), String> {
    let valid = matches!(
        provider.as_deref(),
        None | Some("deepgram") | Some("openai") | Some("assemblyai") | Some("google")
    );
    if !valid {
        return Err(format!("Invalid cloud provider: {:?}", provider));
    }

    {
        let mut config = state.transcription_config.lock();
        config.cloud_provider = provider.clone();
        if api_key.is_some() { config.cloud_api_key = api_key; }
        config.cloud_hostname   = hostname.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        config.cloud_model      = model.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        config.cloud_rest_model = rest_model.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        config.cloud_language   = language.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if let Some(v) = operator_mode       { config.operator_mode        = Some(v); }
        if let Some(v) = preacher_mode       { config.preacher_mode        = Some(v); }
        if let Some(v) = auto_project        { config.auto_project         = v; }
        if let Some(v) = verse_lock_secs     { config.verse_lock_secs      = v; }
        if let Some(v) = confidence_threshold {
            config.confidence_threshold = v.clamp(0.0, 1.0);
        }
        config.save(&state.app_data_dir);
    }
    // Propagate confidence threshold to BibleStore immediately
    if let Some(v) = confidence_threshold {
        state.store.set_confidence_threshold(&app, v.clamp(0.0, 1.0));
    }

    *state.engine.lock() = None;

    if provider.is_none() {
        let filename = state.transcription_config.lock().active_model.clone();
        let new_path = filename
            .as_ref()
            .and_then(|f| model_path_if_exists(&state.app_data_dir, f));
        *state.whisper_path.lock() = new_path;
    }

    Ok(())
}

/// Startup health status for the frontend to display setup issues.
#[derive(Serialize)]
struct StartupStatus {
    db_ok: bool,
    embeddings_ok: bool,
    onnx_model_ok: bool,
    tokenizer_ok: bool,
    reranker_ok: bool,
    whisper_model_ok: bool,
    whisper_model_name: Option<String>,
    db_path: String,
    issues: Vec<String>,
}

#[tauri::command]
async fn get_startup_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<StartupStatus, String> {
    let mut issues = Vec::new();

    // Re-derive the resource path by probing the same candidates as setup
    let resource_path = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));

    let db_path = engine::model_manager::bible_db_path(&state.app_data_dir, &resource_path);
    let emb_path = engine::model_manager::semantic_index_path(&state.app_data_dir, &resource_path);
    let vidx_path = engine::model_manager::verse_index_path(&state.app_data_dir, &resource_path);
    
    let db_ok = db_path.exists();
    let emb_ok = emb_path.is_some();
    let vidx_ok = vidx_path.is_some();
    let onnx_ok = state.embedding_model_path.exists();
    let tok_ok = state.tokenizer_path.exists();
    let rerank_ok = state.reranker_model_path.exists() && state.reranker_tokenizer_path.exists();
    
    let whisper = state.whisper_path.lock().clone();
    let whisper_ok = whisper.as_ref().map_or(false, |p| p.exists());
    let whisper_name = whisper.and_then(|p| p.file_name().map(|f| f.to_string_lossy().to_string()));

    if !db_ok { issues.push("Bible database not found. Please download it in Settings.".to_string()); }
    if !emb_ok { issues.push("Embeddings file missing. Auto-detection will be unavailable.".to_string()); }
    if !vidx_ok { issues.push("Verse index missing. Semantic search might be limited.".to_string()); }
    if !onnx_ok { issues.push("ONNX embedding model missing. Semantic search disabled.".to_string()); }
    if !tok_ok { issues.push("Tokenizer missing. Semantic search disabled.".to_string()); }
    if !rerank_ok { issues.push("Reranker model missing. Precision search will be limited.".to_string()); }
    if !whisper_ok { issues.push("No Whisper model selected. Go to Settings \u{2192} Transcription Model.".to_string()); }

    Ok(StartupStatus {
        db_ok,
        embeddings_ok: emb_ok,
        onnx_model_ok: onnx_ok,
        tokenizer_ok: tok_ok,
        reranker_ok: rerank_ok,
        whisper_model_ok: whisper_ok,
        whisper_model_name: whisper_name,
        db_path: db_path.display().to_string(),
        issues,
    })
}

/// Returns the count of currently connected remote WebSocket clients.
#[tauri::command]
async fn get_remote_client_count(state: State<'_, AppState>) -> Result<u32, String> {
    let count = state.signaling_clients.lock().len() as u32;
    Ok(count)
}

/// Returns a list of saved transcript filenames (most recent first).
#[tauri::command]
async fn list_transcripts(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let dir = state.app_data_dir.join("transcripts");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut files: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().extension().map(|x| x == "json").unwrap_or(false)
        })
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    files.sort_by(|a, b| b.cmp(a)); // most recent first
    Ok(files)
}

/// Sets the minimum cosine similarity threshold for semantic verse detection.
/// Persists the value to transcription config on disk.
#[tauri::command]
async fn set_confidence_threshold(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    threshold: f32,
) -> Result<(), String> {
    let clamped = threshold.clamp(0.0, 1.0);
    state.store.set_confidence_threshold(&app, clamped);
    {
        let mut config = state.transcription_config.lock();
        config.confidence_threshold = clamped;
        config.save(&state.app_data_dir);
    }
    Ok(())
}

/// Returns the full session transcript log accumulated since the last START LIVE.
#[tauri::command]
async fn get_session_transcript(
    state: State<'_, AppState>,
) -> Result<Vec<TranscriptSegment>, String> {
    Ok(state.session_transcript.lock().clone())
}

/// Clears the session transcript log (e.g. at the start of a new service).
#[tauri::command]
async fn clear_session_transcript(state: State<'_, AppState>) -> Result<(), String> {
    state.session_transcript.lock().clear();
    state.context_buffer.lock().clear();
    Ok(())
}

/// Saves the session transcript to a file on disk.
/// `format` is "txt" (default) or "json".
#[tauri::command]
async fn export_transcript(
    state: State<'_, AppState>,
    path: String,
    format: Option<String>,
) -> Result<(), String> {
    let segments = state.session_transcript.lock().clone();
    let fmt = format.as_deref().unwrap_or("txt");

    let content = match fmt {
        "json" => serde_json::to_string_pretty(&segments)
            .map_err(|e| e.to_string())?,
        _ => {
            // Plain text: one paragraph per final segment with time prefix
            segments
                .iter()
                .map(|s| {
                    let secs = s.timestamp_ms / 1000;
                    format!("[{:02}:{:02}] {}", secs / 60, secs % 60, s.text)
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
    };

    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn test_cloud_connection(
    app: AppHandle,
    provider: String,
    api_key: String,
    model: Option<String>,
) -> Result<String, String> {
    log_msg(&app, &format!("[Test] Testing {} connection (model={:?})", provider, model));
    let result = engine::cloud::test_connection(&provider, &api_key, model.as_deref()).await;
    match &result {
        Ok(_)  => log_msg(&app, &format!("[Test] {} connection OK", provider)),
        Err(e) => log_msg(&app, &format!("[Test] {} connection FAILED: {}", provider, e)),
    }
    result.map(|_| "Connected".to_string()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Writes to a temporary file and then renames it to prevent corruption.
fn atomic_write(path: &PathBuf, content: String) -> std::io::Result<()> {
    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, content)?;
    fs::rename(tmp_path, path)?;
    Ok(())
}

#[tauri::command]
async fn save_studio_recording_transcript(state: State<'_, AppState>, id: String, text: String) -> Result<(), String> {
    let txt_path = state.app_data_dir.join("recordings").join(format!("{}.txt", id));
    fs::write(txt_path, text).map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let resolver = app.path();

            // Resolve resource directory with a fallback to the executable's own directory.
            // On corporate Windows systems the standard resource_dir() path may be
            // inaccessible (e.g. redirected Roaming profile, AppLocker policy), so we
            // probe several candidates in order.
            let resource_path: PathBuf = {
                let mut candidates: Vec<PathBuf> = Vec::new();

                // 1. Tauri's canonical resource directory
                if let Ok(p) = resolver.resource_dir() {
                    candidates.push(p);
                }
                // 2. Directory of the running executable (covers portable / custom-extracted installs)
                if let Ok(exe) = std::env::current_exe() {
                    if let Some(dir) = exe.parent() {
                        candidates.push(dir.to_path_buf());
                    }
                }
                // 3. Current working directory (last resort)
                if let Ok(cwd) = std::env::current_dir() {
                    candidates.push(cwd);
                }

                let chosen = candidates.iter().find(|p| p.join("bible_data/wordlyte_bible.db").exists())
                    .or_else(|| candidates.first())
                    .cloned();

                match chosen {
                    Some(p) => {
                        log_msg(app, &format!("Resource Dir: {:?}", p));
                        p
                    }
                    None => {
                        log_msg(app, "CRITICAL: Could not locate resource directory");
                        return Err("Could not locate resource directory".into());
                    }
                }
            };

            // Use app_local_data_dir (C:\Users\{user}\AppData\Local\...) rather than
            // app_data_dir (Roaming), which on corporate systems is often redirected to a
            // network share that may be inaccessible or slow.
            let app_data_dir = app.path()
                .app_local_data_dir()
                .or_else(|_| app.path().app_data_dir())
                .map_err(|e| e.to_string())?;
            log_msg(app, &format!("User data dir: {:?}", app_data_dir));
            if !app_data_dir.exists() {
                fs::create_dir_all(&app_data_dir).map_err(|e| format!("Cannot create data dir {:?}: {}", app_data_dir, e))?;
            }

            // Asset paths: prioritize App Data folder (downloaded), fallback to Resources
            let embedding_model_path = engine::model_manager::bge_model_path(&app_data_dir, &resource_path);
            let tokenizer_path = engine::model_manager::bge_tokenizer_path(&app_data_dir, &resource_path);
            let reranker_model_path = engine::model_manager::reranker_model_path(&app_data_dir, &resource_path);
            let reranker_tokenizer_path = engine::model_manager::reranker_tokenizer_path(&app_data_dir, &resource_path);
            let db_path = engine::model_manager::bible_db_path(&app_data_dir, &resource_path);
            let embeddings_path = engine::model_manager::semantic_index_path(&app_data_dir, &resource_path);

            for (label, path) in [
                ("ONNX model", &embedding_model_path),
                ("Tokenizer", &tokenizer_path),
                ("Reranker model", &reranker_model_path),
                ("Reranker Tokenizer", &reranker_tokenizer_path),
                ("Bible Database", &db_path),
            ] {
                if path.exists() {
                    log_msg(app, &format!("{} found at {:?}", label, path));
                } else {
                    log_msg(app, &format!("{} not found at {:?}", label, path));
                }
            }

            let db_path_str = db_path.to_str()
                .ok_or_else(|| format!("Bible DB path contains non-UTF-8 characters: {:?}", db_path))?;
            let embeddings_path_str = embeddings_path.as_ref().and_then(|p| p.to_str());

            // Initialize BibleStore. It handles missing DB internally (empty store).
            let store = match store::BibleStore::new(app.handle(), db_path_str, embeddings_path_str) {
                Ok(s) => {
                    if s.is_embeddings_loaded() {
                        log_msg(app, "Bible Store: Semantic search index loaded.");
                    }
                    Arc::new(s)
                }
                Err(e) => {
                    // If DB doesn't exist, BibleStore::new might fail if it tries to open it.
                    // We need to ensure BibleStore::new is resilient or we handle it here.
                    log_msg(app, &format!("Warning: Could not connect to Bible Database: {}. (Expected if not yet downloaded)", e));
                    // We still need a Store object, so we'll try to create one even if DB is missing
                    // Note: You might need to adjust BibleStore::new to be more resilient.
                    Arc::new(store::BibleStore::new_empty(app.handle()))
                }
            };

            let operator_audio = Arc::new(Mutex::new(audio::AudioEngine::new()));
            let preacher_audio = Arc::new(Mutex::new(audio::AudioEngine::new()));
            log_msg(app, "Audio Engines initialized.");

            let media_schedule = Arc::new(store::MediaScheduleStore::new(app_data_dir.clone()).map_err(|e| e.to_string())?);
            log_msg(app, "Media Schedule Store initialized.");

            let initial_settings = media_schedule
                .load_settings()
                .unwrap_or_else(|_| store::PresentationSettings::default());

            // Load transcription config and resolve initial whisper path
            let transcription_config = TranscriptionConfig::load(&app_data_dir);
            let _ = fs::create_dir_all(user_models_dir(&app_data_dir));
            let initial_whisper = resolve_whisper_path(&transcription_config, &app_data_dir, &resource_path);
            if let Some(ref p) = initial_whisper {
                log_msg(app, &format!("Whisper model resolved: {:?}", p));
            } else {
                log_msg(app, "No Whisper model found — user must download one in Settings.");
            }
            log_msg(
                app,
                "AI models will be loaded on the first START LIVE click (lazy load).",
            );

            let (broadcast_tx, _) = tokio::sync::broadcast::channel::<String>(128);

            // Load persisted PIN or generate a new one and save it.
            let pin_file = app_data_dir.join("remote_pin.txt");
            let remote_pin = std::fs::read_to_string(&pin_file)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| s.len() == 6 && s.chars().all(|c| c.is_ascii_digit()))
                .unwrap_or_else(|| {
                    let pin = format!("{:06}", rand::random::<u32>() % 1000000);
                    let _ = atomic_write(&pin_file, pin.clone());
                    pin
                });
            log_msg(app, &format!("Remote PIN: {}", remote_pin));

            // Generate or load the self-signed TLS cert for the embedded HTTPS server.
            let cert_dir = app_data_dir.join("tls");
            let app_cert = camera::AppCert::load_or_generate(&cert_dir)
                .unwrap_or_else(|e| {
                    log_msg(app, &format!("[tls] Cert init failed: {e} — falling back to plain HTTP"));
                    // Create a dummy cert so the field is always populated;
                    // remote::start will fall back to plain HTTP if cert is invalid.
                    panic!("TLS cert generation failed: {e}");
                });
            log_msg(app, &format!("[tls] Certificate fingerprint: {}", app_cert.fingerprint));

            // Device token secret = SHA-256 of "wordlyte-device-token:" + PIN
            // This ties tokens to the current PIN, so rotating the PIN invalidates all tokens.
            let token_secret = {
                use sha2::{Digest, Sha256};
                Sha256::digest(
                    format!("wordlyte-device-token:{}", remote_pin).as_bytes()
                ).to_vec()
            };
            let device_tokens = std::sync::Arc::new(camera::DeviceTokenManager::new(token_secret));

            let state = AppState {
                operator_audio,
                preacher_audio,
                studio_audio: Arc::new(Mutex::new(audio::AudioEngine::new())),
                operator_ptt_active: Arc::new(AtomicBool::new(false)),
                engine: Arc::new(Mutex::new(None)), // loaded lazily in start_session
                store,
                media_schedule,
                transcription_config: Arc::new(Mutex::new(transcription_config)),
                whisper_path: Arc::new(Mutex::new(initial_whisper)),
                embedding_model_path,
                tokenizer_path,
                reranker_model_path,
                reranker_tokenizer_path,
                app_data_dir,
                download_in_progress: Arc::new(AtomicBool::new(false)),
                is_running: Arc::new(Mutex::new(false)),
                live_item: Arc::new(Mutex::new(None)),
                staged_item: Arc::new(Mutex::new(None)),
                settings: Arc::new(Mutex::new(initial_settings.clone())),
                lower_third: Arc::new(Mutex::new(None)),
                broadcast_tx,
                app_handle: Arc::new(OnceLock::new()),
                remote_pin: Arc::new(Mutex::new(remote_pin)),
                transcription_window: Arc::new(Mutex::new(16000)), // 1 s default
                signaling_clients: Arc::new(Mutex::new(HashMap::new())),
                transcription_paused: Arc::new(AtomicBool::new(false)),
                operator_muted: Arc::new(AtomicBool::new(false)),
                preacher_muted: Arc::new(AtomicBool::new(false)),
                inference_semaphore: Arc::new(tokio::sync::Semaphore::new(1)),
                props_layer: Arc::new(Mutex::new(Vec::new())),
                connected_cameras: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
                camera_sessions: camera::SessionRegistry::new(),
                camera_tally: camera::TallyRegistry::new(),
                session_transcript: Arc::new(Mutex::new(Vec::new())),
                context_buffer: Arc::new(Mutex::new(Vec::new())),
                operator_cloud_stream_handle: Arc::new(Mutex::new(None)),
                preacher_cloud_stream_handle: Arc::new(Mutex::new(None)),
                auth_throttles: Arc::new(Mutex::new(HashMap::new())),
                session_tokens: Arc::new(Mutex::new(std::collections::HashSet::new())),
                app_cert,
                device_tokens,
                ndi_manager: Arc::new(ndi::NdiManager::new()),
                operator_is_active: Arc::new(AtomicBool::new(false)),
                preacher_is_active: Arc::new(AtomicBool::new(false)),
                studio_is_active: Arc::new(AtomicBool::new(false)),
                session_start_ms: Arc::new(Mutex::new(0)),
                remote_operators: Arc::new(Mutex::new(HashMap::new())),
                remote_proposals: Arc::new(Mutex::new(HashMap::new())),
            };

            // Sync NDI state from persisted settings
            {
                let mut ndi_config = state.ndi_manager.config.lock();
                ndi_config.enabled = initial_settings.ndi_enabled;
            }

            // Store app_handle so remote module can emit events to Tauri windows
            state.app_handle.set(app.handle().clone()).ok();

            // Start the LAN remote server in the background
            // Port is configurable via BIBLE_PRESENTER_REMOTE_PORT env var
            let remote_port = initial_settings.remote_port;
            let remote_state = Arc::new(state.clone());
            tauri::async_runtime::spawn(async move {
                remote::start(remote_state, remote_port).await;
            });

            // Spawn camera session heartbeat watchdog via Tauri's runtime
            // (avoids tokio::spawn panic if setup hook runs outside a Tokio context)
            {
                let sessions = state.camera_sessions.clone();
                let tally    = state.camera_tally.clone();
                let bcast    = state.broadcast_tx.clone();
                tauri::async_runtime::spawn(camera::heartbeat_watchdog(sessions, tally, bcast));
            }

            app.manage(state);

            // Intercept close on secondary windows — hide instead of destroy so
            // the toggle commands can show them again later.
            for label in ["output", "stage", "design", "studio"] {
                if let Some(win) = app.get_webview_window(label) {
                    let win2 = win.clone();
                    win.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = win2.hide();
                        }
                    });
                }
            }

            log_msg(app, "App state managed. Ready.");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    // Graceful shutdown: stop audio + cloud streams before exit
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<AppState>() {
                        if let Some(handle) = state.operator_cloud_stream_handle.lock().take() {
                            handle.stop();
                        }
                        if let Some(handle) = state.preacher_cloud_stream_handle.lock().take() {
                            handle.stop();
                        }
                        state.operator_audio.lock().stop();
                        state.preacher_audio.lock().stop();
                        *state.is_running.lock() = false;
                    }
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_session,
            stop_session,
            start_operator_recording,
            stop_operator_recording,
            start_preacher_recording,
            stop_preacher_recording,
            toggle_output_window,
            get_audio_devices,
            set_operator_device,
            set_preacher_device,
            toggle_ndi,
            get_ndi_config,
            set_operator_ptt,
            get_bible_versions,
            set_bible_version,
            split_verse,
            search_manual,
            search_semantic_query,
            read_file_base64,
            get_current_item,
            get_staged_item,
            get_books,
            get_chapters,
            get_verses_count,
            get_chapter,
            get_verse,
            get_next_verse,
            get_prev_verse,
            list_media,
            add_media,
            delete_media,
            set_media_fit,
            update_media_metadata,
            bulk_delete_media,
            bulk_update_media,
            check_media_existence,
            save_schedule,
            load_schedule,
            stage_item,
            go_live,
            go_live_item,
            clear_live,
            get_settings,
            save_settings,
            list_studio_presentations,
            save_studio_presentation,
            load_studio_presentation,
            delete_studio_presentation,
            list_scenes,
            save_scene,
            delete_scene,
            list_connected_cameras,
            list_songs,
            save_song,
            delete_song,
            show_lower_third,
            hide_lower_third,
            save_lt_templates,
            load_lt_templates,
            get_current_lower_third,
            list_lt_presets,
            save_lt_preset,
            delete_lt_preset,
            show_lt_preset,
            get_remote_info,
            regenerate_remote_pin,
            set_transcription_window,
            set_transcription_paused,
            set_operator_muted,
            set_preacher_muted,
            update_timer,
            toggle_stage_window,
            toggle_design_window,
            toggle_studio_window,
            list_studio_recordings,
            set_studio_device,
            delete_studio_recording,
            rename_studio_recording,
            get_studio_recording_transcript,
            save_studio_recording_transcript,
            transcribe_studio_recording,
            trim_studio_recording,
            start_studio_recording,
            stop_studio_recording,
            import_studio_audio,
            get_recording_peaks,
            get_available_monitors,
            list_services,
            save_service,
            load_service,
            delete_service,
            get_props,
            set_props,
            get_app_data_dir,
            get_hymn_library,
            list_whisper_models,
            get_hardware_info,
            download_whisper_model,
            cancel_whisper_download,
            set_active_whisper_model,
            set_gpu_enabled,
            delete_whisper_model,
            get_semantic_index_status,
            get_verse_index_status,
            download_bible_db_cmd,
            download_core_search_models_cmd,
            get_transcription_config,
            set_cloud_config,
            test_cloud_connection,
            get_session_transcript,
            clear_session_transcript,
            export_transcript,
            set_confidence_threshold,
            get_startup_status,
            get_remote_client_count,
            get_remote_proposals,
            dismiss_remote_proposal,
            list_transcripts,
            save_recovery,
            load_recovery,
            clear_recovery,
            camera::commands::camera_list_devices,
            camera::commands::camera_get_status,
            camera::commands::camera_set_program,
            camera::commands::camera_set_preview,
            camera::commands::camera_clear_program,
            camera::commands::camera_kick_device,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
