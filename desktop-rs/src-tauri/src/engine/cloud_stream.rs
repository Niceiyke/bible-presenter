use anyhow::Context;
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::{connect_async_tls_with_config, tungstenite::Message};

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

fn log<S: Into<String>>(app: &AppHandle, msg: S) {
    let ts = unix_secs();
    let _ = app.emit("system-log", serde_json::json!({"level":"debug","message":msg.into(),"timestamp":ts}));
}
fn log_warn<S: Into<String>>(app: &AppHandle, msg: S) {
    let ts = unix_secs();
    let _ = app.emit("system-log", serde_json::json!({"level":"warn","message":msg.into(),"timestamp":ts}));
}
fn log_err<S: Into<String>>(app: &AppHandle, msg: S) {
    let ts = unix_secs();
    let _ = app.emit("system-log", serde_json::json!({"level":"error","message":msg.into(),"timestamp":ts}));
}
fn unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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
// Public dispatcher
// ---------------------------------------------------------------------------

pub fn provider_supports_streaming(provider: &str) -> bool {
    matches!(provider, "deepgram" | "assemblyai")
}

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
                transcript_tx,
            )
            .await?
        }
        p => anyhow::bail!("Provider '{}' does not support WebSocket streaming", p),
    };
    Ok((handle, transcript_rx))
}

// ---------------------------------------------------------------------------
// Reconnect helpers
// ---------------------------------------------------------------------------

/// Maximum number of audio chunks to hold in the unbounded channel.
/// Above this we start dropping oldest to prevent unbounded memory growth
/// during prolonged network outages.
const MAX_BUFFERED_AUDIO_CHUNKS: usize = 300; // ~300 × 320 bytes ≈ 96 KB

/// Exponential back-off delays (seconds) for reconnect attempts.
const BACKOFF_SECS: &[u64] = &[2, 4, 8, 16, 30, 60];

/// Returns whether a session ended due to a disconnect (true = reconnect) or a
/// clean shutdown (false = exit the connection manager loop).
enum SessionEnd {
    Reconnect(String), // reason string for logging
    Shutdown,
}

/// Waits `secs` seconds but wakes early if the shutdown signal fires.
/// Returns `true` if shutdown fired (caller should return), `false` if timer elapsed.
async fn sleep_or_shutdown(secs: u64, shutdown_tx: &broadcast::Sender<()>) -> bool {
    let mut rx = shutdown_tx.subscribe();
    tokio::select! {
        _ = tokio::time::sleep(std::time::Duration::from_secs(secs)) => false,
        _ = rx.recv() => true,
    }
}

// ---------------------------------------------------------------------------
// Deepgram streaming with auto-reconnect
// ---------------------------------------------------------------------------

async fn start_deepgram(
    app: &AppHandle,
    api_key: &str,
    hostname: &str,
    model: &str,
    language: &str,
    transcript_tx: mpsc::UnboundedSender<StreamTranscript>,
) -> anyhow::Result<CloudStreamHandle> {
    // Connect once upfront so start_stream can fail fast on bad credentials/network.
    let url = deepgram_url(hostname, model, language);
    let req = build_deepgram_request(&url, api_key)?;
    let (ws_stream, _) = connect_async_tls_with_config(req, None, false, None)
        .await
        .context("Failed to connect to Deepgram WebSocket")?;

    log(app, format!("[Deepgram] Connected → {}", url));

    let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (shutdown_tx, _) = broadcast::channel::<()>(4);

    let app2 = app.clone();
    let key = api_key.to_string();
    let host = hostname.to_string();
    let mdl = model.to_string();
    let lang = language.to_string();
    let sdtx = shutdown_tx.clone();

    tokio::spawn(async move {
        deepgram_manager(app2, key, host, mdl, lang, transcript_tx, audio_rx, sdtx, ws_stream).await;
    });

    Ok(CloudStreamHandle { audio_tx, shutdown_tx })
}

fn deepgram_url(hostname: &str, model: &str, language: &str) -> String {
    format!(
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
    )
}

fn build_deepgram_request(
    url: &str,
    api_key: &str,
) -> anyhow::Result<tokio_tungstenite::tungstenite::handshake::client::Request> {
    let mut req = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(url)
        .context("Invalid Deepgram URL")?;
    req.headers_mut().insert(
        "Authorization",
        format!("Token {}", api_key).parse().context("Invalid API key")?,
    );
    Ok(req)
}

type DgWs = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn deepgram_manager(
    app: AppHandle,
    api_key: String,
    hostname: String,
    model: String,
    language: String,
    transcript_tx: mpsc::UnboundedSender<StreamTranscript>,
    mut audio_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    shutdown_tx: broadcast::Sender<()>,
    initial_stream: DgWs,
) {
    let mut backoff_idx: usize = 0;
    let mut first_stream: Option<DgWs> = Some(initial_stream);

    loop {
        let mut shutdown_rx = shutdown_tx.subscribe();
        if shutdown_rx.try_recv().is_ok() { return; }

        // Use the pre-opened stream on the first iteration, reconnect fresh after that.
        let ws_stream = if let Some(s) = first_stream.take() {
            s
        } else {
            let url = deepgram_url(&hostname, &model, &language);
            match build_deepgram_request(&url, &api_key) {
                Err(e) => { log_err(&app, format!("[Deepgram] Bad request: {}", e)); return; }
                Ok(req) => match connect_async_tls_with_config(req, None, false, None).await {
                    Err(e) => {
                        let delay = BACKOFF_SECS[backoff_idx.min(BACKOFF_SECS.len() - 1)];
                        log_err(&app, format!("[Deepgram] Connection failed: {}. Retrying in {}s…", e, delay));
                        let _ = app.emit("audio-error", format!("Preacher stream disconnected. Reconnecting in {}s…", delay));
                        if sleep_or_shutdown(delay, &shutdown_tx).await { return; }
                        backoff_idx = (backoff_idx + 1).min(BACKOFF_SECS.len() - 1);
                        continue;
                    }
                    Ok((s, _)) => {
                        log(&app, "[Deepgram] Reconnected — resuming transcription");
                        // Drain audio buffered during the downtime so stale audio isn't burst-sent.
                        let mut drained = 0usize;
                        while audio_rx.try_recv().is_ok() { drained += 1; }
                        if drained > 0 {
                            log_warn(&app, format!("[Deepgram] Drained {} stale audio chunks from reconnect window", drained));
                        }
                        backoff_idx = 0;
                        s
                    }
                }
            }
        };

        match deepgram_run_session(&app, &transcript_tx, &mut audio_rx, &shutdown_tx, ws_stream).await {
            SessionEnd::Shutdown => return,
            SessionEnd::Reconnect(reason) => {
                let delay = BACKOFF_SECS[backoff_idx.min(BACKOFF_SECS.len() - 1)];
                log_warn(&app, format!("[Deepgram] Session ended: {}. Reconnecting in {}s…", reason, delay));
                let _ = app.emit("audio-error", format!("Stream disconnected: {}. Reconnecting…", reason));
                if sleep_or_shutdown(delay, &shutdown_tx).await { return; }
                backoff_idx = (backoff_idx + 1).min(BACKOFF_SECS.len() - 1);
            }
        }
    }
}

async fn deepgram_run_session(
    app: &AppHandle,
    transcript_tx: &mpsc::UnboundedSender<StreamTranscript>,
    audio_rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
    shutdown_tx: &broadcast::Sender<()>,
    ws_stream: DgWs,
) -> SessionEnd {
    let (mut sink, mut source) = ws_stream.split();
    let (disc_tx, mut disc_rx) = tokio::sync::oneshot::channel::<String>();

    // Receiver subtask: parse transcripts, signal disc_tx on any disconnect.
    let app_r = app.clone();
    let tx = transcript_tx.clone();
    tokio::spawn(async move {
        let mut chunk_count: u64 = 0;
        while let Some(msg) = source.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    chunk_count += 1;
                    if chunk_count % 500 == 0 {
                        log(&app_r, format!("[Deepgram] {} messages received", chunk_count));
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        parse_deepgram_message(&app_r, &v, &tx);
                    }
                }
                Ok(Message::Close(frame)) => {
                    let reason = frame.map(|f| f.reason.to_string()).unwrap_or_else(|| "server close".to_string());
                    let _ = disc_tx.send(reason);
                    return;
                }
                Err(e) => {
                    let _ = disc_tx.send(e.to_string());
                    return;
                }
                _ => {}
            }
        }
        // Source stream ended (provider closed connection without a Close frame)
        let _ = disc_tx.send("connection closed".to_string());
    });

    let mut shutdown_rx = shutdown_tx.subscribe();
    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(5));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut audio_chunk_count: u64 = 0;

    loop {
        // Drop oldest audio if the buffer is growing too large (e.g. slow network).
        while audio_rx.len() > MAX_BUFFERED_AUDIO_CHUNKS {
            let _ = audio_rx.try_recv();
        }

        tokio::select! {
            reason = &mut disc_rx => {
                return SessionEnd::Reconnect(reason.unwrap_or_else(|_| "receiver task exited".to_string()));
            }
            _ = shutdown_rx.recv() => {
                let _ = sink.send(Message::Text(r#"{"type":"CloseStream"}"#.to_string().into())).await;
                let _ = sink.close().await;
                return SessionEnd::Shutdown;
            }
            chunk = audio_rx.recv() => {
                match chunk {
                    None => return SessionEnd::Shutdown, // audio_tx dropped
                    Some(c) => {
                        audio_chunk_count += 1;
                        if audio_chunk_count % 500 == 0 {
                            log(app, format!("[Deepgram] Audio pump: {} chunks sent", audio_chunk_count));
                        }
                        if sink.send(Message::Binary(c.into())).await.is_err() {
                            return SessionEnd::Reconnect("audio send error".to_string());
                        }
                    }
                }
            }
            _ = keepalive.tick() => {
                if audio_rx.is_empty() {
                    if sink.send(Message::Text(r#"{"type":"KeepAlive"}"#.to_string().into())).await.is_err() {
                        return SessionEnd::Reconnect("keepalive send error".to_string());
                    }
                }
            }
        }
    }
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
                "[Deepgram] {} \"{}\" (conf={:.2})",
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
        log(app, format!("[Deepgram] Session request_id={}", v["request_id"].as_str().unwrap_or("?")));
    } else if msg_type == "SpeechStarted" {
        // noisy — log only at low frequency
    } else if !msg_type.is_empty() {
        log(app, format!("[Deepgram] Unknown message type: {}", msg_type));
    }
}

// ---------------------------------------------------------------------------
// AssemblyAI real-time streaming (v3 API) with auto-reconnect
// ---------------------------------------------------------------------------

async fn start_assemblyai(
    app: &AppHandle,
    api_key: &str,
    hostname: &str,
    model: Option<&str>,
    transcript_tx: mpsc::UnboundedSender<StreamTranscript>,
) -> anyhow::Result<CloudStreamHandle> {
    let speech_model = model.unwrap_or("universal-streaming-english");
    let url = assemblyai_url(hostname, speech_model);
    let req = build_assemblyai_request(&url, api_key)?;

    let (ws_stream, _) = connect_async_tls_with_config(req, None, false, None)
        .await
        .context("Failed to connect to AssemblyAI WebSocket")?;

    log(app, format!("[AssemblyAI] Connected → {}", url));

    let (audio_tx, audio_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (shutdown_tx, _) = broadcast::channel::<()>(4);

    let app2 = app.clone();
    let key = api_key.to_string();
    let host = hostname.to_string();
    let mdl = speech_model.to_string();
    let sdtx = shutdown_tx.clone();

    tokio::spawn(async move {
        assemblyai_manager(app2, key, host, mdl, transcript_tx, audio_rx, sdtx, ws_stream).await;
    });

    Ok(CloudStreamHandle { audio_tx, shutdown_tx })
}

fn assemblyai_url(hostname: &str, speech_model: &str) -> String {
    format!("wss://{}/v3/ws?sample_rate=16000&speech_model={}", hostname, speech_model)
}

fn build_assemblyai_request(
    url: &str,
    api_key: &str,
) -> anyhow::Result<tokio_tungstenite::tungstenite::handshake::client::Request> {
    let mut req = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(url)
        .context("Invalid AssemblyAI URL")?;
    req.headers_mut().insert(
        "Authorization",
        api_key.parse().context("Invalid AssemblyAI API key")?,
    );
    Ok(req)
}

type AaiWs = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn assemblyai_manager(
    app: AppHandle,
    api_key: String,
    hostname: String,
    model: String,
    transcript_tx: mpsc::UnboundedSender<StreamTranscript>,
    mut audio_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    shutdown_tx: broadcast::Sender<()>,
    initial_stream: AaiWs,
) {
    let mut backoff_idx: usize = 0;
    let mut first_stream: Option<AaiWs> = Some(initial_stream);

    loop {
        let mut shutdown_rx = shutdown_tx.subscribe();
        if shutdown_rx.try_recv().is_ok() { return; }

        let ws: Option<AaiWs> = if let Some(s) = first_stream.take() {
            Some(s)
        } else {
            let url = assemblyai_url(&hostname, &model);
            match build_assemblyai_request(&url, &api_key) {
                Err(e) => { log_err(&app, format!("[AssemblyAI] Bad request: {}", e)); return; }
                Ok(req) => {
                    match connect_async_tls_with_config(req, None, false, None).await {
                        Err(e) => {
                            let delay = BACKOFF_SECS[backoff_idx.min(BACKOFF_SECS.len() - 1)];
                            log_err(&app, format!("[AssemblyAI] Connection failed: {}. Retrying in {}s…", e, delay));
                            let _ = app.emit("audio-error", format!("Preacher stream disconnected. Reconnecting in {}s…", delay));
                            if sleep_or_shutdown(delay, &shutdown_tx).await { return; }
                            backoff_idx = (backoff_idx + 1).min(BACKOFF_SECS.len() - 1);
                            continue;
                        }
                        Ok((ws_stream, _)) => Some(ws_stream),
                    }
                }
            }
        };

        // SAFETY: all None paths above either `continue`, `return`, or produce Some(_).
        let ws_stream = ws.expect("ws is always Some here");

        if backoff_idx > 0 {
            log(&app, "[AssemblyAI] Reconnected — resuming transcription");
            let mut drained = 0usize;
            while audio_rx.try_recv().is_ok() { drained += 1; }
            if drained > 0 {
                log_warn(&app, format!("[AssemblyAI] Drained {} stale audio chunks", drained));
            }
        }
        backoff_idx = 0;

        match assemblyai_run_session(&app, &transcript_tx, &mut audio_rx, &shutdown_tx, ws_stream).await {
            SessionEnd::Shutdown => return,
            SessionEnd::Reconnect(reason) => {
                let delay = BACKOFF_SECS[backoff_idx.min(BACKOFF_SECS.len() - 1)];
                log_warn(&app, format!("[AssemblyAI] Session ended: {}. Reconnecting in {}s…", reason, delay));
                let _ = app.emit("audio-error", format!("Stream disconnected: {}. Reconnecting…", reason));
                if sleep_or_shutdown(delay, &shutdown_tx).await { return; }
                backoff_idx = (backoff_idx + 1).min(BACKOFF_SECS.len() - 1);
            }
        }
    }
}

async fn assemblyai_run_session(
    app: &AppHandle,
    transcript_tx: &mpsc::UnboundedSender<StreamTranscript>,
    audio_rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
    shutdown_tx: &broadcast::Sender<()>,
    ws_stream: AaiWs,
) -> SessionEnd {
    let (mut sink, mut source) = ws_stream.split();
    let (disc_tx, mut disc_rx) = tokio::sync::oneshot::channel::<String>();

    let app_r = app.clone();
    let tx = transcript_tx.clone();
    tokio::spawn(async move {
        while let Some(msg) = source.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        parse_assemblyai_message(&app_r, &v, &tx);
                    }
                }
                Ok(Message::Close(frame)) => {
                    let reason = frame.map(|f| f.reason.to_string()).unwrap_or_else(|| "server close".to_string());
                    let _ = disc_tx.send(reason);
                    return;
                }
                Err(e) => {
                    let _ = disc_tx.send(e.to_string());
                    return;
                }
                _ => {}
            }
        }
        let _ = disc_tx.send("connection closed".to_string());
    });

    let mut shutdown_rx = shutdown_tx.subscribe();
    // AssemblyAI needs a continuous audio stream — send silence every 300ms if no audio,
    // to keep the session alive during natural pauses. The main.rs pump also sends silence
    // every 500ms, so this is double-defence.
    let mut keepalive = tokio::time::interval(std::time::Duration::from_millis(300));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let silence_chunk = vec![0u8; 320]; // 10ms of 16kHz 16-bit silence
    let mut audio_chunk_count: u64 = 0;

    loop {
        while audio_rx.len() > MAX_BUFFERED_AUDIO_CHUNKS {
            let _ = audio_rx.try_recv();
        }

        tokio::select! {
            reason = &mut disc_rx => {
                return SessionEnd::Reconnect(reason.unwrap_or_else(|_| "receiver task exited".to_string()));
            }
            _ = shutdown_rx.recv() => {
                let _ = sink.send(Message::Text(r#"{"type":"Terminate"}"#.to_string().into())).await;
                let _ = sink.close().await;
                return SessionEnd::Shutdown;
            }
            chunk = audio_rx.recv() => {
                match chunk {
                    None => return SessionEnd::Shutdown,
                    Some(c) => {
                        audio_chunk_count += 1;
                        if audio_chunk_count % 500 == 0 {
                            log(app, format!("[AssemblyAI] Audio pump: {} chunks sent", audio_chunk_count));
                        }
                        if sink.send(Message::Binary(c.into())).await.is_err() {
                            return SessionEnd::Reconnect("audio send error".to_string());
                        }
                    }
                }
            }
            _ = keepalive.tick() => {
                // Only send silence keepalive if the audio channel has been quiet
                if audio_rx.is_empty() {
                    if sink.send(Message::Binary(silence_chunk.clone().into())).await.is_err() {
                        return SessionEnd::Reconnect("keepalive send error".to_string());
                    }
                }
            }
        }
    }
}

fn parse_assemblyai_message(
    app: &AppHandle,
    v: &serde_json::Value,
    tx: &mpsc::UnboundedSender<StreamTranscript>,
) {
    let msg_type = v["type"].as_str().unwrap_or("");
    match msg_type {
        "Begin" => {
            log(app, format!("[AssemblyAI] Session began — id={}", v["id"].as_str().unwrap_or("?")));
        }
        "Turn" => {
            let is_final   = v["end_of_turn"].as_bool().unwrap_or(false);
            let text       = v["transcript"].as_str().unwrap_or("").to_string();
            let confidence = v["end_of_turn_confidence"].as_f64().unwrap_or(0.8) as f32;
            let turn_order = v["turn_order"].as_u64().unwrap_or(0);
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
        "" => {}
        other => {
            log_warn(app, format!("[AssemblyAI] Unknown message type: {} — {}", other, v));
        }
    }
}
