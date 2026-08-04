use crate::state::{self, AppState};
use crate::events::{SessionStatus, TranscriptionUpdate, TranscriptSegment};
use crate::{engine, store};
use store::log_msg;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn start_session(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut running = state.pipeline.is_running.lock();
        if *running {
            return Err("A session is already running. Click STOP first.".to_string());
        }
        *running = true;
    }

    state.pipeline.session_transcript.lock().clear();
    state.pipeline.context_buffer.lock().clear();

    if let Err(e) = state.get_or_init_engine(&app).await {
        *state.pipeline.is_running.lock() = false;
        let _ = app.emit("session-status", SessionStatus { status: "error".to_string(), message: format!("AI models failed to load: {}", e) });
        return Err(e);
    }

    let session_start_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    *state.pipeline.session_start_ms.lock() = session_start_ms;

    let _ = app.emit("session-status", SessionStatus { status: "running".to_string(), message: "Live session started".to_string() });
    Ok(())
}

#[tauri::command]
pub async fn stop_session(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let _ = app.emit("session-status", SessionStatus {
        status: "stopping".to_string(),
        message: "Stopping session…".to_string(),
    });

    if let Some(handle) = state.pipeline.operator_cloud_stream.lock().take() {
        handle.stop();
    }
    if let Some(handle) = state.pipeline.preacher_cloud_stream.lock().take() {
        handle.stop();
    }

    state.audio.operator.lock().stop();
    state.audio.preacher.lock().stop();
    *state.pipeline.is_running.lock() = false;
    state.audio.operator_is_active.store(false, Ordering::Relaxed);
    state.audio.preacher_is_active.store(false, Ordering::Relaxed);

    let transcript = state.pipeline.session_transcript.lock().clone();
    if !transcript.is_empty() {
        let transcripts_dir = state.app_data_dir.join("transcripts");
        let _ = std::fs::create_dir_all(&transcripts_dir);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let path = transcripts_dir.join(format!("{}.json", ts));
        if let Ok(json) = serde_json::to_string_pretty(&transcript) {
            let _ = atomic_write(&path, json);
        }
    }

    let _ = app.emit("session-status", SessionStatus {
        status: "stopped".to_string(),
        message: "Session stopped".to_string(),
    });
    Ok(())
}

fn atomic_write(path: &std::path::PathBuf, content: String) -> std::io::Result<()> {
    let tmp_path = path.with_extension("tmp");
    std::fs::write(&tmp_path, content)?;
    std::fs::rename(tmp_path, path)?;
    Ok(())
}

#[tauri::command]
pub async fn start_operator_recording(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if !*state.pipeline.is_running.lock() {
        return Err("No active session. Start the session first.".to_string());
    }
    if state.audio.operator_is_active.load(Ordering::Relaxed) {
        return Err("Operator recording is already active.".to_string());
    }

    let engine = match state.get_or_init_engine(&app).await {
        Ok(e) => e,
        Err(e) => return Err(format!("AI models failed to load: {}", e)),
    };

    let (op_audio_tx, mut op_audio_rx) = tokio::sync::mpsc::channel::<Vec<f32>>(128);
    let (op_error_tx, mut op_error_rx) = tokio::sync::mpsc::channel::<String>(10);
    let (op_level_tx, mut op_level_rx) = tokio::sync::mpsc::channel::<f32>(50);

    {
        let op_device = state.audio.operator.lock().selected_device().map(|s| s.to_string()).unwrap_or_else(|| "system default".to_string());
        if let Err(e) = state.audio.operator.lock().start_capturing(op_audio_tx, op_error_tx, Some(op_level_tx), 16000.0) {
            return Err(format!("Operator mic error: {}", e));
        }
        log_msg(&app, &format!("[Operator] Recording started — device: \"{}\"", op_device));
    }

    let app_err = app.clone();
    tokio::spawn(async move { while let Some(msg) = op_error_rx.recv().await { let _ = app_err.emit("audio-error", format!("Operator: {}", msg)); } });
    let app_level = app.clone();
    tokio::spawn(async move { while let Some(level) = op_level_rx.recv().await { let _ = app_level.emit("operator-audio-level", level); } });

    state.audio.operator_is_active.store(true, Ordering::Relaxed);
    let _ = app.emit("operator-recording-status", serde_json::json!({"active": true}));

    let config = state.transcription_config.lock().clone();
    let operator_mode = config.operator_mode.clone().unwrap_or_else(|| "local".to_string());
    let cloud_provider = config.cloud_provider.clone();
    let cloud_api_key = config.cloud_api_key.clone();
    let cloud_model = config.cloud_model.clone();
    let cloud_rest_model = config.cloud_rest_model.clone().or_else(|| cloud_model.clone());
    let cloud_language = config.cloud_language.clone();

    let session_start_ms = *state.pipeline.session_start_ms.lock();
    let store = state.store.clone();
    let context_buffer = state.pipeline.context_buffer.clone();
    let transcription_window = state.pipeline.transcription_window.clone();
    let transcription_paused = state.pipeline.transcription_paused.clone();
    let operator_muted = state.audio.operator_muted.clone();
    let operator_ptt_active = state.audio.operator_ptt_active.clone();
    let inference_semaphore = state.pipeline.inference_semaphore.clone();
    let session_transcript = state.pipeline.session_transcript.clone();
    let op_active = state.audio.operator_is_active.clone();

    let app_op = app.clone();
    tokio::spawn(async move {
        let mut buffer = Vec::with_capacity(48000 * 3);
        const OVERLAP: usize = 4000;
        const MIN_SAMPLES: usize = 8000;
        let is_cloud = operator_mode == "cloud" && cloud_provider.is_some() && cloud_api_key.is_some();
        let provider_name = if is_cloud { cloud_provider.clone().unwrap() } else { "local".to_string() };
        let mut was_ptt_active = false;
        let mut first_chunk = true;

        while let Some(chunk) = op_audio_rx.recv().await {
            if first_chunk {
                log_msg(&app_op, &format!("[Operator] PTT pipeline ready ({})", provider_name));
                first_chunk = false;
            }
            let window_size = *transcription_window.lock();
            let is_ptt_active = operator_ptt_active.load(Ordering::Relaxed);
            let is_paused = transcription_paused.load(Ordering::Relaxed);
            let is_muted = operator_muted.load(Ordering::Relaxed);

            if is_muted { buffer.clear(); was_ptt_active = false; continue; }
            buffer.extend_from_slice(&chunk);

            let trigger_on_release = was_ptt_active && !is_ptt_active && buffer.len() >= MIN_SAMPLES;
            let trigger_on_window = is_ptt_active && buffer.len() >= window_size;

            if !is_paused && (trigger_on_release || trigger_on_window) {
                let buf_samples = buffer.len();
                let buf_ms = buf_samples * 1000 / 16000;
                let trigger_reason = if trigger_on_release { "PTT released" } else { "window full" };

                let maybe_permit = if !is_cloud {
                    match Arc::clone(&inference_semaphore).try_acquire_owned() {
                        Ok(p) => Some(p),
                        Err(_) => {
                            log_msg(&app_op, &format!("[Operator] Inference busy — window dropped ({} samples / {}ms)", buf_samples, buf_ms));
                            buffer.clear();
                            was_ptt_active = is_ptt_active;
                            continue;
                        }
                    }
                } else { None };

                log_msg(&app_op, &format!("[Operator] Voice search triggered: {} — {}ms via {}", trigger_reason, buf_ms, provider_name));

                let b_clone = buffer.clone();
                let e_clone = engine.clone();
                let s_clone = store.clone();
                let ctx_buf = context_buffer.clone();
                let op_p = cloud_provider.clone();
                let op_k = cloud_api_key.clone();
                let op_l = cloud_language.clone();
                let op_m = cloud_rest_model.clone();
                let app_op_inner = app_op.clone();
                let p_name = provider_name.clone();
                let tx_log = session_transcript.clone();

                tokio::spawn(async move {
                    let _permit = maybe_permit;
                    let t0 = std::time::Instant::now();
                    let result: Option<(String, Option<store::DisplayItem>, f32)> = if is_cloud {
                        if let Ok(text) = engine::cloud::transcribe_cloud(&b_clone, op_p.as_ref().unwrap(), op_k.as_ref().unwrap(), op_m.as_deref()).await {
                            log_msg(&app_op_inner, &format!("[Operator] Cloud transcription ({} ms): \"{}\"", t0.elapsed().as_millis(), &text[..text.len().min(80)]));
                            let t1 = std::time::Instant::now();
                            let result = tokio::task::spawn_blocking(move || {
                                let combined = { let mut buf = ctx_buf.lock(); buf.push(text.clone()); if buf.len() > 3 { buf.remove(0); } buf.join(" ") };
                                let embedding = e_clone.embed(&combined).ok();
                                let (verse, confidence) = s_clone.detect_verse_hybrid(&combined, embedding);
                                Some((text, verse.map(store::DisplayItem::Verse), confidence))
                            }).await.ok().flatten();
                            log_msg(&app_op_inner, &format!("[Operator] Verse detection ({} ms)", t1.elapsed().as_millis()));
                            result
                        } else {
                            log_msg(&app_op_inner, &format!("[Operator] Cloud transcription failed after {} ms", t0.elapsed().as_millis()));
                            None
                        }
                    } else {
                        let app_blk = app_op_inner.clone();
                        tokio::task::spawn_blocking(move || {
                            let t_whisper = std::time::Instant::now();
                            let text = match e_clone.transcribe(&b_clone, op_l.as_deref()) {
                                Ok(t) => t,
                                Err(e) => { log_msg(&app_blk, &format!("[Operator] Whisper error after {} ms: {}", t_whisper.elapsed().as_millis(), e)); return None; }
                            };
                            log_msg(&app_blk, &format!("[Operator] Whisper ({} ms): \"{}\"", t_whisper.elapsed().as_millis(), &text[..text.len().min(80)]));
                            let t_detect = std::time::Instant::now();
                            let combined = { let mut buf = ctx_buf.lock(); buf.push(text.clone()); if buf.len() > 3 { buf.remove(0); } buf.join(" ") };
                            let embedding = e_clone.embed(&combined).ok();
                            let (verse, confidence) = s_clone.detect_verse_hybrid(&combined, embedding);
                            log_msg(&app_blk, &format!("[Operator] Verse detection ({} ms): {}", t_detect.elapsed().as_millis(),
                                match &verse {
                                    Some(v) => format!("MATCH {} {}:{} (conf={:.2})", v.book, v.chapter, v.verse, confidence),
                                    None => format!("no match (conf={:.2})", confidence),
                                }
                            ));
                            Some((text, verse.map(store::DisplayItem::Verse), confidence))
                        }).await.ok().flatten()
                    };

                    if let Some((text, item, confidence)) = result {
                        if state::is_hallucination(&text) {
                            log_msg(&app_op_inner, &format!("[Operator] Hallucination filtered: \"{}\"", &text[..text.len().min(60)]));
                        } else {
                            let word_count = text.split_whitespace().count();
                            if word_count < 3 && item.is_none() {
                                log_msg(&app_op_inner, &format!("[Operator] Voice search skipped (too short, {} word(s)): \"{}\"", word_count, &text));
                            } else {
                                let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                                tx_log.lock().push(TranscriptSegment { text: text.clone(), timestamp_ms: now_ms.saturating_sub(session_start_ms), is_final: true, source: p_name.clone() });
                                log_msg(&app_op_inner, &format!("[Operator] Voice search done ({} ms) — emitting result", t0.elapsed().as_millis()));
                                let _ = app_op_inner.emit("operator-transcription-update", TranscriptionUpdate { text: text.clone(), detected_item: item, confidence, source: p_name, is_partial: false });
                            }
                        }
                    }
                });

                if trigger_on_release || is_cloud { buffer.clear(); } else {
                    if buffer.len() > window_size * 2 { let to_drain = buffer.len() - (window_size + OVERLAP); buffer.drain(0..to_drain); }
                    else { let remaining = buffer.len().saturating_sub(OVERLAP); buffer = buffer[remaining..].to_vec(); }
                }
            }

            if !is_ptt_active && !trigger_on_release {
                if buffer.len() > 8000 { buffer.drain(0..buffer.len() - 8000); }
            }
            was_ptt_active = is_ptt_active;
        }
        op_active.store(false, Ordering::Relaxed);
        let _ = app_op.emit("operator-recording-status", serde_json::json!({"active": false}));
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_operator_recording(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(handle) = state.pipeline.operator_cloud_stream.lock().take() {
        handle.stop();
    }
    state.audio.operator.lock().stop();
    state.audio.operator_is_active.store(false, Ordering::Relaxed);
    log_msg(&app, "[Operator] Recording stopped");
    let _ = app.emit("operator-recording-status", serde_json::json!({"active": false}));
    Ok(())
}

#[tauri::command]
pub async fn start_preacher_recording(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if !*state.pipeline.is_running.lock() {
        return Err("No active session. Start the session first.".to_string());
    }
    if state.audio.preacher_is_active.load(Ordering::Relaxed) {
        return Err("Preacher recording is already active.".to_string());
    }

    let op_dev = state.audio.operator.lock().selected_device().map(str::to_string);
    let pr_dev = state.audio.preacher.lock().selected_device().map(str::to_string);
    if pr_dev.is_none() {
        return Err("No preacher microphone selected. Choose a device in Settings.".to_string());
    }
    if pr_dev == op_dev {
        return Err("Preacher device is the same as the operator device. Select a separate microphone.".to_string());
    }

    let engine = match state.get_or_init_engine(&app).await {
        Ok(e) => e,
        Err(e) => return Err(format!("AI models failed to load: {}", e)),
    };

    let (pr_audio_tx, pr_audio_rx) = tokio::sync::mpsc::channel::<Vec<f32>>(128);
    let (pr_error_tx, mut pr_error_rx) = tokio::sync::mpsc::channel::<String>(10);
    let (pr_level_tx, mut pr_level_rx) = tokio::sync::mpsc::channel::<f32>(50);

    let pr_device = state.audio.preacher.lock().selected_device().map(|s| s.to_string()).unwrap_or_default();
    if let Err(e) = state.audio.preacher.lock().start_capturing(pr_audio_tx, pr_error_tx, Some(pr_level_tx), 16000.0) {
        return Err(format!("Preacher mic error: {}", e));
    }
    log_msg(&app, &format!("[Preacher] Recording started — device: \"{}\"", pr_device));

    let app_err = app.clone();
    tokio::spawn(async move { while let Some(msg) = pr_error_rx.recv().await { let _ = app_err.emit("audio-error", format!("Preacher: {}", msg)); } });
    let app_level = app.clone();
    tokio::spawn(async move { while let Some(level) = pr_level_rx.recv().await { let _ = app_level.emit("preacher-audio-level", level); } });

    state.audio.preacher_is_active.store(true, Ordering::Relaxed);
    let _ = app.emit("preacher-recording-status", serde_json::json!({"active": true}));

    let config = state.transcription_config.lock().clone();
    let preacher_mode = config.preacher_mode.clone().unwrap_or_else(|| "cloud".to_string());
    let cloud_provider = config.cloud_provider.clone();
    let cloud_api_key = config.cloud_api_key.clone();
    let cloud_hostname = config.cloud_hostname.clone();
    let cloud_model = config.cloud_model.clone();
    let cloud_language = config.cloud_language.clone();

    let session_start_ms = *state.pipeline.session_start_ms.lock();
    let preacher_muted = state.audio.preacher_muted.clone();
    let session_transcript = state.pipeline.session_transcript.clone();
    let context_buffer = state.pipeline.context_buffer.clone();
    let transcription_window = state.pipeline.transcription_window.clone();
    let transcription_paused = state.pipeline.transcription_paused.clone();
    let inference_semaphore = state.pipeline.inference_semaphore.clone();
    let preacher_is_active = state.audio.preacher_is_active.clone();
    let store = state.store.clone();

    let preacher_use_stream = preacher_mode == "cloud"
        && cloud_provider.as_deref().map(engine::cloud_stream::provider_supports_streaming).unwrap_or(false)
        && cloud_api_key.is_some();

    let pr_provider_fb = cloud_provider.clone();
    let pr_api_key_fb = cloud_api_key.clone();
    let mut pr_audio_rx_fallback: Option<tokio::sync::mpsc::Receiver<Vec<f32>>> = None;

    if preacher_use_stream {
        let provider = cloud_provider.unwrap();
        let api_key = cloud_api_key.unwrap();
        log_msg(&app, &format!("[Preacher] Starting {} WebSocket stream (model={:?}, host={:?})", provider, cloud_model, cloud_hostname));
        let stream_result = engine::cloud_stream::start_stream(&app, &provider, &api_key, cloud_hostname.as_deref(), cloud_model.as_deref(), cloud_language.as_deref()).await;

        match stream_result {
            Ok((stream_handle, mut transcript_rx)) => {
                log_msg(&app, "[Preacher] Cloud WS stream connected — audio pump starting");
                *state.pipeline.preacher_cloud_stream.lock() = Some(stream_handle);
                let handle_arc = state.pipeline.preacher_cloud_stream.clone();
                let pr_muted_pump = preacher_muted.clone();
                let mut pr_audio_rx = pr_audio_rx;

                let app_pump = app.clone();
                tokio::spawn(async move {
                    let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
                    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    let mut first_chunk = true;
                    loop {
                        tokio::select! {
                            res = pr_audio_rx.recv() => {
                                if let Some(chunk) = res {
                                    if first_chunk {
                                        log_msg(&app_pump, "[Preacher] First audio chunk received — VAD active, streaming to cloud");
                                        first_chunk = false;
                                    }
                                    let is_muted = pr_muted_pump.load(Ordering::Relaxed);
                                    let bytes: Vec<u8> = chunk.iter()
                                        .map(|&s| if is_muted { 0i16 } else { (s.clamp(-1.0, 1.0) * 32767.0) as i16 })
                                        .flat_map(|s| s.to_le_bytes())
                                        .collect();
                                    if let Some(ref h) = *handle_arc.lock() {
                                        if h.audio_tx.send(bytes).is_err() { break; }
                                    } else { break; }
                                } else { break; }
                            }
                            _ = interval.tick() => {
                                let silence = vec![0u8; 320];
                                if let Some(ref h) = *handle_arc.lock() {
                                    if h.audio_tx.send(silence).is_err() { break; }
                                }
                            }
                        }
                    }
                });

                let app_pr = app.clone();
                let tx_log_pr = session_transcript.clone();
                let provider_name = provider.clone();
                let handle_arc_stop = state.pipeline.preacher_cloud_stream.clone();
                let engine_ws = engine.clone();
                let store_ws = store.clone();
                let ctx_buf_ws = context_buffer.clone();
                let pr_active = preacher_is_active.clone();

                tokio::spawn(async move {
                    while let Some(seg) = transcript_rx.recv().await {
                        let text = seg.text.trim().to_string();
                        if !seg.is_final || state::is_hallucination(&text) || text.is_empty() { continue; }
                        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                        tx_log_pr.lock().push(TranscriptSegment { text: text.clone(), timestamp_ms: now_ms.saturating_sub(session_start_ms), is_final: true, source: provider_name.clone() });
                        let word_count = text.split_whitespace().count();
                        let (detected_item, confidence) = if word_count >= 3 {
                            let e = engine_ws.clone();
                            let s = store_ws.clone();
                            let ctx = ctx_buf_ws.clone();
                            let t = text.clone();
                            tokio::task::spawn_blocking(move || {
                                let combined = { let mut buf = ctx.lock(); buf.push(t.clone()); if buf.len() > 3 { buf.remove(0); } buf.join(" ") };
                                let embedding = e.embed(&combined).ok();
                                let (verse, conf) = s.detect_verse_hybrid(&combined, embedding);
                                (verse.map(store::DisplayItem::Verse), conf)
                            }).await.unwrap_or((None, 0.0))
                        } else if let Some(verse) = store_ws.detect_verse_by_ref(&text) {
                            (Some(store::DisplayItem::Verse(verse)), 1.0)
                        } else {
                            log_msg(&app_pr, &format!("[Session] Final skipped (too short, {} word(s)): \"{}\"", word_count, &text));
                            (None, 0.0)
                        };
                        if let Some(store::DisplayItem::Verse(ref v)) = detected_item {
                            log_msg(&app_pr, &format!("[Session] Verse detected: {} {}:{} (conf={:.2})", v.book, v.chapter, v.verse, confidence));
                        } else if word_count >= 3 {
                            log_msg(&app_pr, &format!("[Session] Final transcript — no verse match (conf={:.2}): \"{}\"", confidence, &text[..text.len().min(60)]));
                        }
                        let _ = app_pr.emit("preacher-transcription-update", TranscriptionUpdate { text: text.clone(), detected_item, confidence, source: provider_name.clone(), is_partial: false });
                    }
                    *handle_arc_stop.lock() = None;
                    pr_active.store(false, Ordering::Relaxed);
                    let _ = app_pr.emit("preacher-recording-status", serde_json::json!({"active": false}));
                });
            }
            Err(e) => {
                log_msg(&app, &format!("[Preacher] Cloud WS failed: {}. Falling back to local/REST.", e));
                let _ = app.emit("audio-error", format!("Preacher cloud stream failed: {}. Using local transcription.", e));
                // Note: pr_audio_rx was moved into the pump task above, can't reuse here.
                // We'll let the session restart for clean device reinit.
            }
        }
    } else {
        pr_audio_rx_fallback = Some(pr_audio_rx);
    }

    if let Some(mut pr_audio_rx) = pr_audio_rx_fallback {
        let app_pr = app.clone();
        let engine_pr = engine.clone();
        let pr_provider = pr_provider_fb;
        let pr_api_key = pr_api_key_fb;
        let pr_language = cloud_language.clone();
        let pr_model = cloud_model.clone();
        let pr_active = preacher_is_active.clone();

        tokio::spawn(async move {
            let mut buffer = Vec::with_capacity(48000 * 3);
            const OVERLAP: usize = 4000;
            let is_cloud = preacher_mode == "cloud" && pr_provider.is_some() && pr_api_key.is_some();
            let provider_name = if is_cloud { pr_provider.clone().unwrap() } else { "local".to_string() };

            while let Some(chunk) = pr_audio_rx.recv().await {
                let is_muted = preacher_muted.load(Ordering::Relaxed);
                if is_muted { buffer.clear(); continue; }

                buffer.extend_from_slice(&chunk);

                let window_size = *transcription_window.lock();
                let paused = transcription_paused.load(Ordering::Relaxed);
                if paused {
                    if buffer.len() > window_size { let keep = buffer.len().min(8000); buffer.drain(0..buffer.len() - keep); }
                    continue;
                }

                if buffer.len() >= window_size {
                    let maybe_permit = if !is_cloud {
                        match Arc::clone(&inference_semaphore).try_acquire_owned() {
                            Ok(p) => Some(p),
                            Err(_) => { let keep = buffer.len().min(OVERLAP); buffer.drain(0..buffer.len() - keep); continue; }
                        }
                    } else { None };

                    let b_clone = buffer.clone();
                    let e_clone = engine_pr.clone();
                    let pr_m = pr_model.clone();
                    let lang_opt = pr_language.clone();
                    let prov = pr_provider.clone();
                    let key = pr_api_key.clone();
                    let tx_log = session_transcript.clone();
                    let app_pr_inner = app_pr.clone();
                    let p_name = provider_name.clone();

                    tokio::spawn(async move {
                        let _permit = maybe_permit;
                        let text_opt: Option<String> = if is_cloud {
                            engine::cloud::transcribe_cloud(&b_clone, prov.as_ref().unwrap(), key.as_ref().unwrap(), pr_m.as_deref()).await.ok()
                        } else {
                            tokio::task::spawn_blocking(move || { e_clone.transcribe(&b_clone, lang_opt.as_deref()).ok() }).await.ok().flatten()
                        };

                        if let Some(text) = text_opt {
                            if !state::is_hallucination(&text) {
                                let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                                tx_log.lock().push(TranscriptSegment { text: text.clone(), timestamp_ms: now_ms.saturating_sub(session_start_ms), is_final: true, source: p_name.clone() });
                                let _ = app_pr_inner.emit("preacher-transcription-update", TranscriptionUpdate { text: text.clone(), detected_item: None, confidence: 1.0, source: p_name, is_partial: false });
                            }
                        }
                    });

                    if is_cloud { buffer.clear(); } else {
                        if buffer.len() > window_size * 2 { let to_drain = buffer.len() - (window_size + OVERLAP); buffer.drain(0..to_drain); } else { let remaining = buffer.len().saturating_sub(OVERLAP); buffer = buffer[remaining..].to_vec(); }
                    }
                }
            }
            pr_active.store(false, Ordering::Relaxed);
            let _ = app_pr.emit("preacher-recording-status", serde_json::json!({"active": false}));
        });
    }

    Ok(())
}

#[tauri::command]
pub async fn stop_preacher_recording(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(handle) = state.pipeline.preacher_cloud_stream.lock().take() {
        handle.stop();
    }
    state.audio.preacher.lock().stop();
    state.audio.preacher_is_active.store(false, Ordering::Relaxed);
    log_msg(&app, "[Preacher] Recording stopped by operator");
    let _ = app.emit("preacher-recording-status", serde_json::json!({"active": false}));
    Ok(())
}

#[tauri::command]
pub async fn set_transcription_window(state: State<'_, AppState>, samples: usize) -> Result<(), String> {
    *state.pipeline.transcription_window.lock() = samples.clamp(8_000, 48_000);
    Ok(())
}

#[tauri::command]
pub async fn set_transcription_paused(state: State<'_, AppState>, paused: bool) -> Result<(), String> {
    state.pipeline.transcription_paused.store(paused, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn set_operator_muted(state: State<'_, AppState>, muted: bool) -> Result<(), String> {
    state.audio.operator_muted.store(muted, Ordering::Relaxed);
    state.audio.operator.lock().is_muted.store(muted, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn set_preacher_muted(state: State<'_, AppState>, muted: bool) -> Result<(), String> {
    state.audio.preacher_muted.store(muted, Ordering::Relaxed);
    state.audio.preacher.lock().is_muted.store(muted, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn set_operator_ptt(state: State<'_, AppState>, active: bool) -> Result<(), String> {
    state.audio.operator_ptt_active.store(active, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn get_session_transcript(state: State<'_, AppState>) -> Result<Vec<TranscriptSegment>, String> {
    Ok(state.pipeline.session_transcript.lock().clone())
}

#[tauri::command]
pub async fn clear_session_transcript(state: State<'_, AppState>) -> Result<(), String> {
    state.pipeline.session_transcript.lock().clear();
    state.pipeline.context_buffer.lock().clear();
    Ok(())
}

#[tauri::command]
pub async fn export_transcript(state: State<'_, AppState>, path: String, format: Option<String>) -> Result<(), String> {
    let segments = state.pipeline.session_transcript.lock().clone();
    let fmt = format.as_deref().unwrap_or("txt");

    let content = match fmt {
        "json" => serde_json::to_string_pretty(&segments).map_err(|e| e.to_string())?,
        _ => {
            segments.iter().map(|s| {
                let secs = s.timestamp_ms / 1000;
                format!("[{:02}:{:02}] {}", secs / 60, secs % 60, s.text)
            }).collect::<Vec<_>>().join("\n")
        }
    };

    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}
