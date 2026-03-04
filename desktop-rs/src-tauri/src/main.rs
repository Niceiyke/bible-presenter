// Bible Presenter RS Main Entry Point
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod remote;
mod ndi;

use bible_presenter_lib::{audio, engine, store};
use ringbuf::traits::{Consumer, Observer};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use engine::model_manager::{
    self, detect_hardware, download_model, list_model_statuses, model_path_if_exists,
    resolve_whisper_path, user_models_dir, DownloadProgress, HardwareInfo, ModelStatus,
    TranscriptionConfig,
};
use tauri::{AppHandle, Emitter, Manager, State};

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

pub struct AppState {
    audio: Arc<Mutex<audio::AudioEngine>>,
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
    /// 4-digit PIN displayed in Settings tab; required for WS auth. Mutable so it can be regenerated.
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
    /// Persistent props layer — graphics that survive slide changes (logos, clocks).
    pub props_layer: Arc<Mutex<Vec<store::PropItem>>>,
    /// Currently connected LAN camera clients: device_id → device_name.
    pub connected_cameras: Arc<tokio::sync::Mutex<HashMap<String, String>>>,
    /// Full transcript log for the current service session.
    pub session_transcript: Arc<Mutex<Vec<TranscriptSegment>>>,
    /// Rolling last-3 final-segment context buffer used to improve semantic
    /// verse detection by giving the embedding model more text context.
    pub context_buffer: Arc<Mutex<Vec<String>>>,
    /// Handle to the active cloud WebSocket stream (Deepgram / AssemblyAI).
    /// None when local Whisper or REST cloud mode is active.
    pub cloud_stream_handle: Arc<Mutex<Option<engine::cloud_stream::CloudStreamHandle>>>,
    /// IP-based auth throttling to prevent PIN brute-force.
    pub auth_throttles: Arc<Mutex<HashMap<std::net::IpAddr, (u8, std::time::Instant)>>>,
    /// NDI Streaming Manager.
    pub ndi_manager: Arc<ndi::NdiManager>,
}

impl Clone for AppState {
    fn clone(&self) -> Self {
        Self {
            audio: self.audio.clone(),
            engine: self.engine.clone(),
            store: self.store.clone(),
            media_schedule: self.media_schedule.clone(),
            transcription_config: self.transcription_config.clone(),
            whisper_path: self.whisper_path.clone(),
            embedding_model_path: self.embedding_model_path.clone(),
            tokenizer_path: self.tokenizer_path.clone(),
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
            props_layer: self.props_layer.clone(),
            connected_cameras: self.connected_cameras.clone(),
            session_transcript: self.session_transcript.clone(),
            context_buffer: self.context_buffer.clone(),
            cloud_stream_handle: self.cloud_stream_handle.clone(),
            auth_throttles: self.auth_throttles.clone(),
            ndi_manager: self.ndi_manager.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct SystemLog {
    level: String,
    message: String,
    timestamp: u64,
}

fn log_msg<M: Manager<tauri::Wry> + Emitter<tauri::Wry>>(manager: &M, message: &str) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let log = SystemLog {
        level: "info".to_string(),
        message: message.to_string(),
        timestamp,
    };

    let _ = manager.emit("system-log", &log);

    if let Ok(path) = manager.path().app_log_dir() {
        if !path.exists() {
            let _ = std::fs::create_dir_all(&path);
        }
        let log_file = path.join("app.log");
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_file) {
            let _ = writeln!(file, "[{}] {}", timestamp, message);
        }
    }
    println!("{}", message);
}

#[allow(dead_code)]
fn log_msg_handle(handle: &tauri::AppHandle, message: &str, level: &str) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let log = SystemLog {
        level: level.to_string(),
        message: message.to_string(),
        timestamp,
    };

    let _ = handle.emit("system-log", &log);
    println!("[{}] {}: {}", timestamp, level.to_uppercase(), message);
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
    pub async fn get_or_init_engine(&self, app: &tauri::AppHandle) -> Result<Arc<engine::TranscriptionEngine>, String> {
        let engine = { self.engine.lock().clone() };
        if let Some(e) = engine {
            return Ok(e);
        }

        let whisper_path_opt = self.whisper_path.lock().clone();
        let use_gpu = self.transcription_config.lock().use_gpu;
        let embedding_path = self.embedding_model_path.to_str().unwrap_or("").to_string();
        let tokenizer_path = self.tokenizer_path.to_str().unwrap_or("").to_string();

        let whisper_str: Option<String> = whisper_path_opt.map(|p| p.to_str().unwrap_or("").to_string());
        let engine_mutex = self.engine.clone();

        log_msg(app, "Lazy-loading AI engine for semantic search...");

        match tokio::task::spawn_blocking(move || {
            engine::TranscriptionEngine::new(
                whisper_str.as_deref(),
                &embedding_path,
                &tokenizer_path,
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
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn start_session(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // ── C3: Guard — reject duplicate sessions ────────────────────────────
    {
        let mut running = state.is_running.lock();
        if *running {
            return Err("A session is already running. Click STOP first.".to_string());
        }
        *running = true;
    }

    // ── Extract everything from `state` before any .await ─────────────────
    let audio = state.audio.clone();
    let store = state.store.clone();
    let is_running = state.is_running.clone();
    let live_item_arc = state.live_item.clone();
    let broadcast_tx = state.broadcast_tx.clone();
    let transcription_window = state.transcription_window.clone();
    let transcription_paused_task = state.transcription_paused.clone();
    let session_transcript_arc = state.session_transcript.clone();
    let context_buffer_arc = state.context_buffer.clone();
    let cloud_stream_handle_arc = state.cloud_stream_handle.clone();

    // Clear previous session state
    session_transcript_arc.lock().clear();
    context_buffer_arc.lock().clear();

    // Snapshot cloud config
    let cloud_provider = state.transcription_config.lock().cloud_provider.clone();
    let cloud_api_key = state.transcription_config.lock().cloud_api_key.clone();
    let cloud_hostname = state.transcription_config.lock().cloud_hostname.clone();
    let cloud_model = state.transcription_config.lock().cloud_model.clone();
    let cloud_language = state.transcription_config.lock().cloud_language.clone();

    let use_cloud_stream = cloud_provider
        .as_deref()
        .map(engine::cloud_stream::provider_supports_streaming)
        .unwrap_or(false)
        && cloud_api_key.as_ref().map_or(false, |k| !k.is_empty());

    let use_cloud_rest = cloud_provider.is_some()
        && cloud_api_key.as_ref().map_or(false, |k| !k.is_empty())
        && !use_cloud_stream;

    // ── Lazy-load AI models ───────────────────────────────────────────────
    let engine = match state.get_or_init_engine(&app).await {
        Ok(e) => e,
        Err(e) => {
            *is_running.lock() = false;
            let _ = app.emit(
                "session-status",
                SessionStatus {
                    status: "error".to_string(),
                    message: format!("AI models failed to load: {}", e),
                },
            );
            return Err(e);
        }
    };
    drop(state);

    // ── Audio capture ─────────────────────────────────────────────────────
    let (error_tx, mut error_rx) = tokio::sync::mpsc::channel::<String>(10);
    let (tx, mut rx)             = tokio::sync::mpsc::channel::<()>(50);
    let (level_tx, mut level_rx) = tokio::sync::mpsc::channel::<f32>(50);

    let rb = ringbuf::HeapRb::<f32>::new(48000 * 5);
    let (prod, mut cons) = ringbuf::traits::Split::split(rb);

    {
        let mut audio_guard = audio.lock();
        if let Err(e) = audio_guard.start_capturing(tx, prod, error_tx, Some(level_tx)) {
            *is_running.lock() = false;
            return Err(e.to_string());
        }
    }

    let app_err = app.clone();
    tokio::spawn(async move {
        while let Some(msg) = error_rx.recv().await {
            let _ = app_err.emit("audio-error", msg);
        }
    });

    let app_level = app.clone();
    tokio::spawn(async move {
        while let Some(level) = level_rx.recv().await {
            let _ = app_level.emit("audio-level", level);
        }
    });

    let _ = app.emit("session-status", SessionStatus {
        status: "running".to_string(),
        message: "Live session started".to_string(),
    });

    // ══════════════════════════════════════════════════════════════════════
    // BRANCH A: WebSocket Streaming (Deepgram / AssemblyAI)
    // ══════════════════════════════════════════════════════════════════════
    if use_cloud_stream {
        let provider  = cloud_provider.clone().unwrap();
        let api_key   = cloud_api_key.clone().unwrap();
        let hostname  = cloud_hostname.as_deref().map(str::to_string);
        let model     = cloud_model.as_deref().map(str::to_string);
        let language  = cloud_language.as_deref().map(str::to_string);

        let stream_result = engine::cloud_stream::start_stream(
            &provider,
            &api_key,
            hostname.as_deref(),
            model.as_deref(),
            language.as_deref(),
        ).await;

        match stream_result {
            Err(e) => {
                *is_running.lock() = false;
                let _ = app.emit("session-status", SessionStatus {
                    status: "error".to_string(),
                    message: format!("Cloud stream failed to connect: {}", e),
                });
                return Err(format!("Cloud stream error: {}", e));
            }
            Ok((stream_handle, mut transcript_rx)) => {
                // Store handle so stop_session can close the WS cleanly
                *cloud_stream_handle_arc.lock() = Some(stream_handle);

                let app_stream = app.clone();
                let is_running_s = is_running.clone();
                let store_s = store.clone();
                let engine_s = engine.clone();
                let session_transcript_s = session_transcript_arc.clone();
                let context_buffer_s = context_buffer_arc.clone();
                let broadcast_s = broadcast_tx.clone();
                let provider_name = provider.clone();

                // ── Audio pump: ring buffer → WS audio_tx ───────────────
                let stream_handle_arc2 = cloud_stream_handle_arc.clone();
                tokio::spawn(async move {
                    // Track last-sent time to throttle how often we poll
                    // the ring buffer (every ~100 ms = 1600 samples at 16 kHz).
                    const CHUNK_SAMPLES: usize = 1600;
                    let mut interval =
                        tokio::time::interval(std::time::Duration::from_millis(100));

                    while let Some(()) = rx.recv().await {
                        interval.tick().await;

                        let paused = transcription_paused_task.load(Ordering::Relaxed);
                        let avail  = cons.occupied_len();
                        if avail == 0 || paused { continue; }

                        let take = avail.min(CHUNK_SAMPLES * 4); // drain up to 400 ms
                        let mut pcm = vec![0.0f32; take];
                        let read = cons.pop_slice(&mut pcm);
                        pcm.truncate(read);

                        let bytes: Vec<u8> = pcm
                            .iter()
                            .map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16)
                            .flat_map(|s| s.to_le_bytes())
                            .collect();

                        let guard = stream_handle_arc2.lock();
                        if let Some(ref h) = *guard {
                            let _ = h.audio_tx.send(bytes);
                        } else {
                            break; // stream was stopped
                        }
                    }
                });

                // ── Transcript handler: StreamTranscript events → UI ─────
                let session_start_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;

                tokio::spawn(async move {
                    while let Some(seg) = transcript_rx.recv().await {
                        let text = seg.text.trim().to_string();
                        if is_hallucination(&text) { continue; }

                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        let timestamp_ms = now_ms.saturating_sub(session_start_ms);

                        if seg.is_final {
                            // ── Final segment ───────────────────────────
                            // 1. Append to session transcript log
                            session_transcript_s.lock().push(TranscriptSegment {
                                text: text.clone(),
                                timestamp_ms,
                                is_final: true,
                                source: provider_name.clone(),
                            });

                            // 2. Update rolling context buffer (last 3 finals)
                            let combined = {
                                let mut buf = context_buffer_s.lock();
                                buf.push(text.clone());
                                if buf.len() > 3 { buf.remove(0); }
                                buf.join(" ")
                            };

                            // 3. Run verse detection (ONNX embed + hybrid) in
                            //    blocking thread so we don't stall the async runtime
                            let e_clone = engine_s.clone();
                            let s_clone = store_s.clone();
                            let combined_clone = combined.clone();
                            let text_clone = text.clone();

                            let result = tokio::task::spawn_blocking(move || {
                                let embedding = e_clone.embed(&combined_clone).ok();
                                let (verse, confidence) =
                                    s_clone.detect_verse_hybrid(&combined_clone, embedding);
                                (verse.map(store::DisplayItem::Verse), confidence, text_clone)
                            }).await;

                            if let Ok((item, confidence, raw_text)) = result {
                                let _ = app_stream.emit("transcription-update", TranscriptionUpdate {
                                    text: raw_text.clone(),
                                    detected_item: item.clone(),
                                    confidence,
                                    source: "auto".to_string(),
                                    is_partial: false,
                                });
                                let _ = broadcast_s.send(serde_json::json!({
                                    "type": "transcription",
                                    "text": raw_text,
                                    "detected_item": item,
                                    "confidence": confidence,
                                    "source": "auto",
                                    "is_partial": false
                                }).to_string());
                            }
                        } else {
                            // ── Partial segment ─────────────────────────
                            // Run regex-only (cheap). Only emit a detected_item
                            // if a COMPLETE reference (book + chapter + verse) found.
                            let detected = store_s.detect_verse_by_ref(&text)
                                .map(store::DisplayItem::Verse);

                            let _ = app_stream.emit("transcription-update", TranscriptionUpdate {
                                text: text.clone(),
                                detected_item: detected.clone(),
                                confidence: if detected.is_some() { 1.0 } else { 0.0 },
                                source: "auto".to_string(),
                                is_partial: true,
                            });
                        }
                    }

                    // Stream closed — clear handle and mark stopped if still running
                    *cloud_stream_handle_arc.lock() = None;
                    let was_running = {
                        let mut r = is_running_s.lock();
                        let prev = *r;
                        *r = false;
                        prev
                    };
                    if was_running {
                        let _ = app_stream.emit("session-status", SessionStatus {
                            status: "stopped".to_string(),
                            message: "Session ended".to_string(),
                        });
                    }
                });
            }
        }

        return Ok(());
    }

    // ══════════════════════════════════════════════════════════════════════
    // BRANCH B: Local Whisper OR REST cloud batch (OpenAI / Google)
    // ══════════════════════════════════════════════════════════════════════
    let app_task = app.clone();
    let is_running_t = is_running.clone();
    let _live_item_t = live_item_arc.clone();
    let broadcast_tx_task = broadcast_tx.clone();
    let transcription_window_task = transcription_window.clone();
    let cloud_provider_task = cloud_provider.clone();
    let cloud_api_key_task = cloud_api_key.clone();
    let cloud_language_task = cloud_language.clone();
    let session_transcript_b = session_transcript_arc.clone();
    let context_buffer_b = context_buffer_arc.clone();

    let cloud_in_flight = Arc::new(std::sync::atomic::AtomicBool::new(false));

    tokio::spawn(async move {
        let mut buffer = Vec::with_capacity(48000 * 3);
        const OVERLAP: usize = 4000;
        let provider_name = cloud_provider_task.clone().unwrap_or_else(|| "local".to_string());

        let session_start_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        while let Some(()) = rx.recv().await {
            let avail = cons.occupied_len();
            if avail > 0 {
                let old_len = buffer.len();
                buffer.resize(old_len + avail, 0.0);
                let read = cons.pop_slice(&mut buffer[old_len..]);
                buffer.truncate(old_len + read);
            }

            let window_size = *transcription_window_task.lock();
            let paused = transcription_paused_task.load(Ordering::Relaxed);

            if paused {
                if buffer.len() > window_size {
                    let keep = buffer.len().min(8000);
                    buffer.drain(0..buffer.len() - keep);
                }
                continue;
            }

            if cloud_in_flight.load(Ordering::Relaxed) {
                if buffer.len() > window_size {
                    buffer.drain(0..buffer.len() - window_size);
                }
                continue;
            }

            if buffer.len() >= window_size {
                let b_clone = buffer.clone();
                let e_clone = engine.clone();
                let s_clone = store.clone();
                let ctx_buf = context_buffer_b.clone();
                let tx_log  = session_transcript_b.clone();
                let p_name  = provider_name.clone();

                let result: Option<(String, Option<store::DisplayItem>, f32)> =
                    if let (Some(ref provider), Some(ref api_key)) =
                        (&cloud_provider_task, &cloud_api_key_task)
                    {
                        cloud_in_flight.store(true, Ordering::Relaxed);
                        let outcome = match engine::cloud::transcribe_cloud(
                            &b_clone, provider, api_key,
                        ).await {
                            Ok(text) => tokio::task::spawn_blocking(move || {
                                // Update context buffer
                                let combined = {
                                    let mut buf = ctx_buf.lock();
                                    buf.push(text.clone());
                                    if buf.len() > 3 { buf.remove(0); }
                                    buf.join(" ")
                                };
                                let embedding = e_clone.embed(&combined).ok();
                                let (verse, confidence) =
                                    s_clone.detect_verse_hybrid(&combined, embedding);
                                // Log to session transcript
                                let now_ms = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis() as u64;
                                tx_log.lock().push(TranscriptSegment {
                                    text: text.clone(),
                                    timestamp_ms: now_ms.saturating_sub(session_start_ms),
                                    is_final: true,
                                    source: p_name,
                                });
                                Some((text, verse.map(store::DisplayItem::Verse), confidence))
                            }).await.ok().flatten(),
                            Err(e) => { eprintln!("[cloud] {}", e); None }
                        };
                        cloud_in_flight.store(false, Ordering::Relaxed);
                        outcome
                    } else {
                        let lang_opt = cloud_language_task.clone();
                        tokio::task::spawn_blocking(move || {
                            let text = e_clone.transcribe(&b_clone, lang_opt.as_deref()).ok()?;
                            // Update context buffer
                            let combined = {
                                let mut buf = ctx_buf.lock();
                                buf.push(text.clone());
                                if buf.len() > 3 { buf.remove(0); }
                                buf.join(" ")
                            };
                            let embedding = e_clone.embed(&combined).ok();
                            let (verse, confidence) =
                                s_clone.detect_verse_hybrid(&combined, embedding);
                            // Log to session transcript
                            let now_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64;
                            tx_log.lock().push(TranscriptSegment {
                                text: text.clone(),
                                timestamp_ms: now_ms.saturating_sub(session_start_ms),
                                is_final: true,
                                source: p_name,
                            });
                            Some((text, verse.map(store::DisplayItem::Verse), confidence))
                        }).await.ok().flatten()
                    };

                if let Some((text, item, confidence)) = result {
                    if !is_hallucination(&text) {
                        let _ = app_task.emit("transcription-update", TranscriptionUpdate {
                            text: text.clone(),
                            detected_item: item.clone(),
                            confidence,
                            source: "auto".to_string(),
                            is_partial: false,
                        });
                        let _ = broadcast_tx_task.send(serde_json::json!({
                            "type": "transcription",
                            "text": text,
                            "detected_item": item,
                            "confidence": confidence,
                            "source": "auto",
                            "is_partial": false
                        }).to_string());
                    }
                }

                if cloud_provider_task.is_some() {
                    buffer.clear();
                } else {
                    // Backpressure: if transcription is slower than audio duration,
                    // the buffer will grow. Cap it to prevent exponential CPU load.
                    if buffer.len() > window_size * 2 {
                        let to_drain = buffer.len() - (window_size + OVERLAP);
                        buffer.drain(0..to_drain);
                    } else {
                        let remaining = buffer.len().saturating_sub(OVERLAP);
                        buffer = buffer[remaining..].to_vec();
                    }
                }
            }
        }

        let was_running = {
            let mut r = is_running_t.lock();
            let prev = *r;
            *r = false;
            prev
        };
        if was_running {
            let _ = app_task.emit("session-status", SessionStatus {
                status: "stopped".to_string(),
                message: "Session ended".to_string(),
            });
        }
    });

    Ok(())
}

/// C3: Stops the running session cleanly.
/// Dropping the CPAL stream closes the audio channel, which causes
/// the processing loop to exit on its next recv() call.
#[tauri::command]
async fn stop_session(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Close cloud WebSocket stream first (graceful FIN before dropping audio)
    if let Some(handle) = state.cloud_stream_handle.lock().take() {
        handle.stop();
    }
    state.audio.lock().stop();
    *state.is_running.lock() = false;

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
                let _ = app.emit(
                    "transcription-update",
                    TranscriptionUpdate {
                        text: item.to_label(),
                        detected_item: Some(item),
                        confidence: 1.0,
                        source: "manual".to_string(),
                        is_partial: false,
                    },
                );
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
    let audio = state.audio.lock();
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
async fn set_audio_device(
    state: State<'_, AppState>,
    device_name: String,
) -> Result<(), String> {
    let mut audio = state.audio.lock();
    audio
        .select_device(&device_name)
        .map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn set_vad_threshold(state: State<'_, AppState>, threshold: f32) -> Result<(), String> {
    let mut audio = state.audio.lock();
    audio.set_vad_threshold(threshold);
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
    state: State<'_, AppState>,
    version: String,
) -> Result<(), String> {
    state.store.set_active_version(&version);
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

#[derive(Serialize)]
pub struct SearchResponse {
    pub results: Vec<store::Verse>,
    pub method: String,
}

/// Semantic search across all versions using ONNX embedding; falls back to keyword search.
#[tauri::command]
async fn search_semantic_query(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    query: String,
) -> Result<SearchResponse, String> {
    // 1. Try direct reference match first
    let ref_results = state.store.detect_verses_by_ref(&query);
    if !ref_results.is_empty() {
        return Ok(SearchResponse {
            results: ref_results,
            method: "reference".to_string(),
        });
    }

    // 2. Try semantic search
    match state.get_or_init_engine(&app).await {
        Ok(engine) => {
            match engine.embed(&query) {
                Ok(embedding) => {
                    let results = state.store.search_top_n_semantic(&embedding, 20);
                    if !results.is_empty() {
                        log_msg(&app, &format!("Semantic search for '{}' returned {} results.", query, results.len()));
                        return Ok(SearchResponse {
                            results,
                            method: "semantic".to_string(),
                        });
                    } else {
                        log_msg(&app, &format!("Semantic search for '{}' returned no matches. Falling back to keyword search...", query));
                    }
                }
                Err(e) => {
                    log_msg(&app, &format!("Embedding error, falling back to keyword search: {}", e));
                    eprintln!("Embedding error, falling back to keyword search: {}", e);
                }
            }
        }
        Err(e) => {
            log_msg(&app, &format!("Failed to lazy-load engine for semantic search: {}", e));
            eprintln!("Failed to lazy-load engine for semantic search: {}", e);
        }
    }

    // 3. Fallback to improved keyword search
    let results = state.store
        .search_manual_all_versions(&query)
        .map_err(|e| e.to_string())?;

    Ok(SearchResponse {
        results,
        method: "keyword".to_string(),
    })
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
        *state.live_item.lock() = Some(item.clone());
        
        let mut is_media = false;
        if let store::DisplayItem::Media(ref m) = item {
            if matches!(m.media_type, store::MediaItemType::Video) { is_media = true; }
        }
        state.audio.lock().media_playing.store(is_media, std::sync::atomic::Ordering::Relaxed);
        
        let _ = app.emit(
            "transcription-update",
            TranscriptionUpdate {
                text: item.to_label(),
                detected_item: Some(item.clone()),
                confidence: 1.0,
                source: "manual".to_string(),
                is_partial: false,
            },
        );
        // Broadcast to WS remote clients
        let _ = state.broadcast_tx.send(
            serde_json::json!({ "type": "state", "live_item": item }).to_string()
        );
    }
    Ok(())
}

#[tauri::command]
async fn clear_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    *state.live_item.lock() = None;
    state.audio.lock().media_playing.store(false, std::sync::atomic::Ordering::Relaxed);
    let _ = app.emit(
        "transcription-update",
        TranscriptionUpdate {
            text: "".to_string(),
            detected_item: None,
            confidence: 1.0,
            source: "manual".to_string(),
            is_partial: false,
        },
    );
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
        let _ = app.emit(
            "transcription-update",
            TranscriptionUpdate {
                text: item.to_label(),
                detected_item: Some(item),
                confidence: 1.0,
                source: "manual".to_string(),
                is_partial: false,
            },
        );
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
                let _ = app.emit(
                    "transcription-update",
                    TranscriptionUpdate {
                        text: item.to_label(),
                        detected_item: Some(item),
                        confidence: 1.0,
                        source: "manual".to_string(),
                        is_partial: false,
                    },
                );
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
// Remote control info
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct RemoteInfo {
    url: String,
    pin: String,
    port: u16,
    /// Some("http://100.x.x.x:port") when Tailscale is running; None otherwise.
    tailscale_url: Option<String>,
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

    // Run tailscale CLI in a blocking thread so we don't stall the async runtime
    let tailscale_url = tokio::task::spawn_blocking(get_tailscale_ip)
        .await
        .ok()
        .flatten()
        .map(|ip| format!("http://{}:{}", ip, port));

    Ok(RemoteInfo {
        url: format!("http://{}:{}", lan_ip, port),
        pin: state.remote_pin.lock().clone(),
        port,
        tailscale_url,
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
        let result = download_model(&info, &app_data_dir, cancel_flag.clone(), move |progress| {
            let _ = app_clone.emit("model-download-progress", &progress);
        })
        .await;

        // Clear the flag when done (whether success or failure)
        cancel_flag.store(false, Ordering::SeqCst);

        if let Err(e) = result {
            let _ = app.emit(
                "model-download-progress",
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
    state: State<'_, AppState>,
    provider: Option<String>,
    api_key: Option<String>,
    hostname: Option<String>,
    model: Option<String>,
    language: Option<String>,
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
        config.cloud_hostname = hostname;
        config.cloud_model    = model;
        config.cloud_language = language;
        if let Some(v) = auto_project        { config.auto_project         = v; }
        if let Some(v) = verse_lock_secs     { config.verse_lock_secs      = v; }
        if let Some(v) = confidence_threshold {
            config.confidence_threshold = v.clamp(0.0, 1.0);
        }
        config.save(&state.app_data_dir);
    }
    // Propagate confidence threshold to BibleStore immediately
    if let Some(v) = confidence_threshold {
        state.store.set_confidence_threshold(v.clamp(0.0, 1.0));
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
    whisper_model_ok: bool,
    whisper_model_name: Option<String>,
    db_path: String,
    issues: Vec<String>,
}

#[tauri::command]
async fn get_startup_status(
    state: State<'_, AppState>,
) -> Result<StartupStatus, String> {
    let mut issues = Vec::new();

    // Re-derive the resource path by probing the same candidates as setup
    let resource_path = {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.to_path_buf());
            }
        }
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd);
        }
        candidates.into_iter()
            .find(|p| p.join("bible_data/super_bible.db").exists())
            .unwrap_or_else(|| state.app_data_dir.clone())
    };

    let db_path = resource_path.join("bible_data/super_bible.db");
    let emb_path = resource_path.join("bible_data/all_versions_embeddings.npy");
    let db_ok = db_path.exists();
    let emb_ok = emb_path.exists();
    let onnx_ok = state.embedding_model_path.exists();
    let tok_ok = state.tokenizer_path.exists();
    let whisper = state.whisper_path.lock().clone();
    let whisper_ok = whisper.as_ref().map_or(false, |p| p.exists());
    let whisper_name = whisper.and_then(|p| p.file_name().map(|f| f.to_string_lossy().to_string()));

    if !db_ok { issues.push("Bible database not found. The app cannot display scripture.".to_string()); }
    if !emb_ok { issues.push("Embeddings file missing. Auto-detection will be unavailable.".to_string()); }
    if !onnx_ok { issues.push("ONNX embedding model missing. Semantic search disabled.".to_string()); }
    if !tok_ok { issues.push("Tokenizer missing. Semantic search disabled.".to_string()); }
    if !whisper_ok { issues.push("No Whisper model selected. Go to Settings \u{2192} Transcription Model.".to_string()); }

    Ok(StartupStatus {
        db_ok,
        embeddings_ok: emb_ok,
        onnx_model_ok: onnx_ok,
        tokenizer_ok: tok_ok,
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
    state: State<'_, AppState>,
    threshold: f32,
) -> Result<(), String> {
    let clamped = threshold.clamp(0.0, 1.0);
    state.store.set_confidence_threshold(clamped);
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
    provider: String,
    api_key: String,
) -> Result<String, String> {
    engine::cloud::test_connection(&provider, &api_key)
        .await
        .map(|_| "Connected".to_string())
        .map_err(|e| e.to_string())
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

                let chosen = candidates.iter().find(|p| p.join("bible_data/super_bible.db").exists())
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

            // Bundled embedding + tokenizer paths (stay fixed)
            let embedding_model_path = resource_path.join("models/all-minilm-l6-v2.onnx");
            let tokenizer_path = resource_path.join("models/tokenizer.json");
            for (label, path) in [
                ("ONNX model", &embedding_model_path),
                ("Tokenizer", &tokenizer_path),
            ] {
                if path.exists() {
                    log_msg(app, &format!("{} found at {:?}", label, path));
                } else {
                    log_msg(app, &format!("Warning: {} not found at {:?}", label, path));
                }
            }

            let db_path = resource_path.join("bible_data/super_bible.db");
            let embeddings_path = resource_path.join("bible_data/all_versions_embeddings.npy");

            log_msg(app, &format!("Looking for DB at: {:?}", db_path));
            if !db_path.exists() {
                log_msg(
                    app,
                    &format!("CRITICAL: Bible Database missing at {:?}", db_path),
                );
            }

            let db_path_str = db_path.to_str()
                .ok_or_else(|| format!("Bible DB path contains non-UTF-8 characters: {:?}", db_path))?;
            let embeddings_path_str = embeddings_path.to_str();

            let store = match store::BibleStore::new(db_path_str, embeddings_path_str) {
                Ok(s) => {
                    if s.is_embeddings_loaded() {
                        log_msg(app, "Bible Store: Semantic search index loaded.");
                    } else {
                        log_msg(app, "Bible Store: Embeddings not found. Semantic search disabled (falling back to keyword).");
                    }
                    Arc::new(s)
                }
                Err(e) => {
                    log_msg(
                        app,
                        &format!("CRITICAL: Failed to connect to Bible Database: {}", e),
                    );
                    return Err(format!("Database error: {}", e).into());
                }
            };

            let audio = Arc::new(Mutex::new(audio::AudioEngine::new()));
            log_msg(app, "Audio Engine initialized.");

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

            let state = AppState {
                audio,
                engine: Arc::new(Mutex::new(None)), // loaded lazily in start_session
                store,
                media_schedule,
                transcription_config: Arc::new(Mutex::new(transcription_config)),
                whisper_path: Arc::new(Mutex::new(initial_whisper)),
                embedding_model_path,
                tokenizer_path,
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
                props_layer: Arc::new(Mutex::new(Vec::new())),
                connected_cameras: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
                session_transcript: Arc::new(Mutex::new(Vec::new())),
                context_buffer: Arc::new(Mutex::new(Vec::new())),
                cloud_stream_handle: Arc::new(Mutex::new(None)),
                auth_throttles: Arc::new(Mutex::new(HashMap::new())),
                ndi_manager: Arc::new(ndi::NdiManager::new()),
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

            app.manage(state);

            // Intercept close on secondary windows — hide instead of destroy so
            // the toggle commands can show them again later.
            for label in ["output", "stage", "design"] {
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
                        if let Some(handle) = state.cloud_stream_handle.lock().take() {
                            handle.stop();
                        }
                        state.audio.lock().stop();
                        *state.is_running.lock() = false;
                    }
                    app.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_session,
            stop_session,
            toggle_output_window,
            get_audio_devices,
            set_audio_device,
            toggle_ndi,
            get_ndi_config,
            set_vad_threshold,
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
            get_remote_info,
            regenerate_remote_pin,
            set_transcription_window,
            set_transcription_paused,
            update_timer,
            toggle_stage_window,
            toggle_design_window,
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
            get_transcription_config,
            set_cloud_config,
            test_cloud_connection,
            get_session_transcript,
            clear_session_transcript,
            export_transcript,
            set_confidence_threshold,
            get_startup_status,
            get_remote_client_count,
            list_transcripts,
            save_recovery,
            load_recovery,
            clear_recovery
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
