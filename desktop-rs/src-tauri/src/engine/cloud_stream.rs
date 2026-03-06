use anyhow::Context;
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::{connect_async_tls_with_config, tungstenite::Message};

// ---------------------------------------------------------------------------
// Logging helper — emits to the UI LogViewer as "debug" level
// ---------------------------------------------------------------------------

fn log<S: Into<String>>(app: &AppHandle, msg: S) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let _ = app.emit("system-log", serde_json::json!({
        "level": "debug",
        "message": msg.into(),
        "timestamp": timestamp,
    }));
}

fn log_err<S: Into<String>>(app: &AppHandle, msg: S) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let _ = app.emit("system-log", serde_json::json!({
        "level": "error",
        "message": msg.into(),
        "timestamp": timestamp,
    }));
}

fn log_warn<S: Into<String>>(app: &AppHandle, msg: S) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let _ = app.emit("system-log", serde_json::json!({
        "level": "warn",
        "message": msg.into(),
        "timestamp": timestamp,
    }));
}

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
pub fn provider_supports_streaming(provider: &str) -> bool {
    matches!(provider, "deepgram" | "assemblyai")
}

/// Open a cloud WebSocket stream.
pub async fn start_stream(
    app: &AppHandle,
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
                app,
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
                app,
                api_key,
                hostname.unwrap_or("streaming.assemblyai.com"),
                model,
                language,
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
    app: &AppHandle,
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

    log(app, format!("[Deepgram] Connecting → {}", url));

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

    log(app, "[Deepgram] WebSocket connected");

    let (mut ws_sink, mut ws_source) = ws_stream.split();

    let (audio_tx, mut audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (shutdown_tx, mut shutdown_rx) = broadcast::channel::<()>(4);
    let mut shutdown_rx2 = shutdown_tx.subscribe();

    let app_sender = app.clone();
    let app_recv   = app.clone();

    // ── Sender task ───────────────────────────────────────────────────────
    tokio::spawn(async move {
        let mut chunk_count: u64 = 0;
        let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(5));
        keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        log(&app_sender, "[Deepgram] Audio pump started (16 kHz mono PCM → binary WS frames)");
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    log(&app_sender, "[Deepgram] Sending CloseStream and shutting down");
                    let _ = ws_sink
                        .send(Message::Text(r#"{"type":"CloseStream"}"#.to_string().into()))
                        .await;
                    let _ = ws_sink.close().await;
                    break;
                }
                Some(chunk) = audio_rx.recv() => {
                    chunk_count += 1;
                    if chunk_count % 50 == 0 {
                        log(&app_sender, format!("[Deepgram] Audio pump: {} chunks sent", chunk_count));
                    }
                    if ws_sink.send(Message::Binary(chunk.into())).await.is_err() {
                        log_err(&app_sender, "[Deepgram] Audio send error — connection dropped");
                        break;
                    }
                }
                _ = keepalive.tick() => {
                    if audio_rx.is_empty() {
                        log(&app_sender, "[Deepgram] Sending KeepAlive (silence detected)");
                        let _ = ws_sink
                            .send(Message::Text(r#"{"type":"KeepAlive"}"#.to_string().into()))
                            .await;
                    }
                }
            }
        }
    });

    // ── Receiver task ─────────────────────────────────────────────────────
    tokio::spawn(async move {
        log(&app_recv, "[Deepgram] Transcript listener started");
        loop {
            tokio::select! {
                _ = shutdown_rx2.recv() => {
                    log(&app_recv, "[Deepgram] Transcript listener shutting down");
                    break;
                }
                msg = ws_source.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                                parse_deepgram_message(&app_recv, &v, &transcript_tx);
                            } else {
                                log_warn(&app_recv, format!("[Deepgram] Non-JSON message: {}", &text[..text.len().min(120)]));
                            }
                        }
                        Some(Err(e)) => {
                            log_err(&app_recv, format!("[Deepgram] WS error: {}", e));
                            break;
                        }
                        None => {
                            log(&app_recv, "[Deepgram] Server closed the connection");
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
    });

    Ok(CloudStreamHandle { audio_tx, shutdown_tx })
}

fn parse_deepgram_message(
    app: &AppHandle,
    v: &serde_json::Value,
    tx: &mpsc::UnboundedSender<StreamTranscript>,
) {
    let msg_type = v["type"].as_str().unwrap_or("");

    if msg_type == "Results" {
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
            log(app, format!(
                "[Deepgram] {} transcript: \"{}\" (conf={:.2})",
                if is_final { "FINAL" } else { "partial" },
                &transcript[..transcript.len().min(80)],
                confidence
            ));
            let _ = tx.send(StreamTranscript { text: transcript, is_final, confidence });
        }
    } else if msg_type == "UtteranceEnd" {
        log(app, "[Deepgram] UtteranceEnd — flushing partial");
        let _ = tx.send(StreamTranscript { text: String::new(), is_final: true, confidence: 0.0 });
    } else if msg_type == "Metadata" {
        log(app, format!("[Deepgram] Metadata: request_id={}", v["request_id"].as_str().unwrap_or("?")));
    } else if msg_type == "SpeechStarted" {
        log(app, "[Deepgram] Speech started (VAD)");
    } else if !msg_type.is_empty() {
        log(app, format!("[Deepgram] Unknown message type: {}", msg_type));
    }
}

// ---------------------------------------------------------------------------
// AssemblyAI real-time streaming (v3 API)
// ---------------------------------------------------------------------------

async fn start_assemblyai(
    app: &AppHandle,
    api_key: &str,
    hostname: &str,
    model: Option<&str>,
    _language: Option<&str>,
    transcript_tx: mpsc::UnboundedSender<StreamTranscript>,
) -> anyhow::Result<CloudStreamHandle> {
    let speech_model = model.unwrap_or("universal-streaming-english");
    let url = format!(
        "wss://{}/v3/ws?sample_rate=16000&speech_model={}",
        hostname, speech_model
    );

    log(app, format!("[AssemblyAI] Connecting → {} (model={})", url, speech_model));

    let mut request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
            url.as_str(),
        )
        .context("Failed to build AssemblyAI WS request")?;

    // v3 auth: Authorization header with raw API key (no prefix)
    request.headers_mut().insert(
        "Authorization",
        api_key
            .parse()
            .context("Invalid AssemblyAI API key for header")?,
    );
    log(app, "[AssemblyAI] Authorization header set (raw key, no prefix)");

    let (ws_stream, _) = connect_async_tls_with_config(request, None, false, None)
        .await
        .context("Failed to connect to AssemblyAI WebSocket")?;

    log(app, "[AssemblyAI] WebSocket connected — waiting for Begin message");

    let (mut ws_sink, mut ws_source) = ws_stream.split();

    let (audio_tx, mut audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (shutdown_tx, mut shutdown_rx) = broadcast::channel::<()>(4);
    let mut shutdown_rx2 = shutdown_tx.subscribe();

    let app_sender = app.clone();
    let app_recv   = app.clone();

    // ── Sender task ───────────────────────────────────────────────────────
    tokio::spawn(async move {
        let mut chunk_count: u64 = 0;
        log(&app_sender, "[AssemblyAI] Audio pump started (16 kHz mono PCM → binary WS frames)");
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    log(&app_sender, "[AssemblyAI] Sending Terminate and shutting down");
                    let _ = ws_sink
                        .send(Message::Text(r#"{"type":"Terminate"}"#.to_string().into()))
                        .await;
                    let _ = ws_sink.close().await;
                    break;
                }
                Some(chunk) = audio_rx.recv() => {
                    chunk_count += 1;
                    if chunk_count % 50 == 0 {
                        log(&app_sender, format!("[AssemblyAI] Audio pump: {} chunks sent", chunk_count));
                    }
                    if ws_sink.send(Message::Binary(chunk.into())).await.is_err() {
                        log_err(&app_sender, "[AssemblyAI] Audio send error — connection dropped");
                        break;
                    }
                }
            }
        }
    });

    // ── Receiver task ─────────────────────────────────────────────────────
    tokio::spawn(async move {
        log(&app_recv, "[AssemblyAI] Transcript listener started");
        loop {
            tokio::select! {
                _ = shutdown_rx2.recv() => {
                    log(&app_recv, "[AssemblyAI] Transcript listener shutting down");
                    break;
                }
                msg = ws_source.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                                parse_assemblyai_message(&app_recv, &v, &transcript_tx);
                            } else {
                                log_warn(&app_recv, format!("[AssemblyAI] Non-JSON: {}", &text[..text.len().min(120)]));
                            }
                        }
                        Some(Err(e)) => {
                            log_err(&app_recv, format!("[AssemblyAI] WS error: {}", e));
                            break;
                        }
                        None => {
                            log(&app_recv, "[AssemblyAI] Server closed the connection");
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
    });

    Ok(CloudStreamHandle { audio_tx, shutdown_tx })
}

fn parse_assemblyai_message(
    app: &AppHandle,
    v: &serde_json::Value,
    tx: &mpsc::UnboundedSender<StreamTranscript>,
) {
    let msg_type = v["type"].as_str().unwrap_or("");

    match msg_type {
        "Begin" => {
            log(app, format!(
                "[AssemblyAI] Session began — id={}",
                v["id"].as_str().unwrap_or("?")
            ));
        }
        "Turn" => {
            let is_final    = v["end_of_turn"].as_bool().unwrap_or(false);
            let text        = v["transcript"].as_str().unwrap_or("").to_string();
            let confidence  = v["end_of_turn_confidence"].as_f64().unwrap_or(0.8) as f32;
            let turn_order  = v["turn_order"].as_u64().unwrap_or(0);

            if !text.is_empty() {
                log(app, format!(
                    "[AssemblyAI] {} turn #{}: \"{}\" (eot_conf={:.2})",
                    if is_final { "FINAL" } else { "partial" },
                    turn_order,
                    &text[..text.len().min(80)],
                    confidence
                ));
                let _ = tx.send(StreamTranscript { text, is_final, confidence });
            }
        }
        "Termination" => {
            log(app, format!(
                "[AssemblyAI] Session terminated — audio={:.1}s session={:.1}s",
                v["audio_duration_seconds"].as_f64().unwrap_or(0.0),
                v["session_duration_seconds"].as_f64().unwrap_or(0.0),
            ));
        }
        "" => {} // ignore empty type
        other => {
            log_warn(app, format!("[AssemblyAI] Unknown message type: {} — {}", other, v));
        }
    }
}
