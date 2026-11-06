use crate::ai_detection::{
    detect_reference, direct_quote_match_score, quote_tokens, MIN_DIRECT_QUOTE_WORDS,
};
use crate::commands::program_audio::{feed_diagnostics, subscribe_feed, AudioRelay};
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
use tokio::process::{Child, ChildStdout, Command};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use uuid::Uuid;

const DEEPGRAM_PROVIDER: &str = "deepgram";
const ASSEMBLYAI_PROVIDER: &str = "assemblyai";
const DEEPGRAM_KEY_FILE: &str = "deepgram-api-key.dpapi";
const ASSEMBLYAI_KEY_FILE: &str = "assemblyai-api-key.dpapi";
const DEEPGRAM_BASE_URL: &str = "wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&smart_format=true&utterance_end_ms=1200&vad_events=true&redact_usage=true";
const ASSEMBLYAI_BASE_URL: &str = "wss://streaming.assemblyai.com/v3/ws";
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
const MIN_COMPLETE_THOUGHT_WORDS: usize = 5;
const SUGGESTION_COOLDOWN: Duration = Duration::from_secs(60);
const MAX_SHORT_QUOTE_CONFIDENCE: f32 = 0.89;
const STRONG_SEMANTIC_SIMILARITY: f32 = 0.80;
const STRONG_SEMANTIC_MARGIN: f32 = 0.08;
const ASSEMBLYAI_PARTIAL_DETECTION_STEP_WORDS: usize = 6;
const MAX_SPOKEN_REFERENCE_RANGE: i32 = 10;
const MAX_AUDIO_RECOVERIES: usize = 2;
const MAX_DECODER_ERROR_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AsrProvider {
    Deepgram,
    AssemblyAi,
}

impl AsrProvider {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            DEEPGRAM_PROVIDER => Ok(Self::Deepgram),
            ASSEMBLYAI_PROVIDER => Ok(Self::AssemblyAi),
            _ => Err(format!(
                "Unsupported transcription provider. Choose {DEEPGRAM_PROVIDER} or {ASSEMBLYAI_PROVIDER}."
            )),
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Deepgram => DEEPGRAM_PROVIDER,
            Self::AssemblyAi => ASSEMBLYAI_PROVIDER,
        }
    }

    const fn display_name(self) -> &'static str {
        match self {
            Self::Deepgram => "Deepgram",
            Self::AssemblyAi => "AssemblyAI",
        }
    }

    const fn key_file(self) -> &'static str {
        match self {
            Self::Deepgram => DEEPGRAM_KEY_FILE,
            Self::AssemblyAi => ASSEMBLYAI_KEY_FILE,
        }
    }
}

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

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn assemblyai_url() -> String {
    let keyterms = serde_json::to_string(BIBLE_KEYTERMS).expect("Bible keyterms are serializable");
    let language_codes = percent_encode(r#"["en"]"#);
    format!(
        "{ASSEMBLYAI_BASE_URL}?speech_model=universal-3-6-pro&mode=min_latency&encoding=pcm_s16le&sample_rate=16000&language_codes={language_codes}&include_partial_turns=true&session_heartbeat=true&min_turn_silence=300&max_turn_silence=900&keyterms_prompt={}",
        percent_encode(&keyterms)
    )
}

fn provider_url(provider: AsrProvider) -> String {
    match provider {
        AsrProvider::Deepgram => deepgram_url(),
        AsrProvider::AssemblyAi => assemblyai_url(),
    }
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

#[derive(Debug, Deserialize)]
struct AssemblyAiResponse {
    #[serde(rename = "type")]
    kind: Option<String>,
    transcript: Option<String>,
    end_of_turn: Option<bool>,
    turn_is_formatted: Option<bool>,
    turn_order: Option<u64>,
    words: Option<Vec<AssemblyAiWord>>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AssemblyAiWord {
    confidence: Option<f32>,
}

struct ProviderTranscript {
    text: String,
    is_final: bool,
    confidence: f32,
    turn_order: Option<u64>,
}

struct AiSessionControl {
    id: String,
    stop: watch::Sender<bool>,
    audio_device: String,
    version: String,
    provider: AsrProvider,
}

struct AsrSessionConfig {
    provider: AsrProvider,
    audio_device: String,
    version: String,
}

struct AiRuntime {
    session: Option<AiSessionControl>,
    last_message: String,
    last_provider: AsrProvider,
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
    is_interim: bool,
}

struct DetectionPipeline {
    context: VecDeque<(Instant, String)>,
    recently_suggested: Arc<Mutex<HashMap<String, Instant>>>,
    generation: Arc<AtomicU64>,
    quote_tx: watch::Sender<Option<QuoteJob>>,
    assemblyai_turn_order: Option<u64>,
    assemblyai_partial_words: usize,
    assemblyai_partial_reference: Option<(String, u8)>,
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
            last_provider: AsrProvider::Deepgram,
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
    let latest_is_complete = sentences
        .last()
        .is_some_and(|sentence| sentence.split_whitespace().count() >= MIN_COMPLETE_THOUGHT_WORDS);
    let sentence_count = if latest_is_complete {
        1
    } else {
        MAX_SEMANTIC_SENTENCES
    };
    let selected = sentences
        .iter()
        .rev()
        .take(sentence_count)
        .rev()
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    let words = selected.split_whitespace().collect::<Vec<_>>();
    let start = words.len().saturating_sub(MAX_SEMANTIC_CONTEXT_WORDS);
    (words[start..].join(" "), segment_count)
}

fn key_path(app_data_dir: &Path, provider: AsrProvider) -> PathBuf {
    app_data_dir.join("secrets").join(provider.key_file())
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
            .map_err(|e| format!("Could not protect the transcription API key: {e}"))?;
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
            .map_err(|e| format!("Could not decrypt the transcription API key: {e}"))?;
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

fn load_api_key(app_data_dir: &Path, provider: AsrProvider) -> Result<String, String> {
    let name = provider.display_name();
    let encrypted = std::fs::read(key_path(app_data_dir, provider))
        .map_err(|_| format!("{name} API key is not configured."))?;
    let clear = key_storage::unprotect(&encrypted)?;
    let key = String::from_utf8(clear).map_err(|_| format!("Stored {name} API key is invalid."))?;
    if key.trim().is_empty() {
        return Err(format!("{name} API key is not configured."));
    }
    Ok(key)
}

#[tauri::command]
pub fn ai_key_status(state: State<'_, AppState>, provider: String) -> AiKeyStatus {
    let provider = AsrProvider::parse(&provider).unwrap_or(AsrProvider::Deepgram);
    AiKeyStatus {
        configured: load_api_key(&state.app_data_dir, provider).is_ok(),
        provider: provider.as_str().into(),
    }
}

#[tauri::command]
pub fn ai_set_api_key(
    state: State<'_, AppState>,
    provider: String,
    api_key: String,
) -> Result<AiKeyStatus, String> {
    let provider = AsrProvider::parse(&provider)?;
    let key = api_key.trim();
    if key.len() < 16 || key.chars().any(char::is_whitespace) {
        return Err(format!(
            "Enter a valid {} API key.",
            provider.display_name()
        ));
    }
    let path = key_path(&state.app_data_dir, provider);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let encrypted = key_storage::protect(key.as_bytes())?;
    std::fs::write(path, encrypted).map_err(|e| format!("Could not save the API key: {e}"))?;
    Ok(AiKeyStatus {
        configured: true,
        provider: provider.as_str().into(),
    })
}

#[tauri::command]
pub fn ai_clear_api_key(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    let provider = AsrProvider::parse(&provider)?;
    let _ = ai_stop();
    let path = key_path(&state.app_data_dir, provider);
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
            provider: session.provider.as_str().into(),
            audio_device: Some(session.audio_device.clone()),
            version: Some(session.version.clone()),
            message: guard.last_message.clone(),
        },
        None => AiRuntimeStatus {
            state: "stopped".into(),
            provider: guard.last_provider.as_str().into(),
            audio_device: None,
            version: None,
            message: guard.last_message.clone(),
        },
    }
}

fn emit_status(
    app: &AppHandle,
    provider: AsrProvider,
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
            provider: provider.as_str().into(),
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
    provider: String,
    audio_device: String,
    version: String,
) -> Result<AiRuntimeStatus, String> {
    let provider = AsrProvider::parse(&provider)?;
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
    let api_key = load_api_key(&state.app_data_dir, provider)?;
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
        guard.last_message = format!("Connecting to {}…", provider.display_name());
        guard.last_provider = provider;
        guard.session = Some(AiSessionControl {
            id: session_id.clone(),
            stop: stop_tx,
            audio_device: audio_device.clone(),
            version: version.clone(),
            provider,
        });
    }

    emit_status(
        &app,
        provider,
        "connecting",
        format!("Connecting to {}…", provider.display_name()),
        Some(audio_device.clone()),
        Some(version.clone()),
    );

    let bible = state.store.clone();
    let task_app = app.clone();
    let task_device = audio_device.clone();
    let task_version = version.clone();
    tauri::async_runtime::spawn(async move {
        let result = AssertUnwindSafe(run_asr_session(
            task_app.clone(),
            bible,
            relay,
            api_key,
            AsrSessionConfig {
                provider,
                audio_device: task_device.clone(),
                version: task_version.clone(),
            },
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
                Ok(()) => emit_status(
                    &task_app,
                    provider,
                    "stopped",
                    "AI Scripture stopped.",
                    None,
                    None,
                ),
                Err(error) => emit_status(
                    &task_app,
                    provider,
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
        provider: provider.as_str().into(),
        audio_device: Some(audio_device),
        version: Some(version),
        message: format!("Connecting to {}…", provider.display_name()),
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

struct PcmDecoder {
    child: Child,
    stdout: ChildStdout,
    stderr_task: tokio::task::JoinHandle<String>,
}

impl PcmDecoder {
    async fn exit_diagnostics(&mut self) -> String {
        let status = self
            .child
            .wait()
            .await
            .map(|status| status.to_string())
            .unwrap_or_else(|error| format!("status unavailable: {error}"));
        let stderr = (&mut self.stderr_task).await.unwrap_or_default();
        let stderr = stderr.trim();
        if stderr.is_empty() {
            format!("decoder exited with {status}")
        } else {
            format!("decoder exited with {status}; ffmpeg: {stderr}")
        }
    }

    async fn stop(mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        let _ = self.stderr_task.await;
    }
}

async fn spawn_pcm_decoder(relay: &AudioRelay) -> Result<PcmDecoder, String> {
    let mut child = Command::new(crate::binpaths::ffmpeg_path())
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
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Could not start the transcription audio decoder: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read transcription audio.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not inspect transcription audio errors.".to_string())?;
    let stderr_task = tokio::spawn(async move {
        let mut stderr = stderr;
        let mut tail: VecDeque<u8> = VecDeque::with_capacity(MAX_DECODER_ERROR_BYTES);
        let mut buf = [0u8; 1024];
        while let Ok(count) = stderr.read(&mut buf).await {
            if count == 0 {
                break;
            }
            tail.extend(&buf[..count]);
            while tail.len() > MAX_DECODER_ERROR_BYTES {
                tail.pop_front();
            }
        }
        String::from_utf8_lossy(&tail.into_iter().collect::<Vec<_>>()).to_string()
    });
    Ok(PcmDecoder {
        child,
        stdout,
        stderr_task,
    })
}

async fn run_asr_session(
    app: AppHandle,
    bible: Arc<BibleStore>,
    relay: AudioRelay,
    api_key: String,
    config: AsrSessionConfig,
    mut stop: watch::Receiver<bool>,
) -> Result<(), String> {
    let AsrSessionConfig {
        provider,
        audio_device,
        version,
    } = config;
    let semantic = semantic_scripture::engine(
        app.path()
            .app_local_data_dir()
            .or_else(|_| app.path().app_data_dir())
            .map_err(|error| error.to_string())?
            .as_path(),
    );
    let mut request = provider_url(provider).into_client_request().map_err(|e| {
        format!(
            "Could not create the {} request: {e}",
            provider.display_name()
        )
    })?;
    let authorization = match provider {
        AsrProvider::Deepgram => format!("Token {api_key}"),
        AsrProvider::AssemblyAi => api_key,
    };
    request.headers_mut().insert(
        "Authorization",
        authorization
            .parse()
            .map_err(|_| "Invalid transcription API key header")?,
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
            format!(
                "{} connection timed out after 15 seconds. Check the network and try again.",
                provider.display_name()
            )
        })?
        .map_err(|e| format!("{} connection failed: {e}", provider.display_name()))?;

    let mut relay = Some(relay);
    let mut decoder = spawn_pcm_decoder(relay.as_ref().expect("audio relay initialized")).await?;
    let mut audio_recoveries = 0usize;
    emit_status(
        &app,
        provider,
        "listening",
        format!("Listening for Scripture via {}…", provider.display_name()),
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
        assemblyai_turn_order: None,
        assemblyai_partial_words: 0,
        assemblyai_partial_reference: None,
    };
    let mut audio = vec![0u8; 3200];

    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_ok() && *stop.borrow() { break; }
            }
            read = decoder.stdout.read(&mut audio) => {
                let count = read.map_err(|e| format!("Audio decoder failed: {e}"))?;
                if count == 0 {
                    let decoder_diagnostics = decoder.exit_diagnostics().await;
                    let feed_diagnostics = feed_diagnostics();
                    let diagnostics = format!("{decoder_diagnostics}; {feed_diagnostics}");
                    crate::store::log_msg(
                        &app,
                        &format!("[ai-scripture] audio decoder EOF: {diagnostics}"),
                    );
                    if audio_recoveries >= MAX_AUDIO_RECOVERIES {
                        return Err(format!(
                            "Transcription audio stopped after {MAX_AUDIO_RECOVERIES} automatic recovery attempts. Check the selected input and try again."
                        ));
                    }

                    audio_recoveries += 1;
                    emit_status(
                        &app,
                        provider,
                        "connecting",
                        format!(
                            "Recovering transcription audio ({audio_recoveries}/{MAX_AUDIO_RECOVERIES})…"
                        ),
                        Some(audio_device.clone()),
                        Some(version.clone()),
                    );
                    drop(relay.take());
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    let replacement = subscribe_feed(&audio_device).map_err(|error| {
                        format!("Could not recover transcription audio: {error}")
                    })?;
                    decoder = spawn_pcm_decoder(&replacement).await.map_err(|error| {
                        format!("Could not recover transcription audio: {error}")
                    })?;
                    relay = Some(replacement);
                    emit_status(
                        &app,
                        provider,
                        "listening",
                        format!("Listening for Scripture via {}…", provider.display_name()),
                        Some(audio_device.clone()),
                        Some(version.clone()),
                    );
                    continue;
                }
                socket.send(Message::Binary(audio[..count].to_vec().into()))
                    .await
                    .map_err(|e| format!("Could not send audio to {}: {e}", provider.display_name()))?;
            }
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if provider == AsrProvider::AssemblyAi {
                            if let Some(error) = parse_assemblyai_error(text.as_ref()) {
                                return Err(format!("AssemblyAI rejected the session: {error}"));
                            }
                        }
                        handle_provider_message(
                            &app,
                            &bible,
                            &detection,
                            provider,
                            text.as_ref(),
                            &mut pipeline,
                        )?;
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let reason = frame.map(|f| f.reason.to_string()).unwrap_or_else(|| "connection closed".into());
                        return Err(format!("{} closed the session: {reason}", provider.display_name()));
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(format!("{} stream failed: {error}", provider.display_name())),
                    None => return Err(format!("{} ended the transcription session.", provider.display_name())),
                }
            }
        }
    }

    // Stop the local producer first so no audio follows the provider's close
    // command. AssemblyAI finalizes its open turn only after `Terminate`, and
    // sends that final Turn before `Termination`; keep reading so the last
    // spoken reference or quotation is not silently discarded.
    decoder.stop().await;
    drop(relay.take());
    match provider {
        AsrProvider::Deepgram => {
            let _ = socket
                .send(Message::Text(r#"{"type":"CloseStream"}"#.into()))
                .await;
        }
        AsrProvider::AssemblyAi => {
            let _ = socket
                .send(Message::Text(r#"{"type":"Terminate"}"#.into()))
                .await;
            let drain = async {
                while let Some(incoming) = socket.next().await {
                    match incoming {
                        Ok(Message::Text(text)) => {
                            let text = text.as_ref();
                            if assemblyai_message_kind(text).as_deref() == Some("Termination") {
                                break;
                            }
                            if let Some(error) = parse_assemblyai_error(text) {
                                crate::store::log_msg(
                                    &app,
                                    &format!(
                                        "[ai-scripture] AssemblyAI termination error: {error}"
                                    ),
                                );
                                break;
                            }
                            handle_provider_message(
                                &app,
                                &bible,
                                &detection,
                                provider,
                                text,
                                &mut pipeline,
                            )?;
                        }
                        Ok(Message::Close(_)) => break,
                        Ok(_) => {}
                        Err(error) => {
                            crate::store::log_msg(
                                &app,
                                &format!(
                                    "[ai-scripture] AssemblyAI termination drain ended: {error}"
                                ),
                            );
                            break;
                        }
                    }
                }
                Ok::<(), String>(())
            };
            match tokio::time::timeout(Duration::from_secs(5), drain).await {
                Ok(result) => result?,
                Err(_) => crate::store::log_msg(
                    &app,
                    "[ai-scripture] AssemblyAI did not confirm termination within 5 seconds.",
                ),
            }
            // Give the coalescing quotation worker a bounded chance to process
            // the final turn before the session's activity guard is dropped.
            tokio::time::sleep(Duration::from_millis(750)).await;
        }
    }
    Ok(())
}

fn spawn_quote_worker(worker: DetectionWorker, mut quote_rx: watch::Receiver<Option<QuoteJob>>) {
    tauri::async_runtime::spawn(async move {
        let mut previous_semantic_passages = std::collections::HashSet::new();
        let mut interim_quotes = std::collections::HashSet::new();
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
                    worker_job.is_interim,
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
                || (!job.is_interim && worker.generation.load(Ordering::Acquire) != job.generation)
            {
                continue;
            }
            if job.is_interim {
                if let Some(suggestion) = suggestion {
                    emit_interim_suggestion_if_new(&worker.app, &mut interim_quotes, suggestion);
                }
                continue;
            }
            if suggestion.is_some_and(|suggestion| {
                emit_suggestion_if_new(&worker.app, &worker.recently_suggested, suggestion)
            }) {
                continue;
            }

            // An older quotation can remain in the rolling lexical window
            // after its card has already been shown. A cooldown-suppressed
            // duplicate must not starve semantic retrieval for the speaker's
            // newer sentence-aware thought.

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
                    if outcome.matches.is_empty() {
                        previous_semantic_passages.clear();
                        continue;
                    }
                    let current_passages = outcome
                        .matches
                        .iter()
                        .map(semantic_passage_key)
                        .collect::<std::collections::HashSet<_>>();
                    let confirmed_matches = outcome
                        .matches
                        .into_iter()
                        .filter(|found| {
                            semantic_match_is_stable(found, &previous_semantic_passages)
                        })
                        .collect::<Vec<_>>();
                    previous_semantic_passages = current_passages;

                    if confirmed_matches.is_empty() {
                        outcome.diagnostic.state = "waiting".into();
                        outcome.diagnostic.reason = "Possible theme is not stable yet; waiting for the next complete thought to confirm it.".into();
                        let _ = worker
                            .app
                            .emit("ai-scripture-diagnostic", &outcome.diagnostic);
                        continue;
                    }

                    let group_id = Uuid::new_v4().to_string();
                    // Events are prepended in React, so emit alternatives in
                    // reverse order and leave rank 1 at the top of the group.
                    for found in confirmed_matches.into_iter().rev() {
                        let suggestion = ScriptureSuggestion {
                            id: Uuid::new_v4().to_string(),
                            detection: "paraphrase".into(),
                            confidence: found.confidence,
                            evidence: job.semantic_text.clone(),
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
                    previous_semantic_passages.clear();
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

fn emit_interim_suggestion_if_new(
    app: &AppHandle,
    emitted: &mut std::collections::HashSet<String>,
    suggestion: ScriptureSuggestion,
) {
    let key = suggestion_cooldown_key(&suggestion.detection, &suggestion.verse);
    if emitted.insert(key) {
        crate::store::log_msg(
            app,
            &format!(
                "[ai-scripture] interim suggestion {} {} {}:{} confidence={:.3}",
                suggestion.detection,
                suggestion.verse.book,
                suggestion.verse.chapter,
                suggestion.verse.verse,
                suggestion.confidence,
            ),
        );
        let _ = app.emit("ai-scripture-suggestion", suggestion);
    }
}

fn semantic_passage_key(found: &semantic_scripture::SemanticMatch) -> String {
    format!("{}:{}", found.verse.book, found.verse.chapter)
}

fn semantic_match_is_stable(
    found: &semantic_scripture::SemanticMatch,
    previous_passages: &std::collections::HashSet<String>,
) -> bool {
    let exceptionally_strong =
        found.similarity >= STRONG_SEMANTIC_SIMILARITY && found.margin >= STRONG_SEMANTIC_MARGIN;
    exceptionally_strong || previous_passages.contains(&semantic_passage_key(found))
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
        crate::store::log_msg(
            app,
            &format!(
                "[ai-scripture] suggestion {} {} {}:{} confidence={:.3}",
                suggestion.detection,
                suggestion.verse.book,
                suggestion.verse.chapter,
                suggestion.verse.verse,
                suggestion.confidence,
            ),
        );
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

fn handle_provider_message(
    app: &AppHandle,
    bible: &BibleStore,
    detection: &DetectionConfig,
    provider: AsrProvider,
    json: &str,
    pipeline: &mut DetectionPipeline,
) -> Result<(), String> {
    let provider_transcript = match provider {
        AsrProvider::Deepgram => parse_deepgram_transcript(json),
        AsrProvider::AssemblyAi => parse_assemblyai_transcript(json),
    };
    let Some(provider_transcript) = provider_transcript else {
        return Ok(());
    };
    let transcript = provider_transcript.text.trim();
    if transcript.is_empty() {
        return Ok(());
    }
    let is_final = provider_transcript.is_final;
    let confidence = provider_transcript.confidence;
    let turn_order = provider_transcript.turn_order;
    let segment = TranscriptSegment {
        id: provider_transcript
            .turn_order
            .map(|turn| format!("assemblyai-turn-{turn}"))
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        text: transcript.to_string(),
        is_final,
        confidence,
        timestamp: now_ms(),
    };
    let _ = app.emit("ai-scripture-transcript", &segment);
    if !is_final {
        if provider == AsrProvider::AssemblyAi {
            handle_assemblyai_partial(
                app, bible, detection, pipeline, transcript, confidence, turn_order,
            );
        }
        return Ok(());
    }
    pipeline.assemblyai_turn_order = None;
    pipeline.assemblyai_partial_words = 0;
    pipeline.assemblyai_partial_reference = None;

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
    if let Some(reference) = detect_reference(&reference_text, &detection.books) {
        let mut emitted = false;
        // Events are prepended in React. Emit a range in reverse so its first
        // verse remains the top card and is the only verse eligible for
        // automatic staging; the remaining range verses stay manual.
        for verse in verses_for_reference(bible, &reference, &detection.output_version)
            .into_iter()
            .rev()
        {
            let confidence = if verse.verse == reference.verse {
                (0.92 + confidence * 0.07).clamp(0.0, 0.99)
            } else {
                MAX_SHORT_QUOTE_CONFIDENCE
            };
            emitted |= emit_suggestion_if_new(
                app,
                &pipeline.recently_suggested,
                ScriptureSuggestion {
                    id: Uuid::new_v4().to_string(),
                    detection: "reference".into(),
                    confidence,
                    evidence: transcript.to_string(),
                    verse,
                    timestamp: now_ms(),
                    group_id: None,
                    rank: None,
                    passage_start: Some(reference.verse),
                    passage_end: reference.verse_end,
                    similarity: None,
                    margin: None,
                },
            );
        }
        if emitted {
            return Ok(());
        }
    }
    pipeline.quote_tx.send_replace(Some(QuoteJob {
        generation: current_generation,
        rolling_text,
        semantic_text,
        semantic_segments,
        evidence: transcript.to_string(),
        asr_confidence: confidence,
        is_interim: false,
    }));
    Ok(())
}

fn handle_assemblyai_partial(
    app: &AppHandle,
    bible: &BibleStore,
    detection: &DetectionConfig,
    pipeline: &mut DetectionPipeline,
    transcript: &str,
    asr_confidence: f32,
    turn_order: Option<u64>,
) {
    if pipeline.assemblyai_turn_order != turn_order {
        pipeline.assemblyai_turn_order = turn_order;
        pipeline.assemblyai_partial_words = 0;
        pipeline.assemblyai_partial_reference = None;
    }

    let words = quote_tokens(transcript).len();
    if words < pipeline.assemblyai_partial_words {
        // A provider revision shortened the turn. Measure the next detection
        // interval from the revised snapshot rather than waiting indefinitely.
        pipeline.assemblyai_partial_words = words;
        pipeline.assemblyai_partial_reference = None;
        return;
    }
    if words
        < pipeline
            .assemblyai_partial_words
            .saturating_add(ASSEMBLYAI_PARTIAL_DETECTION_STEP_WORDS)
    {
        return;
    }
    pipeline.assemblyai_partial_words = words;

    if let Some(reference) = detect_reference(transcript, &detection.books) {
        let key = format!(
            "{}:{}:{}:{}",
            reference.book,
            reference.chapter,
            reference.verse,
            reference.verse_end.unwrap_or(reference.verse)
        );
        if confirm_interim_reference(&mut pipeline.assemblyai_partial_reference, Some(key)) {
            for verse in verses_for_reference(bible, &reference, &detection.output_version)
                .into_iter()
                .rev()
            {
                let suggestion = ScriptureSuggestion {
                    id: Uuid::new_v4().to_string(),
                    detection: "reference".into(),
                    // Interim references are useful immediately but remain
                    // manual until the provider confirms the final turn.
                    confidence: (0.82 + asr_confidence * 0.07)
                        .clamp(0.0, MAX_SHORT_QUOTE_CONFIDENCE),
                    evidence: latest_word_suffix(transcript, MAX_SEMANTIC_CONTEXT_WORDS),
                    verse,
                    timestamp: now_ms(),
                    group_id: None,
                    rank: None,
                    passage_start: Some(reference.verse),
                    passage_end: reference.verse_end,
                    similarity: None,
                    margin: None,
                };
                crate::store::log_msg(
                    app,
                    &format!(
                        "[ai-scripture] interim suggestion reference {} {}:{} confidence={:.3}",
                        suggestion.verse.book,
                        suggestion.verse.chapter,
                        suggestion.verse.verse,
                        suggestion.confidence,
                    ),
                );
                let _ = app.emit("ai-scripture-suggestion", suggestion);
            }
        }
    } else {
        confirm_interim_reference(&mut pipeline.assemblyai_partial_reference, None);
    }

    pipeline.quote_tx.send_replace(Some(QuoteJob {
        generation: pipeline.generation.load(Ordering::Acquire),
        rolling_text: transcript.to_string(),
        semantic_text: String::new(),
        semantic_segments: 0,
        evidence: latest_word_suffix(transcript, MAX_SEMANTIC_CONTEXT_WORDS),
        asr_confidence,
        is_interim: true,
    }));
}

fn latest_word_suffix(text: &str, limit: usize) -> String {
    let words = text.split_whitespace().collect::<Vec<_>>();
    words[words.len().saturating_sub(limit)..].join(" ")
}

fn verses_for_reference(
    bible: &BibleStore,
    reference: &crate::ai_detection::ScriptureReference,
    version: &str,
) -> Vec<Verse> {
    let requested_end = reference.verse_end.unwrap_or(reference.verse);
    let end = requested_end.min(reference.verse + MAX_SPOKEN_REFERENCE_RANGE - 1);
    (reference.verse..=end)
        .filter_map(|verse| {
            bible
                .get_verse(&reference.book, reference.chapter, verse, version)
                .ok()
                .flatten()
        })
        .collect()
}

fn confirm_interim_reference(state: &mut Option<(String, u8)>, key: Option<String>) -> bool {
    let Some(key) = key else {
        *state = None;
        return false;
    };
    match state {
        Some((previous, confirmations)) if previous == &key => {
            *confirmations = confirmations.saturating_add(1);
            *confirmations == 2
        }
        _ => {
            *state = Some((key, 1));
            false
        }
    }
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
        turn_order: None,
    })
}

fn parse_assemblyai_transcript(json: &str) -> Option<ProviderTranscript> {
    let response: AssemblyAiResponse = serde_json::from_str(json).ok()?;
    if response.kind.as_deref() != Some("Turn") {
        return None;
    }
    let words = response.words.unwrap_or_default();
    let confidence = if words.is_empty() {
        0.0
    } else {
        words
            .iter()
            .map(|word| word.confidence.unwrap_or(0.0).clamp(0.0, 1.0))
            .sum::<f32>()
            / words.len() as f32
    };
    Some(ProviderTranscript {
        text: response.transcript.unwrap_or_default(),
        // Universal-3.6 Pro sends one fully formatted final for each turn.
        // Requiring formatting also avoids double-processing if this adapter
        // is later used with a model that emits unformatted and formatted
        // end-of-turn revisions.
        is_final: response.end_of_turn.unwrap_or(false)
            && response.turn_is_formatted.unwrap_or(true),
        confidence,
        turn_order: response.turn_order,
    })
}

fn parse_assemblyai_error(json: &str) -> Option<String> {
    let response: AssemblyAiResponse = serde_json::from_str(json).ok()?;
    (response.kind.as_deref() == Some("Error")).then(|| {
        response
            .error
            .unwrap_or_else(|| "Unknown provider error".into())
    })
}

fn assemblyai_message_kind(json: &str) -> Option<String> {
    serde_json::from_str::<AssemblyAiResponse>(json).ok()?.kind
}

fn detect_direct_quote(
    bible: &BibleStore,
    rolling_text: &str,
    evidence: &str,
    output_version: &str,
    asr_confidence: f32,
    is_interim: bool,
) -> Option<ScriptureSuggestion> {
    if quote_tokens(rolling_text).len() < MIN_DIRECT_QUOTE_WORDS {
        return None;
    }
    // Search the newest finalized turn first. This keeps a long rolling sermon
    // window from diluting candidate retrieval when the speaker moves directly
    // into a sustained quotation. Fall back to the rolling suffix to recover
    // quotations split across ASR turn boundaries.
    let evidence_query = quote_search_query(evidence);
    let rolling_query = quote_search_query(rolling_text);
    let mut best = best_direct_quote_candidate(bible, &evidence_query, evidence);
    if best.is_none() && rolling_query != evidence_query {
        best = best_direct_quote_candidate(bible, &rolling_query, rolling_text);
    }
    let (matched_verse, score) = best?;
    let verse = bible
        .get_verse(
            &matched_verse.book,
            matched_verse.chapter,
            matched_verse.verse,
            output_version,
        )
        .ok()
        .flatten()?;
    let mut confidence = quote_confidence(score, asr_confidence, quote_tokens(evidence).len());
    if is_interim {
        confidence = confidence.min(MAX_SHORT_QUOTE_CONFIDENCE);
    }
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

fn quote_search_query(text: &str) -> String {
    let tokens = quote_tokens(text);
    tokens
        .iter()
        .rev()
        .take(24)
        .rev()
        .cloned()
        .collect::<Vec<_>>()
        .join(" ")
}

fn best_direct_quote_candidate(
    bible: &BibleStore,
    query: &str,
    scoring_text: &str,
) -> Option<(Verse, f32)> {
    if quote_tokens(query).len() < MIN_DIRECT_QUOTE_WORDS {
        return None;
    }
    bible
        .search_quote_candidates(query)
        .ok()?
        .into_iter()
        .filter_map(|verse| {
            direct_quote_match_score(scoring_text, &verse.text).map(|score| (verse, score))
        })
        .max_by(|(_, left), (_, right)| left.total_cmp(right))
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
    fn semantic_context_prefers_the_latest_complete_thought() {
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
        assert_eq!(text, "Let God transform the way you think.");
    }

    #[test]
    fn semantic_context_uses_previous_sentence_when_latest_is_short() {
        let context = VecDeque::from([(
            Instant::now(),
            "The notices are finished. Grace rescues us through faith. There is hope.".into(),
        )]);
        let (text, _) = semantic_context(&context);
        assert_eq!(text, "Grace rescues us through faith. There is hope.");
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
    fn semantic_themes_require_strength_or_repeated_passage_support() {
        let found = semantic_scripture::SemanticMatch {
            verse: Verse {
                book: "Daniel".into(),
                chapter: 6,
                verse: 11,
                text: "Daniel praying and making supplication".into(),
                version: "KJV".into(),
                split_index: None,
                total_splits: None,
                score: None,
            },
            confidence: 0.60,
            similarity: 0.754,
            margin: 0.048,
            rank: 1,
            passage_start: 11,
            passage_end: 11,
        };
        assert!(!semantic_match_is_stable(
            &found,
            &std::collections::HashSet::new()
        ));
        assert!(semantic_match_is_stable(
            &found,
            &std::collections::HashSet::from(["Daniel:6".into()])
        ));

        let strong = semantic_scripture::SemanticMatch {
            similarity: STRONG_SEMANTIC_SIMILARITY,
            margin: STRONG_SEMANTIC_MARGIN,
            ..found
        };
        assert!(semantic_match_is_stable(
            &strong,
            &std::collections::HashSet::new()
        ));
    }

    #[test]
    fn assemblyai_interim_references_require_two_consistent_snapshots() {
        let mut state = None;
        assert!(!confirm_interim_reference(
            &mut state,
            Some("Psalms:149:6".into())
        ));
        assert!(confirm_interim_reference(
            &mut state,
            Some("Psalms:149:6".into())
        ));
        assert!(!confirm_interim_reference(
            &mut state,
            Some("Ephesians:6:17".into())
        ));
        assert!(confirm_interim_reference(
            &mut state,
            Some("Ephesians:6:17".into())
        ));
        assert!(!confirm_interim_reference(&mut state, None));
        assert!(state.is_none());
    }

    #[test]
    fn interim_evidence_is_bounded_to_the_latest_words() {
        assert_eq!(
            latest_word_suffix("one two three four five", 3),
            "three four five"
        );
        assert_eq!(latest_word_suffix("one two", 3), "one two");
    }

    #[test]
    fn deepgram_url_uses_separate_encoded_bible_keyterms() {
        let url = deepgram_url();
        assert!(url.contains("&keyterm=First%20Thessalonians"));
        assert!(url.contains("&keyterm=Ecclesiastes"));
        assert!(!url.contains("keyterm=First Thessalonians"));
        assert_eq!(url.matches("&keyterm=").count(), BIBLE_KEYTERMS.len());
    }

    #[test]
    fn assemblyai_turns_normalize_to_provider_transcripts() {
        let transcript = parse_assemblyai_transcript(
            r#"{"type":"Turn","turn_order":7,"turn_is_formatted":true,"transcript":"John 3:16","end_of_turn":true,"words":[{"text":"John","confidence":0.9},{"text":"3:16","confidence":0.8}]}"#,
        )
        .expect("turn message should produce a transcript");
        assert_eq!(transcript.text, "John 3:16");
        assert!(transcript.is_final);
        assert_eq!(transcript.turn_order, Some(7));
        assert!((transcript.confidence - 0.85).abs() < f32::EPSILON);
        assert!(!parse_assemblyai_transcript(
            r#"{"type":"Turn","turn_order":7,"turn_is_formatted":false,"transcript":"john 3 16","end_of_turn":true}"#
        )
        .expect("unformatted turn should remain an interim revision")
        .is_final);
        assert!(parse_assemblyai_transcript(r#"{"type":"Begin"}"#).is_none());
        assert!(parse_assemblyai_transcript("not json").is_none());
    }

    #[test]
    fn assemblyai_url_requests_pcm_english_streaming_and_encoded_keyterms() {
        let url = assemblyai_url();
        assert!(url.starts_with(ASSEMBLYAI_BASE_URL));
        assert!(url.contains("speech_model=universal-3-6-pro"));
        assert!(url.contains("mode=min_latency"));
        assert!(url.contains("encoding=pcm_s16le"));
        assert!(url.contains("language_codes=%5B%22en%22%5D"));
        assert!(url.contains("min_turn_silence=300"));
        assert!(url.contains("max_turn_silence=900"));
        assert!(url.contains("keyterms_prompt=%5B%22Psalms%22"));
        assert!(!url.contains("First Thessalonians"));
    }
}
