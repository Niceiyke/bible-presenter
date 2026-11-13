use crate::ai_detection::{
    detect_references_with_aliases, direct_quote_match_score_tokens, normalized_transcript_tokens,
    parse_number, quote_content_word_count, quote_tokens, quote_tokens_from_normalized,
    reference_aliases_for_books, ScriptureReference, MIN_DIRECT_QUOTE_WORDS,
    MIN_LOOSE_QUOTE_CONTENT_WORDS, MIN_QUOTE_CONTENT_WORDS,
};
use crate::commands::program_audio::{feed_diagnostics, subscribe_pcm_feed, AudioRelay};
use crate::semantic_scripture::{self, SemanticScripture};
use crate::state::AppState;
use crate::store::{BibleStore, MediaScheduleStore, Verse};
mod providers;
mod quote_index;
use self::providers::{adapter_for, AsrProvider, ProviderEvent, TranscriptUpdate};
use self::quote_index::{QuoteHit, QuoteIndexCache, QuoteSearchCache, QuoteSearchIndex};
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
/// A chapter-only citation ("Isaiah chapter two") is a valid navigation
/// preview, but the speaker has not yet selected a verse. Keep it below the
/// reference auto-stage threshold so the later "verse 10" produces the single
/// automatic Stage/Live action.
const MAX_INCOMPLETE_REFERENCE_CONFIDENCE: f32 = 0.85;
/// A quotation without an explicit citation or attribution cue is useful as a
/// manual preview, but it must never reach the automatic Stage/Live gates.
const MAX_LOOSE_QUOTE_CONFIDENCE: f32 = 0.88;
const QUOTE_SEARCH_WINDOW_WORDS: usize = 24;
const QUOTE_SEARCH_WINDOW_OVERLAP: usize = 8;
const MAX_QUOTE_SEARCH_WINDOWS: usize = 24;
/// Two neighbouring sentences are searched together while their combined span
/// stays this small (two search windows); continuous speech produces long
/// sentences that a quotation can straddle.
const MAX_PAIRED_SENTENCE_WORDS: usize = QUOTE_SEARCH_WINDOW_WORDS * 2;
const MAX_DIRECT_QUOTES_PER_TURN: usize = 3;
const MIN_SHORT_WINDOW_CONTENT_WORDS: usize = 3;
const STRONG_SEMANTIC_SIMILARITY: f32 = 0.80;
const STRONG_SEMANTIC_MARGIN: f32 = 0.08;
/// A reference can only start a finite distance behind the newest interim
/// words; finalized turns still scan their complete transcript.
const MAX_INTERIM_REFERENCE_SCAN_WORDS: usize = 64;
/// Only this much of the previous final turn is used to recover a quotation
/// split across an ASR boundary. Scanning the whole rolling context was a
/// major source of repeated FTS work.
const QUOTE_CROSS_TURN_WORDS: usize = 24;
const PROACTIVE_REFERENCE_FINALIZATION_WINDOW: Duration = Duration::from_secs(5);
const MAX_SPOKEN_REFERENCE_RANGE: i32 = 10;
const MAX_AUDIO_RECOVERIES: usize = 2;
const MAX_PROVIDER_RECONNECT_ATTEMPTS: usize = 12;
const PROVIDER_RECONNECT_BASE_DELAY_MILLIS: u64 = 1_000;
const PROVIDER_RECONNECT_MAX_DELAY_MILLIS: u64 = 60_000;
const PROVIDER_RECONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const PROVIDER_RECONNECT_STABLE_WINDOW: Duration = Duration::from_secs(30);
/// Proactively refresh the in-memory AI token while the session is healthy, so
/// a later provider reconnect does not depend on a fresh license-service call.
const AI_TOKEN_REFRESH_INTERVAL: Duration = Duration::from_secs(8 * 60);

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
    /// Wall-clock start of the active transcription session. The operator UI
    /// uses this to show a live session duration without keeping a second
    /// timer that can drift from the saved transcript session.
    pub started_at: Option<u64>,
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
    /// For quote cards: "anchored" when the same final turn carries a matching
    /// explicit citation or an attribution cue. Loose quote cards are
    /// deliberately ineligible for automatic Stage/Live.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote_support: Option<String>,
    /// Translation whose verse text produced the lexical match.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matching_version: Option<String>,
    /// Number of rare index terms that contributed to the candidate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rare_word_count: Option<usize>,
    /// Set when the spoken citation and the lexically matched verse disagree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citation_conflict: Option<String>,
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
    /// End-of-session timing and detection counters used by the platform
    /// admin dashboard. Contains no transcript or evidence text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub performance: Option<serde_json::Value>,
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
    started_at: u64,
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
    started_at: u64,
    /// Local transcript retention. When disabled the recorder still keeps the
    /// session in memory for live metrics and optional Dashboard sync, but
    /// never writes it to the local database.
    persist_enabled: bool,
}

impl AiSessionRecorder {
    fn new(
        store: Arc<MediaScheduleStore>,
        id: String,
        provider: AsrProvider,
        mode: String,
        audio_device: String,
        version: String,
        persist_enabled: bool,
    ) -> Result<Arc<Self>, String> {
        let started_at = now_ms();
        let recorder = Arc::new(Self {
            store,
            started_at,
            persist_enabled,
            session: Mutex::new(AiScriptureSavedSession {
                id,
                started_at,
                ended_at: None,
                provider: provider.as_str().into(),
                mode,
                audio_device,
                version,
                transcript: Vec::new(),
                suggestions: Vec::new(),
                stop_reason: None,
                performance: None,
            }),
        });
        recorder.persist()?;
        Ok(recorder)
    }

    fn persist(&self) -> Result<(), String> {
        if !self.persist_enabled {
            return Ok(());
        }
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

    fn record_performance(&self, performance: serde_json::Value) -> Result<(), String> {
        self.session
            .lock()
            .map_err(|error| error.to_string())?
            .performance = Some(performance);
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
        "performance": session.performance,
    });
    license
        .post_ai_authenticated("/transcripts/sync", &body)
        .await
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
    /// Last canonical book name spoken, even when the speaker has not yet
    /// supplied a chapter. This lets "in Isaiah" followed by "chapter seven and
    /// verse fourteen" resolve against Isaiah rather than the last projected
    /// verse's book.
    last_spoken_book: Arc<Mutex<Option<String>>>,
    /// When the last book name was spoken. A stale book mention must not
    /// override the verse the congregation is currently seeing when the
    /// preacher simply says "verse 10".
    last_spoken_book_at: Arc<Mutex<Option<Instant>>>,
    /// True when the previous ASR segment ended on the word "chapter", so the
    /// next segment's leading number is the chapter rather than a verse.
    pending_chapter: Arc<Mutex<bool>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VerseAnchor {
    book: String,
    chapter: i32,
    verse: i32,
    /// The anchor's freshness is used to arbitrate between a recently spoken
    /// book name and the verse that is currently live.
    updated_at: Instant,
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
    /// Explicit citations spoken in the same final turn. Every citation is
    /// retained so a quotation inside a spoken range can be anchored.
    references: Vec<ScriptureReference>,
    /// True when the turn contains an attribution phrase such as "it is
    /// written" or "the Bible says".
    attribution_cue: bool,
    source_transcript_timestamp: u64,
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
    quote_indexes: Arc<Mutex<QuoteIndexCache>>,
    quote_cache: Arc<Mutex<QuoteSearchCache>>,
}

struct ActiveDetectionSession(Arc<AtomicBool>);

impl Drop for ActiveDetectionSession {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Shared between the AI listener and the manual display commands. The anchor
/// must follow every verse the operator sends live, not only AI-originated
/// sends, so a following "verse 10" stays in Philippians 3 instead of jumping
/// back to an older AI reference.
static SHARED_NAVIGATION_ANCHOR: OnceLock<Arc<Mutex<Option<VerseAnchor>>>> = OnceLock::new();

fn shared_navigation_anchor() -> Arc<Mutex<Option<VerseAnchor>>> {
    SHARED_NAVIGATION_ANCHOR
        .get_or_init(|| Arc::new(Mutex::new(None)))
        .clone()
}

pub(crate) fn note_live_verse(verse: &Verse) {
    if let Ok(mut anchor) = shared_navigation_anchor().lock() {
        *anchor = Some(VerseAnchor {
            book: verse.book.clone(),
            chapter: verse.chapter,
            verse: verse.verse,
            updated_at: Instant::now(),
        });
    }
}

pub(crate) fn clear_live_verse_anchor() {
    if let Ok(mut anchor) = shared_navigation_anchor().lock() {
        *anchor = None;
    }
}

fn sync_navigation_anchor_from_live(app: &AppHandle) {
    let mut anchor = None;
    if let Some(state) = app.try_state::<AppState>() {
        for slot in [&state.presentation.live_item, &state.presentation.staged_item] {
            if let Some(crate::store::DisplayItem::Verse(verse)) = slot.lock().as_ref() {
                anchor = Some(VerseAnchor {
                    book: verse.book.clone(),
                    chapter: verse.chapter,
                    verse: verse.verse,
                    updated_at: Instant::now(),
                });
                break;
            }
        }
    }
    if let Ok(mut current) = shared_navigation_anchor().lock() {
        *current = anchor;
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
            updated_at: Instant::now(),
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
                    quote_support: None,
                    matching_version: None,
                    rare_word_count: None,
                    citation_conflict: None,
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
        updated_at: Instant::now(),
    })
}

fn contextual_book_is_authoritative(
    pending_chapter: bool,
    recent_book_at: Option<Instant>,
    anchor: Option<&VerseAnchor>,
) -> bool {
    pending_chapter
        || anchor.is_none()
        || recent_book_at.is_some_and(|at| {
            anchor.is_some_and(|anchor| at > anchor.updated_at)
        })
}

/// Sermons commonly continue through a chapter with "verse seventeen and
/// eighteen" after naming the book once. Resolve that concise form against
/// whichever is fresher: the last book actually spoken or the verse currently
/// live. This lets a manual "Go live" update the following verse reference
/// without letting a stale book name hijack it.
fn detect_contextual_verse_reference_from_tokens(
    tokens: &[String],
    detection: &DetectionConfig,
    app: &AppHandle,
) -> Option<crate::ai_detection::ScriptureReference> {
    let recent_book = detection
        .last_spoken_book
        .lock()
        .ok()
        .and_then(|book| book.clone());
    let recent_book_at = detection
        .last_spoken_book_at
        .lock()
        .ok()
        .and_then(|at| *at);
    let pending_chapter = detection
        .pending_chapter
        .lock()
        .map(|pending| *pending)
        .unwrap_or(false);
    let anchor = navigation_anchor(detection, app);
    // A book name from ten minutes ago must not beat the verse the operator
    // just sent live. Book context wins only while it is newer than the live
    // anchor, or while completing a split "Isaiah chapter" handoff.
    let use_recent_book =
        contextual_book_is_authoritative(pending_chapter, recent_book_at, anchor.as_ref());
    let contextual_book = if use_recent_book {
        recent_book.as_deref()
    } else {
        None
    };
    let reference = contextual_verse_reference_for_tokens(
        tokens,
        contextual_book,
        anchor.as_ref(),
        pending_chapter,
    );
    if pending_chapter {
        if let Ok(mut pending) = detection.pending_chapter.lock() {
            *pending = false;
        }
    }
    if let Some(reference) = &reference {
        if let Ok(mut book) = detection.last_spoken_book.lock() {
            *book = Some(reference.book.clone());
        }
    }
    reference
}

/// Records the last canonical book named in the transcript, even when no
/// chapter/verse follows yet. The next ASR segment can then resolve "chapter
/// seven and verse fourteen" against Isaiah.
fn remember_last_spoken_book(
    detection: &DetectionConfig,
    tokens: &[String],
    direct_references: &[crate::ai_detection::ScriptureReference],
) {
    let book = direct_references
        .last()
        .map(|reference| reference.book.clone())
        .or_else(|| last_book_mention(tokens, &detection.reference_aliases));
    if let Some(book) = book {
        if let Ok(mut current) = detection.last_spoken_book.lock() {
            *current = Some(book);
        }
        if let Ok(mut at) = detection.last_spoken_book_at.lock() {
            *at = Some(Instant::now());
        }
    }
}

fn mark_pending_chapter(
    detection: &DetectionConfig,
    tokens: &[String],
    direct_references: &[crate::ai_detection::ScriptureReference],
) {
    let pending = direct_references.is_empty()
        && tokens.last().is_some_and(|token| token == "chapter")
        && detection
            .last_spoken_book
            .lock()
            .map(|book| book.is_some())
            .unwrap_or(false);
    if let Ok(mut current) = detection.pending_chapter.lock() {
        *current = pending;
    }
}

fn last_book_mention(
    tokens: &[String],
    aliases: &[(Vec<String>, String)],
) -> Option<String> {
    let mut best: Option<(usize, usize, String)> = None;
    for (alias, canonical) in aliases {
        if alias.is_empty() || alias.len() > tokens.len() {
            continue;
        }
        for start in 0..=tokens.len() - alias.len() {
            if tokens[start..start + alias.len()] != alias[..] {
                continue;
            }
            let end = start + alias.len();
            // Bare aliases are only safe at a natural thought boundary. A
            // common word in the middle of prose ("this is the day", "do not
            // judge him") must not become the book context for a later
            // "verse 31". Also keep the split "Isaiah chapter" -> "seven and
            // verse fourteen" handoff working.
            let at_thought_end = end == tokens.len();
            let before_split_chapter = tokens.get(end).is_some_and(|token| token == "chapter")
                && end + 1 == tokens.len();
            if !at_thought_end && !before_split_chapter {
                continue;
            }
            let replace = best
                .as_ref()
                .is_none_or(|(best_end, best_len, _)| {
                    end > *best_end || (end == *best_end && alias.len() > *best_len)
                });
            if replace {
                best = Some((end, alias.len(), canonical.clone()));
            }
        }
    }
    best.map(|(_, _, book)| book)
}

#[cfg(test)]
fn contextual_verse_reference_for_anchor(
    transcript: &str,
    anchor: &VerseAnchor,
) -> Option<crate::ai_detection::ScriptureReference> {
    let tokens = quote_tokens(transcript);
    contextual_verse_reference_for_tokens(&tokens, Some(&anchor.book), Some(anchor), false)
}

fn contextual_verse_reference_for_tokens(
    tokens: &[String],
    recent_book: Option<&str>,
    anchor: Option<&VerseAnchor>,
    pending_chapter: bool,
) -> Option<crate::ai_detection::ScriptureReference> {
    let book = recent_book.or_else(|| anchor.map(|anchor| anchor.book.as_str()))?;
    let fallback_chapter = anchor.map(|anchor| anchor.chapter);
    let mut latest = None;
    let mut index = 0usize;
    // If the previous ASR segment ended with "chapter", the next segment's
    // leading number is the chapter: "Isaiah chapter" -> "seven and verse 14".
    if pending_chapter {
        if let Some((chapter, next)) = parse_number(tokens, 0) {
            let mut marker = next;
            if tokens.get(marker).is_some_and(|token| token == "and") {
                marker += 1;
            }
            if tokens
                .get(marker)
                .is_some_and(|token| token == "verse" || token == "verses")
            {
                let plural = tokens[marker] == "verses";
                if let Some((verse, _verse_next, verse_end)) =
                    crate::ai_detection::parse_verse_number(tokens, marker + 1, plural)
                {
                    if chapter > 0 && (1..=176).contains(&verse) {
                        return Some(crate::ai_detection::ScriptureReference {
                            book: book.to_string(),
                            chapter,
                            verse,
                            verse_end: verse_end.filter(|end| *end <= 176),
                        });
                    }
                }
            }
        }
    }
    while index < tokens.len() {
        // Explicit chapter followed by a verse: "chapter seven and verse 14".
        // The chapter wins over the navigation anchor so a new book mention is
        // not misread as another passage in the previously projected book.
        if tokens[index] == "chapter" {
            if let Some((chapter, next)) = parse_number(tokens, index + 1) {
                let mut marker = next;
                if tokens.get(marker).is_some_and(|token| token == "and") {
                    marker += 1;
                }
                if tokens
                    .get(marker)
                    .is_some_and(|token| token == "verse" || token == "verses")
                {
                    let plural = tokens[marker] == "verses";
                    if let Some((verse, verse_next, verse_end)) =
                        crate::ai_detection::parse_verse_number(tokens, marker + 1, plural)
                    {
                        if chapter > 0 && (1..=176).contains(&verse) {
                            let verse_end = verse_end.filter(|end| *end <= 176);
                            latest = Some(crate::ai_detection::ScriptureReference {
                                book: book.to_string(),
                                chapter,
                                verse,
                                verse_end,
                            });
                            index = verse_next;
                            continue;
                        }
                    }
                }
            }
        }
        // Verse-only continuation: "verse seventeen and eighteen".
        let plural_marker = tokens[index] == "verses";
        if plural_marker || tokens[index] == "verse" {
            if let Some(chapter) = fallback_chapter {
                let Some((verse, next, verse_end)) =
                    crate::ai_detection::parse_verse_number(tokens, index + 1, plural_marker)
                else {
                    index += 1;
                    continue;
                };
                if (1..=176).contains(&verse) {
                    let verse_end = verse_end.filter(|end| *end <= 176);
                    latest = Some(crate::ai_detection::ScriptureReference {
                        book: book.to_string(),
                        chapter,
                        verse,
                        verse_end,
                    });
                    index = next;
                    continue;
                }
            }
        }
        index += 1;
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
            quote_support: None,
            matching_version: None,
            rare_word_count: None,
            citation_conflict: None,
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
            started_at: Some(session.started_at),
        },
        None => AiRuntimeStatus {
            state: "stopped".into(),
            provider: guard.last_provider.as_str().into(),
            audio_device: None,
            version: None,
            message: guard.last_message.clone(),
            started_at: None,
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
    let mut started_at = None;
    if let Ok(mut guard) = runtime().lock() {
        guard.last_message = message.clone();
        started_at = guard.session.as_ref().map(|session| session.started_at);
    }
    let _ = app.emit(
        "ai-scripture-status",
        AiRuntimeStatus {
            state: state.into(),
            provider: provider.as_str().into(),
            audio_device: device,
            version,
            message,
            started_at,
        },
    );
}

#[tauri::command]
pub async fn ai_start(
    app: AppHandle,
    state: State<'_, AppState>,
    audio_device: String,
    version: String,
    mode: String,
) -> Result<AiRuntimeStatus, String> {
    crate::license::ensure_core_activated(&state)?;
    // The platform admin selects the transcription provider in the gateway.
    // Operators never choose or see the upstream service.
    let provider = AsrProvider::parse(&state.license.ai_asr_provider().await?)?;
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
    let (retention_enabled, sync_enabled) = {
        let settings = state.presentation.settings.lock();
        (
            settings.transcript_retention_enabled,
            settings.transcript_sync_enabled,
        )
    };
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
            retention_enabled,
        )?;
        guard.last_message = "Connecting to transcription…".to_string();
        guard.last_provider = provider;
        guard.session = Some(AiSessionControl {
            id: session_id.clone(),
            started_at: recorder.started_at,
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
        "Connecting to transcription…".to_string(),
        Some(audio_device.clone()),
        Some(version.clone()),
    );

    let session_started_at = recorder.started_at;
    let bible = state.store.clone();
    let license = state.license.clone();
    let sync_license = license.clone();

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
                        if let Err(error) = sync_session_to_dashboard(&sync_license, &session).await
                        {
                            crate::store::log_msg(
                                &sync_app,
                                &format!(
                                    "[ai-scripture] dashboard transcript sync failed: {error}"
                                ),
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
        message: "Connecting to transcription…".to_string(),
        started_at: Some(session_started_at),
    })
}

#[tauri::command]
pub async fn ai_stop(performance: Option<serde_json::Value>) -> Result<(), String> {
    let session = {
        let guard = runtime().lock().map_err(|e| e.to_string())?;
        guard
            .session
            .as_ref()
            .map(|session| (session.id.clone(), session.stop.clone(), session.recorder.clone()))
    };
    let Some((session_id, stop, recorder)) = session else {
        return Ok(());
    };
    if let Some(performance) = performance {
        recorder.record_performance(performance)?;
    }
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
    _provider: AsrProvider,
    access_token: &str,
    stop: &mut watch::Receiver<bool>,
    timeout: Duration,
) -> Result<Option<AsrWebSocket>, String> {
    let gateway_ws_base = websocket_base_url(&crate::license::ai_gateway_url());
    // Provider-neutral route. The gateway selects the upstream service from
    // platform-admin configuration; `provider` is only the local wire adapter.
    let gateway_url = format!("{}/v1/asr", gateway_ws_base.trim_end_matches('/'));
    let mut request = gateway_url.into_client_request().map_err(|error| {
        format!(
            "Could not start the transcription connection: {error}"
        )
    })?;
    adapter.configure_gateway_request(&mut request, access_token)?;

    let connection = tokio::time::timeout(timeout, tokio_tungstenite::connect_async(request));
    let result = tokio::select! {
        _ = stop.changed() => return Ok(None),
        result = connection => result,
    };
    let (socket, _) = result
        .map_err(|_| format!("Transcription connection timed out after {} seconds.", timeout.as_secs()))?
        .map_err(|error| format!("Could not connect to the transcription service: {error}"))?;
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
        let backoff = PROVIDER_RECONNECT_BASE_DELAY_MILLIS
            .saturating_mul(1_u64 << (attempt - 1).min(6))
            .min(PROVIDER_RECONNECT_MAX_DELAY_MILLIS);
        let jitter = (SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos()
            % 500) as u64;
        let delay = backoff.saturating_add(jitter);
        emit_status(
            app,
            provider,
            "connecting",
            format!(
                "Transcription connection lost; reconnecting ({attempt}/{MAX_PROVIDER_RECONNECT_ATTEMPTS})…"
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
                    "Transcription reconnected.".to_string(),
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
    let _ = failures;
    Err(format!(
        "Transcription disconnected and could not reconnect after {} attempts. Check your internet connection and try again.",
        MAX_PROVIDER_RECONNECT_ATTEMPTS
    ))
}

async fn connect_pcm_relay(relay: &AudioRelay) -> Result<tokio::net::TcpStream, String> {
    let connection = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect(("127.0.0.1", relay.port())),
    )
    .await
    .map_err(|_| "Timed out connecting to the AI Scripture audio feed.".to_string())?
    .map_err(|error| format!("Could not connect to the AI Scripture audio feed: {error}"))?;
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
    let quote_indexes = Arc::new(Mutex::new(QuoteIndexCache::new(bible.clone())));
    // Build the selected translation's rare-word index before opening the
    // provider socket, so a first-build pause cannot leave an idle ASR
    // connection waiting. If it cannot be built, the session still runs;
    // direct references and the semantic path are unaffected.
    let index_started = Instant::now();
    match quote_indexes
        .lock()
        .map_err(|error| error.to_string())
        .and_then(|mut indexes| indexes.get_or_build(&version))
    {
        Ok(index) => crate::store::log_msg(
            &app,
            &format!(
                "[ai-scripture] quote index ready for {} ({} verses, {} ms)",
                index.version(),
                index.verse_count(),
                index_started.elapsed().as_millis()
            ),
        ),
        Err(error) => crate::store::log_msg(
            &app,
            &format!("[ai-scripture] quote index unavailable: {error}"),
        ),
    }
    let refresh_license = license.clone();
    let refresh_app = app.clone();
    let mut refresh_stop = stop.clone();
    tauri::async_runtime::spawn(async move {
        let mut next_refresh = AI_TOKEN_REFRESH_INTERVAL;
        loop {
            tokio::select! {
                _ = tokio::time::sleep(next_refresh) => {}
                changed = refresh_stop.changed() => {
                    if changed.is_err() || *refresh_stop.borrow() {
                        break;
                    }
                    continue;
                }
            }
            match refresh_license.ai_access().await {
                Ok(_) => next_refresh = AI_TOKEN_REFRESH_INTERVAL,
                Err(error) => {
                    crate::store::log_msg(
                        &refresh_app,
                        &format!("[ai-scripture] proactive AI token refresh failed: {error}"),
                    );
                    next_refresh = Duration::from_secs(60);
                }
            }
        }
    });
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
        "Listening for Scripture…".to_string(),
        Some(audio_device.clone()),
        Some(version.clone()),
    );

    let books = bible.get_books(&version).map_err(|e| e.to_string())?;
    let reference_aliases = reference_aliases_for_books(&books);
    // The MVP is English-only, so every installed translation can help align
    // a quotation. The winning canonical reference is converted back to the
    // operator-selected output translation before it reaches the UI.
    sync_navigation_anchor_from_live(&app);
    let detection = Arc::new(DetectionConfig {
        output_version: Arc::new(Mutex::new(version.clone())),
        available_versions,
        reference_aliases,
        navigation_anchor: shared_navigation_anchor(),
        last_spoken_book: Arc::new(Mutex::new(None)),
        last_spoken_book_at: Arc::new(Mutex::new(None)),
        pending_chapter: Arc::new(Mutex::new(false)),
    });
    let recently_suggested = Arc::new(Mutex::new(HashMap::new()));
    let detection_generation = Arc::new(AtomicU64::new(0));
    let detection_active = Arc::new(AtomicBool::new(true));
    let _active_detection_session = ActiveDetectionSession(detection_active.clone());
    let quote_cache = Arc::new(Mutex::new(QuoteSearchCache::default()));
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
            quote_indexes,
            quote_cache,
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
    let mut last_audio_level_emit = Instant::now() - Duration::from_millis(100);

    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_ok() && *stop.borrow() { break; }
            }
            read = pcm.read(&mut audio) => {
                let count = read.map_err(|e| format!("AI Scripture audio feed failed: {e}"))?;
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
                        "Listening for Scripture…".to_string(),
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
                            return Err("The transcription service ended the session.".to_string());
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
        while quote_rx.changed().await.is_ok() {
            let Some(job) = quote_rx.borrow_and_update().clone() else {
                continue;
            };
            let output_version = current_output_version(&worker.detection);
            let index = match worker
                .quote_indexes
                .lock()
                .map_err(|error| error.to_string())
                .and_then(|mut indexes| indexes.get_or_build(&output_version))
            {
                Ok(index) => index,
                Err(error) => {
                    crate::store::log_msg(
                        &worker.app,
                        &format!("[ai-scripture] quote index refresh failed: {error}"),
                    );
                    continue;
                }
            };
            let quote_cache = worker.quote_cache.clone();
            let worker_job = job.clone();
            let started = Instant::now();
            let mut suggestions = tokio::task::spawn_blocking(move || {
                let mut cache = match quote_cache.lock() {
                    Ok(cache) => cache,
                    Err(poisoned) => poisoned.into_inner(),
                };
                detect_direct_quotes(
                    &index,
                    &mut cache,
                    &worker_job.rolling_text,
                    &worker_job.evidence,
                    &worker_job.references,
                    worker_job.attribution_cue,
                    worker_job.asr_confidence,
                )
            })
            .await
            .unwrap_or_default();
            if started.elapsed() > Duration::from_millis(1_200) {
                crate::store::log_msg(
                    &worker.app,
                    &format!(
                        "[ai-scripture] quote lookup took {} ms",
                        started.elapsed().as_millis()
                    ),
                );
            }

            for suggestion in &mut suggestions {
                suggestion.source_transcript_timestamp = Some(job.source_transcript_timestamp);
            }
            if let Some(cited) = job.references.first() {
                for suggestion in &suggestions {
                    if suggestion.detection == "quote"
                        && !job
                            .references
                            .iter()
                            .any(|reference| reference_covers_verse(reference, &suggestion.verse))
                    {
                        crate::store::log_msg(
                            &worker.app,
                            &format!(
                                "[ai-scripture] citation/quote conflict: cited {} {}:{} (or a cited range), quote evidence matched {} {}:{}",
                                cited.book,
                                cited.chapter,
                                cited.verse,
                                suggestion.verse.book,
                                suggestion.verse.chapter,
                                suggestion.verse.verse,
                            ),
                        );
                    }
                }
            }

            if !worker.active.load(Ordering::Acquire) {
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

            // React prepends events. Emit weaker alternatives first so the
            // strongest quotation remains at the top of the suggestion list.
            for suggestion in suggestions.into_iter().rev() {
                let _ = emit_suggestion_if_new(&worker.app, &worker.recently_suggested, suggestion);
            }

            // Direct quote detection and paraphrase retrieval are deliberately
            // independent. A valid direct quotation must not starve the
            // speaker's newer sentence-aware thought for the rest of the turn.
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
                            quote_support: None,
                            matching_version: None,
                            rare_word_count: None,
                            citation_conflict: None,
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
        ProviderEvent::Error(error) => {
            crate::store::log_msg(app, &format!("[ai-scripture] transcription error: {error}"));
            Err("The transcription service reported an error. Wordlyte will try to reconnect.".to_string())
        }
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
    let min_word_confidence = provider_transcript.min_word_confidence;
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
        // Interim text is used only for cheap, deterministic reference
        // previews. Quote retrieval is final-turn work: running broad lexical
        // search on every six-word revision saturated the single quote worker
        // and delayed final cards by seconds.
        handle_interim_transcript(
            app,
            bible,
            detection,
            pipeline,
            transcript,
            &normalized_tokens,
            &transcript_quote_tokens,
            transcript_timestamp,
        );
        return Ok(());
    }
    let direct_references =
        detect_references_with_aliases(&normalized_tokens, &detection.reference_aliases);
    remember_last_spoken_book(detection, &normalized_tokens, &direct_references);
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
    mark_pending_chapter(detection, &normalized_tokens, &final_references.0);
    let reference_hints = final_references.0.clone();
    if !final_references.0.is_empty() {
        // One spoken citation produces one passage card. Expanding every verse
        // in a range used to flood the feed and, because all range verses shared
        // the same 0.89 confidence, let a single range pass the automatic Stage
        // gate many times. The card carries passage_start/passage_end so the
        // operator can still navigate the full range.
        let output_version = current_output_version(detection);
        for reference in final_references.0.into_iter().rev() {
            let verses = verses_for_reference(bible, &reference, &output_version);
            let Some(first) = verses.first().cloned() else {
                continue;
            };
            let last_verse = verses.last().map(|verse| verse.verse);
            if let Some(last) = verses.last() {
                set_navigation_anchor(detection, last);
            }
            let passage_end = last_verse.filter(|last| *last > first.verse);
            let chapter_only = reference_is_chapter_only(&reference, transcript);
            let mut reference_confidence = if chapter_only {
                MAX_INCOMPLETE_REFERENCE_CONFIDENCE
            } else {
                (0.92 + confidence * 0.07).clamp(0.0, 0.99)
            };
            // A cited chapter/verse is only as reliable as its spoken numerals.
            // If both the average and the weakest word are poor, keep the card
            // reviewable but below the automatic Stage threshold.
            if min_word_confidence.is_some_and(|word| word < 0.55) && confidence < 0.85 {
                reference_confidence = reference_confidence.min(MAX_SHORT_QUOTE_CONFIDENCE);
            }
            let suggestion = ScriptureSuggestion {
                id: Uuid::new_v4().to_string(),
                detection: "reference".into(),
                evidence_types: Vec::new(),
                confidence: reference_confidence,
                evidence: transcript.to_string(),
                verse: first,
                timestamp: now_ms(),
                source_transcript_timestamp: Some(transcript_timestamp),
                group_id: None,
                rank: None,
                passage_start: Some(reference.verse),
                passage_end,
                similarity: None,
                margin: None,
                quote_support: None,
                matching_version: None,
                rare_word_count: None,
                citation_conflict: None,
            };
            if final_references.1 {
                emit_fresh_reference(app, &pipeline.recently_suggested, suggestion);
            } else {
                emit_suggestion_if_new(app, &pipeline.recently_suggested, suggestion);
            }
        }
        // A finalized ASR turn can contain both an explicit reference and
        // other quotations. Keep the deterministic reference fast path, but
        // still queue the same turn for quotation/semantic analysis.
    }
    let final_evidence = transcript.to_string();
    pipeline.quote_tx.send_replace(Some(QuoteJob {
        generation: current_generation,
        rolling_text,
        semantic_text,
        semantic_segments,
        evidence: final_evidence,
        asr_confidence: confidence,
        references: reference_hints,
        attribution_cue: has_quote_attribution_cue(transcript),
        source_transcript_timestamp: transcript_timestamp,
    }));
    Ok(())
}

fn has_quote_attribution_cue(text: &str) -> bool {
    let normalized = normalize_voice_phrase(text);
    [
        "it is written",
        "as it is written",
        "the scripture says",
        "the scripture saith",
        "the scripture tells us",
        "the bible says",
        "the bible tells us",
        "the bible declares",
        "the word tells us",
        "the word of god says",
        "the word of god tells us",
        "it says",
        "thus saith the lord",
        "in the book of",
    ]
    .iter()
    .any(|cue| contains_voice_phrase(&normalized, cue))
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
    transcript_timestamp: u64,
) {
    // References are the operator's real-time path. Search every provider
    // revision as soon as it contains a complete, locally verifiable reference
    // instead of waiting for a second revision, a word-count sample, or an ASR
    // turn boundary. They remain Preview-only until the provider sends its
    // final transcript: ASR can briefly revise a spoken number while the
    // preacher is still speaking.
    remember_last_spoken_book(detection, normalized_tokens, &[]);
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
    remember_last_spoken_book(detection, normalized_tokens, &references);
    mark_pending_chapter(detection, normalized_tokens, &references);
    let output_version = current_output_version(detection);
    for reference in references {
        let verses = verses_for_reference(bible, &reference, &output_version);
        let Some(first) = verses.first().cloned() else {
            continue;
        };
        let last_verse = verses.last().map(|verse| verse.verse);
        let passage_end = last_verse.filter(|last| *last > first.verse);
        let suggestion = ScriptureSuggestion {
            id: Uuid::new_v4().to_string(),
            detection: "reference".into(),
            evidence_types: Vec::new(),
            confidence: if reference_is_chapter_only(&reference, transcript) {
                MAX_INCOMPLETE_REFERENCE_CONFIDENCE
            } else {
                MAX_SHORT_QUOTE_CONFIDENCE
            },
            evidence: latest_word_suffix(transcript, MAX_SEMANTIC_CONTEXT_WORDS),
            verse: first,
            timestamp: now_ms(),
            source_transcript_timestamp: Some(transcript_timestamp),
            group_id: None,
            rank: None,
            passage_start: Some(reference.verse),
            passage_end,
            similarity: None,
            margin: None,
            quote_support: None,
            matching_version: None,
            rare_word_count: None,
            citation_conflict: None,
        };
        emit_proactive_preview_reference(app, &pipeline.recently_suggested, suggestion);
    }
}

fn interim_reference_tokens(tokens: &[String]) -> &[String] {
    let start = tokens
        .len()
        .saturating_sub(MAX_INTERIM_REFERENCE_SCAN_WORDS);
    &tokens[start..]
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
/// This worker runs only on finalized turns; interim revisions are handled by
/// the deterministic reference path.
struct QuoteMatch {
    verse: Verse,
    score: f32,
    rank_score: f32,
    evidence: String,
    rare_word_count: usize,
}

type QuoteMatches = HashMap<(String, i32, i32), QuoteMatch>;

fn detect_direct_quotes(
    index: &QuoteSearchIndex,
    cache: &mut QuoteSearchCache,
    rolling_text: &str,
    evidence: &str,
    references: &[ScriptureReference],
    attribution_cue: bool,
    asr_confidence: f32,
) -> Vec<ScriptureSuggestion> {
    // An explicit citation or an attribution cue may carry a very short exact
    // quotation. Loose quotation cards need three meaningful words so common
    // phrases do not become Scripture cards.
    let minimum_content_words = if references.is_empty() && !attribution_cue {
        MIN_LOOSE_QUOTE_CONTENT_WORDS
    } else {
        MIN_QUOTE_CONTENT_WORDS
    };

    let mut matches: QuoteMatches = HashMap::new();
    for window in quote_search_windows(evidence) {
        consider_quote_window(
            index,
            cache,
            &mut matches,
            &window,
            minimum_content_words,
        );
    }

    // Recover a quotation split across an ASR turn boundary with one bounded
    // tail window. The old implementation rescanned the whole 20-second rolling
    // context whenever the newest turn missed, multiplying FTS work by up to 24
    // windows per final.
    if matches.is_empty() && rolling_text != evidence {
        let tail = latest_word_suffix(rolling_text, QUOTE_CROSS_TURN_WORDS);
        for window in quote_search_windows(&tail) {
            consider_quote_window(
                index,
                cache,
                &mut matches,
                &window,
                minimum_content_words,
            );
        }
    }

    let mut matches = matches.into_values().collect::<Vec<_>>();
    matches.sort_by(|left, right| {
        right
            .rank_score
            .total_cmp(&left.rank_score)
            .then_with(|| right.score.total_cmp(&left.score))
    });
    matches
        .into_iter()
        .take(MAX_DIRECT_QUOTES_PER_TURN)
        .map(|matched| {
            let matching_reference = references
                .iter()
                .find(|reference| reference_covers_verse(reference, &matched.verse));
            let anchored = matching_reference.is_some()
                || (attribution_cue && references.is_empty());
            let citation_conflict = if matching_reference.is_some() {
                None
            } else {
                references.first().map(|reference| {
                    format!(
                        "Spoken citation {} {}:{} differs from the matched verse.",
                        reference.book, reference.chapter, reference.verse
                    )
                })
            };
            let confidence = quote_confidence(
                matched.score,
                asr_confidence,
                quote_tokens(&matched.evidence).len(),
            )
            .min(if anchored {
                0.98
            } else {
                MAX_LOOSE_QUOTE_CONFIDENCE
            });
            ScriptureSuggestion {
                id: Uuid::new_v4().to_string(),
                detection: "quote".into(),
                evidence_types: Vec::new(),
                confidence,
                evidence: matched.evidence,
                verse: matched.verse,
                timestamp: now_ms(),
                source_transcript_timestamp: None,
                group_id: None,
                rank: None,
                passage_start: None,
                passage_end: None,
                similarity: None,
                margin: None,
                quote_support: Some(if anchored { "anchored" } else { "loose" }.into()),
                matching_version: Some(index.version().to_string()),
                rare_word_count: Some(matched.rare_word_count),
                citation_conflict,
            }
        })
        .collect()
}

fn consider_quote_window(
    index: &QuoteSearchIndex,
    cache: &mut QuoteSearchCache,
    matches: &mut QuoteMatches,
    window: &str,
    minimum_content_words: usize,
) {
    let hit = match cache.get(index.version(), window, minimum_content_words) {
        Some(cached) => cached,
        None => {
            let hit = best_indexed_quote_candidate(index, window, minimum_content_words);
            cache.insert(index.version(), window, minimum_content_words, hit);
            hit
        }
    };
    let Some(hit) = hit else {
        return;
    };
    let Some(verse) = index.verse(hit.verse_index) else {
        return;
    };
    let key = (verse.book.clone(), verse.chapter, verse.verse);
    let replace = matches
        .get(&key)
        .is_none_or(|current| hit.rank_score > current.rank_score);
    if replace {
        matches.insert(
            key,
            QuoteMatch {
                verse: verse.clone(),
                score: hit.score,
                rank_score: hit.rank_score,
                evidence: quote_evidence_excerpt(window, &verse.text),
                rare_word_count: hit.rare_terms,
            },
        );
    }
}

/// Show the operator the matching phrase rather than the full 24-word search
/// window. This makes a suggestion auditable and keeps the saved evidence field
/// meaningful when a long ASR turn contains several sentences.
fn quote_evidence_excerpt(window: &str, verse_text: &str) -> String {
    let spoken = quote_tokens(window);
    let verse = quote_tokens(verse_text);
    let mut best_start = 0usize;
    let mut best_len = 0usize;
    for start in 0..spoken.len() {
        for verse_start in 0..verse.len() {
            let mut length = 0;
            while start + length < spoken.len()
                && verse_start + length < verse.len()
                && spoken[start + length] == verse[verse_start + length]
            {
                length += 1;
            }
            if length > best_len {
                best_len = length;
                best_start = start;
            }
        }
    }
    if best_len < 4 {
        return window.to_string();
    }
    let start = best_start.saturating_sub(4);
    let end = (best_start + best_len + 6).min(spoken.len());
    spoken[start..end].join(" ")
}

fn best_indexed_quote_candidate(
    index: &QuoteSearchIndex,
    window: &str,
    minimum_content_words: usize,
) -> Option<QuoteHit> {
    let spoken_tokens = quote_tokens(window);
    if spoken_tokens.len() < MIN_DIRECT_QUOTE_WORDS {
        return None;
    }
    let mut best: Option<QuoteHit> = None;
    for candidate in index.candidates(window) {
        let Some(verse) = index.verse(candidate.verse_index) else {
            continue;
        };
        let verse_tokens = quote_tokens(&verse.text);
        let Some((score, content_ordered)) = direct_quote_match_score_tokens(
            &spoken_tokens,
            &verse_tokens,
            minimum_content_words,
        ) else {
            continue;
        };
        // Confidence stays anchored to the calibrated full-token score. IDF and
        // content ordering only choose between otherwise plausible candidates.
        let rank_score =
            (score * 0.92 + content_ordered * 0.05 + candidate.idf_coverage * 0.03).clamp(0.0, 1.0);
        let hit = QuoteHit {
            verse_index: candidate.verse_index,
            score,
            content_ordered,
            rank_score,
            rare_terms: candidate.rare_terms,
            idf_coverage: candidate.idf_coverage,
        };
        let replace = best.is_none_or(|current| {
            rank_score > current.rank_score
                || (rank_score == current.rank_score
                    && content_ordered > current.content_ordered)
                || (rank_score == current.rank_score
                    && content_ordered == current.content_ordered
                    && candidate.idf_coverage > current.idf_coverage)
                || (rank_score == current.rank_score
                    && content_ordered == current.content_ordered
                    && candidate.idf_coverage == current.idf_coverage
                    && candidate.rare_terms > current.rare_terms)
        });
        if replace {
            best = Some(hit);
        }
    }
    best
}

/// A generated first verse is not the same thing as a completed citation.
/// Chapter-only speech ("Isaiah chapter two") creates a verse-1 navigation
/// preview, but it must remain manual until the speaker names a verse.
fn reference_is_chapter_only(reference: &ScriptureReference, transcript: &str) -> bool {
    if reference.verse != 1 || reference.verse_end.is_some() {
        return false;
    }
    let normalized = quote_tokens(transcript);
    if normalized
        .iter()
        .any(|token| token == "verse" || token == "verses")
    {
        return false;
    }
    !transcript.contains(':')
}

fn reference_covers_verse(reference: &ScriptureReference, verse: &Verse) -> bool {
    let end = reference.verse_end.unwrap_or(reference.verse);
    reference.book == verse.book
        && reference.chapter == verse.chapter
        && (reference.verse..=end).contains(&verse.verse)
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
    use crate::ai_detection::direct_quote_match_score;

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
            quote_support: None,
            matching_version: None,
            rare_word_count: None,
            citation_conflict: None,
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
    fn stale_quote_generations_are_rejected() {
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
                quote_support: None,
                matching_version: None,
                rare_word_count: None,
                citation_conflict: None,
            }],
            stop_reason: None,
            performance: None,
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
    fn loose_quote_requires_three_content_words_but_anchored_quote_allows_two() {
        let index = QuoteSearchIndex::build(
            "KJV".into(),
            vec![Verse {
                book: "Psalms".into(),
                chapter: 24,
                verse: 1,
                text: "The earth is the LORD's, and the fullness thereof.".into(),
                version: "KJV".into(),
                split_index: None,
                total_splits: None,
                score: None,
            }],
        );
        let evidence = "truly the earth is the Lord";

        let mut loose_cache = QuoteSearchCache::default();
        let loose = detect_direct_quotes(
            &index,
            &mut loose_cache,
            evidence,
            evidence,
            &[],
            false,
            1.0,
        );
        assert!(loose.is_empty());

        let mut anchored_cache = QuoteSearchCache::default();
        let reference = ScriptureReference {
            book: "Psalms".into(),
            chapter: 24,
            verse: 1,
            verse_end: None,
        };
        let anchored = detect_direct_quotes(
            &index,
            &mut anchored_cache,
            evidence,
            evidence,
            &[reference],
            false,
            1.0,
        );
        assert_eq!(anchored.len(), 1);
        assert_eq!(anchored[0].verse.book, "Psalms");
    }

    #[test]
    fn latest_word_suffix_is_bounded_to_the_latest_words() {
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
                .any(|window| window.contains("shall not want he make")),
            "a quotation crossing a sentence boundary must stay inside one window"
        );
    }

    /// Calibration test for a real installed Bible database. CI uses synthetic
    /// fixtures; run locally with:
    /// `WORDLYTE_TEST_BIBLE_DB=... cargo test --lib quote_index_calibration -- --ignored`.
    #[test]
    #[ignore = "uses an installed Bible database via WORDLYTE_TEST_BIBLE_DB"]
    fn quote_index_calibration_rejects_common_phrases_and_finds_quotes() {
        let path = std::env::var_os("WORDLYTE_TEST_BIBLE_DB")
            .map(std::path::PathBuf::from)
            .expect("set WORDLYTE_TEST_BIBLE_DB to the installed Bible database");
        let bible = BibleStore::open_for_tests(&path).expect("open Bible database");
        let index = QuoteSearchIndex::build(
            "KJV".into(),
            bible.verses_for_version("KJV").expect("load KJV verses"),
        );

        for phrase in [
            "the lord said to me again",
            "now let me tell you this",
            "making the kingdom of god real on the earth",
            "and he said making the kingdom of god real on the earth",
            "the lord said to me again said pastor come this year",
            "every child of god is born into the family of the superlative",
            "the spirit of god come in a revival season to move you away from",
        ] {
            assert!(
                best_indexed_quote_candidate(&index, phrase, MIN_LOOSE_QUOTE_CONTENT_WORDS)
                    .is_none(),
                "common phrase should not produce a quote candidate: {phrase}"
            );
        }

        for (phrase, book, chapter, verse) in [
            ("the lord is my shepherd i shall not want", "Psalms", 23, 1),
            (
                "he sent his word and healed them and delivered them from their destructions",
                "Psalms",
                107,
                20,
            ),
            (
                "teaching the hands of men to war and their fingers to fight",
                "Psalms",
                144,
                1,
            ),
            (
                "the fear of the lord is the beginning of wisdom a good understanding",
                "Psalms",
                111,
                10,
            ),
        ] {
            let hit =
                best_indexed_quote_candidate(&index, phrase, MIN_LOOSE_QUOTE_CONTENT_WORDS)
                    .unwrap_or_else(|| panic!("expected a quote candidate for: {phrase}"));
            let matched = index.verse(hit.verse_index).expect("candidate verse");
            assert_eq!(
                (matched.book.as_str(), matched.chapter, matched.verse),
                (book, chapter, verse),
                "unexpected verse for {phrase}"
            );
        }
    }

    #[test]
    fn contextual_chapter_uses_the_most_recently_spoken_book() {
        let tokens = quote_tokens("chapter seven and verse fourteen");
        let anchor = VerseAnchor {
            book: "John".into(),
            chapter: 3,
            verse: 8,
            updated_at: Instant::now(),
        };
        assert_eq!(
            contextual_verse_reference_for_tokens(&tokens, Some("Isaiah"), Some(&anchor), false),
            Some(ScriptureReference {
                book: "Isaiah".into(),
                chapter: 7,
                verse: 14,
                verse_end: None,
            })
        );

        let split_tokens = quote_tokens("seven and verse fourteen");
        assert_eq!(
            contextual_verse_reference_for_tokens(
                &split_tokens,
                Some("Isaiah"),
                Some(&anchor),
                true,
            ),
            Some(ScriptureReference {
                book: "Isaiah".into(),
                chapter: 7,
                verse: 14,
                verse_end: None,
            })
        );
    }

    #[test]
    fn last_book_mention_ignores_a_later_verse_anchor() {
        let aliases = reference_aliases_for_books(&["Isaiah".into(), "John".into()]);
        assert_eq!(
            last_book_mention(&quote_tokens("the Bible speaks in Isaiah"), &aliases),
            Some("Isaiah".into())
        );
    }

    #[test]
    fn common_words_do_not_poison_book_context() {
        let aliases =
            reference_aliases_for_books(&["Isaiah".into(), "Judges".into(), "Matthew".into()]);
        assert_eq!(
            last_book_mention(&quote_tokens("this is the day"), &aliases),
            None
        );
        assert_eq!(
            last_book_mention(&quote_tokens("Jesus did not judge him"), &aliases),
            None
        );
        assert_eq!(
            last_book_mention(&quote_tokens("turn with me to Isaiah"), &aliases),
            Some("Isaiah".into())
        );
        assert_eq!(
            last_book_mention(&quote_tokens("Isaiah chapter"), &aliases),
            Some("Isaiah".into())
        );
    }

    #[test]
    fn chapter_only_references_stay_below_auto_stage() {
        let reference = ScriptureReference {
            book: "Isaiah".into(),
            chapter: 2,
            verse: 1,
            verse_end: None,
        };
        assert!(reference_is_chapter_only(
            &reference,
            "Isaiah chapter two"
        ));
        assert!(reference_is_chapter_only(&reference, "Isaiah two"));
        assert!(!reference_is_chapter_only(
            &reference,
            "Isaiah chapter two verse one"
        ));
        assert!(!reference_is_chapter_only(&reference, "Isaiah 2:1"));
    }

    #[test]
    fn a_cited_range_covers_each_verse_in_the_range() {
        let reference = ScriptureReference {
            book: "Hebrews".into(),
            chapter: 12,
            verse: 28,
            verse_end: Some(29),
        };
        let verse = |number| Verse {
            book: "Hebrews".into(),
            chapter: 12,
            verse: number,
            text: String::new(),
            version: "KJV".into(),
            split_index: None,
            total_splits: None,
            score: None,
        };
        assert!(reference_covers_verse(&reference, &verse(28)));
        assert!(reference_covers_verse(&reference, &verse(29)));
        assert!(!reference_covers_verse(&reference, &verse(30)));
    }

    #[test]
    fn stale_spoken_book_does_not_override_a_newer_live_anchor() {
        let now = Instant::now();
        let live = VerseAnchor {
            book: "Philippians".into(),
            chapter: 3,
            verse: 9,
            updated_at: now,
        };
        assert!(!contextual_book_is_authoritative(
            false,
            Some(now - Duration::from_secs(60)),
            Some(&live),
        ));

        let older_anchor = VerseAnchor {
            updated_at: now - Duration::from_secs(60),
            ..live.clone()
        };
        assert!(contextual_book_is_authoritative(
            false,
            Some(now),
            Some(&older_anchor),
        ));
        assert!(contextual_book_is_authoritative(true, None, Some(&live)));
    }

    #[test]
    fn contextual_verses_follow_the_last_verified_chapter() {
        let anchor = VerseAnchor {
            book: "Matthew".into(),
            chapter: 6,
            verse: 10,
            updated_at: Instant::now(),
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
