use anyhow::Context;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::Client;

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

fn pcm_to_wav(samples: &[f32]) -> Vec<u8> {
    let sample_rate: u32 = 16_000;
    let num_channels: u16 = 1;
    let bits_per_sample: u16 = 16;
    let num_samples = samples.len() as u32;
    let data_size = num_samples * (bits_per_sample as u32 / 8);
    let chunk_size = 36 + data_size;

    let mut wav = Vec::with_capacity(44 + data_size as usize);
    // RIFF header
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&chunk_size.to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    // fmt chunk
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // chunk size
    wav.extend_from_slice(&1u16.to_le_bytes());  // PCM format
    wav.extend_from_slice(&num_channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    let byte_rate = sample_rate * num_channels as u32 * bits_per_sample as u32 / 8;
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    let block_align = num_channels * bits_per_sample / 8;
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&bits_per_sample.to_le_bytes());
    // data chunk
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    for &s in samples {
        let i16_val = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        wav.extend_from_slice(&i16_val.to_le_bytes());
    }
    wav
}

fn pcm_to_raw_i16(samples: &[f32]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let i16_val = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        raw.extend_from_slice(&i16_val.to_le_bytes());
    }
    raw
}

// ---------------------------------------------------------------------------
// Provider functions
// ---------------------------------------------------------------------------

async fn transcribe_deepgram(samples: &[f32], api_key: &str, model: Option<&str>) -> anyhow::Result<String> {
    let wav = pcm_to_wav(samples);
    let model_str = model.unwrap_or("nova-2");
    let url = format!("https://api.deepgram.com/v1/listen?model={}&language=en", model_str);
    
    let client = Client::new();
    let resp = client
        .post(url)
        .header("Authorization", format!("Token {}", api_key))
        .header("Content-Type", "audio/wav")
        .body(wav)
        .send()
        .await
        .context("Deepgram request failed")?;

    let status = resp.status();
    let body: serde_json::Value = resp.json().await.context("Failed to parse Deepgram response")?;

    if !status.is_success() {
        anyhow::bail!("HTTP {}: {}", status, body);
    }

    let transcript = body["results"]["channels"][0]["alternatives"][0]["transcript"]
        .as_str()
        .unwrap_or("")
        .to_string();
    Ok(transcript)
}

async fn transcribe_openai(samples: &[f32], api_key: &str, model: Option<&str>) -> anyhow::Result<String> {
    let wav = pcm_to_wav(samples);
    let client = Client::new();

    let part = reqwest::multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model.unwrap_or("whisper-1").to_string());

    let resp = client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await
        .context("OpenAI request failed")?;

    let status = resp.status();
    let body: serde_json::Value = resp.json().await.context("Failed to parse OpenAI response")?;

    if !status.is_success() {
        anyhow::bail!("HTTP {}: {}", status, body);
    }
    Ok(body["text"].as_str().unwrap_or("").to_string())
}

async fn transcribe_assemblyai(samples: &[f32], api_key: &str, model: Option<&str>) -> anyhow::Result<String> {
    let wav = pcm_to_wav(samples);
    let client = Client::new();

    // Step 1: Upload WAV bytes
    let upload_resp = client
        .post("https://api.assemblyai.com/v2/upload")
        .header("Authorization", api_key)
        .header("Content-Type", "application/octet-stream")
        .body(wav)
        .send()
        .await
        .context("AssemblyAI upload failed")?;

    let upload_status = upload_resp.status();
    let upload_body: serde_json::Value = upload_resp
        .json()
        .await
        .context("Failed to parse AssemblyAI upload response")?;

    if !upload_status.is_success() {
        anyhow::bail!("HTTP {}: {}", upload_status, upload_body);
    }

    let audio_url = upload_body["upload_url"]
        .as_str()
        .context("No upload_url in AssemblyAI response")?
        .to_string();

    // Step 2: Submit transcription
    let mut payload = serde_json::json!({ "audio_url": audio_url });
    if let Some(m) = model {
        payload["speech_model"] = serde_json::json!(m);
        // Newer accounts or restricted keys may require speech_models as a list
        payload["speech_models"] = serde_json::json!([m]);
    }

    let submit_resp = client
        .post("https://api.assemblyai.com/v2/transcript")
        .header("Authorization", api_key)
        .json(&payload)
        .send()
        .await
        .context("AssemblyAI submit failed")?;

    let submit_status = submit_resp.status();
    let submit_body: serde_json::Value = submit_resp
        .json()
        .await
        .context("Failed to parse AssemblyAI submit response")?;

    if !submit_status.is_success() {
        anyhow::bail!("HTTP {}: {}", submit_status, submit_body);
    }

    let transcript_id = submit_body["id"]
        .as_str()
        .context("No id in AssemblyAI submit response")?
        .to_string();

    // Step 3: Poll until complete (max 30 s)
    let poll_url = format!("https://api.assemblyai.com/v2/transcript/{}", transcript_id);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);

    loop {
        if std::time::Instant::now() > deadline {
            anyhow::bail!("AssemblyAI timed out after 30s");
        }

        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        let poll_resp = client
            .get(&poll_url)
            .header("Authorization", api_key)
            .send()
            .await
            .context("AssemblyAI poll failed")?;

        let poll_body: serde_json::Value = poll_resp
            .json()
            .await
            .context("Failed to parse AssemblyAI poll response")?;

        let status = poll_body["status"].as_str().unwrap_or("");
        if status == "completed" {
            return Ok(poll_body["text"].as_str().unwrap_or("").to_string());
        } else if status == "error" {
            anyhow::bail!(
                "AssemblyAI error: {}",
                poll_body["error"].as_str().unwrap_or("unknown")
            );
        }
    }
}

async fn transcribe_google(samples: &[f32], api_key: &str, _model: Option<&str>) -> anyhow::Result<String> {
    let raw = pcm_to_raw_i16(samples);
    let encoded = BASE64.encode(&raw);

    let body = serde_json::json!({
        "config": {
            "encoding": "LINEAR16",
            "sampleRateHertz": 16000,
            "languageCode": "en-US",
        },
        "audio": {
            "content": encoded
        }
    });

    let client = Client::new();
    let resp = client
        .post(format!(
            "https://speech.googleapis.com/v1/speech:recognize?key={}",
            api_key
        ))
        .json(&body)
        .send()
        .await
        .context("Google STT request failed")?;

    let status = resp.status();
    let resp_body: serde_json::Value = resp
        .json()
        .await
        .context("Failed to parse Google STT response")?;

    if !status.is_success() {
        anyhow::bail!("HTTP {}: {}", status, resp_body);
    }

    let transcript = resp_body["results"][0]["alternatives"][0]["transcript"]
        .as_str()
        .unwrap_or("")
        .to_string();
    Ok(transcript)
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

pub async fn transcribe_cloud(
    samples: &[f32],
    provider: &str,
    api_key: &str,
    model: Option<&str>,
) -> anyhow::Result<String> {
    match provider {
        "deepgram" => transcribe_deepgram(samples, api_key, model).await,
        "openai" => transcribe_openai(samples, api_key, model).await,
        "assemblyai" => transcribe_assemblyai(samples, api_key, model).await,
        "google" => transcribe_google(samples, api_key, model).await,
        _ => anyhow::bail!("Unknown cloud provider: {}", provider),
    }
}

// ---------------------------------------------------------------------------
// Test helper — sends 1 s of silence; empty transcript is success
// ---------------------------------------------------------------------------

pub async fn test_connection(provider: &str, api_key: &str, model: Option<&str>) -> anyhow::Result<()> {
    let silence = vec![0.0f32; 16_000];
    transcribe_cloud(&silence, provider, api_key, model).await?;
    Ok(())
}
