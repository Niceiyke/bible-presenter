use serde::Deserialize;
use tokio_tungstenite::tungstenite::{http::Request, Message};

const DEEPGRAM_PROVIDER: &str = "deepgram";
const ASSEMBLYAI_PROVIDER: &str = "assemblyai";
const DEEPGRAM_KEY_FILE: &str = "deepgram-api-key.dpapi";
const ASSEMBLYAI_KEY_FILE: &str = "assemblyai-api-key.dpapi";
const DEEPGRAM_BASE_URL: &str = "wss://api.deepgram.com/v1/listen?model=nova-3&language=en-US&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&smart_format=true&utterance_end_ms=1200&vad_events=true&redact_usage=true";
const ASSEMBLYAI_BASE_URL: &str = "wss://streaming.assemblyai.com/v3/ws";

// Provider vocabulary hints are kept here with the provider request adapters,
// rather than in the Scripture detection or audio-session orchestration code.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AsrProvider {
    Deepgram,
    AssemblyAi,
}

impl AsrProvider {
    pub(super) fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            DEEPGRAM_PROVIDER => Ok(Self::Deepgram),
            ASSEMBLYAI_PROVIDER => Ok(Self::AssemblyAi),
            _ => Err(format!(
                "Unsupported transcription provider. Choose {DEEPGRAM_PROVIDER} or {ASSEMBLYAI_PROVIDER}."
            )),
        }
    }

    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Deepgram => DEEPGRAM_PROVIDER,
            Self::AssemblyAi => ASSEMBLYAI_PROVIDER,
        }
    }

    pub(super) const fn display_name(self) -> &'static str {
        match self {
            Self::Deepgram => "Deepgram",
            Self::AssemblyAi => "AssemblyAI",
        }
    }

    pub(super) const fn key_file(self) -> &'static str {
        match self {
            Self::Deepgram => DEEPGRAM_KEY_FILE,
            Self::AssemblyAi => ASSEMBLYAI_KEY_FILE,
        }
    }
}

/// Canonical transcript event consumed by Wordlyte's provider-independent
/// Scripture pipeline.
pub(super) struct TranscriptUpdate {
    pub text: String,
    pub is_final: bool,
    pub confidence: f32,
    pub turn_order: Option<u64>,
}

pub(super) enum ProviderEvent {
    Transcript(TranscriptUpdate),
    Error(String),
    Terminated,
    Ignored,
}

pub(super) type ProviderWebSocketRequest = Request<()>;

/// Adapter boundary for a streaming speech-to-text service. Every adapter
/// receives the same PCM16/16 kHz/mono audio frames and normalizes provider
/// messages into `ProviderEvent`s. Provider-specific wire formats, auth, and
/// end-of-session behavior stay behind this interface.
pub(super) trait StreamingTranscriptionAdapter: Sync {
    fn websocket_url(&self) -> String;
    fn configure_request(
        &self,
        request: &mut ProviderWebSocketRequest,
        api_key: &str,
    ) -> Result<(), String>;
    fn decode_message(&self, text: &str) -> ProviderEvent;
    fn finish_message(&self) -> Option<Message>;
    fn drains_final_messages(&self) -> bool;

    fn audio_message(&self, pcm_s16le_16khz_mono: &[u8]) -> Message {
        Message::Binary(pcm_s16le_16khz_mono.to_vec().into())
    }
}

pub(super) fn adapter_for(provider: AsrProvider) -> &'static dyn StreamingTranscriptionAdapter {
    static DEEPGRAM: DeepgramAdapter = DeepgramAdapter;
    static ASSEMBLY_AI: AssemblyAiAdapter = AssemblyAiAdapter;
    match provider {
        AsrProvider::Deepgram => &DEEPGRAM,
        AsrProvider::AssemblyAi => &ASSEMBLY_AI,
    }
}

struct DeepgramAdapter;

impl StreamingTranscriptionAdapter for DeepgramAdapter {
    fn websocket_url(&self) -> String {
        let mut url = DEEPGRAM_BASE_URL.to_string();
        for keyterm in BIBLE_KEYTERMS.iter().chain(VOICE_COMMAND_KEYTERMS) {
            url.push_str("&keyterm=");
            // Terms are controlled ASCII. Deepgram accepts repeated encoded
            // keyterm parameters rather than a JSON list.
            url.push_str(&keyterm.replace(' ', "%20"));
        }
        url
    }

    fn configure_request(
        &self,
        request: &mut ProviderWebSocketRequest,
        api_key: &str,
    ) -> Result<(), String> {
        request.headers_mut().insert(
            "Authorization",
            format!("Token {api_key}")
                .parse()
                .map_err(|_| "Invalid transcription API key header")?,
        );
        Ok(())
    }

    fn decode_message(&self, text: &str) -> ProviderEvent {
        parse_deepgram_transcript(text)
            .map(ProviderEvent::Transcript)
            .unwrap_or(ProviderEvent::Ignored)
    }

    fn finish_message(&self) -> Option<Message> {
        Some(Message::Text(r#"{"type":"CloseStream"}"#.into()))
    }

    fn drains_final_messages(&self) -> bool {
        false
    }
}

struct AssemblyAiAdapter;

impl StreamingTranscriptionAdapter for AssemblyAiAdapter {
    fn websocket_url(&self) -> String {
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

    fn configure_request(
        &self,
        request: &mut ProviderWebSocketRequest,
        api_key: &str,
    ) -> Result<(), String> {
        request.headers_mut().insert(
            "Authorization",
            api_key
                .parse()
                .map_err(|_| "Invalid transcription API key header")?,
        );
        Ok(())
    }

    fn decode_message(&self, text: &str) -> ProviderEvent {
        let Ok(response) = serde_json::from_str::<AssemblyAiResponse>(text) else {
            return ProviderEvent::Ignored;
        };
        match response.kind.as_deref() {
            Some("Error") => ProviderEvent::Error(
                response
                    .error
                    .unwrap_or_else(|| "Unknown provider error".into()),
            ),
            Some("Termination") => ProviderEvent::Terminated,
            Some("Turn") => parse_assemblyai_turn(response)
                .map(ProviderEvent::Transcript)
                .unwrap_or(ProviderEvent::Ignored),
            _ => ProviderEvent::Ignored,
        }
    }

    fn finish_message(&self) -> Option<Message> {
        Some(Message::Text(r#"{"type":"Terminate"}"#.into()))
    }

    fn drains_final_messages(&self) -> bool {
        true
    }
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

fn parse_deepgram_transcript(text: &str) -> Option<TranscriptUpdate> {
    let response: DeepgramResponse = serde_json::from_str(text).ok()?;
    if response.kind.as_deref() != Some("Results") {
        return None;
    }
    let alternative = response.channel?.alternatives.into_iter().next()?;
    Some(TranscriptUpdate {
        text: alternative.transcript,
        is_final: response.is_final.unwrap_or(false),
        confidence: alternative.confidence.unwrap_or(0.0).clamp(0.0, 1.0),
        turn_order: None,
    })
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

fn parse_assemblyai_turn(response: AssemblyAiResponse) -> Option<TranscriptUpdate> {
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
    Some(TranscriptUpdate {
        text: response.transcript.unwrap_or_default(),
        // AssemblyAI emits a formatted final turn. Ignore unformatted end-of-
        // turn snapshots so the common pipeline sees one final per turn.
        is_final: response.end_of_turn.unwrap_or(false)
            && response.turn_is_formatted.unwrap_or(true),
        confidence,
        turn_order: response.turn_order,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    #[test]
    fn deepgram_adapter_normalizes_interim_and_final_events() {
        let adapter = adapter_for(AsrProvider::Deepgram);
        let ProviderEvent::Transcript(final_turn) = adapter.decode_message(
            r#"{"type":"Results","is_final":true,"channel":{"alternatives":[{"transcript":"John 3:16","confidence":0.97}]}}"#,
        ) else {
            panic!("expected a normalized transcript event");
        };
        assert_eq!(final_turn.text, "John 3:16");
        assert!(final_turn.is_final);
        assert!((final_turn.confidence - 0.97).abs() < f32::EPSILON);

        let ProviderEvent::Transcript(interim) = adapter.decode_message(
            r#"{"type":"Results","is_final":false,"channel":{"alternatives":[{"transcript":"John chapter three verse sixteen","confidence":0.91}]}}"#,
        ) else {
            panic!("expected an interim transcript event");
        };
        assert!(!interim.is_final);
        assert!(matches!(
            adapter.decode_message(r#"{"type":"Metadata"}"#),
            ProviderEvent::Ignored
        ));
    }

    #[test]
    fn assemblyai_adapter_normalizes_turn_error_and_termination_events() {
        let adapter = adapter_for(AsrProvider::AssemblyAi);
        let ProviderEvent::Transcript(turn) = adapter.decode_message(
            r#"{"type":"Turn","transcript":"John 3:16","end_of_turn":true,"turn_is_formatted":true,"turn_order":7,"words":[{"confidence":0.9},{"confidence":0.98}]}"#,
        ) else {
            panic!("expected a normalized transcript event");
        };
        assert_eq!(turn.text, "John 3:16");
        assert!(turn.is_final);
        assert_eq!(turn.turn_order, Some(7));
        assert!((turn.confidence - 0.94).abs() < f32::EPSILON);
        let ProviderEvent::Transcript(unformatted) = adapter.decode_message(
            r#"{"type":"Turn","transcript":"john 3 16","end_of_turn":true,"turn_is_formatted":false}"#,
        ) else {
            panic!("expected an unformatted interim event");
        };
        assert!(!unformatted.is_final);
        assert!(matches!(
            adapter.decode_message(r#"{"type":"Begin"}"#),
            ProviderEvent::Ignored
        ));
        assert!(matches!(
            adapter.decode_message(r#"{"type":"Error","error":"bad key"}"#),
            ProviderEvent::Error(message) if message == "bad key"
        ));
        assert!(matches!(
            adapter.decode_message(r#"{"type":"Termination"}"#),
            ProviderEvent::Terminated
        ));
        assert!(!adapter_for(AsrProvider::Deepgram).drains_final_messages());
        assert!(adapter.drains_final_messages());
    }

    #[test]
    fn providers_expose_their_own_wire_auth_and_shutdown_contracts() {
        let deepgram = adapter_for(AsrProvider::Deepgram);
        let deepgram_url = deepgram.websocket_url();
        assert!(deepgram_url.contains("model=nova-3"));
        assert!(deepgram_url.contains("keyterm=First%20John"));
        let mut deepgram_request = deepgram_url.into_client_request().unwrap();
        deepgram
            .configure_request(&mut deepgram_request, "secret")
            .unwrap();
        assert_eq!(deepgram_request.headers()["Authorization"], "Token secret");
        assert!(matches!(deepgram.finish_message(), Some(Message::Text(_))));

        let assembly = adapter_for(AsrProvider::AssemblyAi);
        let assembly_url = assembly.websocket_url();
        assert!(assembly_url.contains("speech_model=universal-3-6-pro"));
        assert!(assembly_url.contains("language_codes=%5B%22en%22%5D"));
        let mut assembly_request = assembly_url.into_client_request().unwrap();
        assembly
            .configure_request(&mut assembly_request, "secret")
            .unwrap();
        assert_eq!(assembly_request.headers()["Authorization"], "secret");
        assert!(matches!(assembly.finish_message(), Some(Message::Text(_))));
    }
}
