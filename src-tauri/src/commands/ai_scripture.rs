use crate::ai_detection::{
    detect_references, direct_quote_match_score, parse_number, quote_content_word_count,
    quote_tokens, MIN_DIRECT_QUOTE_WORDS,
};
use crate::commands::program_audio::{feed_diagnostics, subscribe_pcm_feed, AudioRelay};
use crate::semantic_scripture::{self, SemanticScripture};
use crate::state::AppState;
use crate::store::{BibleStore, MediaScheduleStore, Verse};
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncReadExt;
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
const VOICE_COMMAND_KEYTERMS: &[&str] = &[
    "next verse",
    "previous verse",
    "King James",
    "New King James",
    "New Living Translation",
    "Amplified",
    "New International Version",
    "English Standard Version",
    "New American Standard",
    "The Message",
    "Good News Translation",
    "Contemporary English Version",
    "KJV",
    "NKJV",
    "NLT",
    "NIV",
    "ESV",
    "NASB",
];
const CONTEXT_WINDOW: Duration = Duration::from_secs(20);
const SEMANTIC_CONTEXT_GAP: Duration = Duration::from_secs(4);
const MAX_SEMANTIC_CONTEXT_WORDS: usize = 48;
const MAX_SEMANTIC_SENTENCES: usize = 2;
const MIN_COMPLETE_THOUGHT_WORDS: usize = 5;
const SUGGESTION_COOLDOWN: Duration = Duration::from_secs(60);
const MAX_SHORT_QUOTE_CONFIDENCE: f32 = 0.89;
const QUOTE_SEARCH_WINDOW_WORDS: usize = 24;
const QUOTE_SEARCH_WINDOW_OVERLAP: usize = 8;
const MAX_QUOTE_SEARCH_WINDOWS: usize = 24;
const MAX_DIRECT_QUOTES_PER_TURN: usize = 3;
const MIN_SHORT_WINDOW_CONTENT_WORDS: usize = 3;
const STRONG_SEMANTIC_SIMILARITY: f32 = 0.80;
const STRONG_SEMANTIC_MARGIN: f32 = 0.08;
const PARTIAL_QUOTE_DETECTION_STEP_WORDS: usize = 6;
const PROACTIVE_REFERENCE_FINALIZATION_WINDOW: Duration = Duration::from_secs(5);
const MAX_SPOKEN_REFERENCE_RANGE: i32 = 10;
const MAX_AUDIO_RECOVERIES: usize = 2;

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
    for keyterm in BIBLE_KEYTERMS.iter().chain(VOICE_COMMAND_KEYTERMS) {
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
    let keyterms = serde_json::to_string(
        &BIBLE_KEYTERMS
            .iter()
            .chain(VOICE_COMMAND_KEYTERMS)
            .copied()
            .collect::<Vec<_>>(),
    )
    .expect("Bible and voice-command keyterms are serializable");
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub text: String,
    pub is_final: bool,
    pub confidence: f32,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptureSuggestion {
    pub id: String,
    pub detection: String,
    pub confidence: f32,
    pub evidence: String,
    pub verse: Verse,
    pub timestamp: u64,
    /// Timestamp of the ASR update that supplied the text used for this
    /// verified result. This makes local ASR-to-detection timing measurable
    /// without retaining the transcript itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_transcript_timestamp: Option<u64>,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiScriptureSavedSession {
    pub id: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub provider: String,
    pub mode: String,
    pub audio_device: String,
    pub version: String,
    pub transcript: Vec<TranscriptSegment>,
    pub suggestions: Vec<ScriptureSuggestion>,
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiScriptureSessionSummary {
    pub id: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub provider: String,
    pub mode: String,
    pub version: String,
    pub transcript_segments: usize,
    pub suggestions: usize,
    pub transcript_preview: String,
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

#[derive(Debug, Clone, Serialize)]
struct AiAudioLevel {
    /// RMS-normalized level from the active 16-bit PCM AI input, from 0 to 1.
    level: f32,
}

fn pcm_level(bytes: &[u8]) -> f32 {
    let mut sum_squares = 0.0f64;
    let mut samples = 0usize;
    for pair in bytes.chunks_exact(2) {
        let sample = i16::from_le_bytes([pair[0], pair[1]]) as f64 / i16::MAX as f64;
        sum_squares += sample * sample;
        samples += 1;
    }
    if samples == 0 {
        return 0.0;
    }
    // Lift quiet spoken-word RMS into a useful operator meter range without
    // reporting an invented decibel value.
    ((sum_squares / samples as f64).sqrt() * 4.0).clamp(0.0, 1.0) as f32
}

struct AiSessionControl {
    id: String,
    stop: watch::Sender<bool>,
    audio_device: String,
    version: String,
    provider: AsrProvider,
    recorder: Arc<AiSessionRecorder>,
}

struct AsrSessionConfig {
    provider: AsrProvider,
    audio_device: String,
    version: String,
    available_versions: Vec<String>,
}

struct AiRuntime {
    session: Option<AiSessionControl>,
    last_message: String,
    last_provider: AsrProvider,
}

struct AiSessionRecorder {
    store: Arc<MediaScheduleStore>,
    session: Mutex<AiScriptureSavedSession>,
}

impl AiSessionRecorder {
    fn new(
        store: Arc<MediaScheduleStore>,
        id: String,
        provider: AsrProvider,
        mode: String,
        audio_device: String,
        version: String,
    ) -> Result<Arc<Self>, String> {
        let recorder = Arc::new(Self {
            store,
            session: Mutex::new(AiScriptureSavedSession {
                id,
                started_at: now_ms(),
                ended_at: None,
                provider: provider.as_str().into(),
                mode,
                audio_device,
                version,
                transcript: Vec::new(),
                suggestions: Vec::new(),
                stop_reason: None,
            }),
        });
        recorder.persist()?;
        Ok(recorder)
    }

    fn persist(&self) -> Result<(), String> {
        let session = self.session.lock().map_err(|error| error.to_string())?;
        let value = serde_json::to_value(&*session).map_err(|error| error.to_string())?;
        self.store
            .save_ai_scripture_session(&session.id, &value)
            .map_err(|error| error.to_string())
    }

    fn record_transcript(&self, segment: &TranscriptSegment) -> Result<(), String> {
        // Persist finalized provider text. Interim revisions remain ephemeral;
        // their aggregate counts are tracked by the performance metrics, while
        // the durable transcript stays readable and suitable for later reuse.
        if !segment.is_final {
            return Ok(());
        }
        self.session
            .lock()
            .map_err(|error| error.to_string())?
            .transcript
            .push(segment.clone());
        self.persist()
    }

    fn record_suggestion(&self, suggestion: &ScriptureSuggestion) -> Result<(), String> {
        self.session
            .lock()
            .map_err(|error| error.to_string())?
            .suggestions
            .push(suggestion.clone());
        self.persist()
    }

    fn update_version(&self, version: &str) -> Result<(), String> {
        self.session
            .lock()
            .map_err(|error| error.to_string())?
            .version = version.to_string();
        self.persist()
    }

    fn finish(&self, reason: Option<String>) -> Result<(), String> {
        {
            let mut session = self.session.lock().map_err(|error| error.to_string())?;
            session.ended_at = Some(now_ms());
            session.stop_reason = reason;
        }
        self.persist()
    }
}

fn active_session_recorder() -> Option<Arc<AiSessionRecorder>> {
    runtime().lock().ok().and_then(|guard| {
        guard
            .session
            .as_ref()
            .map(|session| session.recorder.clone())
    })
}

#[derive(Clone)]
struct DetectionConfig {
    output_version: Arc<Mutex<String>>,
    available_versions: Vec<String>,
    books: Vec<String>,
    navigation_anchor: Arc<Mutex<Option<VerseAnchor>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VerseAnchor {
    book: String,
    chapter: i32,
    verse: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VerseNavigation {
    Next,
    Previous,
    Verse(i32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VoiceDirective {
    navigation: Option<VerseNavigation>,
    version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceCommandEvent {
    command: String,
    message: String,
    version: Option<String>,
    reference: Option<String>,
    timestamp: u64,
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
    source_transcript_timestamp: u64,
}

struct DetectionPipeline {
    context: VecDeque<(Instant, String)>,
    recently_suggested: Arc<Mutex<HashMap<String, Instant>>>,
    generation: Arc<AtomicU64>,
    quote_tx: watch::Sender<Option<QuoteJob>>,
    partial_turn_order: Option<u64>,
    partial_words: usize,
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

fn normalize_voice_phrase(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn contains_voice_phrase(text: &str, phrase: &str) -> bool {
    let padded_text = format!(" {text} ");
    let padded_phrase = format!(" {phrase} ");
    padded_text.contains(&padded_phrase)
}

fn detect_absolute_verse_navigation(text: &str) -> Option<i32> {
    let tokens = quote_tokens(text);
    let markers: &[&[&str]] = &[
        &["go", "to", "verse"],
        &["jump", "to", "verse"],
        &["take", "me", "to", "verse"],
        &["show", "verse"],
    ];
    let mut latest = None;
    for marker in markers {
        if marker.len() >= tokens.len() {
            continue;
        }
        for start in 0..=tokens.len() - marker.len() - 1 {
            if tokens[start..start + marker.len()]
                .iter()
                .map(String::as_str)
                .eq(marker.iter().copied())
            {
                if let Some((verse, _)) = parse_number(&tokens, start + marker.len()) {
                    if (1..=176).contains(&verse)
                        && latest.is_none_or(|(position, _)| start > position)
                    {
                        latest = Some((start, verse));
                    }
                }
            }
        }
    }
    latest.map(|(_, verse)| verse)
}

struct VersionFamily {
    /// Codes and phrases that identify this translation whether it is
    /// installed as "KJV", "King James Version", or "NASB 2020".
    keys: &'static [&'static str],
    /// Everything an operator might say for this translation.
    aliases: &'static [&'static str],
}

const VERSION_FAMILIES: &[VersionFamily] = &[
    VersionFamily {
        keys: &["kjv", "king james"],
        aliases: &["king james", "king james version", "kjv"],
    },
    VersionFamily {
        keys: &["nkjv", "new king james"],
        aliases: &["new king james", "new king james version", "nkjv"],
    },
    VersionFamily {
        keys: &["nlt", "new living"],
        aliases: &["new living", "new living translation", "nlt"],
    },
    VersionFamily {
        keys: &["amp", "ampc", "ampce", "amplified"],
        aliases: &["amplified", "amplified bible", "amplified version", "amp"],
    },
    VersionFamily {
        keys: &["niv", "new international"],
        aliases: &["new international", "new international version", "niv"],
    },
    VersionFamily {
        keys: &["esv", "english standard"],
        aliases: &["english standard", "english standard version", "esv"],
    },
    VersionFamily {
        keys: &["nasb", "nasb1995", "nasb2020", "new american standard"],
        aliases: &[
            "new american standard",
            "new american standard bible",
            "nasb",
        ],
    },
    VersionFamily {
        keys: &["rsv", "revised standard"],
        aliases: &["revised standard", "revised standard version", "rsv"],
    },
    VersionFamily {
        keys: &["nrsv", "nrsvue", "new revised standard"],
        aliases: &[
            "new revised standard",
            "new revised standard version",
            "nrsv",
        ],
    },
    VersionFamily {
        keys: &["csb", "christian standard"],
        aliases: &["christian standard", "christian standard bible", "csb"],
    },
    VersionFamily {
        keys: &["hcsb", "holman christian standard"],
        aliases: &[
            "holman christian standard",
            "holman christian standard bible",
            "hcsb",
        ],
    },
    VersionFamily {
        keys: &["msg", "message"],
        aliases: &["the message", "message bible", "msg"],
    },
    VersionFamily {
        keys: &["tpt", "passion"],
        aliases: &["the passion", "passion translation", "tpt"],
    },
    VersionFamily {
        keys: &["gnt", "good news"],
        aliases: &["good news", "good news translation", "gnt"],
    },
    VersionFamily {
        keys: &["cev", "contemporary english"],
        aliases: &[
            "contemporary english",
            "contemporary english version",
            "cev",
        ],
    },
];

fn version_voice_aliases(version: &str) -> Vec<String> {
    let normalized = normalize_voice_phrase(version);
    let compact = normalized.replace(' ', "");
    let mut aliases = vec![normalized.clone()];
    // Pick only the most specific family so "New King James Version" does not
    // also inherit "King James" aliases from its suffix.
    let mut best_family: Option<(&VersionFamily, usize)> = None;
    for family in VERSION_FAMILIES {
        for key in family.keys {
            let key_compact = key.replace(' ', "");
            let matches = compact == key_compact || contains_voice_phrase(&normalized, key);
            if matches && best_family.is_none_or(|(_, length)| key.len() > length) {
                best_family = Some((family, key.len()));
            }
        }
    }
    if let Some((family, _)) = best_family {
        aliases.extend(family.aliases.iter().map(|alias| alias.to_string()));
    }
    aliases.sort();
    aliases.dedup();
    aliases.sort_by_key(|alias| std::cmp::Reverse(alias.len()));
    aliases
}

fn resolve_spoken_version(text: &str, versions: &[String]) -> Option<String> {
    versions
        .iter()
        .flat_map(|version| {
            version_voice_aliases(version)
                .into_iter()
                .map(move |alias| (alias, version))
        })
        .filter(|(alias, _)| !alias.is_empty() && contains_voice_phrase(text, alias))
        .max_by_key(|(alias, _)| alias.len())
        .map(|(_, version)| version.clone())
}

fn detect_voice_directive(
    transcript: &str,
    versions: &[String],
    has_explicit_reference: bool,
) -> Option<VoiceDirective> {
    let normalized = normalize_voice_phrase(transcript);
    let word_count = normalized.split_whitespace().count();
    let navigation = if word_count <= 16
        && ["next verse", "following verse", "verse after that"]
            .iter()
            .any(|phrase| contains_voice_phrase(&normalized, phrase))
    {
        Some(VerseNavigation::Next)
    } else if word_count <= 16
        && ["previous verse", "verse before that", "go back one verse"]
            .iter()
            .any(|phrase| contains_voice_phrase(&normalized, phrase))
    {
        Some(VerseNavigation::Previous)
    } else if word_count <= 16 && !has_explicit_reference {
        detect_absolute_verse_navigation(&normalized).map(VerseNavigation::Verse)
    } else {
        None
    };
    let has_version_marker = [
        "give me",
        "give us",
        "gimme",
        "show me",
        "show us",
        "bring me",
        "bring up",
        "put up",
        "pull up",
        "switch to",
        "switch version",
        "switch the version",
        "switch translation",
        "change to",
        "change version",
        "change the version",
        "change translation",
        "change the translation",
        "use version",
        "use the version",
        "use translation",
        "read it in",
        "read that in",
        "read from",
        "read that from",
        "see it in",
        "see that in",
        "put it in",
        "let me have",
        "let me see it in",
    ]
    .iter()
    .any(|phrase| contains_voice_phrase(&normalized, phrase));
    let version = (navigation.is_some() || has_version_marker || has_explicit_reference)
        .then(|| resolve_spoken_version(&normalized, versions))
        .flatten();

    (navigation.is_some() || version.is_some()).then_some(VoiceDirective {
        navigation,
        version,
    })
}

fn current_output_version(detection: &DetectionConfig) -> String {
    detection
        .output_version
        .lock()
        .map(|version| version.clone())
        .unwrap_or_default()
}

fn set_navigation_anchor(detection: &DetectionConfig, verse: &Verse) {
    if let Ok(mut anchor) = detection.navigation_anchor.lock() {
        *anchor = Some(VerseAnchor {
            book: verse.book.clone(),
            chapter: verse.chapter,
            verse: verse.verse,
        });
    }
}

fn emit_voice_command(
    app: &AppHandle,
    command: &str,
    message: String,
    version: Option<String>,
    reference: Option<String>,
) {
    let _ = app.emit(
        "ai-scripture-command",
        VoiceCommandEvent {
            command: command.into(),
            message,
            version,
            reference,
            timestamp: now_ms(),
        },
    );
}

fn apply_voice_version(
    app: &AppHandle,
    bible: &BibleStore,
    detection: &DetectionConfig,
    provider: AsrProvider,
    version: &str,
    evidence: &str,
    preview_current_verse: bool,
    source_transcript_timestamp: u64,
) {
    if let Ok(mut current) = detection.output_version.lock() {
        *current = version.to_string();
    }
    if let Some(recorder) = active_session_recorder() {
        if let Err(error) = recorder.update_version(version) {
            crate::store::log_msg(
                app,
                &format!("[ai-scripture] could not save translation change: {error}"),
            );
        }
    }
    bible.set_active_version(app, version);
    let audio_device = runtime().lock().ok().and_then(|mut guard| {
        let session = guard.session.as_mut()?;
        session.version = version.to_string();
        Some(session.audio_device.clone())
    });
    // "Give me the Amplified" usually means the verse already under discussion,
    // not only the next lookup. Re-render the cursor verse as a manual card so
    // the operator sees the new translation without changing live output.
    let previewed_reference = preview_current_verse
        .then(|| navigation_anchor(detection, app))
        .flatten()
        .and_then(|anchor| {
            let verse = bible
                .get_verse(&anchor.book, anchor.chapter, anchor.verse, version)
                .ok()
                .flatten()?;
            let reference = format!("{} {}:{}", verse.book, verse.chapter, verse.verse);
            emit_suggestion(
                app,
                ScriptureSuggestion {
                    id: Uuid::new_v4().to_string(),
                    detection: "command".into(),
                    confidence: 0.99,
                    evidence: evidence.to_string(),
                    verse,
                    timestamp: now_ms(),
                    source_transcript_timestamp: Some(source_transcript_timestamp),
                    group_id: None,
                    rank: None,
                    passage_start: None,
                    passage_end: None,
                    similarity: None,
                    margin: None,
                },
            );
            Some(reference)
        });
    let message = match previewed_reference.as_deref() {
        Some(reference) => {
            format!("Voice command: {reference} loaded in {version}. Review it before staging.")
        }
        None => format!("Voice command: Scripture translation changed to {version}."),
    };
    emit_status(
        app,
        provider,
        "listening",
        &message,
        audio_device,
        Some(version.to_string()),
    );
    emit_voice_command(
        app,
        "version",
        message,
        Some(version.to_string()),
        previewed_reference,
    );
}

fn navigation_anchor(detection: &DetectionConfig, app: &AppHandle) -> Option<VerseAnchor> {
    if let Some(anchor) = detection
        .navigation_anchor
        .lock()
        .ok()
        .and_then(|anchor| anchor.clone())
    {
        return Some(anchor);
    }
    // When listening starts after the operator has already projected a verse,
    // fall back to what the congregation is seeing, then to the staged preview.
    let state = app.try_state::<AppState>()?;
    let live = state
        .presentation
        .live_item
        .lock()
        .as_ref()
        .and_then(|item| match item {
            crate::store::DisplayItem::Verse(verse) => Some(verse.clone()),
            _ => None,
        });
    let staged = state
        .presentation
        .staged_item
        .lock()
        .as_ref()
        .and_then(|item| match item {
            crate::store::DisplayItem::Verse(verse) => Some(verse.clone()),
            _ => None,
        });
    live.or(staged).map(|verse| VerseAnchor {
        book: verse.book,
        chapter: verse.chapter,
        verse: verse.verse,
    })
}

/// Sermons commonly continue through a chapter with "verse seventeen and
/// eighteen" after naming the book and chapter once. Resolve that concise form
/// against the last verified reference instead of making the operator repeat
/// the full citation.
fn detect_contextual_verse_reference(
    transcript: &str,
    detection: &DetectionConfig,
    app: &AppHandle,
) -> Option<crate::ai_detection::ScriptureReference> {
    let anchor = navigation_anchor(detection, app)?;
    contextual_verse_reference_for_anchor(transcript, &anchor)
}

fn contextual_verse_reference_for_anchor(
    transcript: &str,
    anchor: &VerseAnchor,
) -> Option<crate::ai_detection::ScriptureReference> {
    let tokens = quote_tokens(transcript);
    let mut latest = None;
    for index in 0..tokens.len() {
        if !matches!(tokens[index].as_str(), "verse" | "verses") {
            continue;
        }
        let Some((verse, next)) = parse_number(&tokens, index + 1) else {
            continue;
        };
        if !(1..=176).contains(&verse) {
            continue;
        }
        let verse_end = tokens.get(next).and_then(|separator| {
            matches!(separator.as_str(), "-" | "to" | "and")
                .then(|| parse_number(&tokens, next + 1).map(|(end, _)| end))
                .flatten()
                .filter(|end| *end >= verse && *end <= 176)
        });
        latest = Some(crate::ai_detection::ScriptureReference {
            book: anchor.book.clone(),
            chapter: anchor.chapter,
            verse,
            verse_end,
        });
    }
    latest
}

fn handle_voice_navigation(
    app: &AppHandle,
    bible: &BibleStore,
    detection: &DetectionConfig,
    navigation: VerseNavigation,
    evidence: &str,
    source_transcript_timestamp: u64,
) {
    let Some(anchor) = navigation_anchor(detection, app) else {
        emit_voice_command(
            app,
            "navigation",
            "Say or stage a Scripture reference before asking for the next or previous verse."
                .into(),
            Some(current_output_version(detection)),
            None,
        );
        return;
    };
    let version = current_output_version(detection);
    let verse = match navigation {
        VerseNavigation::Next => {
            bible.get_next_verse(&anchor.book, anchor.chapter, anchor.verse, &version)
        }
        VerseNavigation::Previous => {
            bible.get_prev_verse(&anchor.book, anchor.chapter, anchor.verse, &version)
        }
        VerseNavigation::Verse(verse) => {
            bible.get_verse(&anchor.book, anchor.chapter, verse, &version)
        }
    }
    .ok()
    .flatten();
    let Some(verse) = verse else {
        emit_voice_command(
            app,
            "navigation",
            match navigation {
                VerseNavigation::Verse(verse) => format!(
                    "Verse {verse} is not available in {} {} in the selected translation.",
                    anchor.book, anchor.chapter
                ),
                _ => "No adjacent verse is available in the selected translation.".into(),
            },
            Some(version),
            None,
        );
        return;
    };
    set_navigation_anchor(detection, &verse);
    let reference = format!("{} {}:{}", verse.book, verse.chapter, verse.verse);
    crate::store::log_msg(
        app,
        &format!(
            "[ai-scripture] voice navigation {} {} confidence=0.990",
            match navigation {
                VerseNavigation::Next => "next",
                VerseNavigation::Previous => "previous",
                VerseNavigation::Verse(_) => "absolute",
            },
            reference,
        ),
    );
    emit_suggestion(
        app,
        ScriptureSuggestion {
            id: Uuid::new_v4().to_string(),
            detection: "command".into(),
            confidence: 0.99,
            evidence: evidence.to_string(),
            verse,
            timestamp: now_ms(),
            source_transcript_timestamp: Some(source_transcript_timestamp),
            group_id: None,
            rank: None,
            passage_start: None,
            passage_end: None,
            similarity: None,
            margin: None,
        },
    );
    emit_voice_command(
        app,
        "navigation",
        format!("Voice command found {reference} in {version}. Review it before staging."),
        Some(version),
        Some(reference),
    );
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
    mode: String,
) -> Result<AiRuntimeStatus, String> {
    let provider = AsrProvider::parse(&provider)?;
    let mode = match mode.trim().to_ascii_lowercase().as_str() {
        "service" => "service".to_string(),
        "operator" => "operator".to_string(),
        _ => return Err("Choose Service or Operator listening mode.".into()),
    };
    if audio_device.trim().is_empty() {
        return Err("Choose an audio input device.".into());
    }
    let disabled_versions = state
        .presentation
        .settings
        .lock()
        .disabled_bible_versions
        .clone();
    let available_versions = state
        .store
        .get_available_versions()
        .into_iter()
        .filter(|candidate| !disabled_versions.contains(candidate))
        .collect::<Vec<_>>();
    if !available_versions
        .iter()
        .any(|candidate| candidate == &version)
    {
        return Err("Choose an enabled installed Bible version.".into());
    }
    let api_key = load_api_key(&state.app_data_dir, provider)?;
    let relay = subscribe_pcm_feed(&audio_device)?;
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
    let recorder;
    {
        let mut guard = runtime().lock().map_err(|e| e.to_string())?;
        if guard.session.is_some() {
            drop(relay);
            return Err("AI Scripture is already listening.".into());
        }
        recorder = AiSessionRecorder::new(
            state.media_schedule.clone(),
            session_id.clone(),
            provider,
            mode,
            audio_device.clone(),
            version.clone(),
        )?;
        guard.last_message = format!("Connecting to {}…", provider.display_name());
        guard.last_provider = provider;
        guard.session = Some(AiSessionControl {
            id: session_id.clone(),
            stop: stop_tx,
            audio_device: audio_device.clone(),
            version: version.clone(),
            provider,
            recorder: recorder.clone(),
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
                available_versions,
            },
            stop_rx,
        ))
        .catch_unwind()
        .await
        .unwrap_or_else(|_| {
            Err("AI transcription stopped unexpectedly. Stop and try again; details were written to Diagnostics.".into())
        });

        if let Err(error) = recorder.finish(result.as_ref().err().cloned()) {
            crate::store::log_msg(
                &task_app,
                &format!("[ai-scripture] could not finalize saved session: {error}"),
            );
        }

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
pub async fn ai_stop() -> Result<(), String> {
    let session = {
        let guard = runtime().lock().map_err(|e| e.to_string())?;
        guard
            .session
            .as_ref()
            .map(|session| (session.id.clone(), session.stop.clone()))
    };
    let Some((session_id, stop)) = session else {
        return Ok(());
    };
    let _ = stop.send(true);

    // Wait for the provider's final turn and recorder flush before allowing a
    // new listening session to start. This keeps the final spoken sentence in
    // the saved transcript without leaving the UI in a false stopped state.
    for _ in 0..200 {
        let still_running = runtime()
            .lock()
            .map_err(|error| error.to_string())?
            .session
            .as_ref()
            .is_some_and(|session| session.id == session_id);
        if !still_running {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("AI Scripture is still finishing its saved transcript. Try Stop again.".into())
}

fn load_saved_session(
    store: &MediaScheduleStore,
    id: &str,
) -> Result<AiScriptureSavedSession, String> {
    Uuid::parse_str(id).map_err(|_| "Invalid AI Scripture session identifier.".to_string())?;
    let value = store
        .load_ai_scripture_session(id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "AI Scripture session was not found.".to_string())?;
    serde_json::from_value(value).map_err(|error| format!("Saved session is invalid: {error}"))
}

#[tauri::command]
pub fn ai_sessions_list(
    state: State<'_, AppState>,
) -> Result<Vec<AiScriptureSessionSummary>, String> {
    let mut sessions = state
        .media_schedule
        .list_ai_scripture_sessions()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter_map(|value| serde_json::from_value::<AiScriptureSavedSession>(value).ok())
        .map(|session| {
            let transcript_preview = session
                .transcript
                .iter()
                .map(|segment| segment.text.trim())
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(180)
                .collect::<String>();
            AiScriptureSessionSummary {
                id: session.id,
                started_at: session.started_at,
                ended_at: session.ended_at,
                provider: session.provider,
                mode: session.mode,
                version: session.version,
                transcript_segments: session.transcript.len(),
                suggestions: session.suggestions.len(),
                transcript_preview,
            }
        })
        .collect::<Vec<_>>();
    sessions.sort_by_key(|session| std::cmp::Reverse(session.started_at));
    Ok(sessions)
}

#[tauri::command]
pub fn ai_session_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<AiScriptureSavedSession, String> {
    load_saved_session(&state.media_schedule, &id)
}

#[tauri::command]
pub fn ai_session_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    Uuid::parse_str(&id).map_err(|_| "Invalid AI Scripture session identifier.".to_string())?;
    if runtime()
        .lock()
        .map_err(|error| error.to_string())?
        .session
        .as_ref()
        .is_some_and(|session| session.id == id)
    {
        return Err("Stop AI Scripture before deleting the active session.".into());
    }
    state
        .media_schedule
        .delete_ai_scripture_session(&id)
        .map_err(|error| error.to_string())
}

fn validate_session_export_path(raw: &str) -> Result<PathBuf, String> {
    if raw.contains('\0') || raw.split(['/', '\\']).any(|part| part == "..") {
        return Err("Invalid export path.".into());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("Export path must be absolute.".into());
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "txt" | "md" | "json") {
        return Err("Transcript exports must use .txt, .md, or .json.".into());
    }
    Ok(path)
}

fn saved_session_transcript(session: &AiScriptureSavedSession) -> String {
    session
        .transcript
        .iter()
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn saved_session_markdown(session: &AiScriptureSavedSession) -> String {
    let mut output = format!(
        "# AI Scripture Session\n\n- Started: {}\n- Ended: {}\n- Provider: {}\n- Mode: {}\n- Translation: {}\n\n## Transcript\n\n{}\n",
        session.started_at,
        session
            .ended_at
            .map(|value| value.to_string())
            .unwrap_or_else(|| "In progress".into()),
        session.provider,
        session.mode,
        session.version,
        saved_session_transcript(session),
    );
    if !session.suggestions.is_empty() {
        output.push_str("\n## Scripture Suggestions\n\n");
        for suggestion in &session.suggestions {
            output.push_str(&format!(
                "- **{} {}:{} ({})** — {} at {}%\n  - Heard: {}\n",
                suggestion.verse.book,
                suggestion.verse.chapter,
                suggestion.verse.verse,
                suggestion.verse.version,
                suggestion.detection,
                (suggestion.confidence * 100.0).round(),
                suggestion.evidence.replace('\n', " "),
            ));
        }
    }
    output
}

#[tauri::command]
pub fn ai_session_export(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<(), String> {
    let session = load_saved_session(&state.media_schedule, &id)?;
    let destination = validate_session_export_path(&path)?;
    let extension = destination
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let content = match extension.as_str() {
        "json" => serde_json::to_string_pretty(&session).map_err(|error| error.to_string())?,
        "md" => saved_session_markdown(&session),
        _ => saved_session_transcript(&session),
    };
    std::fs::write(destination, content)
        .map_err(|error| format!("Could not export the transcript: {error}"))
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

async fn connect_pcm_relay(relay: &AudioRelay) -> Result<tokio::net::TcpStream, String> {
    let connection = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect(("127.0.0.1", relay.port())),
    )
    .await
    .map_err(|_| "Timed out connecting to the transcription PCM feed.".to_string())?
    .map_err(|error| format!("Could not connect to the transcription PCM feed: {error}"))?;
    connection.set_nodelay(true).ok();
    Ok(connection)
}

/// DirectShow can need a short cooldown after a capture process has released
/// its device pin. Retry the complete subscription (not just the local TCP
/// connection) so a transient PCM branch restart does not end a live listener.
async fn recover_pcm_relay(
    audio_device: &str,
) -> Result<(AudioRelay, tokio::net::TcpStream), String> {
    const ATTEMPTS: usize = 3;
    let mut failures = Vec::with_capacity(ATTEMPTS);
    for attempt in 0..ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(750 * attempt as u64)).await;
        }
        let relay = match subscribe_pcm_feed(audio_device) {
            Ok(relay) => relay,
            Err(error) => {
                failures.push(error);
                continue;
            }
        };
        match connect_pcm_relay(&relay).await {
            Ok(pcm) => return Ok((relay, pcm)),
            Err(error) => {
                // Dropping releases the refcount before the next attempt.
                drop(relay);
                failures.push(error);
            }
        }
    }
    Err(failures.join("; "))
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
        available_versions,
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
    let mut pcm = connect_pcm_relay(relay.as_ref().expect("audio relay initialized")).await?;
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
        output_version: Arc::new(Mutex::new(version.clone())),
        available_versions,
        books,
        navigation_anchor: Arc::new(Mutex::new(None)),
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
        partial_turn_order: None,
        partial_words: 0,
    };
    let mut audio = vec![0u8; 3200];
    let mut last_audio_level_emit = Instant::now() - Duration::from_millis(100);

    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_ok() && *stop.borrow() { break; }
            }
            read = pcm.read(&mut audio) => {
                let count = read.map_err(|e| format!("PCM audio feed failed: {e}"))?;
                if count == 0 {
                    let feed_diagnostics = feed_diagnostics();
                    crate::store::log_msg(
                        &app,
                        &format!("[ai-scripture] PCM audio feed EOF: {feed_diagnostics}"),
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
                    let (replacement, replacement_pcm) = recover_pcm_relay(&audio_device).await.map_err(|error| {
                        format!("Could not recover transcription audio: {error}")
                    })?;
                    pcm = replacement_pcm;
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
                if last_audio_level_emit.elapsed() >= Duration::from_millis(65) {
                    let _ = app.emit("ai-scripture-audio-level", AiAudioLevel {
                        level: pcm_level(&audio[..count]),
                    });
                    last_audio_level_emit = Instant::now();
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
    drop(pcm);
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
        // Stable local verse candidate across two consecutive interim searches.
        // This is intentionally separate from the final-turn cooldown.
        let mut interim_quote = None;
        while quote_rx.changed().await.is_ok() {
            let Some(job) = quote_rx.borrow_and_update().clone() else {
                continue;
            };
            let worker_bible = worker.bible.clone();
            let worker_detection = worker.detection.clone();
            let worker_job = job.clone();
            let mut suggestions = tokio::task::spawn_blocking(move || {
                let output_version = current_output_version(&worker_detection);
                detect_direct_quotes(
                    &worker_bible,
                    &worker_job.rolling_text,
                    &worker_job.evidence,
                    &output_version,
                    worker_job.asr_confidence,
                )
            })
            .await
            .unwrap_or_default();

            for suggestion in &mut suggestions {
                suggestion.source_transcript_timestamp = Some(job.source_transcript_timestamp);
            }

            if !worker.active.load(Ordering::Acquire) {
                continue;
            }
            if job.is_interim {
                if let Some(mut suggestion) = suggestions.into_iter().next() {
                    let key = suggestion_cooldown_key(&suggestion.detection, &suggestion.verse);
                    if confirm_interim_reference(&mut interim_quote, Some(key)) {
                        // Provider interim text can still be revised. Show the
                        // stable preview, but reserve automation for the final
                        // transcript event.
                        suggestion.confidence =
                            suggestion.confidence.min(MAX_SHORT_QUOTE_CONFIDENCE);
                        crate::store::log_msg(
                            &worker.app,
                            &format!(
                                "[ai-scripture] stable interim quote {} {}:{} confidence={:.3}",
                                suggestion.verse.book,
                                suggestion.verse.chapter,
                                suggestion.verse.verse,
                                suggestion.confidence,
                            ),
                        );
                        emit_suggestion(&worker.app, suggestion);
                    }
                } else {
                    confirm_interim_reference(&mut interim_quote, None);
                }
                continue;
            }

            // Final turns can arrive more quickly than local lexical lookup
            // completes. Do not throw away a valid quotation merely because a
            // newer turn arrived; that starves continuous sermons. A delayed
            // result is capped below automation confidence and cannot move the
            // navigation cursor, so a newer explicit reference remains safe.
            let stale = worker.generation.load(Ordering::Acquire) != job.generation;
            if stale {
                for suggestion in &mut suggestions {
                    suggestion.confidence = suggestion.confidence.min(MAX_SHORT_QUOTE_CONFIDENCE);
                }
            } else if let Some(suggestion) = suggestions.first() {
                set_navigation_anchor(&worker.detection, &suggestion.verse);
            }

            let mut emitted_quote = false;
            // React prepends events. Emit weaker alternatives first so the
            // strongest quotation remains at the top of the suggestion list.
            for suggestion in suggestions.into_iter().rev() {
                emitted_quote |=
                    emit_suggestion_if_new(&worker.app, &worker.recently_suggested, suggestion);
            }
            if emitted_quote {
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
            let output_version = current_output_version(&worker.detection);
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
                            source_transcript_timestamp: Some(job.source_transcript_timestamp),
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
        emit_suggestion(app, suggestion);
        true
    } else {
        false
    }
}

/// Revisions for one spoken reference arrive within a few seconds. Surface the
/// first valid reference in Preview immediately, then suppress only that short
/// revision burst; a deliberate later mention remains proactive.
fn emit_proactive_preview_reference(
    app: &AppHandle,
    recently_suggested: &Mutex<HashMap<String, Instant>>,
    suggestion: ScriptureSuggestion,
) {
    if let Ok(mut recent) = recently_suggested.lock() {
        let now = Instant::now();
        recent.retain(|_, at| now.duration_since(*at) <= SUGGESTION_COOLDOWN);
        let key = suggestion_cooldown_key(&suggestion.detection, &suggestion.verse);
        if recent
            .get(&key)
            .is_some_and(|at| now.duration_since(*at) <= PROACTIVE_REFERENCE_FINALIZATION_WINDOW)
        {
            return;
        }
        recent.insert(key, now);
    }
    emit_suggestion(app, suggestion);
}

/// A finalized explicit reference upgrades the proactive Preview card. Its new
/// event ID permits the established auto-stage/Auto Live settings to act on
/// the provider's finalized transcript rather than an ASR revision.
fn emit_fresh_reference(
    app: &AppHandle,
    recently_suggested: &Mutex<HashMap<String, Instant>>,
    suggestion: ScriptureSuggestion,
) {
    if let Ok(mut recent) = recently_suggested.lock() {
        let now = Instant::now();
        recent.retain(|_, at| now.duration_since(*at) <= SUGGESTION_COOLDOWN);
        recent.insert(
            suggestion_cooldown_key(&suggestion.detection, &suggestion.verse),
            now,
        );
    }
    emit_suggestion(app, suggestion);
}

fn emit_suggestion(app: &AppHandle, suggestion: ScriptureSuggestion) {
    if let Some(recorder) = active_session_recorder() {
        if let Err(error) = recorder.record_suggestion(&suggestion) {
            crate::store::log_msg(
                app,
                &format!("[ai-scripture] could not save suggestion: {error}"),
            );
        }
    }
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
}

fn suggestion_cooldown_key(detection: &str, verse: &Verse) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        detection, verse.book, verse.chapter, verse.verse, verse.version
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
    let transcript_timestamp = now_ms();
    let segment = TranscriptSegment {
        id: provider_transcript
            .turn_order
            .map(|turn| format!("assemblyai-turn-{turn}"))
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        text: transcript.to_string(),
        is_final,
        confidence,
        timestamp: transcript_timestamp,
    };
    if let Some(recorder) = active_session_recorder() {
        if let Err(error) = recorder.record_transcript(&segment) {
            crate::store::log_msg(
                app,
                &format!("[ai-scripture] could not save transcript segment: {error}"),
            );
        }
    }
    let _ = app.emit("ai-scripture-transcript", &segment);
    if !is_final {
        // Both providers stream revisable interim text. Use it for local,
        // manual-only reference/quote lookup so the operator sees a likely
        // passage before an ASR turn closes. AssemblyAI is sampled every six
        // words; Deepgram's shorter revisions are stability-gated instead.
        handle_interim_transcript(
            app,
            bible,
            detection,
            pipeline,
            transcript,
            confidence,
            turn_order,
            transcript_timestamp,
        );
        return Ok(());
    }
    pipeline.partial_turn_order = None;
    pipeline.partial_words = 0;

    let direct_references = detect_references(transcript, &detection.books);
    let transcript_reference = direct_references.last().cloned();
    if let Some(directive) = detect_voice_directive(
        transcript,
        &detection.available_versions,
        transcript_reference.is_some(),
    ) {
        // Cancel any quotation/semantic work queued from earlier turns before
        // moving the cursor. Otherwise a stale quote job can finish after
        // navigation and overwrite the new anchor back to the first verse,
        // so a following "give me NLT" renders the initial verse again.
        pipeline.generation.fetch_add(1, Ordering::AcqRel);
        pipeline.quote_tx.send_replace(None);
        if let Some(version) = directive.version.as_deref() {
            if version != current_output_version(detection) {
                apply_voice_version(
                    app,
                    bible,
                    detection,
                    provider,
                    version,
                    transcript,
                    directive.navigation.is_none() && transcript_reference.is_none(),
                    transcript_timestamp,
                );
            } else {
                emit_voice_command(
                    app,
                    "version",
                    format!("Scripture translation is already {version}."),
                    Some(version.to_string()),
                    None,
                );
            }
        }
        if let Some(navigation) = directive.navigation {
            handle_voice_navigation(
                app,
                bible,
                detection,
                navigation,
                transcript,
                transcript_timestamp,
            );
            return Ok(());
        }
        // A translation-only command is operational speech, not sermon
        // content. Do not feed it into quotation or semantic retrieval.
        if transcript_reference.is_none() {
            return Ok(());
        }
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
    let final_references = if direct_references.is_empty() {
        if let Some(contextual) = detect_contextual_verse_reference(transcript, detection, app) {
            (vec![contextual], true)
        } else {
            (detect_references(&reference_text, &detection.books), false)
        }
    } else {
        (direct_references, true)
    };
    if !final_references.0.is_empty() {
        // Events are prepended in React. Emit a range in reverse so its first
        // verse and earliest spoken reference remain at the top of the list.
        let output_version = current_output_version(detection);
        for reference in final_references.0.into_iter().rev() {
            let verses = verses_for_reference(bible, &reference, &output_version);
            if let Some(last) = verses.last() {
                set_navigation_anchor(detection, last);
            }
            for verse in verses.into_iter().rev() {
                let suggestion = ScriptureSuggestion {
                    id: Uuid::new_v4().to_string(),
                    detection: "reference".into(),
                    confidence: if verse.verse == reference.verse {
                        (0.92 + confidence * 0.07).clamp(0.0, 0.99)
                    } else {
                        MAX_SHORT_QUOTE_CONFIDENCE
                    },
                    evidence: transcript.to_string(),
                    verse,
                    timestamp: now_ms(),
                    source_transcript_timestamp: Some(transcript_timestamp),
                    group_id: None,
                    rank: None,
                    passage_start: Some(reference.verse),
                    passage_end: reference.verse_end,
                    similarity: None,
                    margin: None,
                };
                if final_references.1 {
                    emit_fresh_reference(app, &pipeline.recently_suggested, suggestion);
                } else {
                    emit_suggestion_if_new(app, &pipeline.recently_suggested, suggestion);
                }
            }
        }
        // A finalized ASR turn can contain both an explicit reference and
        // other quotations. Keep the deterministic reference fast path, but
        // still queue the same turn for quotation/semantic analysis.
    }
    pipeline.quote_tx.send_replace(Some(QuoteJob {
        generation: current_generation,
        rolling_text,
        semantic_text,
        semantic_segments,
        evidence: transcript.to_string(),
        asr_confidence: confidence,
        is_interim: false,
        source_transcript_timestamp: transcript_timestamp,
    }));
    Ok(())
}

fn handle_interim_transcript(
    app: &AppHandle,
    bible: &BibleStore,
    detection: &DetectionConfig,
    pipeline: &mut DetectionPipeline,
    transcript: &str,
    asr_confidence: f32,
    turn_order: Option<u64>,
    transcript_timestamp: u64,
) {
    if turn_order.is_some() && pipeline.partial_turn_order != turn_order {
        pipeline.partial_turn_order = turn_order;
        pipeline.partial_words = 0;
    }

    // References are the operator's real-time path. Search every provider
    // revision as soon as it contains a complete, locally verifiable reference
    // instead of waiting for a second revision, a word-count sample, or an ASR
    // turn boundary. They remain Preview-only until the provider sends its
    // final transcript: ASR can briefly revise a spoken number while the
    // preacher is still speaking.
    let references = {
        let direct = detect_references(transcript, &detection.books);
        if direct.is_empty() {
            detect_contextual_verse_reference(transcript, detection, app)
                .into_iter()
                .collect()
        } else {
            direct
        }
    };
    let output_version = current_output_version(detection);
    for reference in references {
        for verse in verses_for_reference(bible, &reference, &output_version)
            .into_iter()
            .rev()
        {
            let suggestion = ScriptureSuggestion {
                id: Uuid::new_v4().to_string(),
                detection: "reference".into(),
                confidence: MAX_SHORT_QUOTE_CONFIDENCE,
                evidence: latest_word_suffix(transcript, MAX_SEMANTIC_CONTEXT_WORDS),
                verse,
                timestamp: now_ms(),
                source_transcript_timestamp: Some(transcript_timestamp),
                group_id: None,
                rank: None,
                passage_start: Some(reference.verse),
                passage_end: reference.verse_end,
                similarity: None,
                margin: None,
            };
            emit_proactive_preview_reference(app, &pipeline.recently_suggested, suggestion);
        }
    }

    // Quote and semantic retrieval can be comparatively expensive. Throttle
    // only that background work; it must never delay explicit references.
    let words = quote_tokens(transcript).len();
    if words < pipeline.partial_words {
        // A provider revision shortened the turn. Measure the next background
        // quote-detection interval from the revised snapshot.
        pipeline.partial_words = words;
    }
    if words
        < pipeline
            .partial_words
            .saturating_add(PARTIAL_QUOTE_DETECTION_STEP_WORDS)
    {
        return;
    }
    pipeline.partial_words = words;

    pipeline.quote_tx.send_replace(Some(QuoteJob {
        generation: pipeline.generation.load(Ordering::Acquire),
        rolling_text: transcript.to_string(),
        semantic_text: String::new(),
        semantic_segments: 0,
        evidence: latest_word_suffix(transcript, MAX_SEMANTIC_CONTEXT_WORDS),
        asr_confidence,
        is_interim: true,
        source_transcript_timestamp: transcript_timestamp,
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

/// Quote candidates are probabilistic, unlike a complete explicit reference.
/// Keep the two-update confirmation only for that background matching path.
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

fn detect_direct_quotes(
    bible: &BibleStore,
    rolling_text: &str,
    evidence: &str,
    output_version: &str,
    asr_confidence: f32,
) -> Vec<ScriptureSuggestion> {
    if quote_tokens(rolling_text).len() < MIN_DIRECT_QUOTE_WORDS {
        return Vec::new();
    }

    // A provider can finalize several sentences (or, after a network delay, a
    // sizeable paragraph) as one turn. Search overlapping bounded windows so
    // a quotation near the beginning is not hidden by the final 24 words.
    let mut matches: HashMap<(String, i32, i32), (Verse, f32, String)> = HashMap::new();
    for window in quote_search_windows(evidence) {
        if let Some((verse, score)) = best_direct_quote_candidate(bible, &window, &window) {
            let key = (verse.book.clone(), verse.chapter, verse.verse);
            let replace = matches
                .get(&key)
                .is_none_or(|(_, current_score, _)| score > *current_score);
            if replace {
                matches.insert(key, (verse, score, window));
            }
        }
    }

    // If the newest finalized turn did not contain a complete match, include
    // the rolling context to recover a quotation split across ASR boundaries.
    if matches.is_empty() && rolling_text != evidence {
        for window in quote_search_windows(rolling_text) {
            if let Some((verse, score)) = best_direct_quote_candidate(bible, &window, &window) {
                let key = (verse.book.clone(), verse.chapter, verse.verse);
                let replace = matches
                    .get(&key)
                    .is_none_or(|(_, current_score, _)| score > *current_score);
                if replace {
                    matches.insert(key, (verse, score, window));
                }
            }
        }
    }

    let mut matches = matches.into_values().collect::<Vec<_>>();
    matches.sort_by(|(_, left, _), (_, right, _)| right.total_cmp(left));
    matches
        .into_iter()
        .take(MAX_DIRECT_QUOTES_PER_TURN)
        .filter_map(|(matched_verse, score, matched_evidence)| {
            let verse = bible
                .get_verse(
                    &matched_verse.book,
                    matched_verse.chapter,
                    matched_verse.verse,
                    output_version,
                )
                .ok()
                .flatten()?;
            let confidence =
                quote_confidence(score, asr_confidence, quote_tokens(&matched_evidence).len());
            Some(ScriptureSuggestion {
                id: Uuid::new_v4().to_string(),
                detection: "quote".into(),
                confidence,
                evidence: matched_evidence,
                verse,
                timestamp: now_ms(),
                source_transcript_timestamp: None,
                group_id: None,
                rank: None,
                passage_start: None,
                passage_end: None,
                similarity: None,
                margin: None,
            })
        })
        .collect()
}

fn quote_search_windows(text: &str) -> Vec<String> {
    let sentences = text
        .split_inclusive(['.', '!', '?'])
        .map(str::trim)
        .filter(|sentence| !sentence.is_empty())
        .collect::<Vec<_>>();
    let has_sentence_boundaries = sentences.len() > 1;
    let mut windows = Vec::new();

    if has_sentence_boundaries {
        for sentence in &sentences {
            append_quote_token_windows(&mut windows, &quote_tokens(sentence));
        }
        // Recover a quotation that ASR punctuation split into a very short
        // fragment and its neighboring sentence without blending arbitrary
        // complete sermon thoughts together.
        for pair in sentences.windows(2) {
            let left = quote_tokens(pair[0]);
            let right = quote_tokens(pair[1]);
            if left.len() >= MIN_DIRECT_QUOTE_WORDS && right.len() >= MIN_DIRECT_QUOTE_WORDS {
                continue;
            }
            let mut combined = left;
            combined.extend(right);
            if combined.len() <= QUOTE_SEARCH_WINDOW_WORDS {
                append_quote_token_windows(&mut windows, &combined);
            }
        }
    } else {
        append_quote_token_windows(&mut windows, &quote_tokens(text));
    }

    windows.dedup();
    if windows.len() > MAX_QUOTE_SEARCH_WINDOWS {
        windows.drain(..windows.len() - MAX_QUOTE_SEARCH_WINDOWS);
    }
    windows
}

fn append_quote_token_windows(windows: &mut Vec<String>, tokens: &[String]) {
    if tokens.len() < MIN_DIRECT_QUOTE_WORDS {
        return;
    }
    if tokens.len() <= QUOTE_SEARCH_WINDOW_WORDS {
        let window = tokens.join(" ");
        if tokens.len() > 8 || quote_content_word_count(&window) >= MIN_SHORT_WINDOW_CONTENT_WORDS {
            windows.push(window);
        }
        return;
    }

    let step = QUOTE_SEARCH_WINDOW_WORDS - QUOTE_SEARCH_WINDOW_OVERLAP;
    let mut start = 0;
    loop {
        let end = (start + QUOTE_SEARCH_WINDOW_WORDS).min(tokens.len());
        windows.push(tokens[start..end].join(" "));
        if end == tokens.len() {
            break;
        }
        start = (start + step).min(tokens.len() - QUOTE_SEARCH_WINDOW_WORDS);
        if start + QUOTE_SEARCH_WINDOW_WORDS == tokens.len() {
            windows.push(tokens[start..].join(" "));
            break;
        }
    }
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
    fn saved_session_exports_include_transcript_and_suggestions() {
        let session = AiScriptureSavedSession {
            id: Uuid::new_v4().to_string(),
            started_at: 1,
            ended_at: Some(2),
            provider: "assemblyai".into(),
            mode: "service".into(),
            audio_device: "Mixer".into(),
            version: "KJV".into(),
            transcript: vec![TranscriptSegment {
                id: "turn-1".into(),
                text: "Faith comes by hearing.".into(),
                is_final: true,
                confidence: 0.98,
                timestamp: 1,
            }],
            suggestions: vec![ScriptureSuggestion {
                id: "suggestion-1".into(),
                detection: "reference".into(),
                confidence: 0.99,
                evidence: "Romans 10:17".into(),
                verse: Verse {
                    book: "Romans".into(),
                    chapter: 10,
                    verse: 17,
                    text: "So then faith cometh by hearing".into(),
                    version: "KJV".into(),
                    split_index: None,
                    total_splits: None,
                    score: None,
                },
                timestamp: 2,
                source_transcript_timestamp: Some(1),
                group_id: None,
                rank: None,
                passage_start: None,
                passage_end: None,
                similarity: None,
                margin: None,
            }],
            stop_reason: None,
        };

        assert_eq!(
            saved_session_transcript(&session),
            "Faith comes by hearing."
        );
        let markdown = saved_session_markdown(&session);
        assert!(markdown.contains("Faith comes by hearing."));
        assert!(markdown.contains("Romans 10:17"));
        assert!(validate_session_export_path("C:/Users/test/transcript.md").is_ok());
        assert!(validate_session_export_path("C:/Users/test/transcript.exe").is_err());
        assert!(validate_session_export_path("relative/transcript.txt").is_err());
    }

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
    fn preserves_deepgram_interim_results_for_fast_local_lookup() {
        let transcript = parse_deepgram_transcript(
            r#"{"type":"Results","is_final":false,"channel":{"alternatives":[{"transcript":"John chapter three verse sixteen","confidence":0.91}]}}"#,
        )
        .expect("interim result should produce a transcript");
        assert!(!transcript.is_final);
        assert_eq!(transcript.text, "John chapter three verse sixteen");
    }

    #[test]
    fn five_word_quotes_never_reach_auto_stage_confidence() {
        assert_eq!(quote_confidence(1.0, 1.0, 5), 0.89);
        assert_eq!(quote_confidence(1.0, 1.0, 6), 0.98);
    }

    #[test]
    fn long_final_turns_keep_earlier_quotations_searchable() {
        let filler_before = (0..30)
            .map(|index| format!("opening{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        let filler_between = (0..30)
            .map(|index| format!("middle{index}"))
            .collect::<Vec<_>>()
            .join(" ");
        let transcript = format!(
            "{filler_before} I will never leave thee nor forsake thee {filler_between} whosoever drinketh of the water that I shall give him shall never thirst closing words"
        );
        let windows = quote_search_windows(&transcript);

        assert!(windows.len() > 1);
        assert!(windows
            .iter()
            .all(|window| quote_tokens(window).len() <= QUOTE_SEARCH_WINDOW_WORDS));
        assert!(windows.iter().any(|window| direct_quote_match_score(
            window,
            "For he hath said, I will never leave thee, nor forsake thee."
        )
        .is_some()));
        assert!(windows.iter().any(|window| direct_quote_match_score(
            window,
            "But whosoever drinketh of the water that I shall give him shall never thirst."
        )
        .is_some()));
    }

    #[test]
    fn sermon_commentary_does_not_become_unrelated_direct_quotes() {
        let transcript = "To make you literate, you can access the vision of above. And with faith in the validity of the word. Commits God integrity to respond. If you have asked that from your heart, Heaven will respond in your direction. I took those 2 books and I said, Jesus, show me what you showed Copeland that is showing in his life. So I sat with the books and sat with my Bible. On the 3rd day, I found it because I went for it. I was on the ice-cold path, must fall on the water. I need to turn with it. Someone's gonna have an encounter tonight. I'll become a live wire. Your walk would go. For the remaining days of your life. Let me hear your loudest amen. Church is not a club. It's God's house. Where you walk salvation. midst of the earth. Where he shows people what will give them their rest. Come unto me, I'll give you rest. Come on in. Of man, you find rest for your souls. And who is talking? Jesus. Very much with you, my name. Somebody's leaving here today with the key to next level rest. Next level rest in your journey. In the name of Jesus. Heavenly Father, thank you for another great night.";
        let windows = quote_search_windows(transcript);

        assert!(windows.iter().all(|window| direct_quote_match_score(
            window,
            "And whatsoever ye do in word or deed, do all in the name of the Lord Jesus, giving thanks to God and the Father by him."
        )
        .is_none()));
        assert!(windows.iter().all(|window| direct_quote_match_score(
            window,
            "And the LORD God said unto the serpent, Because thou hast done this, thou art cursed above all cattle, and above every beast of the field; upon thy belly shalt thou go, and dust shalt thou eat all the days of thy life."
        )
        .is_none()));
        // The short shared phrase is not strong enough by itself to claim
        // Jeremiah; prepared paraphrase matching supplies the Matthew context.
        assert!(windows.iter().all(|window| direct_quote_match_score(
            window,
            "Thus saith the LORD, Stand ye in the ways, and see, and ask for the old paths, where is the good way, and walk therein, and ye shall find rest for your souls."
        )
        .is_none()));
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
    fn voice_commands_resolve_navigation_and_installed_version_aliases() {
        let versions = vec!["AMP".into(), "KJV".into(), "NLT".into()];
        assert_eq!(
            detect_voice_directive("Give me Amplified", &versions, false),
            Some(VoiceDirective {
                navigation: None,
                version: Some("AMP".into()),
            })
        );
        assert_eq!(
            detect_voice_directive("Next verse in NLT", &versions, false),
            Some(VoiceDirective {
                navigation: Some(VerseNavigation::Next),
                version: Some("NLT".into()),
            })
        );
        assert_eq!(
            detect_voice_directive("Go back one verse", &versions, false),
            Some(VoiceDirective {
                navigation: Some(VerseNavigation::Previous),
                version: None,
            })
        );
        assert_eq!(
            detect_voice_directive("Go to verse 12", &versions, false),
            Some(VoiceDirective {
                navigation: Some(VerseNavigation::Verse(12)),
                version: None,
            })
        );
        assert_eq!(
            detect_voice_directive("Take me to verse sixteen in NLT", &versions, false),
            Some(VoiceDirective {
                navigation: Some(VerseNavigation::Verse(16)),
                version: Some("NLT".into()),
            })
        );
    }

    #[test]
    fn version_aliases_match_full_installed_names_and_prefer_longest_family() {
        let full_names = vec![
            "Amplified Bible".into(),
            "King James Version".into(),
            "New King James Version".into(),
            "New Living Translation".into(),
        ];
        assert_eq!(
            detect_voice_directive("Give me amplified", &full_names, false)
                .and_then(|directive| directive.version),
            Some("Amplified Bible".into())
        );
        assert_eq!(
            detect_voice_directive("Switch to King James", &full_names, false)
                .and_then(|directive| directive.version),
            Some("King James Version".into())
        );
        assert_eq!(
            detect_voice_directive("Switch to New King James", &full_names, false)
                .and_then(|directive| directive.version),
            Some("New King James Version".into())
        );
        assert_eq!(
            detect_voice_directive("Use version NLT", &full_names, false)
                .and_then(|directive| directive.version),
            Some("New Living Translation".into())
        );
    }

    #[test]
    fn explicit_reference_can_select_a_translation_in_the_same_utterance() {
        let versions = vec!["KJV".into(), "NLT".into()];
        assert_eq!(
            detect_voice_directive("John 3:16 in King James", &versions, true),
            Some(VoiceDirective {
                navigation: None,
                version: Some("KJV".into()),
            })
        );
    }

    #[test]
    fn incidental_translation_names_do_not_switch_versions() {
        let versions = vec!["KJV".into(), "NLT".into()];
        assert!(detect_voice_directive(
            "King James commissioned an English translation",
            &versions,
            false
        )
        .is_none());
    }

    #[test]
    fn suggestion_cooldown_keeps_translations_distinct() {
        let mut kjv = Verse {
            book: "John".into(),
            chapter: 3,
            verse: 16,
            text: "For God so loved the world".into(),
            version: "KJV".into(),
            split_index: None,
            total_splits: None,
            score: None,
        };
        let mut nlt = kjv.clone();
        nlt.version = "NLT".into();
        nlt.text = "For this is how God loved the world".into();
        assert_ne!(
            suggestion_cooldown_key("reference", &kjv),
            suggestion_cooldown_key("reference", &nlt)
        );
        kjv.version = "NLT".into();
        assert_eq!(
            suggestion_cooldown_key("reference", &kjv),
            suggestion_cooldown_key("reference", &nlt)
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
    fn interim_quotes_require_two_consistent_snapshots() {
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
    fn contextual_verses_follow_the_last_verified_chapter() {
        let anchor = VerseAnchor {
            book: "Matthew".into(),
            chapter: 6,
            verse: 10,
        };
        assert_eq!(
            contextual_verse_reference_for_anchor(
                "Verses seventeen and eighteen, when you fast.",
                &anchor
            ),
            Some(crate::ai_detection::ScriptureReference {
                book: "Matthew".into(),
                chapter: 6,
                verse: 17,
                verse_end: Some(18),
            })
        );
    }

    #[test]
    fn deepgram_url_uses_separate_encoded_bible_keyterms() {
        let url = deepgram_url();
        assert!(url.contains("&keyterm=First%20Thessalonians"));
        assert!(url.contains("&keyterm=Ecclesiastes"));
        assert!(url.contains("&keyterm=next%20verse"));
        assert!(url.contains("&keyterm=New%20Living%20Translation"));
        assert!(!url.contains("keyterm=First Thessalonians"));
        assert_eq!(
            url.matches("&keyterm=").count(),
            BIBLE_KEYTERMS.len() + VOICE_COMMAND_KEYTERMS.len()
        );
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
        assert!(url.contains("next%20verse"));
        assert!(url.contains("New%20Living%20Translation"));
        assert!(!url.contains("First Thessalonians"));
    }
}
