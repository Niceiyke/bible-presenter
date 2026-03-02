use anyhow::Context;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::{connect_async_tls_with_config, tungstenite::Message};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A transcript event received from the cloud WebSocket.
#[derive(Debug, Clone)]
pub struct StreamTranscript {
    pub text: String,
    pub is_final: bool,
    pub confidence: f32,
}

/// Handle to a running cloud stream. Drop or call `stop()` to close the connection.
pub struct CloudStreamHandle {
    /// Send raw PCM i16 LE byte chunks here (from the audio pipeline).
    pub audio_tx: mpsc::UnboundedSender<Vec<u8>>,
    shutdown_tx: broadcast::Sender<()>,
}

impl CloudStreamHandle {
    pub fn stop(&self) {
        let _ = self.shutdown_tx.send(());
    }
}

// ---------------------------------------------------------------------------
// Public dispatcher — routes to the right provider
// ---------------------------------------------------------------------------

/// Returns `true` for providers that have a streaming WebSocket API.
/// `false` means the caller should fall back to batch REST (cloud.rs).
pub fn provider_supports_streaming(provider: &str) -> bool {
    matches!(provider, "deepgram" | "assemblyai")
}

/// Open a cloud WebSocket stream. Returns a `CloudStreamHandle` whose
/// `audio_tx` the audio pipeline writes PCM i16 LE chunks into, and
/// a `transcript_rx` the processing loop reads `StreamTranscript` events from.
pub async fn start_stream(
    provider: &str,
    api_key: &str,
    hostname: Option<&str>,
    model: Option<&str>,
    language: Option<&str>,
) -> anyhow::Result<(CloudStreamHandle, mpsc::UnboundedReceiver<StreamTranscript>)> {
    let (transcript_tx, transcript_rx) = mpsc::unbounded_channel::<StreamTranscript>();
    let handle = match provider {
        "deepgram" => {
            start_deepgram(
                api_key,
                hostname.unwrap_or("api.deepgram.com"),
                model.unwrap_or("nova-2"),
                language.unwrap_or("en"),
                transcript_tx,
            )
            .await?
        }
        "assemblyai" => {
            start_assemblyai(
                api_key,
                hostname.unwrap_or("api.assemblyai.com"),
                transcript_tx,
            )
            .await?
        }
        p => anyhow::bail!("Provider '{}' does not support WebSocket streaming", p),
    };
    Ok((handle, transcript_rx))
}

// ---------------------------------------------------------------------------
// Deepgram streaming
// ---------------------------------------------------------------------------

async fn start_deepgram(
    api_key: &str,
    hostname: &str,
    model: &str,
    language: &str,
    transcript_tx: mpsc::UnboundedSender<StreamTranscript>,
) -> anyhow::Result<CloudStreamHandle> {
    let url = format!(
        "wss://{}/v1/listen\
         ?encoding=linear16\
         &sample_rate=16000\
         &channels=1\
         &model={}\
         &language={}\
         &interim_results=true\
         &utterance_end_ms=1000\
         &vad_events=true",
        hostname, model, language
    );

    let mut request = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
        url.as_str(),
    )
    .context("Failed to build Deepgram WS request")?;
    request.headers_mut().insert(
        "Authorization",
        format!("Token {}", api_key)
            .parse()
            .context("Invalid API key for header")?,
    );

    let (ws_stream, _) = connect_async_tls_with_config(request, None, false, None)
        .await
        .context("Failed to connect to Deepgram WebSocket")?;

    let (mut ws_sink, mut ws_source) = ws_stream.split();

    let (audio_tx, mut audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (shutdown_tx, mut shutdown_rx) = broadcast::channel::<()>(4);
    let mut shutdown_rx2 = shutdown_tx.subscribe();

    // ── Sender task: PCM chunks → WS binary frames ───────────────────────
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    // Send the graceful close signal to Deepgram
                    let _ = ws_sink
                        .send(Message::Text(r#"{"type":"CloseStream"}"#.to_string()))
                        .await;
                    let _ = ws_sink.close().await;
                    break;
                }
                Some(chunk) = audio_rx.recv() => {
                    if ws_sink.send(Message::Binary(chunk)).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // ── Receiver task: WS messages → StreamTranscript events ─────────────
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx2.recv() => break,
                msg = ws_source.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(v) =
                                serde_json::from_str::<serde_json::Value>(&text)
                            {
                                parse_deepgram_message(&v, &transcript_tx);
                            }
                        }
                        // Connection closed or error — exit gracefully
                        None | Some(Err(_)) => break,
                        _ => {}
                    }
                }
            }
        }
    });

    Ok(CloudStreamHandle { audio_tx, shutdown_tx })
}

fn parse_deepgram_message(
    v: &serde_json::Value,
    tx: &mpsc::UnboundedSender<StreamTranscript>,
) {
    let msg_type = v["type"].as_str().unwrap_or("");

    if msg_type == "Results" {
        // `is_final` = segment is complete; `speech_final` = utterance boundary.
        // We emit on `speech_final` for verse detection and on every `is_final=false`
        // for the live text display.
        let is_final = v["is_final"].as_bool().unwrap_or(false)
            || v["speech_final"].as_bool().unwrap_or(false);

        let transcript = v["channel"]["alternatives"][0]["transcript"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let confidence = v["channel"]["alternatives"][0]["confidence"]
            .as_f64()
            .unwrap_or(0.0) as f32;

        if !transcript.is_empty() {
            let _ = tx.send(StreamTranscript {
                text: transcript,
                is_final,
                confidence,
            });
        }
    }
    // UtteranceEnd event — emit an empty final so the frontend can flush
    // any partial text that might be sitting unconfirmed.
    else if msg_type == "UtteranceEnd" {
        let _ = tx.send(StreamTranscript {
            text: String::new(),
            is_final: true,
            confidence: 0.0,
        });
    }
}

// ---------------------------------------------------------------------------
// AssemblyAI real-time streaming
// ---------------------------------------------------------------------------

async fn start_assemblyai(
    api_key: &str,
    hostname: &str,
    transcript_tx: mpsc::UnboundedSender<StreamTranscript>,
) -> anyhow::Result<CloudStreamHandle> {
    let url = format!("wss://{}/v2/realtime/ws?sample_rate=16000", hostname);

    let (ws_stream, _) = connect_async_tls_with_config(url.as_str(), None, false, None)
        .await
        .context("Failed to connect to AssemblyAI WebSocket")?;

    let (mut ws_sink, mut ws_source) = ws_stream.split();

    // AssemblyAI real-time authentication: send token as first JSON message
    ws_sink
        .send(Message::Text(
            serde_json::json!({ "token": api_key }).to_string(),
        ))
        .await
        .context("Failed to send AssemblyAI auth token")?;

    let (audio_tx, mut audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (shutdown_tx, mut shutdown_rx) = broadcast::channel::<()>(4);
    let mut shutdown_rx2 = shutdown_tx.subscribe();

    // ── Sender task: PCM chunks → base64-encoded JSON ────────────────────
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    let _ = ws_sink
                        .send(Message::Text(
                            r#"{"terminate_session":true}"#.to_string(),
                        ))
                        .await;
                    let _ = ws_sink.close().await;
                    break;
                }
                Some(chunk) = audio_rx.recv() => {
                    let encoded = BASE64.encode(&chunk);
                    let msg = serde_json::json!({ "audio_data": encoded }).to_string();
                    if ws_sink.send(Message::Text(msg)).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // ── Receiver task ─────────────────────────────────────────────────────
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx2.recv() => break,
                msg = ws_source.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(v) =
                                serde_json::from_str::<serde_json::Value>(&text)
                            {
                                parse_assemblyai_message(&v, &transcript_tx);
                            }
                        }
                        None | Some(Err(_)) => break,
                        _ => {}
                    }
                }
            }
        }
    });

    Ok(CloudStreamHandle { audio_tx, shutdown_tx })
}

fn parse_assemblyai_message(
    v: &serde_json::Value,
    tx: &mpsc::UnboundedSender<StreamTranscript>,
) {
    let msg_type = v["message_type"].as_str().unwrap_or("");

    if msg_type == "FinalTranscript" || msg_type == "PartialTranscript" {
        let is_final = msg_type == "FinalTranscript";
        let text = v["text"].as_str().unwrap_or("").to_string();
        let confidence = v["confidence"].as_f64().unwrap_or(0.0) as f32;

        if !text.is_empty() {
            let _ = tx.send(StreamTranscript {
                text,
                is_final,
                confidence,
            });
        }
    }
}
