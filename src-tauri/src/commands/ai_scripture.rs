use crate::ai_detection::{
    detect_reference, direct_quote_match_score, quote_tokens, MIN_DIRECT_QUOTE_WORDS,
};
use crate::commands::program_audio::{subscribe_feed, AudioRelay};
use crate::semantic_scripture::{self, SemanticScripture};
use crate::state::AppState;
use crate::store::{BibleStore, Verse};
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use uuid::Uuid;

const PROVIDER: &str = "deepgram";
const KEY_FILE: &str = "deepgram-api-key.dpapi";
const DEEPGRAM_BASE_URL: &str = "wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&smart_format=true&utterance_end_ms=1200&vad_events=true&redact_usage=true";
// Nova-3 keyterm prompting improves uncommon proper nouns. Avoid broad terms
// such as "Mark", "Job", and "Acts", which could bias ordinary sermon speech.
const BIBLE_KEYTERMS: &[&str] = &[
    "Psalms",
    "Leviticus",
    "Deuteronomy",
    "Ecclesiastes",
    "Song of Solomon",
    "Song of Songs",
    "Isaiah",
    "Jeremiah",
    "Lamentations",
    "Ezekiel",
    "Hosea",
    "Obadiah",
    "Micah",
    "Nahum",
    "Habakkuk",
    "Zephaniah",
    "Haggai",
    "Zechariah",
    "Malachi",
    "Corinthians",
    "Galatians",
    "Ephesians",
    "Philippians",
    "Colossians",
    "Thessalonians",
    "Timothy",
    "Philemon",
    "Hebrews",
    "Revelation",
    "First Corinthians",
    "Second Corinthians",
    "First Thessalonians",
    "Second Thessalonians",
    "First Timothy",
    "Second Timothy",
    "First Peter",
    "Second Peter",
    "First John",
    "Second John",
    "Third John",
];
const CONTEXT_WINDOW: Duration = Duration::from_secs(20);
const SEMANTIC_CONTEXT_GAP: Duration = Duration::from_secs(4);
const MAX_SEMANTIC_CONTEXT_WORDS: usize = 48;
const MAX_SEMANTIC_SENTENCES: usize = 2;
const SUGGESTION_COOLDOWN: Duration = Duration::from_secs(60);
const MAX_SHORT_QUOTE_CONFIDENCE: f32 = 0.89;

fn deepgram_url() -> String {
    let mut url = DEEPGRAM_BASE_URL.to_string();
    for keyterm in BIBLE_KEYTERMS {
        url.push_str("&keyterm=");
        // Every configured term is controlled ASCII; Deepgram requires a
        // repeated query parameter and encoded spaces for each separate term.
        url.push_str(&keyterm.replace(' ', "%20"));
    }
    url
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiKeyStatus {
    pub configured: bool,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRuntimeStatus {
    pub state: String,
    pub provider: String,
    pub audio_device: Option<String>,
    pub version: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub text: String,
    pub is_final: bool,
    pub confidence: f32,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptureSuggestion {
    pub id: String,
    pub detection: String,
    pub confidence: f32,
    pub evidence: String,
    pub verse: Verse,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rank: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passage_start: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passage_end: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similarity: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margin: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct DeepgramResponse {
    #[serde(rename = "type")]
    kind: Option<String>,
    is_final: Option<bool>,
    channel: Option<DeepgramChannel>,
}

#[derive(Debug, Deserialize)]
struct DeepgramChannel {
    alternatives: Vec<DeepgramAlternative>,
}

#[derive(Debug, Deserialize)]
struct DeepgramAlternative {
    transcript: String,
    confidence: Option<f32>,
}

struct ProviderTranscript {
    text: String,
    is_final: bool,
    confidence: f32,
}

struct AiSessionControl {
    id: String,
    stop: watch::Sender<bool>,
    audio_device: String,
    version: String,
}

struct AiRuntime {
    session: Option<AiSessionControl>,
    last_message: String,
}

#[derive(Clone)]
struct DetectionConfig {
    output_version: String,
    books: Vec<String>,
}

#[derive(Clone)]
struct QuoteJob {
    generation: u64,
    rolling_text: String,
    semantic_text: String,
    semantic_segments: usize,
    evidence: String,
    asr_confidence: f32,
}

struct DetectionPipeline {
    context: VecDeque<(Instant, String)>,
    recently_suggested: Arc<Mutex<HashMap<String, Instant>>>,
    generation: Arc<AtomicU64>,
    quote_tx: watch::Sender<Option<QuoteJob>>,
}

struct DetectionWorker {
    app: AppHandle,
    bible: Arc<BibleStore>,
    detection: Arc<DetectionConfig>,
    generation: Arc<AtomicU64>,
    active: Arc<AtomicBool>,
    recently_suggested: Arc<Mutex<HashMap<String, Instant>>>,
    semantic: Arc<SemanticScripture>,
}

struct ActiveDetectionSession(Arc<AtomicBool>);

impl Drop for ActiveDetectionSession {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

static RUNTIME: OnceLock<Mutex<AiRuntime>> = OnceLock::new();

fn runtime() -> &'static Mutex<AiRuntime> {
    RUNTIME.get_or_init(|| {
        Mutex::new(AiRuntime {
            session: None,
            last_message: "AI Scripture is stopped.".into(),
        })
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn semantic_context(context: &VecDeque<(Instant, String)>) -> (String, usize) {
    let mut recent = Vec::new();
    let mut newer_at: Option<Instant> = None;
    for (at, text) in context.iter().rev() {
        if newer_at.is_some_and(|newer| newer.duration_since(*at) > SEMANTIC_CONTEXT_GAP) {
            break;
        }
        recent.push(text.as_str());
        newer_at = Some(*at);
    }
    recent.reverse();
    let segment_count = recent.len();
    let joined = recent.join(" ");
    let sentences = joined
        .split_inclusive(['.', '!', '?'])
        .map(str::trim)
        .filter(|sentence| !sentence.is_empty())
        .collect::<Vec<_>>();
    let selected = sentences
        .iter()
        .rev()
        .take(MAX_SEMANTIC_SENTENCES)
        .rev()
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    let words = selected.split_whitespace().collect::<Vec<_>>();
    let start = words.len().saturating_sub(MAX_SEMANTIC_CONTEXT_WORDS);
    (words[start..].join(" "), segment_count)
}

fn key_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("secrets").join(KEY_FILE)
}

#[cfg(windows)]
mod key_storage {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    fn collect(out: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
        unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec()
    }

    fn free_blob(out: &CRYPT_INTEGER_BLOB) {
        unsafe {
            if !out.pbData.is_null() {
                let _ = LocalFree(Some(HLOCAL(out.pbData.cast())));
            }
        }
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(
                &blob(data),
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .map_err(|e| format!("Could not protect the Deepgram API key: {e}"))?;
        }
        let result = collect(&out);
        free_blob(&out);
        Ok(result)
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = CRYPT_INTEGER_BLOB::default();
        let mut description = PWSTR::null();
        unsafe {
            CryptUnprotectData(
                &blob(data),
                Some(&mut description),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
            .map_err(|e| format!("Could not decrypt the Deepgram API key: {e}"))?;
        }
        let result = collect(&out);
        free_blob(&out);
        if !description.is_null() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(description.as_ptr().cast())));
            }
        }
        Ok(result)
    }
}

#[cfg(not(windows))]
mod key_storage {
    pub fn protect(_data: &[u8]) -> Result<Vec<u8>, String> {
        Err("Secure AI credential storage is currently available only on Windows.".into())
    }
    pub fn unprotect(_data: &[u8]) -> Result<Vec<u8>, String> {
        Err("Secure AI credential storage is currently available only on Windows.".into())
    }
}

fn load_api_key(app_data_dir: &Path) -> Result<String, String> {
    let encrypted = std::fs::read(key_path(app_data_dir))
        .map_err(|_| "Deepgram API key is not configured.".to_string())?;
    let clear = key_storage::unprotect(&encrypted)?;
    let key =
        String::from_utf8(clear).map_err(|_| "Stored Deepgram API key is invalid.".to_string())?;
    if key.trim().is_empty() {
        return Err("Deepgram API key is not configured.".into());
    }
    Ok(key)
}

#[tauri::command]
pub fn ai_key_status(state: State<'_, AppState>) -> AiKeyStatus {
    AiKeyStatus {
        configured: load_api_key(&state.app_data_dir).is_ok(),
        provider: PROVIDER.into(),
    }
}

#[tauri::command]
pub fn ai_set_api_key(state: State<'_, AppState>, api_key: String) -> Result<AiKeyStatus, String> {
    let key = api_key.trim();
    if key.len() < 16 || key.chars().any(char::is_whitespace) {
        return Err("Enter a valid Deepgram API key.".into());
    }
    let path = key_path(&state.app_data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let encrypted = key_storage::protect(key.as_bytes())?;
    std::fs::write(path, encrypted).map_err(|e| format!("Could not save the API key: {e}"))?;
    Ok(AiKeyStatus {
        configured: true,
        provider: PROVIDER.into(),
    })
}

#[tauri::command]
pub fn ai_clear_api_key(state: State<'_, AppState>) -> Result<(), String> {
    let _ = ai_stop();
    let path = key_path(&state.app_data_dir);
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("Could not remove the API key: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn ai_status() -> AiRuntimeStatus {
    let guard = runtime().lock().unwrap_or_else(|e| e.into_inner());
    match guard.session.as_ref() {
        Some(session) => AiRuntimeStatus {
            state: "running".into(),
            provider: PROVIDER.into(),
            audio_device: Some(session.audio_device.clone()),
            version: Some(session.version.clone()),
            message: guard.last_message.clone(),
        },
        None => AiRuntimeStatus {
            state: "stopped".into(),
            provider: PROVIDER.into(),
            audio_device: None,
            version: None,
            message: guard.last_message.clone(),
        },
    }
}

fn emit_status(
    app: &AppHandle,
    state: &str,
    message: impl Into<String>,
    device: Option<String>,
    version: Option<String>,
) {
    let message = message.into();
    crate::store::log_msg(app, &format!("[ai-scripture] {state}: {message}"));
    if let Ok(mut guard) = runtime().lock() {
        guard.last_message = message.clone();
    }
    let _ = app.emit(
        "ai-scripture-status",
        AiRuntimeStatus {
            state: state.into(),
            provider: PROVIDER.into(),
            audio_device: device,
            version,
            message,
        },
    );
}

#[tauri::command]
pub async fn ai_start(
    app: AppHandle,
    state: State<'_, AppState>,
    audio_device: String,
    version: String,
) -> Result<AiRuntimeStatus, String> {
    if audio_device.trim().is_empty() {
        return Err("Choose an audio input device.".into());
    }
    if !state
        .store
        .get_available_versions()
        .iter()
        .any(|v| v == &version)
    {
        return Err("Choose an installed Bible version.".into());
    }
    let api_key = load_api_key(&state.app_data_dir)?;
    let relay = subscribe_feed(&audio_device)?;
    let semantic = semantic_scripture::engine(&state.app_data_dir);
    if semantic.was_prepared() && !semantic.is_ready() {
        let _ = semantic_scripture::prepare_in_background(
            app.clone(),
            state.store.clone(),
            state.app_data_dir.clone(),
        );
    }
    let session_id = Uuid::new_v4().to_string();
    let (stop_tx, stop_rx) = watch::channel(false);
    {
        let mut guard = runtime().lock().map_err(|e| e.to_string())?;
        if guard.session.is_some() {
            drop(relay);
            return Err("AI Scripture is already listening.".into());
        }
        guard.last_message = "Connecting to Deepgram…".into();
        guard.session = Some(AiSessionControl {
            id: session_id.clone(),
            stop: stop_tx,
            audio_device: audio_device.clone(),
            version: version.clone(),
        });
    }

    emit_status(
        &app,
        "connecting",
        "Connecting to Deepgram…",
        Some(audio_device.clone()),
        Some(version.clone()),
    );

    let bible = state.store.clone();
    let task_app = app.clone();
    let task_device = audio_device.clone();
    let task_version = version.clone();
    tauri::async_runtime::spawn(async move {
        let result = AssertUnwindSafe(run_deepgram_session(
            task_app.clone(),
            bible,
            relay,
            api_key,
            task_device.clone(),
            task_version.clone(),
            stop_rx,
        ))
        .catch_unwind()
        .await
        .unwrap_or_else(|_| {
            Err("AI transcription stopped unexpectedly. Stop and try again; details were written to Diagnostics.".into())
        });

        let was_current = if let Ok(mut guard) = runtime().lock() {
            if guard
                .session
                .as_ref()
                .is_some_and(|session| session.id == session_id)
            {
                guard.session = None;
                true
            } else {
                false
            }
        } else {
            false
        };
        if was_current {
            match result {
                Ok(()) => emit_status(&task_app, "stopped", "AI Scripture stopped.", None, None),
                Err(error) => emit_status(
                    &task_app,
                    "error",
                    error,
                    Some(task_device),
                    Some(task_version),
                ),
            }
        }
    });

    Ok(AiRuntimeStatus {
        state: "connecting".into(),
        provider: PROVIDER.into(),
        audio_device: Some(audio_device),
        version: Some(version),
        message: "Connecting to Deepgram…".into(),
    })
}

#[tauri::command]
pub fn ai_stop() -> Result<(), String> {
    let session = runtime().lock().map_err(|e| e.to_string())?.session.take();
    if let Some(session) = session {
        let _ = session.stop.send(true);
    }
    Ok(())
}

#[tauri::command]
pub fn ai_semantic_status(state: State<'_, AppState>) -> semantic_scripture::SemanticStatus {
    semantic_scripture::engine(&state.app_data_dir).status()
}

#[tauri::command]
pub fn ai_prepare_semantic(
    app: AppHandle,
    state: State<'_, AppState>,
) -> semantic_scripture::SemanticStatus {
    semantic_scripture::prepare_in_background(app, state.store.clone(), state.app_data_dir.clone())
}

#[tauri::command]
pub fn ai_cancel_semantic(
    app: AppHandle,
    state: State<'_, AppState>,
) -> semantic_scripture::SemanticStatus {
    semantic_scripture::engine(&state.app_data_dir).cancel_preparation(&app)
}

#[tauri::command]
pub fn ai_remove_semantic(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<semantic_scripture::SemanticStatus, String> {
    if runtime()
        .lock()
        .map_err(|error| error.to_string())?
        .session
        .is_some()
    {
        return Err("Stop AI Scripture before removing the local model.".into());
    }
    semantic_scripture::engine(&state.app_data_dir).remove_local_model(&app)
}

async fn spawn_pcm_decoder(relay: &AudioRelay) -> Result<Child, String> {
    Command::new(crate::binpaths::ffmpeg_path())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "aac",
            "-i",
            &format!("tcp://127.0.0.1:{}", relay.port()),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-acodec",
            "pcm_s16le",
            "-f",
            "s16le",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Could not start the transcription audio decoder: {e}"))
}

async fn run_deepgram_session(
    app: AppHandle,
    bible: Arc<BibleStore>,
    relay: AudioRelay,
    api_key: String,
    audio_device: String,
    version: String,
    mut stop: watch::Receiver<bool>,
) -> Result<(), String> {
    let semantic = semantic_scripture::engine(
        app.path()
            .app_local_data_dir()
            .or_else(|_| app.path().app_data_dir())
            .map_err(|error| error.to_string())?
            .as_path(),
    );
    let mut request = deepgram_url()
        .into_client_request()
        .map_err(|e| format!("Could not create the Deepgram request: {e}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Token {api_key}")
            .parse()
            .map_err(|_| "Invalid Deepgram API key header")?,
    );
    let connection = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(request),
    );
    let connection_result = tokio::select! {
        _ = stop.changed() => return Ok(()),
        result = connection => result,
    };
    let (mut socket, _) = connection_result
        .map_err(|_| {
            "Deepgram connection timed out after 15 seconds. Check the network and try again."
                .to_string()
        })?
        .map_err(|e| format!("Deepgram connection failed: {e}"))?;

    let mut decoder = spawn_pcm_decoder(&relay).await?;
    let mut stdout = decoder
        .stdout
        .take()
        .ok_or_else(|| "Could not read transcription audio.".to_string())?;
    emit_status(
        &app,
        "listening",
        "Listening for Scripture…",
        Some(audio_device.clone()),
        Some(version.clone()),
    );

    let books = bible.get_books(&version).map_err(|e| e.to_string())?;
    // The MVP is English-only, so every installed translation can help align
    // a quotation. The winning canonical reference is converted back to the
    // operator-selected output translation before it reaches the UI.
    let detection = Arc::new(DetectionConfig {
        output_version: version.clone(),
        books,
    });
    let recently_suggested = Arc::new(Mutex::new(HashMap::new()));
    let detection_generation = Arc::new(AtomicU64::new(0));
    let detection_active = Arc::new(AtomicBool::new(true));
    let _active_detection_session = ActiveDetectionSession(detection_active.clone());
    let (quote_tx, quote_rx) = watch::channel(None::<QuoteJob>);
    spawn_quote_worker(
        DetectionWorker {
            app: app.clone(),
            bible: bible.clone(),
            detection: detection.clone(),
            generation: detection_generation.clone(),
            active: detection_active,
            recently_suggested: recently_suggested.clone(),
            semantic,
        },
        quote_rx,
    );
    let mut pipeline = DetectionPipeline {
        context: VecDeque::new(),
        recently_suggested,
        generation: detection_generation,
        quote_tx,
    };
    let mut audio = vec![0u8; 3200];

    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_ok() && *stop.borrow() { break; }
            }
            read = stdout.read(&mut audio) => {
                let count = read.map_err(|e| format!("Audio decoder failed: {e}"))?;
                if count == 0 { return Err("The transcription audio decoder stopped unexpectedly.".into()); }
                socket.send(Message::Binary(audio[..count].to_vec().into()))
                    .await
                    .map_err(|e| format!("Could not send audio to Deepgram: {e}"))?;
            }
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        handle_deepgram_message(
                            &app,
                            &bible,
                            &detection,
                            text.as_ref(),
                            &mut pipeline,
                        )?;
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let reason = frame.map(|f| f.reason.to_string()).unwrap_or_else(|| "connection closed".into());
                        return Err(format!("Deepgram closed the session: {reason}"));
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(format!("Deepgram stream failed: {error}")),
                    None => return Err("Deepgram ended the transcription session.".into()),
                }
            }
        }
    }

    let _ = socket
        .send(Message::Text(r#"{"type":"CloseStream"}"#.into()))
        .await;
    let _ = decoder.kill().await;
    drop(relay);
    Ok(())
}

fn spawn_quote_worker(worker: DetectionWorker, mut quote_rx: watch::Receiver<Option<QuoteJob>>) {
    tauri::async_runtime::spawn(async move {
        while quote_rx.changed().await.is_ok() {
            let Some(job) = quote_rx.borrow_and_update().clone() else {
                continue;
            };
            let worker_bible = worker.bible.clone();
            let worker_detection = worker.detection.clone();
            let worker_job = job.clone();
            let suggestion = tokio::task::spawn_blocking(move || {
                detect_direct_quote(
                    &worker_bible,
                    &worker_job.rolling_text,
                    &worker_job.evidence,
                    &worker_detection.output_version,
                    worker_job.asr_confidence,
                )
            })
            .await
            .ok()
            .flatten();

            // Quote retrieval is deliberately lower priority than explicit
            // references. If any newer final transcript arrived while this
            // search ran, discard the stale result so it cannot replace a
            // newer auto-staged reference.
            if !worker.active.load(Ordering::Acquire)
                || worker.generation.load(Ordering::Acquire) != job.generation
            {
                continue;
            }
            if let Some(suggestion) = suggestion {
                let _ = emit_suggestion_if_new(&worker.app, &worker.recently_suggested, suggestion);
                continue;
            }

            if !worker.semantic.is_ready() {
                continue;
            }
            let semantic_engine = worker.semantic.clone();
            let semantic_bible = worker.bible.clone();
            let semantic_job = job.clone();
            let output_version = worker.detection.output_version.clone();
            let semantic_started = Instant::now();
            let semantic_result = tokio::task::spawn_blocking(move || {
                semantic_engine.search(
                    &semantic_job.semantic_text,
                    &output_version,
                    &semantic_bible,
                )
            })
            .await;
            if !worker.active.load(Ordering::Acquire)
                || worker.generation.load(Ordering::Acquire) != job.generation
            {
                continue;
            }
            match semantic_result {
                Ok(Ok(mut outcome)) => {
                    outcome.diagnostic.context_segments = job.semantic_segments;
                    outcome.diagnostic.latency_ms =
                        semantic_started.elapsed().as_secs_f64() * 1_000.0;
                    let _ = worker
                        .app
                        .emit("ai-scripture-diagnostic", &outcome.diagnostic);
                    crate::store::log_msg(
                        &worker.app,
                        &format!(
                            "[ai-scripture] semantic {} similarity={:?} margin={:?} candidates={} latency_ms={:.1}: {}",
                            outcome.diagnostic.state,
                            outcome.diagnostic.similarity,
                            outcome.diagnostic.margin,
                            outcome.matches.len(),
                            outcome.diagnostic.latency_ms,
                            outcome.diagnostic.reason,
                        ),
                    );
                    let group_id = Uuid::new_v4().to_string();
                    // Events are prepended in React, so emit alternatives in
                    // reverse order and leave rank 1 at the top of the group.
                    for found in outcome.matches.into_iter().rev() {
                        let suggestion = ScriptureSuggestion {
                            id: Uuid::new_v4().to_string(),
                            detection: "paraphrase".into(),
                            confidence: found.confidence,
                            evidence: job.evidence.clone(),
                            verse: found.verse,
                            timestamp: now_ms(),
                            group_id: Some(group_id.clone()),
                            rank: Some(found.rank),
                            passage_start: Some(found.passage_start),
                            passage_end: Some(found.passage_end),
                            similarity: Some(found.similarity),
                            margin: Some(found.margin),
                        };
                        let _ = emit_suggestion_if_new(
                            &worker.app,
                            &worker.recently_suggested,
                            suggestion,
                        );
                    }
                }
                Ok(Err(error)) => {
                    let diagnostic = semantic_scripture::SemanticDiagnostic {
                        state: "error".into(),
                        reason: error.clone(),
                        query_words: job.semantic_text.split_whitespace().count(),
                        context_segments: job.semantic_segments,
                        similarity: None,
                        margin: None,
                        minimum_similarity: semantic_scripture::MIN_SIMILARITY,
                        minimum_margin: semantic_scripture::MIN_MARGIN,
                        latency_ms: semantic_started.elapsed().as_secs_f64() * 1_000.0,
                        candidates: Vec::new(),
                    };
                    let _ = worker.app.emit("ai-scripture-diagnostic", diagnostic);
                    crate::store::log_msg(
                        &worker.app,
                        &format!("[ai-scripture] paraphrase retrieval skipped: {error}"),
                    );
                }
                Err(error) => crate::store::log_msg(
                    &worker.app,
                    &format!("[ai-scripture] paraphrase worker stopped: {error}"),
                ),
            }
        }
    });
}

fn emit_suggestion_if_new(
    app: &AppHandle,
    recently_suggested: &Mutex<HashMap<String, Instant>>,
    suggestion: ScriptureSuggestion,
) -> bool {
    let now = Instant::now();
    let Ok(mut recent) = recently_suggested.lock() else {
        return false;
    };
    recent.retain(|_, at| now.duration_since(*at) <= SUGGESTION_COOLDOWN);
    let key = suggestion_cooldown_key(&suggestion.detection, &suggestion.verse);
    if let std::collections::hash_map::Entry::Vacant(entry) = recent.entry(key) {
        entry.insert(now);
        drop(recent);
        let _ = app.emit("ai-scripture-suggestion", suggestion);
        true
    } else {
        false
    }
}

fn suggestion_cooldown_key(detection: &str, verse: &Verse) -> String {
    format!(
        "{}:{}:{}:{}",
        detection, verse.book, verse.chapter, verse.verse
    )
}

fn handle_deepgram_message(
    app: &AppHandle,
    bible: &BibleStore,
    detection: &DetectionConfig,
    json: &str,
    pipeline: &mut DetectionPipeline,
) -> Result<(), String> {
    let Some(provider_transcript) = parse_deepgram_transcript(json) else {
        return Ok(());
    };
    let transcript = provider_transcript.text.trim();
    if transcript.is_empty() {
        return Ok(());
    }
    let is_final = provider_transcript.is_final;
    let confidence = provider_transcript.confidence;
    let segment = TranscriptSegment {
        id: Uuid::new_v4().to_string(),
        text: transcript.to_string(),
        is_final,
        confidence,
        timestamp: now_ms(),
    };
    let _ = app.emit("ai-scripture-transcript", &segment);
    if !is_final {
        return Ok(());
    }

    let now = Instant::now();
    pipeline.context.push_back((now, transcript.to_string()));
    while pipeline
        .context
        .front()
        .is_some_and(|(at, _)| now.duration_since(*at) > CONTEXT_WINDOW)
    {
        pipeline.context.pop_front();
    }
    let rolling_text = pipeline
        .context
        .iter()
        .map(|(_, text)| text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    // Two final segments are enough to recover a reference split at an ASR
    // boundary without letting an older reference suppress quotation matching
    // for the full 20-second quotation context window.
    let reference_text = pipeline
        .context
        .iter()
        .rev()
        .take(2)
        .rev()
        .map(|(_, text)| text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let (semantic_text, semantic_segments) = semantic_context(&pipeline.context);
    let current_generation = pipeline.generation.fetch_add(1, Ordering::AcqRel) + 1;

    // Explicit references are deterministic and take the fast path. Quotation
    // retrieval can scan every installed translation and therefore runs in a
    // coalescing background worker instead of blocking audio/WebSocket I/O.
    let suggestion = detect_reference(&reference_text, &detection.books)
        .and_then(|reference| {
            bible
                .get_verse(
                    &reference.book,
                    reference.chapter,
                    reference.verse,
                    &detection.output_version,
                )
                .ok()
                .flatten()
        })
        .map(|verse| ScriptureSuggestion {
            id: Uuid::new_v4().to_string(),
            detection: "reference".into(),
            confidence: (0.92 + confidence * 0.07).clamp(0.0, 0.99),
            evidence: transcript.to_string(),
            verse,
            timestamp: now_ms(),
            group_id: None,
            rank: None,
            passage_start: None,
            passage_end: None,
            similarity: None,
            margin: None,
        });

    if suggestion.is_some_and(|suggestion| {
        emit_suggestion_if_new(app, &pipeline.recently_suggested, suggestion)
    }) {
        return Ok(());
    }
    pipeline.quote_tx.send_replace(Some(QuoteJob {
        generation: current_generation,
        rolling_text,
        semantic_text,
        semantic_segments,
        evidence: transcript.to_string(),
        asr_confidence: confidence,
    }));
    Ok(())
}

fn parse_deepgram_transcript(json: &str) -> Option<ProviderTranscript> {
    let response: DeepgramResponse = match serde_json::from_str(json) {
        Ok(value) => value,
        Err(_) => return None,
    };
    if response.kind.as_deref() != Some("Results") {
        return None;
    }
    let alternative = response
        .channel
        .and_then(|channel| channel.alternatives.into_iter().next())?;
    Some(ProviderTranscript {
        text: alternative.transcript,
        is_final: response.is_final.unwrap_or(false),
        confidence: alternative.confidence.unwrap_or(0.0).clamp(0.0, 1.0),
    })
}

fn detect_direct_quote(
    bible: &BibleStore,
    rolling_text: &str,
    evidence: &str,
    output_version: &str,
    asr_confidence: f32,
) -> Option<ScriptureSuggestion> {
    let query_tokens = quote_tokens(rolling_text);
    if query_tokens.len() < MIN_DIRECT_QUOTE_WORDS {
        return None;
    }
    let query = query_tokens
        .iter()
        .rev()
        .take(24)
        .rev()
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
    let (matched_verse, score) = bible
        .search_quote_candidates(&query)
        .ok()?
        .into_iter()
        .filter_map(|verse| {
            direct_quote_match_score(rolling_text, &verse.text).map(|score| (verse, score))
        })
        .max_by(|(_, a), (_, b)| a.total_cmp(b))?;
    let verse = bible
        .get_verse(
            &matched_verse.book,
            matched_verse.chapter,
            matched_verse.verse,
            output_version,
        )
        .ok()
        .flatten()?;
    let confidence = quote_confidence(score, asr_confidence, quote_tokens(evidence).len());
    Some(ScriptureSuggestion {
        id: Uuid::new_v4().to_string(),
        detection: "quote".into(),
        confidence,
        evidence: evidence.to_string(),
        verse,
        timestamp: now_ms(),
        group_id: None,
        rank: None,
        passage_start: None,
        passage_end: None,
        similarity: None,
        margin: None,
    })
}

fn quote_confidence(score: f32, asr_confidence: f32, evidence_words: usize) -> f32 {
    let confidence = (score * 0.85 + asr_confidence * 0.15).clamp(0.0, 0.98);
    if evidence_words <= MIN_DIRECT_QUOTE_WORDS {
        confidence.min(MAX_SHORT_QUOTE_CONFIDENCE)
    } else {
        confidence
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_deepgram_result_messages() {
        let transcript = parse_deepgram_transcript(
            r#"{"type":"Results","is_final":true,"channel":{"alternatives":[{"transcript":"John 3:16","confidence":0.97}]}}"#,
        )
        .expect("results message should produce a transcript");
        assert_eq!(transcript.text, "John 3:16");
        assert!(transcript.is_final);
        assert!((transcript.confidence - 0.97).abs() < f32::EPSILON);
        assert!(parse_deepgram_transcript(r#"{"type":"Metadata"}"#).is_none());
        assert!(parse_deepgram_transcript("not json").is_none());
    }

    #[test]
    fn five_word_quotes_never_reach_auto_stage_confidence() {
        assert_eq!(quote_confidence(1.0, 1.0, 5), 0.89);
        assert_eq!(quote_confidence(1.0, 1.0, 6), 0.98);
    }

    #[test]
    fn semantic_context_keeps_two_recent_sentences_and_respects_silence() {
        let now = Instant::now();
        let context = VecDeque::from([
            (
                now - Duration::from_secs(10),
                "Old announcement about next week's schedule.".into(),
            ),
            (
                now - Duration::from_secs(2),
                "Do not let the culture shape you.".into(),
            ),
            (now, "Let God transform the way you think.".into()),
        ]);
        let (text, segments) = semantic_context(&context);
        assert_eq!(segments, 2);
        assert_eq!(
            text,
            "Do not let the culture shape you. Let God transform the way you think."
        );
    }

    #[test]
    fn semantic_context_discards_older_sentences_within_one_segment() {
        let context = VecDeque::from([(
            Instant::now(),
            "Welcome everyone. The notices are finished. Grace rescues us through faith.".into(),
        )]);
        let (text, _) = semantic_context(&context);
        assert_eq!(
            text,
            "The notices are finished. Grace rescues us through faith."
        );
    }

    #[test]
    fn paraphrase_cooldown_cannot_suppress_an_explicit_reference() {
        let verse = Verse {
            book: "John".into(),
            chapter: 3,
            verse: 16,
            text: "For God so loved the world".into(),
            version: "KJV".into(),
            split_index: None,
            total_splits: None,
            score: None,
        };
        assert_ne!(
            suggestion_cooldown_key("paraphrase", &verse),
            suggestion_cooldown_key("reference", &verse)
        );
    }

    #[test]
    fn deepgram_url_uses_separate_encoded_bible_keyterms() {
        let url = deepgram_url();
        assert!(url.contains("&keyterm=First%20Thessalonians"));
        assert!(url.contains("&keyterm=Ecclesiastes"));
        assert!(!url.contains("keyterm=First Thessalonians"));
        assert_eq!(url.matches("&keyterm=").count(), BIBLE_KEYTERMS.len());
    }
}
