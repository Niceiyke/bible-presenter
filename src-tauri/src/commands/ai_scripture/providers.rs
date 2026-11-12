use serde::Deserialize;
use tokio_tungstenite::tungstenite::{http::Request, Message};

const DEEPGRAM_PROVIDER: &str = "deepgram";
const ASSEMBLYAI_PROVIDER: &str = "assemblyai";

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
}

/// Canonical transcript event consumed by Wordlyte's provider-independent
/// Scripture pipeline.
pub(super) struct TranscriptUpdate {
    pub text: String,
    pub is_final: bool,
    pub confidence: f32,
    /// Lowest word confidence in the update, when the provider supplies it.
    /// Used as a conservative guard for deterministic reference automation.
    pub min_word_confidence: Option<f32>,
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
    /// Authenticate to the Wordlyte AI Gateway. The adapter still owns the
    /// provider wire format, but provider credentials no longer reach the
    /// desktop.
    fn configure_gateway_request(
        &self,
        request: &mut ProviderWebSocketRequest,
        access_token: &str,
    ) -> Result<(), String> {
        request.headers_mut().insert(
            "Authorization",
            format!("Bearer {access_token}")
                .parse()
                .map_err(|_| "Invalid Wordlyte AI access token header")?,
        );
        Ok(())
    }
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
    #[serde(default)]
    words: Vec<DeepgramWord>,
}

#[derive(Debug, Deserialize)]
struct DeepgramWord {
    confidence: Option<f32>,
}

fn parse_deepgram_transcript(text: &str) -> Option<TranscriptUpdate> {
    let response: DeepgramResponse = serde_json::from_str(text).ok()?;
    if response.kind.as_deref() != Some("Results") {
        return None;
    }
    let alternative = response.channel?.alternatives.into_iter().next()?;
    let min_word_confidence = alternative
        .words
        .iter()
        .filter_map(|word| word.confidence)
        .map(|confidence| confidence.clamp(0.0, 1.0))
        .reduce(f32::min);
    Some(TranscriptUpdate {
        text: alternative.transcript,
        is_final: response.is_final.unwrap_or(false),
        confidence: alternative.confidence.unwrap_or(0.0).clamp(0.0, 1.0),
        min_word_confidence,
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
    let min_word_confidence = words
        .iter()
        .filter_map(|word| word.confidence)
        .map(|confidence| confidence.clamp(0.0, 1.0))
        .reduce(f32::min);
    Some(TranscriptUpdate {
        text: response.transcript.unwrap_or_default(),
        // AssemblyAI emits a formatted final turn. Ignore unformatted end-of-
        // turn snapshots so the common pipeline sees one final per turn.
        is_final: response.end_of_turn.unwrap_or(false)
            && response.turn_is_formatted.unwrap_or(true),
        confidence,
        min_word_confidence,
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
            r#"{"type":"Results","is_final":true,"channel":{"alternatives":[{"transcript":"John 3:16","confidence":0.97,"words":[{"confidence":0.88},{"confidence":0.97}]}]}}"#,
        ) else {
            panic!("expected a normalized transcript event");
        };
        assert_eq!(final_turn.text, "John 3:16");
        assert!(final_turn.is_final);
        assert!((final_turn.confidence - 0.97).abs() < f32::EPSILON);
        assert_eq!(final_turn.min_word_confidence, Some(0.88));

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
        assert_eq!(turn.min_word_confidence, Some(0.9));
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
    fn providers_use_the_managed_gateway_auth_and_shutdown_contracts() {
        for provider in [AsrProvider::Deepgram, AsrProvider::AssemblyAi] {
            let adapter = adapter_for(provider);
            let mut request = "wss://gateway.test/v1/asr/provider"
                .into_client_request()
                .unwrap();
            adapter
                .configure_gateway_request(&mut request, "short-lived-token")
                .unwrap();
            assert_eq!(
                request.headers()["Authorization"],
                "Bearer short-lived-token"
            );
            assert!(matches!(adapter.finish_message(), Some(Message::Text(_))));
        }
    }
}
