use crate::state::AppState;
use crate::{engine, store};
use store::log_msg;
use std::sync::atomic::Ordering;
use serde::Serialize;
use std::path::PathBuf;
use std::fs;
use tauri::{AppHandle, Emitter, State};
use rubato::Resampler;

#[derive(Serialize)]
pub struct StudioRecording {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size_mb: f32,
    pub date: String,
    pub duration: String,
    pub transcribed: bool,
}

#[derive(Serialize)]
pub struct RecordingPeaks {
    pub peaks: Vec<f32>,
    pub duration: f32,
}

#[tauri::command]
pub async fn get_recording_peaks(state: State<'_, AppState>, id: String, n_peaks: Option<usize>) -> Result<RecordingPeaks, String> {
    let path = state.app_data_dir.join("recordings").join(format!("{}.wav", id));
    tauri::async_runtime::spawn_blocking(move || {
        let reader = hound::WavReader::open(&path).map_err(|e| e.to_string())?;
        let spec = reader.spec();
        let total_samples = reader.duration() as usize;
        let duration = total_samples as f32 / spec.sample_rate as f32;

        let n = n_peaks.unwrap_or(1000).clamp(100, 8000);
        let window = (total_samples / n).max(1);

        let all_samples: Vec<f32> = reader
            .into_samples::<i16>()
            .filter_map(|s| s.ok())
            .map(|s| s as f32 / i16::MAX as f32)
            .collect();

        let peaks: Vec<f32> = all_samples
            .chunks(window)
            .map(|chunk| chunk.iter().map(|s| s.abs()).fold(0.0f32, f32::max))
            .collect();

        Ok(RecordingPeaks { peaks, duration })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_studio_recordings(state: State<'_, AppState>) -> Result<Vec<StudioRecording>, String> {
    let recordings_dir = state.app_data_dir.join("recordings");
    if !recordings_dir.exists() {
        fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?;
        return Ok(vec![]);
    }

    let mut list = Vec::new();
    let entries = fs::read_dir(recordings_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.is_file() && path.extension().map_or(false, |ext| ext == "wav") {
                let metadata = entry.metadata().map_err(|e| e.to_string())?;
                let id = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                let name = id.clone();
                let size_bytes = metadata.len();
                let size_mb = size_bytes as f32 / 1024.0 / 1024.0;
                let date = metadata.modified().map(|m| {
                    chrono::DateTime::<chrono::Local>::from(m).format("%Y-%m-%d %H:%M").to_string()
                }).unwrap_or_default();

                let duration = hound::WavReader::open(&path).map(|r| {
                    let secs = r.duration() / r.spec().sample_rate;
                    format!("{}:{:02}", secs / 60, secs % 60)
                }).unwrap_or_else(|_| {
                    let secs = size_bytes / (16000 * 2);
                    format!("{}:{:02}", secs / 60, secs % 60)
                });

                let transcribed = state.app_data_dir.join("recordings").join(format!("{}.txt", id)).exists();

                list.push(StudioRecording { id, name, path: path.to_string_lossy().to_string(), size_mb, date, duration, transcribed });
            }
        }
    }

    list.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(list)
}

#[tauri::command]
pub async fn set_studio_device(state: State<'_, AppState>, device_name: String) -> Result<(), String> {
    let mut audio = state.audio.studio.lock();
    audio.select_device(&device_name).map_err(|e| e.to_string())?;
    if state.audio.studio_is_active.load(Ordering::Relaxed) {
        audio.hot_swap_device(&device_name).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_studio_recording(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let path = state.app_data_dir.join("recordings").join(format!("{}.wav", id));
    if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
    let txt_path = state.app_data_dir.join("recordings").join(format!("{}.txt", id));
    if txt_path.exists() { let _ = fs::remove_file(txt_path); }
    Ok(())
}

#[tauri::command]
pub async fn rename_studio_recording(state: State<'_, AppState>, id: String, new_name: String) -> Result<(), String> {
    let clean_name = if new_name.to_lowercase().ends_with(".wav") { &new_name[..new_name.len() - 4] } else { &new_name };
    if clean_name.contains('/') || clean_name.contains('\\') || clean_name.contains("..") {
        return Err("Invalid recording name".to_string());
    }

    let old_path = state.app_data_dir.join("recordings").join(format!("{}.wav", id));
    let new_path = state.app_data_dir.join("recordings").join(format!("{}.wav", clean_name));
    if old_path.exists() { fs::rename(old_path, new_path).map_err(|e| e.to_string())?; }
    let old_txt = state.app_data_dir.join("recordings").join(format!("{}.txt", id));
    let new_txt = state.app_data_dir.join("recordings").join(format!("{}.txt", clean_name));
    if old_txt.exists() { let _ = fs::rename(old_txt, new_txt); }
    Ok(())
}

#[tauri::command]
pub async fn get_studio_recording_transcript(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let txt_path = state.app_data_dir.join("recordings").join(format!("{}.txt", id));
    if txt_path.exists() { fs::read_to_string(txt_path).map_err(|e| e.to_string()) } else { Ok("".to_string()) }
}

#[tauri::command]
pub async fn save_studio_recording_transcript(state: State<'_, AppState>, id: String, text: String) -> Result<(), String> {
    let txt_path = state.app_data_dir.join("recordings").join(format!("{}.txt", id));
    fs::write(txt_path, text).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn transcribe_studio_recording(app: AppHandle, state: State<'_, AppState>, id: String, mode: Option<String>) -> Result<String, String> {
    let path = state.app_data_dir.join("recordings").join(format!("{}.wav", id));
    if !path.exists() { return Err("Recording not found".to_string()); }

    let config = state.transcription_config.lock().clone();
    let selected_mode = mode.unwrap_or_else(|| "local".to_string());

    let mut reader = hound::WavReader::open(&path).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => reader.samples::<i16>().map(|s| s.unwrap_or(0) as f32 / i16::MAX as f32).collect(),
        hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap_or(0.0)).collect(),
    };

    if samples.is_empty() { return Err("Audio file is empty".to_string()); }

    let _ = app.emit("studio-transcription-status", serde_json::json!({"id": id, "status": "processing"}));

    let result = if selected_mode == "cloud" {
        let provider = config.cloud_provider.clone().ok_or("No cloud provider configured in Settings")?;
        let api_key = config.cloud_api_key.clone().ok_or("No cloud API key configured")?;
        let model = config.cloud_rest_model.clone().or(config.cloud_model.clone());
        engine::cloud::transcribe_cloud(&samples, &provider, &api_key, model.as_deref()).await
            .map_err(|e| format!("Cloud transcription failed: {}", e))?
    } else {
        let engine = state.get_or_init_engine(&app).await?;
        tauri::async_runtime::spawn_blocking(move || { engine.transcribe(&samples, None) })
            .await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?
    };

    let txt_path = state.app_data_dir.join("recordings").join(format!("{}.txt", id));
    fs::write(txt_path, &result).map_err(|e| e.to_string())?;

    let _ = app.emit("studio-transcription-status", serde_json::json!({"id": id, "status": "complete", "text": result.clone()}));
    Ok(result)
}

#[tauri::command]
pub async fn trim_studio_recording(
    state: State<'_, AppState>,
    id: String,
    start_sec: f32,
    end_sec: f32,
    new_id: Option<String>,
    fade_in_sec: Option<f32>,
    fade_out_sec: Option<f32>,
) -> Result<(), String> {
    let path = state.app_data_dir.join("recordings").join(format!("{}.wav", id));
    if !path.exists() { return Err("Recording not found".to_string()); }

    let target_id = new_id.unwrap_or_else(|| id.clone());
    let target_path = state.app_data_dir.join("recordings").join(format!("{}.wav", target_id));

    tauri::async_runtime::spawn_blocking(move || {
        let mut reader = hound::WavReader::open(&path).map_err(|e| e.to_string())?;
        let spec = reader.spec();
        let sample_rate = spec.sample_rate as f32;
        let channels = spec.channels as usize;

        let start_sample = (start_sec * sample_rate) as u32 * channels as u32;
        let end_sample = (end_sec * sample_rate) as u32 * channels as u32;

        let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap_or(0)).collect();
        drop(reader);

        if start_sample >= end_sample || end_sample as usize > samples.len() {
            return Err("Invalid trim range".to_string());
        }

        let mut faded: Vec<f32> = samples[start_sample as usize..end_sample as usize]
            .iter().map(|&s| s as f32 / 32768.0).collect();

        if let Some(fi) = fade_in_sec {
            if fi > 0.0 {
                let fi_frames = ((fi * sample_rate).round() as usize * channels).min(faded.len());
                for i in 0..fi_frames { faded[i] *= i as f32 / fi_frames as f32; }
            }
        }

        if let Some(fo) = fade_out_sec {
            if fo > 0.0 {
                let fo_frames = ((fo * sample_rate).round() as usize * channels).min(faded.len());
                let start_idx = faded.len().saturating_sub(fo_frames);
                for i in 0..fo_frames { faded[start_idx + i] *= 1.0 - (i as f32 / fo_frames as f32); }
            }
        }

        let mut writer = hound::WavWriter::create(&target_path, spec).map_err(|e| e.to_string())?;
        for s in faded {
            let sample = (s * 32767.0).clamp(-32768.0, 32767.0) as i16;
            writer.write_sample(sample).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn start_studio_recording(app: AppHandle, state: State<'_, AppState>, sample_rate: Option<u32>) -> Result<(), String> {
    if state.audio.studio_is_active.load(Ordering::Relaxed) {
        return Err("Recording already in progress".to_string());
    }
    let sample_rate = sample_rate.unwrap_or(44100).clamp(8000, 192000);

    let recordings_dir = state.app_data_dir.join("recordings");
    if !recordings_dir.exists() { fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?; }

    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    let filename = format!("rec_{}.wav", timestamp);
    let path = recordings_dir.join(&filename);

    let (audio_tx, mut audio_rx) = tokio::sync::mpsc::channel::<Vec<f32>>(100);
    let (error_tx, mut error_rx) = tokio::sync::mpsc::channel::<String>(10);
    let (level_tx, mut level_rx) = tokio::sync::mpsc::channel::<f32>(50);

    state.audio.studio_is_active.store(true, Ordering::Relaxed);
    let is_active = state.audio.studio_is_active.clone();

    {
        let mut audio = state.audio.studio.lock();
        audio.start_capturing(audio_tx, error_tx, Some(level_tx), sample_rate as f64).map_err(|e| e.to_string())?;
    }

    let path_clone = path.clone();
    tauri::async_runtime::spawn(async move {
        let stem = path_clone.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let spec = hound::WavSpec { channels: 1, sample_rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut writer = match hound::WavWriter::create(path_clone, spec) {
            Ok(w) => w,
            Err(e) => { log_msg(&app, &format!("Failed to create WavWriter: {}", e)); is_active.store(false, Ordering::Relaxed); return; }
        };

        while is_active.load(Ordering::Relaxed) {
            tokio::select! {
                res = audio_rx.recv() => {
                    if let Some(samples) = res {
                        for s in samples {
                            let sample = (s * std::i16::MAX as f32).clamp(-32768.0, 32767.0) as i16;
                            if let Err(e) = writer.write_sample(sample) {
                                log_msg(&app, &format!("Failed to write sample: {}", e));
                                is_active.store(false, Ordering::Relaxed);
                                break;
                            }
                        }
                    } else { break; }
                }
                res = level_rx.recv() => {
                    if let Some(level) = res { let _ = app.emit("studio-audio-level", level); } else { break; }
                }
                res = error_rx.recv() => {
                    if let Some(err) = res { let _ = app.emit("studio-audio-error", err); } else { break; }
                }
            }
        }
        let _ = writer.finalize();
        let _ = app.emit("studio-recording-saved", stem);
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_studio_recording(state: State<'_, AppState>) -> Result<(), String> {
    state.audio.studio_is_active.store(false, Ordering::Relaxed);
    state.audio.studio.lock().stop();
    Ok(())
}

#[tauri::command]
pub async fn import_studio_audio(app: AppHandle, state: State<'_, AppState>, path: String, sample_rate: Option<u32>) -> Result<(), String> {
    let source_path = PathBuf::from(path);
    if !source_path.exists() { return Err("File not found".to_string()); }

    let recordings_dir = state.app_data_dir.join("recordings");
    if !recordings_dir.exists() { fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?; }

    let stem = source_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let target_filename = format!("{}_imported.wav", stem);
    let target_path = recordings_dir.join(target_filename);
    let sample_rate = sample_rate.unwrap_or(44100).clamp(8000, 192000);

    tauri::async_runtime::spawn_blocking(move || {
        let res = (|| -> Result<(), String> {
            log_msg(&app, &format!("[Studio] Importing audio from: {:?}", source_path));
            let file = fs::File::open(&source_path).map_err(|e| e.to_string())?;
            use symphonia::core::io::MediaSourceStream;
            use symphonia::core::probe::Hint;
            use symphonia::core::formats::FormatOptions;
            use symphonia::core::meta::MetadataOptions;
            use symphonia::core::codecs::DecoderOptions;

            let mss = MediaSourceStream::new(Box::new(file), Default::default());
            let mut hint = Hint::new();
            if let Some(ext) = source_path.extension().and_then(|s| s.to_str()) { hint.with_extension(ext); }

            let probed = symphonia::default::get_probe().format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
                .map_err(|e| e.to_string())?;

            let mut format = probed.format;
            let track = format.tracks().iter().find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
                .ok_or_else(|| "No supported audio track found".to_string())?;

            let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())
                .map_err(|e| e.to_string())?;

            let track_id = track.id;
            let source_rate = track.codec_params.sample_rate.unwrap_or(44100) as f64;
            let source_channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(2);
            let target_rate = sample_rate as f64;

            let spec = hound::WavSpec { channels: 1, sample_rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
            let mut writer = hound::WavWriter::create(target_path, spec).map_err(|e| e.to_string())?;

            let mut resampler = if (source_rate - target_rate).abs() > 0.1 {
                use rubato::{SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
                let params = SincInterpolationParameters { sinc_len: 256, f_cutoff: 0.95, interpolation: SincInterpolationType::Linear, window: WindowFunction::BlackmanHarris2, oversampling_factor: 256 };
                Some(SincFixedIn::<f32>::new(target_rate / source_rate, 2.0, params, 1024, source_channels).map_err(|e| e.to_string())?)
            } else { None };

            let mut sample_buf = None;
            loop {
                let packet = match format.next_packet() {
                    Ok(p) => p,
                    Err(symphonia::core::errors::Error::IoError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                    Err(e) => return Err(e.to_string()),
                };
                if packet.track_id() != track_id { continue; }
                let decoded = decoder.decode(&packet).map_err(|e| e.to_string())?;
                if sample_buf.is_none() {
                    let spec = *decoded.spec();
                    let duration = decoded.capacity() as u64;
                    sample_buf = Some(symphonia::core::audio::SampleBuffer::<f32>::new(duration, spec));
                }
                if let Some(buf) = sample_buf.as_mut() {
                    buf.copy_interleaved_ref(decoded);
                    let samples = buf.samples();
                    let mut planar = vec![vec![0.0f32; samples.len() / source_channels]; source_channels];
                    for (i, &s) in samples.iter().enumerate() { planar[i % source_channels][i / source_channels] = s; }

                    let mono_samples = if let Some(ref mut rs) = resampler {
                        let output = rs.process(&planar, None).map_err(|e: rubato::ResampleError| e.to_string())?;
                        let mut mono = vec![0.0f32; output[0].len()];
                        for chan_data in output { for (i, s) in chan_data.iter().enumerate() { mono[i] += *s; } }
                        for s in &mut mono { *s /= source_channels as f32; }
                        mono
                    } else {
                        let mut mono = vec![0.0f32; planar[0].len()];
                        for chan_data in planar { for (i, s) in chan_data.iter().enumerate() { mono[i] += *s; } }
                        for s in &mut mono { *s /= source_channels as f32; }
                        mono
                    };
                    for s in mono_samples {
                        let sample = (s * std::i16::MAX as f32).clamp(-32768.0, 32767.0) as i16;
                        writer.write_sample(sample).map_err(|e| e.to_string())?;
                    }
                }
            }
            writer.finalize().map_err(|e| e.to_string())?;
            log_msg(&app, "[Studio] Import complete.");
            Ok(())
        })();
        match res {
            Ok(_) => { let _ = app.emit("studio-import-complete", stem); }
            Err(e) => { let _ = app.emit("studio-import-error", e); }
        }
    });

    Ok(())
}
