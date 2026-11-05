use crate::ai_detection::{detect_reference, direct_quote_match_score, quote_tokens};
use crate::commands::program_audio::{subscribe_feed, AudioRelay};
use crate::state::AppState;
use crate::store::{BibleStore, Verse};
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
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
const SUGGESTION_COOLDOWN: Duration = Duration::from_secs(60);

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

struct DetectionConfig {
    output_version: String,
    books: Vec<String>,
    quote_versions: Vec<String>,
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
    let detection = DetectionConfig {
        output_version: version.clone(),
        books,
        quote_versions: bible.get_available_versions(),
    };
    let mut context: VecDeque<(Instant, String)> = VecDeque::new();
    let mut recently_suggested: HashMap<String, Instant> = HashMap::new();
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
                            &mut context,
                            &mut recently_suggested,
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

fn handle_deepgram_message(
    app: &AppHandle,
    bible: &BibleStore,
    detection: &DetectionConfig,
    json: &str,
    context: &mut VecDeque<(Instant, String)>,
    recently_suggested: &mut HashMap<String, Instant>,
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
    context.push_back((now, transcript.to_string()));
    while context
        .front()
        .is_some_and(|(at, _)| now.duration_since(*at) > CONTEXT_WINDOW)
    {
        context.pop_front();
    }
    recently_suggested.retain(|_, at| now.duration_since(*at) <= SUGGESTION_COOLDOWN);
    let rolling_text = context
        .iter()
        .map(|(_, text)| text.as_str())
        .collect::<Vec<_>>()
        .join(" ");

    let suggestion = detect_reference(&rolling_text, &detection.books)
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
        })
        .or_else(|| {
            detect_direct_quote(
                bible,
                &rolling_text,
                transcript,
                &detection.quote_versions,
                &detection.output_version,
                confidence,
            )
        });

    if let Some(suggestion) = suggestion {
        let key = format!(
            "{}:{}:{}",
            suggestion.verse.book, suggestion.verse.chapter, suggestion.verse.verse
        );
        if let std::collections::hash_map::Entry::Vacant(entry) = recently_suggested.entry(key) {
            entry.insert(now);
            let _ = app.emit("ai-scripture-suggestion", suggestion);
        }
    }
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
    search_versions: &[String],
    output_version: &str,
    asr_confidence: f32,
) -> Option<ScriptureSuggestion> {
    let query_tokens = quote_tokens(rolling_text);
    if query_tokens.len() < 6 {
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
    let (matched_verse, score) = search_versions
        .iter()
        .filter_map(|version| bible.search_all(&query, version).ok())
        .flat_map(|response| response.results)
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
    Some(ScriptureSuggestion {
        id: Uuid::new_v4().to_string(),
        detection: "quote".into(),
        confidence: (score * 0.85 + asr_confidence * 0.15).clamp(0.0, 0.98),
        evidence: evidence.to_string(),
        verse,
        timestamp: now_ms(),
    })
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
    fn deepgram_url_uses_separate_encoded_bible_keyterms() {
        let url = deepgram_url();
        assert!(url.contains("&keyterm=First%20Thessalonians"));
        assert!(url.contains("&keyterm=Ecclesiastes"));
        assert!(!url.contains("keyterm=First Thessalonians"));
        assert_eq!(url.matches("&keyterm=").count(), BIBLE_KEYTERMS.len());
    }
}
