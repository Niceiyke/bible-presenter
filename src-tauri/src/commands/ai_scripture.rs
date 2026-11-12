use crate::ai_detection::{
    detect_references_with_aliases, direct_quote_match_score, normalized_transcript_tokens,
    parse_number, quote_content_word_count, quote_tokens, quote_tokens_from_normalized,
    reference_aliases_for_books, MIN_DIRECT_QUOTE_WORDS,
};
use crate::commands::program_audio::{feed_diagnostics, subscribe_pcm_feed, AudioRelay};
use crate::semantic_scripture::{self, SemanticScripture};
use crate::state::AppState;
use crate::store::{BibleStore, MediaScheduleStore, Verse};
mod providers;
use self::providers::{adapter_for, AsrProvider, ProviderEvent, TranscriptUpdate};
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncReadExt;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use uuid::Uuid;

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
/// Two neighbouring sentences are searched together while their combined span
/// stays this small (two search windows); continuous speech produces long
/// sentences that a quotation can straddle.
const MAX_PAIRED_SENTENCE_WORDS: usize = QUOTE_SEARCH_WINDOW_WORDS * 2;
const MAX_DIRECT_QUOTES_PER_TURN: usize = 3;
/// Limits how many FTS-retrieved candidates are lexically aligned per search
/// window; tier results arrive bm25-ordered, so the front is the strongest.
const MAX_QUOTE_CANDIDATES_SCORED: usize = 96;
const MIN_SHORT_WINDOW_CONTENT_WORDS: usize = 3;
const STRONG_SEMANTIC_SIMILARITY: f32 = 0.80;
const STRONG_SEMANTIC_MARGIN: f32 = 0.08;
const PARTIAL_QUOTE_DETECTION_STEP_WORDS: usize = 6;
/// A reference can only start a finite distance behind the newest interim
/// words; finalized turns still scan their complete transcript.
const MAX_INTERIM_REFERENCE_SCAN_WORDS: usize = 64;
/// Words of already-submitted text repeated in the next interim quote job so a
/// quotation straddling two submissions stays inside one search window.
const QUOTE_SCAN_LOOKBACK_WORDS: usize = 12;
/// Upper bound on words of unseen text in one interim quote job. The cursor
/// only advances over words actually submitted, so a slow worker catches up
/// across several jobs instead of dropping the middle of a long turn.
const MAX_INTERIM_QUOTE_SCAN_WORDS: usize = 192;
/// Tail of each recent finalized turn prefixed to interim evidence so a
/// quotation split across an ASR turn boundary is still covered.
const QUOTE_CROSS_TURN_WORDS: usize = 16;
/// Interim submissions widen to this step when the quote worker falls behind,
/// trading preview freshness for coverage during continuous speech.
const PARTIAL_QUOTE_DETECTION_BACKLOG_STEP_WORDS: usize = 12;
const QUOTE_WORKER_BACKLOG_MILLIS: u64 = 1200;
const PROACTIVE_REFERENCE_FINALIZATION_WINDOW: Duration = Duration::from_secs(5);
const MAX_SPOKEN_REFERENCE_RANGE: i32 = 10;
const MAX_AUDIO_RECOVERIES: usize = 2;
const MAX_PROVIDER_RECONNECT_ATTEMPTS: usize = 12;
const PROVIDER_RECONNECT_BASE_DELAY_MILLIS: u64 = 250;
const PROVIDER_RECONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const PROVIDER_RECONNECT_STABLE_WINDOW: Duration = Duration::from_secs(30);

type AsrWebSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence_types: Vec<String>,
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

#[derive(Debug, Clone, Serialize)]
struct AiAudioLevel {
    /// RMS-normalized level from the active 16-bit PCM AI input, from 0 to 1.
    level: f32,
}

fn pcm_level(bytes: &[u8]) -> f32 {
    let mut sum_squares = 0.0f64;
    let mut samples = 0usize;
    for &pair in bytes.as_chunks::<2>().0 {
        let sample = i16::from_le_bytes(pair) as f64 / i16::MAX as f64;
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
        let mut suggestion = suggestion.clone();
        if is_direct_detection(&suggestion.detection) {
            suggestion.evidence_types = direct_evidence_types(&suggestion);
        }
        {
            let mut session = self.session.lock().map_err(|error| error.to_string())?;
            if is_direct_detection(&suggestion.detection) {
                if let Some(existing) = session.suggestions.iter_mut().find(|existing| {
                    is_direct_detection(&existing.detection)
                        && same_canonical_verse(&existing.verse, &suggestion.verse)
                }) {
                    merge_direct_suggestions(existing, suggestion);
                } else {
                    session.suggestions.push(suggestion);
                }
            } else {
                session.suggestions.push(suggestion);
            }
        }
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

    fn snapshot(&self) -> Result<AiScriptureSavedSession, String> {
        self.session
            .lock()
            .map(|session| session.clone())
            .map_err(|error| error.to_string())
    }
}

async fn sync_session_to_dashboard(
    license: &crate::license::LicenseManager,
    session: &AiScriptureSavedSession,
) -> Result<(), String> {
    let body = serde_json::json!({
        "session_id": session.id,
        "started_at": session.started_at,
        "ended_at": session.ended_at,
        "provider": session.provider,
        "mode": session.mode,
        "version": session.version,
        "transcript": session.transcript,
        "suggestions": session.suggestions,
        "transcript_text": saved_session_transcript(session),
        "stop_reason": session.stop_reason,
    });
    license.post_ai_authenticated("/transcripts/sync", &body).await
}

fn is_direct_detection(detection: &str) -> bool {
    matches!(detection, "reference" | "quote")
}

fn same_canonical_verse(left: &Verse, right: &Verse) -> bool {
    left.book == right.book && left.chapter == right.chapter && left.verse == right.verse
}

fn direct_evidence_types(suggestion: &ScriptureSuggestion) -> Vec<String> {
    let mut evidence_types = suggestion
        .evidence_types
        .iter()
        .filter(|source| is_direct_detection(source))
        .cloned()
        .collect::<Vec<_>>();
    let missing_detection_source = is_direct_detection(&suggestion.detection)
        && !evidence_types.contains(&suggestion.detection);
    if missing_detection_source {
        evidence_types.push(suggestion.detection.clone());
    }
    evidence_types.sort_by_key(|source| if source == "reference" { 0 } else { 1 });
    evidence_types.dedup();
    evidence_types
}

fn merge_direct_suggestions(existing: &mut ScriptureSuggestion, incoming: ScriptureSuggestion) {
    let mut evidence_types = direct_evidence_types(existing);
    for source in direct_evidence_types(&incoming) {
        if !evidence_types.contains(&source) {
            evidence_types.push(source);
        }
    }
    evidence_types.sort_by_key(|source| if source == "reference" { 0 } else { 1 });

    // An explicit citation remains the primary source if a quote match arrives
    // later. Otherwise the newest result refreshes the card's text/confidence.
    if incoming.detection == "reference" || existing.detection != "reference" {
        *existing = incoming;
    }
    existing.evidence_types = evidence_types;
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
    reference_aliases: Vec<(Vec<String>, String)>,
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
    /// Interim word cursor this job had examined when submitted. The worker
    /// publishes it back so dropped (coalesced) jobs are rescanned rather than
    /// skipped.
    scanned_words: usize,
}

struct DetectionPipeline {
    context: VecDeque<(Instant, String)>,
    recently_suggested: Arc<Mutex<HashMap<String, Instant>>>,
    generation: Arc<AtomicU64>,
    quote_tx: watch::Sender<Option<QuoteJob>>,
    partial_turn_order: Option<u64>,
    partial_words: usize,
    /// Furthest word of the current interim turn submitted for quote lookup
    /// (a high-water mark; the worker cursor may trail it).
    partial_scanned_words: usize,
    /// Word cursor the quote worker has actually processed; lags the
    /// submission cursor when jobs are coalesced away.
    quote_processed_words: Arc<AtomicUsize>,
    /// Worker turnaround in milliseconds; widens the submission step under load.
    quote_latency_millis: Arc<AtomicU64>,
}

struct DetectionWorker {
    app: AppHandle,
    bible: Arc<BibleStore>,
    detection: Arc<DetectionConfig>,
    generation: Arc<AtomicU64>,
    active: Arc<AtomicBool>,
    recently_suggested: Arc<Mutex<HashMap<String, Instant>>>,
    semantic: Arc<SemanticScripture>,
    quote_processed_words: Arc<AtomicUsize>,
    quote_latency_millis: Arc<AtomicU64>,
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

#[allow(clippy::too_many_arguments)] // internal pipeline helper, args mirror detection flow
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
                    evidence_types: Vec::new(),
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
fn detect_contextual_verse_reference_from_tokens(
    tokens: &[String],
    detection: &DetectionConfig,
    app: &AppHandle,
) -> Option<crate::ai_detection::ScriptureReference> {
    let anchor = navigation_anchor(detection, app)?;
    contextual_verse_reference_for_anchor_tokens(tokens, &anchor)
}

#[cfg(test)]
fn contextual_verse_reference_for_anchor(
    transcript: &str,
    anchor: &VerseAnchor,
) -> Option<crate::ai_detection::ScriptureReference> {
    let tokens = quote_tokens(transcript);
    contextual_verse_reference_for_anchor_tokens(&tokens, anchor)
}

fn contextual_verse_reference_for_anchor_tokens(
    tokens: &[String],
    anchor: &VerseAnchor,
) -> Option<crate::ai_detection::ScriptureReference> {
    let mut latest = None;
    for index in 0..tokens.len() {
        let plural_marker = tokens[index].as_str() == "verses";
        if !plural_marker && tokens[index].as_str() != "verse" {
            continue;
        }
        // The anchor's contextual parser must agree with the explicit
        // `ai_detection` reference parser on the same range policy, including
        // that a singular "verse" marker does not extend a range with "and".
        let Some((verse, _next, verse_end)) =
            crate::ai_detection::parse_verse_number(tokens, index + 1, plural_marker)
        else {
            continue;
        };
        // Speech navigates within a chapter's verse numbers only.
        if !(1..=176).contains(&verse) {
            continue;
        }
        let verse_end = verse_end.filter(|end| *end <= 176);
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
            evidence_types: Vec::new(),
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
    crate::license::ensure_core_activated(&state)?;
    let provider = AsrProvider::parse(&provider)?;
    // Managed transcription replaces the beta BYOK path. Remove any legacy
    // provider credentials so they can never be used again after this update.
    for legacy in ["deepgram-api-key.dpapi", "assemblyai-api-key.dpapi"] {
        let path = state.app_data_dir.join("secrets").join(legacy);
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
    }
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
    let access = state.license.ai_access().await?;
    if access.ai.available_units_remaining < 1.0 {
        return Err("Not enough AI Units to start transcription.".into());
    }
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
    let license = state.license.clone();
    let sync_license = license.clone();
    let sync_enabled = state.presentation.settings.lock().transcript_sync_enabled;
    let task_app = app.clone();
    let task_device = audio_device.clone();
    let task_version = version.clone();
    tauri::async_runtime::spawn(async move {
        let result = AssertUnwindSafe(run_asr_session(
            task_app.clone(),
            bible,
            relay,
            license,
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

        if sync_enabled {
            match recorder.snapshot() {
                Ok(session) => {
                    let sync_app = task_app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = sync_session_to_dashboard(&sync_license, &session).await {
                            crate::store::log_msg(
                                &sync_app,
                                &format!("[ai-scripture] dashboard transcript sync failed: {error}"),
                            );
                        }
                    });
                }
                Err(error) => crate::store::log_msg(
                    &task_app,
                    &format!("[ai-scripture] could not snapshot transcript for sync: {error}"),
                ),
            }
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
) -> Result<semantic_scripture::SemanticStatus, String> {
    crate::license::ensure_active_tier(&state, crate::license::LicenseTier::Pro)?;
    Ok(semantic_scripture::prepare_in_background(
        app,
        state.store.clone(),
        state.app_data_dir.clone(),
    ))
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

fn websocket_base_url(base: &str) -> String {
    if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_owned()
    }
}

async fn connect_provider_socket(
    adapter: &dyn providers::StreamingTranscriptionAdapter,
    provider: AsrProvider,
    access_token: &str,
    stop: &mut watch::Receiver<bool>,
    timeout: Duration,
) -> Result<Option<AsrWebSocket>, String> {
    let gateway_ws_base = websocket_base_url(&crate::license::ai_gateway_url());
    let gateway_url = format!(
        "{}/v1/asr/{}",
        gateway_ws_base.trim_end_matches('/'),
        provider.as_str()
    );
    let mut request = gateway_url.into_client_request().map_err(|error| {
        format!(
            "Could not create the {} gateway request: {error}",
            provider.display_name()
        )
    })?;
    adapter.configure_gateway_request(&mut request, access_token)?;

    let connection = tokio::time::timeout(timeout, tokio_tungstenite::connect_async(request));
    let result = tokio::select! {
        _ = stop.changed() => return Ok(None),
        result = connection => result,
    };
    let (socket, _) = result
        .map_err(|_| {
            format!(
                "{} connection timed out after {} seconds.",
                provider.display_name(),
                timeout.as_secs()
            )
        })?
        .map_err(|error| format!("{} connection failed: {error}", provider.display_name()))?;
    Ok(Some(socket))
}

#[allow(clippy::too_many_arguments)]
async fn reconnect_provider_socket(
    app: &AppHandle,
    adapter: &dyn providers::StreamingTranscriptionAdapter,
    provider: AsrProvider,
    license: &Arc<crate::license::LicenseManager>,
    audio_device: &str,
    version: &str,
    reason: &str,
    stop: &mut watch::Receiver<bool>,
    reconnect_attempts: &mut usize,
) -> Result<Option<AsrWebSocket>, String> {
    crate::store::log_msg(
        app,
        &format!(
            "[ai-scripture] {} transcription connection lost: {reason}",
            provider.display_name()
        ),
    );
    let mut failures = Vec::new();
    while *reconnect_attempts < MAX_PROVIDER_RECONNECT_ATTEMPTS {
        *reconnect_attempts += 1;
        let attempt = *reconnect_attempts;
        let delay =
            PROVIDER_RECONNECT_BASE_DELAY_MILLIS.saturating_mul(1_u64 << (attempt - 1).min(4));
        emit_status(
            app,
            provider,
            "connecting",
            format!(
                "Transcription connection lost; reconnecting to {} ({attempt}/{MAX_PROVIDER_RECONNECT_ATTEMPTS})…",
                provider.display_name()
            ),
            Some(audio_device.to_string()),
            Some(version.to_string()),
        );
        tokio::select! {
            _ = stop.changed() => return Ok(None),
            _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
        }
        let access = match license.ai_access().await {
            Ok(access) => access,
            Err(error) => {
                failures.push(error);
                continue;
            }
        };
        match connect_provider_socket(
            adapter,
            provider,
            &access.token,
            stop,
            PROVIDER_RECONNECT_TIMEOUT,
        )
        .await
        {
            Ok(Some(socket)) => {
                emit_status(
                    app,
                    provider,
                    "listening",
                    format!("Reconnected to {} transcription.", provider.display_name()),
                    Some(audio_device.to_string()),
                    Some(version.to_string()),
                );
                return Ok(Some(socket));
            }
            Ok(None) => return Ok(None),
            Err(error) => {
                crate::store::log_msg(
                    app,
                    &format!(
                        "[ai-scripture] {} reconnect attempt {attempt} failed: {error}",
                        provider.display_name()
                    ),
                );
                failures.push(error);
            }
        }
    }
    Err(format!(
        "{} transcription disconnected and could not reconnect after {} attempts: {}",
        provider.display_name(),
        MAX_PROVIDER_RECONNECT_ATTEMPTS,
        failures.join("; ")
    ))
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
    license: Arc<crate::license::LicenseManager>,
    config: AsrSessionConfig,
    mut stop: watch::Receiver<bool>,
) -> Result<(), String> {
    let AsrSessionConfig {
        provider,
        audio_device,
        version,
        available_versions,
    } = config;
    let adapter = adapter_for(provider);
    let semantic = semantic_scripture::engine(
        app.path()
            .app_local_data_dir()
            .or_else(|_| app.path().app_data_dir())
            .map_err(|error| error.to_string())?
            .as_path(),
    );
    let access = license.ai_access().await?;
    let Some(mut socket) = connect_provider_socket(
        adapter,
        provider,
        &access.token,
        &mut stop,
        Duration::from_secs(15),
    )
    .await?
    else {
        return Ok(());
    };

    let mut relay = Some(relay);
    let mut pcm = connect_pcm_relay(relay.as_ref().expect("audio relay initialized")).await?;
    let mut audio_recoveries = 0usize;
    let mut reconnect_attempts = 0usize;
    let mut connection_started = Instant::now();
    emit_status(
        &app,
        provider,
        "listening",
        format!("Listening for Scripture via {}…", provider.display_name()),
        Some(audio_device.clone()),
        Some(version.clone()),
    );

    let books = bible.get_books(&version).map_err(|e| e.to_string())?;
    let reference_aliases = reference_aliases_for_books(&books);
    // The MVP is English-only, so every installed translation can help align
    // a quotation. The winning canonical reference is converted back to the
    // operator-selected output translation before it reaches the UI.
    let detection = Arc::new(DetectionConfig {
        output_version: Arc::new(Mutex::new(version.clone())),
        available_versions,
        reference_aliases,
        navigation_anchor: Arc::new(Mutex::new(None)),
    });
    let recently_suggested = Arc::new(Mutex::new(HashMap::new()));
    let detection_generation = Arc::new(AtomicU64::new(0));
    let detection_active = Arc::new(AtomicBool::new(true));
    let _active_detection_session = ActiveDetectionSession(detection_active.clone());
    let quote_processed_words = Arc::new(AtomicUsize::new(0));
    let quote_latency_millis = Arc::new(AtomicU64::new(0));
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
            quote_processed_words: quote_processed_words.clone(),
            quote_latency_millis: quote_latency_millis.clone(),
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
        partial_scanned_words: 0,
        quote_processed_words,
        quote_latency_millis,
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
                if let Err(error) = socket.send(adapter.audio_message(&audio[..count])).await {
                    if connection_started.elapsed() >= PROVIDER_RECONNECT_STABLE_WINDOW {
                        reconnect_attempts = 0;
                    }
                    let Some(reconnected) = reconnect_provider_socket(
                        &app,
                        adapter,
                        provider,
                        &license,
                        &audio_device,
                        &version,
                        &format!("could not send audio: {error}"),
                        &mut stop,
                        &mut reconnect_attempts,
                    )
                    .await?
                    else {
                        return Ok(());
                    };
                    socket = reconnected;
                    connection_started = Instant::now();
                }
            }
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if handle_provider_event(
                            &app,
                            &bible,
                            &detection,
                            provider,
                            adapter.decode_message(text.as_ref()),
                            &mut pipeline,
                        )? {
                            return Err(format!(
                                "{} ended the transcription session.",
                                provider.display_name()
                            ));
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let reason = frame.map(|f| f.reason.to_string()).unwrap_or_else(|| "connection closed".into());
                        if connection_started.elapsed() >= PROVIDER_RECONNECT_STABLE_WINDOW {
                            reconnect_attempts = 0;
                        }
                        let Some(reconnected) = reconnect_provider_socket(
                            &app,
                            adapter,
                            provider,
                            &license,
                            &audio_device,
                            &version,
                            &reason,
                            &mut stop,
                            &mut reconnect_attempts,
                        )
                        .await?
                        else {
                            return Ok(());
                        };
                        socket = reconnected;
                        connection_started = Instant::now();
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => {
                        if connection_started.elapsed() >= PROVIDER_RECONNECT_STABLE_WINDOW {
                            reconnect_attempts = 0;
                        }
                        let Some(reconnected) = reconnect_provider_socket(
                            &app,
                            adapter,
                            provider,
                            &license,
                            &audio_device,
                            &version,
                            &error.to_string(),
                            &mut stop,
                            &mut reconnect_attempts,
                        )
                        .await?
                        else {
                            return Ok(());
                        };
                        socket = reconnected;
                        connection_started = Instant::now();
                    }
                    None => {
                        if connection_started.elapsed() >= PROVIDER_RECONNECT_STABLE_WINDOW {
                            reconnect_attempts = 0;
                        }
                        let Some(reconnected) = reconnect_provider_socket(
                            &app,
                            adapter,
                            provider,
                            &license,
                            &audio_device,
                            &version,
                            "provider closed the stream",
                            &mut stop,
                            &mut reconnect_attempts,
                        )
                        .await?
                        else {
                            return Ok(());
                        };
                        socket = reconnected;
                        connection_started = Instant::now();
                    }
                }
            }
        }
    }

    // Stop the local producer first so no audio follows the provider's close
    // command. Adapters that finalize an open turn on shutdown drain their
    // normalized events here so the last spoken reference or quotation is kept.
    drop(pcm);
    drop(relay.take());
    if let Some(message) = adapter.finish_message() {
        let _ = socket.send(message).await;
    }
    if adapter.drains_final_messages() {
        let drain = async {
            while let Some(incoming) = socket.next().await {
                match incoming {
                    Ok(Message::Text(text)) => {
                        match handle_provider_event(
                            &app,
                            &bible,
                            &detection,
                            provider,
                            adapter.decode_message(text.as_ref()),
                            &mut pipeline,
                        ) {
                            Ok(true) => break,
                            Ok(false) => {}
                            Err(error) => {
                                crate::store::log_msg(
                                    &app,
                                    &format!("[ai-scripture] provider shutdown error: {error}"),
                                );
                                break;
                            }
                        }
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(_) => {}
                    Err(error) => {
                        crate::store::log_msg(
                            &app,
                            &format!("[ai-scripture] provider shutdown drain ended: {error}"),
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
                &format!(
                    "[ai-scripture] {} did not confirm termination within 5 seconds.",
                    provider.display_name()
                ),
            ),
        }
        // Give the coalescing quotation worker a bounded chance to process the
        // final turn before the session's activity guard is dropped.
        tokio::time::sleep(Duration::from_millis(750)).await;
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
            let is_interim = worker_job.is_interim;
            let started = Instant::now();
            let mut suggestions = tokio::task::spawn_blocking(move || {
                let output_version = current_output_version(&worker_detection);
                detect_direct_quotes(
                    &worker_bible,
                    &worker_job.rolling_text,
                    &worker_job.evidence,
                    &output_version,
                    worker_job.asr_confidence,
                    // Interim evidence already walks the whole turn with a
                    // cursor, so the expensive full-turn rescan is reserved
                    // for finalized turns where cross-turn context matters.
                    !is_interim,
                )
            })
            .await
            .unwrap_or_default();
            // Publish both metrics before emitting: the interim submitter
            // widens its step when turnaround grows and rescans any span the
            // watch channel coalesced away.
            worker
                .quote_latency_millis
                .store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
            worker
                .quote_processed_words
                .store(job.scanned_words, Ordering::Relaxed);

            for suggestion in &mut suggestions {
                suggestion.source_transcript_timestamp = Some(job.source_transcript_timestamp);
            }

            if !worker.active.load(Ordering::Acquire) {
                continue;
            }
            if job.is_interim {
                if !quote_generation_is_current(
                    worker.generation.load(Ordering::Acquire),
                    job.generation,
                ) {
                    // A finalized turn or voice command superseded this
                    // in-flight preview while quote retrieval was running.
                    interim_quote = None;
                    continue;
                }
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
            let stale = !quote_generation_is_current(
                worker.generation.load(Ordering::Acquire),
                job.generation,
            );
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
                            evidence_types: Vec::new(),
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

fn quote_generation_is_current(current_generation: u64, job_generation: u64) -> bool {
    current_generation == job_generation
}

fn semantic_passage_key(found: &semantic_scripture::SemanticMatch) -> String {
    // Anchor on the winning verse, not the chapter. Two different passages in
    // the same chapter are not the "same thought stabilizing"; a coarse key
    // would compound a coincidental match into a confirmation.
    format!(
        "{}:{}:{}",
        found.verse.book, found.verse.chapter, found.verse.verse
    )
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

fn emit_suggestion(app: &AppHandle, mut suggestion: ScriptureSuggestion) {
    if is_direct_detection(&suggestion.detection) {
        suggestion.evidence_types = direct_evidence_types(&suggestion);
    }
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

fn handle_provider_event(
    app: &AppHandle,
    bible: &BibleStore,
    detection: &DetectionConfig,
    provider: AsrProvider,
    event: ProviderEvent,
    pipeline: &mut DetectionPipeline,
) -> Result<bool, String> {
    match event {
        ProviderEvent::Transcript(transcript) => {
            handle_transcription_update(app, bible, detection, provider, transcript, pipeline)?;
            Ok(false)
        }
        ProviderEvent::Error(error) => Err(format!(
            "{} rejected the session: {error}",
            provider.display_name()
        )),
        ProviderEvent::Terminated => Ok(true),
        ProviderEvent::Ignored => Ok(false),
    }
}

fn handle_transcription_update(
    app: &AppHandle,
    bible: &BibleStore,
    detection: &DetectionConfig,
    provider: AsrProvider,
    provider_transcript: TranscriptUpdate,
    pipeline: &mut DetectionPipeline,
) -> Result<(), String> {
    let transcript = provider_transcript.text.trim();
    if transcript.is_empty() {
        return Ok(());
    }
    let normalized_tokens = normalized_transcript_tokens(transcript);
    let transcript_quote_tokens = quote_tokens_from_normalized(&normalized_tokens);
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
            &normalized_tokens,
            &transcript_quote_tokens,
            confidence,
            turn_order,
            transcript_timestamp,
        );
        return Ok(());
    }
    pipeline.partial_turn_order = None;
    pipeline.partial_words = 0;
    pipeline.partial_scanned_words = 0;

    let direct_references =
        detect_references_with_aliases(&normalized_tokens, &detection.reference_aliases);
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
        if let Some(contextual) =
            detect_contextual_verse_reference_from_tokens(&transcript_quote_tokens, detection, app)
        {
            (vec![contextual], true)
        } else {
            let reference_tokens = normalized_transcript_tokens(&reference_text);
            (
                detect_references_with_aliases(&reference_tokens, &detection.reference_aliases),
                false,
            )
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
                    evidence_types: Vec::new(),
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
    let final_evidence = transcript.to_string();
    let final_scanned_words = transcript_quote_tokens.len();
    pipeline.quote_tx.send_replace(Some(QuoteJob {
        generation: current_generation,
        scanned_words: final_scanned_words,
        rolling_text,
        semantic_text,
        semantic_segments,
        evidence: final_evidence,
        asr_confidence: confidence,
        is_interim: false,
        source_transcript_timestamp: transcript_timestamp,
    }));
    Ok(())
}

#[allow(clippy::too_many_arguments)] // internal pipeline helper, args mirror detection flow
fn handle_interim_transcript(
    app: &AppHandle,
    bible: &BibleStore,
    detection: &DetectionConfig,
    pipeline: &mut DetectionPipeline,
    transcript: &str,
    normalized_tokens: &[String],
    quote_token_cache: &[String],
    asr_confidence: f32,
    turn_order: Option<u64>,
    transcript_timestamp: u64,
) {
    if turn_order.is_some() && pipeline.partial_turn_order != turn_order {
        pipeline.partial_turn_order = turn_order;
        pipeline.partial_words = 0;
        pipeline.partial_scanned_words = 0;
    }

    // References are the operator's real-time path. Search every provider
    // revision as soon as it contains a complete, locally verifiable reference
    // instead of waiting for a second revision, a word-count sample, or an ASR
    // turn boundary. They remain Preview-only until the provider sends its
    // final transcript: ASR can briefly revise a spoken number while the
    // preacher is still speaking.
    let references = {
        let direct = detect_references_with_aliases(
            interim_reference_tokens(normalized_tokens),
            &detection.reference_aliases,
        );
        if direct.is_empty() {
            detect_contextual_verse_reference_from_tokens(
                interim_reference_tokens(quote_token_cache),
                detection,
                app,
            )
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
                evidence_types: Vec::new(),
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
    let words = quote_token_cache.len();
    if words < pipeline.partial_words {
        // A provider revision shortened the turn. Rescan from the revised
        // timeline rather than trusting a cursor past the new text.
        pipeline.partial_words = words;
        pipeline.partial_scanned_words = pipeline.partial_scanned_words.min(words);
    }
    // The worker coalesces jobs through a watch channel, so some submissions
    // are never scored. Measure new text from the last *processed* cursor and
    // rescan whatever it missed instead of leaving a silent gap in a
    // continuous sermon.
    let processed = pipeline
        .quote_processed_words
        .load(Ordering::Relaxed)
        .min(pipeline.partial_scanned_words);
    if words
        < pipeline
            .partial_scanned_words
            .saturating_add(interim_quote_step(
                pipeline.quote_latency_millis.load(Ordering::Relaxed),
            ))
    {
        return;
    }

    // Walk the turn with a monotonic cursor instead of rescanning only the
    // final words: continuous speech produces long unbroken turns, and the
    // old tail-only suffix left early quotations unexamined. Recent finalized
    // turn tails join the evidence so a quotation split at an ASR boundary is
    // still covered.
    let cross_turn_tails = pipeline
        .context
        .iter()
        .rev()
        .take(2)
        .rev()
        .map(|(_, text)| latest_word_suffix(text, QUOTE_CROSS_TURN_WORDS))
        .collect::<Vec<_>>();
    let Some((evidence, scanned_words)) =
        interim_quote_evidence(quote_token_cache, processed, &cross_turn_tails)
    else {
        return;
    };
    pipeline.partial_words = words;
    // Keep the submission cursor as a high-water mark: while the worker is
    // behind, evidence restarts from its processed point, and the step gate
    // must still measure against the furthest text already submitted.
    pipeline.partial_scanned_words = pipeline.partial_scanned_words.max(scanned_words);

    pipeline.quote_tx.send_replace(Some(QuoteJob {
        generation: pipeline.generation.load(Ordering::Acquire),
        scanned_words,
        rolling_text: transcript.to_string(),
        semantic_text: String::new(),
        semantic_segments: 0,
        evidence,
        asr_confidence,
        is_interim: true,
        source_transcript_timestamp: transcript_timestamp,
    }));
}

fn interim_reference_tokens(tokens: &[String]) -> &[String] {
    let start = tokens
        .len()
        .saturating_sub(MAX_INTERIM_REFERENCE_SCAN_WORDS);
    &tokens[start..]
}

/// Interim submissions narrow to a short anchored slice at normal speed and
/// widen during backlogs; the cursor guarantees coverage either way.
fn interim_quote_step(quote_latency_millis: u64) -> usize {
    if quote_latency_millis > QUOTE_WORKER_BACKLOG_MILLIS {
        PARTIAL_QUOTE_DETECTION_BACKLOG_STEP_WORDS
    } else {
        PARTIAL_QUOTE_DETECTION_STEP_WORDS
    }
}

/// Builds interim quote evidence for the next cursor span in `tokens`.
/// Returns the anchored text and the word index the submission cursor
/// advanced to.
fn interim_quote_evidence(
    tokens: &[String],
    scanned_words: usize,
    cross_turn_tails: &[String],
) -> Option<(String, usize)> {
    let words = tokens.len();
    if words == 0 {
        return None;
    }
    let scanned = scanned_words.min(words);
    let start = scanned.saturating_sub(QUOTE_SCAN_LOOKBACK_WORDS);
    let end = words.min(start.saturating_add(MAX_INTERIM_QUOTE_SCAN_WORDS));
    if end <= start {
        return None;
    }
    let mut evidence = String::new();
    for tail in cross_turn_tails.iter().filter(|tail| !tail.is_empty()) {
        evidence.push_str(tail);
        evidence.push(' ');
    }
    evidence.push_str(&tokens[start..end].join(" "));
    Some((evidence, end))
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

fn detect_direct_quotes(
    bible: &BibleStore,
    rolling_text: &str,
    evidence: &str,
    output_version: &str,
    asr_confidence: f32,
    search_rolling_context: bool,
) -> Vec<ScriptureSuggestion> {
    // Interim jobs already carry bounded quote evidence. Avoid retokenizing
    // their entire (potentially very long) growing ASR turn on every update.
    if search_rolling_context && quote_tokens(rolling_text).len() < MIN_DIRECT_QUOTE_WORDS {
        return Vec::new();
    }

    // A provider can finalize several sentences (or, after a network delay, a
    // sizeable paragraph) as one turn. Search overlapping bounded windows so
    // a quotation near the beginning is not hidden by the final 24 words.
    let mut matches: HashMap<(String, i32, i32), (Verse, f32, String)> = HashMap::new();
    for window in quote_search_windows(evidence) {
        if let Some((verse, score)) =
            best_direct_quote_candidate(bible, &window, &window, search_rolling_context)
        {
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
    if matches.is_empty() && search_rolling_context && rolling_text != evidence {
        for window in quote_search_windows(rolling_text) {
            if let Some((verse, score)) =
                best_direct_quote_candidate(bible, &window, &window, search_rolling_context)
            {
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
                evidence_types: Vec::new(),
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
        // Pair neighbouring sentences whenever the combined span stays
        // bounded. Continuous speech produces long punctuated sentences, and
        // the old rule only paired when one side was a short fragment, which
        // made a quotation spanning two ordinary sentences invisible.
        for pair in sentences.windows(2) {
            let mut combined = quote_tokens(pair[0]);
            combined.extend(quote_tokens(pair[1]));
            if combined.len() <= MAX_PAIRED_SENTENCE_WORDS {
                append_quote_token_windows(&mut windows, &combined);
            }
        }
    } else {
        append_quote_token_windows(&mut windows, &quote_tokens(text));
    }

    windows.dedup();
    if windows.len() > MAX_QUOTE_SEARCH_WINDOWS {
        // Continuous speech can produce long turns whose opening words hold
        // the quotation. Keep both ends instead of only the latest windows.
        let keep_head = MAX_QUOTE_SEARCH_WINDOWS / 2;
        let keep_tail = MAX_QUOTE_SEARCH_WINDOWS - keep_head;
        let tail = windows.split_off(windows.len() - keep_tail);
        windows.truncate(keep_head);
        windows.extend(tail);
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
    allow_like_fallback: bool,
) -> Option<(Verse, f32)> {
    if quote_tokens(query).len() < MIN_DIRECT_QUOTE_WORDS {
        return None;
    }
    let candidates = if allow_like_fallback {
        bible.search_quote_candidates(query)
    } else {
        bible.search_quote_candidates_fast(query)
    };
    candidates
        .ok()?
        .into_iter()
        // `search_quote_candidates` orders each tier by bm25 relevance
        // (exact-phrase tier first, then AND, OR, LIKE), so truncating the
        // front preserves the strongest candidates while bounding alignment
        // work when broad OR/LIKE tiers return hundreds of rows.
        .take(MAX_QUOTE_CANDIDATES_SCORED)
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
    fn managed_transcription_converts_the_http_gateway_base_to_websocket() {
        assert_eq!(
            websocket_base_url("https://wordlyte-ai-gateway.example.workers.dev"),
            "wss://wordlyte-ai-gateway.example.workers.dev"
        );
        assert_eq!(
            websocket_base_url("http://127.0.0.1:8787"),
            "ws://127.0.0.1:8787"
        );
        assert_eq!(
            websocket_base_url("wss://ai.example.test"),
            "wss://ai.example.test"
        );
    }

    fn direct_test_suggestion(detection: &str, confidence: f32) -> ScriptureSuggestion {
        ScriptureSuggestion {
            id: format!("{detection}-test"),
            detection: detection.into(),
            evidence_types: vec![detection.into()],
            confidence,
            evidence: format!("{detection} evidence"),
            verse: Verse {
                book: "John".into(),
                chapter: 3,
                verse: 16,
                text: "For God so loved the world".into(),
                version: "KJV".into(),
                split_index: None,
                total_splits: None,
                score: None,
            },
            timestamp: 1,
            source_transcript_timestamp: None,
            group_id: None,
            rank: None,
            passage_start: None,
            passage_end: None,
            similarity: None,
            margin: None,
        }
    }

    #[test]
    fn merged_direct_suggestion_keeps_reference_as_primary_evidence() {
        let mut reference = direct_test_suggestion("reference", 0.94);
        merge_direct_suggestions(&mut reference, direct_test_suggestion("quote", 0.82));

        assert_eq!(reference.detection, "reference");
        assert_eq!(reference.evidence_types, ["reference", "quote"]);
        assert_eq!(reference.confidence, 0.94);
    }

    #[test]
    fn stale_interim_quote_generations_are_rejected() {
        assert!(quote_generation_is_current(4, 4));
        assert!(!quote_generation_is_current(5, 4));
    }

    #[test]
    fn interim_reference_scan_is_bounded_and_keeps_recent_citations() {
        let books = vec!["John".to_string()];
        let aliases = reference_aliases_for_books(&books);
        let tokens = normalized_transcript_tokens(&format!(
            "{} John 3:16",
            "sermon words ".repeat(MAX_INTERIM_REFERENCE_SCAN_WORDS + 10)
        ));
        let scan = interim_reference_tokens(&tokens);

        assert!(scan.len() <= MAX_INTERIM_REFERENCE_SCAN_WORDS);
        assert_eq!(
            detect_references_with_aliases(scan, &aliases)
                .last()
                .map(|reference| (reference.book.as_str(), reference.chapter, reference.verse)),
            Some(("John", 3, 16))
        );
    }

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
                evidence_types: vec!["reference".into()],
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
        let serialized = serde_json::to_value(&session).unwrap();
        assert_eq!(
            serialized["suggestions"][0]["evidenceTypes"][0],
            "reference"
        );
        let markdown = saved_session_markdown(&session);
        assert!(markdown.contains("Faith comes by hearing."));
        assert!(markdown.contains("Romans 10:17"));
        assert!(validate_session_export_path("C:/Users/test/transcript.md").is_ok());
        assert!(validate_session_export_path("C:/Users/test/transcript.exe").is_err());
        assert!(validate_session_export_path("relative/transcript.txt").is_err());
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
    fn semantic_stability_requires_the_same_specific_passage() {
        let verse_fixture = |book: &str, chapter: i32, verse: i32| Verse {
            book: book.into(),
            chapter,
            verse,
            text: String::new(),
            version: "KJV".into(),
            split_index: None,
            total_splits: None,
            score: None,
        };
        let previous = ["John:3:16".to_string()].into_iter().collect();
        let confirmed = semantic_scripture::SemanticMatch {
            verse: verse_fixture("John", 3, 16),
            confidence: 0.7,
            similarity: 0.72,
            margin: 0.03,
            rank: 1,
            passage_start: 16,
            passage_end: 16,
        };
        assert!(semantic_match_is_stable(&confirmed, &previous));
        // A different verse in the same chapter is a different passage: the
        // former chapter-level key confirmed it by coincidence.
        let drifted = semantic_scripture::SemanticMatch {
            verse: verse_fixture("John", 3, 2),
            ..confirmed.clone()
        };
        assert!(!semantic_match_is_stable(&drifted, &previous));
        // Only an exceptionally strong match may skip the stability window.
        let exceptional = semantic_scripture::SemanticMatch {
            similarity: STRONG_SEMANTIC_SIMILARITY,
            margin: STRONG_SEMANTIC_MARGIN,
            ..drifted.clone()
        };
        assert!(semantic_match_is_stable(&exceptional, &previous));
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
            // The stability key anchors on the winning verse, not the chapter.
            &std::collections::HashSet::from(["Daniel:6:11".into()])
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
    fn continuous_turns_keep_their_opening_windows() {
        let mut text = String::from("the lord is my shepherd i shall not want");
        for index in 0..400 {
            text.push_str(&format!(" word{index}"));
        }
        let windows = quote_search_windows(&text);
        assert!(windows.len() <= MAX_QUOTE_SEARCH_WINDOWS);
        assert!(
            windows
                .iter()
                .any(|window| window.contains("my shepherd i shall not want")),
            "the opening quotation must survive window truncation"
        );
        assert!(
            windows.iter().any(|window| window.contains("word399")),
            "the newest words must still be searched"
        );
    }

    #[test]
    fn quotations_spanning_two_sentences_are_searched_together() {
        let text = "the lord is my shepherd i shall not want. \
                    he makes me to lie down in green pastures.";
        let windows = quote_search_windows(text);
        assert!(
            windows
                .iter()
                .any(|window| window.contains("shall not want he makes")),
            "a quotation crossing a sentence boundary must stay inside one window"
        );
    }

    #[test]
    fn interim_evidence_walks_a_continuous_turn_without_gaps() {
        let tokens = (0..420)
            .map(|index| format!("token{index}"))
            .collect::<Vec<_>>();
        let mut scanned = 0;
        let mut submitted = Vec::new();
        while scanned < tokens.len() {
            let (evidence, next) = interim_quote_evidence(&tokens, scanned, &[]).unwrap();
            assert!(next > scanned);
            assert!(
                evidence.split_whitespace().count()
                    <= QUOTE_SCAN_LOOKBACK_WORDS + MAX_INTERIM_QUOTE_SCAN_WORDS
            );
            submitted.push(evidence);
            scanned = next;
        }
        for index in 0..tokens.len() {
            let needle = format!("token{index}");
            assert!(
                submitted
                    .iter()
                    .any(|evidence| evidence.split_whitespace().any(|word| word == needle)),
                "word {index} was never submitted"
            );
        }
    }

    #[test]
    fn interim_evidence_carries_recent_finalized_turn_tails() {
        let tokens = quote_tokens("verse seventeen continues the thought");
        let (evidence, _) =
            interim_quote_evidence(&tokens, 0, &["the lord is my shepherd".to_string()]).unwrap();
        assert!(evidence.starts_with("the lord is my shepherd"));
        assert!(evidence.contains("verse seventeen"));
    }

    #[test]
    fn backlog_widens_the_interim_quote_step() {
        assert_eq!(
            interim_quote_step(QUOTE_WORKER_BACKLOG_MILLIS),
            PARTIAL_QUOTE_DETECTION_STEP_WORDS
        );
        assert_eq!(
            interim_quote_step(QUOTE_WORKER_BACKLOG_MILLIS + 1),
            PARTIAL_QUOTE_DETECTION_BACKLOG_STEP_WORDS
        );
    }

    #[test]
    fn continuous_flow_submits_early_quotations_for_review() {
        let mut text = String::from("the lord is my shepherd i shall not want");
        for index in 0..600 {
            text.push_str(&format!(" filler{index}"));
        }
        let tokens = quote_tokens(&text);
        let mut scanned = 0;
        let mut reviewed = false;
        let mut words = 0;
        while words < tokens.len() {
            words = (words + PARTIAL_QUOTE_DETECTION_STEP_WORDS).min(tokens.len());
            let (evidence, next) = interim_quote_evidence(&tokens[..words], scanned, &[]).unwrap();
            if quote_search_windows(&evidence)
                .iter()
                .any(|window| window.contains("my shepherd i shall not want"))
            {
                reviewed = true;
            }
            scanned = next;
        }
        assert!(
            reviewed,
            "the early quotation never entered a submitted window"
        );
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
}
