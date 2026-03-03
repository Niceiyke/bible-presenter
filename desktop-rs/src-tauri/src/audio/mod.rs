use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::HeapRb;
use ringbuf::traits::Producer;
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use webrtc_vad::{Vad, VadMode};

/// A thread-safe wrapper for cpal::Stream.
///
/// SAFETY: cpal::Stream on Windows is !Send/!Sync because it contains raw pointers (WASAPI handles).
/// However, we manage access via Mutex<AudioEngine> in AppState, ensuring synchronized access.
/// Dropping this handle from a different thread than creation can theoretically cause a crash
/// on some WASAPI drivers, but in practice, CPAL handles this internal cleanup.
#[allow(dead_code)] // field kept alive intentionally — dropping cpal::Stream stops audio
struct StreamHandle(cpal::Stream);
unsafe impl Send for StreamHandle {}
unsafe impl Sync for StreamHandle {}

/// Wrapper to make Vad Send. 
/// SAFETY: Vad is only accessed from within the audio callback thread.
struct SendVad(Vad);
unsafe impl Send for SendVad {}
unsafe impl Sync for SendVad {}

impl SendVad {
    fn is_voice_segment(&mut self, chunk: &[i16]) -> anyhow::Result<bool> {
        self.0.is_voice_segment(chunk).map_err(|e| anyhow::anyhow!("{:?}", e))
    }
}

pub type AudioRb = HeapRb<f32>;

pub struct AudioEngine {
    stream: Option<Arc<StreamHandle>>,
    selected_device_name: Option<String>,
    active_tx: Option<mpsc::Sender<()>>,
    active_error_tx: Option<mpsc::Sender<String>>,
    active_level_tx: Option<mpsc::Sender<f32>>,
    vad_threshold: f32,
    pub media_playing: Arc<AtomicBool>,
}

impl AudioEngine {
    pub fn new() -> Self {
        Self {
            stream: None,
            selected_device_name: None,
            active_tx: None,
            active_error_tx: None,
            active_level_tx: None,
            vad_threshold: 0.002,
            media_playing: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_vad_threshold(&mut self, threshold: f32) {
        self.vad_threshold = threshold;
    }

    pub fn list_devices(&self) -> anyhow::Result<Vec<(String, String)>> {
        let host = cpal::default_host();
        let devices = host.input_devices()?;
        let mut list = Vec::new();
        for device in devices {
            if let Ok(name) = device.name() {
                list.push((name.clone(), name));
            }
        }
        Ok(list)
    }

    pub fn select_device(&mut self, device_name: &str) -> anyhow::Result<()> {
        self.selected_device_name = Some(device_name.to_string());
        Ok(())
    }

    pub fn start_capturing(
        &mut self,
        tx: mpsc::Sender<()>,
        prod: impl Producer<Item = f32> + Send + 'static,
        error_tx: mpsc::Sender<String>,
        level_tx: Option<mpsc::Sender<f32>>,
    ) -> anyhow::Result<()> {
        // Stop any existing stream before starting a new one (prevents double-stream)
        self.stop();
        self.active_tx = Some(tx.clone());
        self.active_error_tx = Some(error_tx.clone());
        self.active_level_tx = level_tx.clone();

        let host = cpal::default_host();

        let device = if let Some(ref name) = self.selected_device_name {
            let mut devices = host.input_devices()?;
            devices
                .find(|d| d.name().map(|n| n == *name).unwrap_or(false))
                .ok_or_else(|| anyhow::anyhow!(
                    "Microphone '{}' not found. Reconnect it or choose a different device in Settings → Audio Device, then start the session again.",
                    name
                ))?
        } else {
            host.default_input_device()
                .ok_or_else(|| anyhow::anyhow!("No input device available"))?
        };

        let config = device.default_input_config()?;
        let sample_rate = config.sample_rate().0 as f64;
        let target_rate = 16000.0;

        let vad = self.vad_threshold;
        let aec_flag = self.media_playing.clone();

        let build_result = match config.sample_format() {
            cpal::SampleFormat::F32 => self.build_stream::<f32>(
                &device,
                &config.into(),
                sample_rate,
                target_rate,
                vad,
                aec_flag,
                tx,
                prod,
                error_tx,
                level_tx,
            ),
            cpal::SampleFormat::I16 => self.build_stream::<i16>(
                &device,
                &config.into(),
                sample_rate,
                target_rate,
                vad,
                aec_flag,
                tx,
                prod,
                error_tx,
                level_tx,
            ),
            cpal::SampleFormat::U16 => self.build_stream::<u16>(
                &device,
                &config.into(),
                sample_rate,
                target_rate,
                vad,
                aec_flag,
                tx,
                prod,
                error_tx,
                level_tx,
            ),
            _ => return Err(anyhow::anyhow!("Unsupported sample format")),
        };
        let stream = build_result.map_err(|e| {
            let msg = e.to_string();
            if msg.contains("0x80070005")
                || msg.to_lowercase().contains("access denied")
                || msg.to_lowercase().contains("access is denied")
            {
                anyhow::anyhow!(
                    "Microphone access denied (0x80070005). \
                    Please enable microphone access in Windows Settings → \
                    Privacy & Security → Microphone, then restart the app."
                )
            } else {
                e
            }
        })?;

        stream.play()?;
        self.stream = Some(Arc::new(StreamHandle(stream)));
        Ok(())
    }

    fn build_stream<T>(
        &self,
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        source_rate: f64,
        target_rate: f64,
        vad_threshold: f32,
        aec_flag: Arc<AtomicBool>,
        tx: mpsc::Sender<()>,
        mut prod: impl Producer<Item = f32> + Send + 'static,
        error_tx: mpsc::Sender<String>,
        level_tx: Option<mpsc::Sender<f32>>,
    ) -> anyhow::Result<cpal::Stream>
    where
        T: cpal::Sample + Into<f32> + 'static + cpal::SizedSample,
    {
        let channels = config.channels as usize;
        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            window: WindowFunction::BlackmanHarris2,
            oversampling_factor: 256,
        };

        let mut resampler =
            SincFixedIn::<f32>::new(target_rate / source_rate, 2.0, params, 1024, channels)?;

        let mut input_buffer = vec![Vec::with_capacity(2048); channels];

        // Clone error_tx for use inside the data callback (the original moves into the error callback)
        let error_tx_inner = error_tx.clone();

        // Advanced AI-Driven VAD
        let mut vad_raw = Vad::new();
        vad_raw.set_mode(VadMode::Aggressive);
        let mut vad = SendVad(vad_raw);

        // Auto-Gain Control State
        let target_rms = 0.05f32; // ~ -26 dBFS target average
        let mut current_gain = 1.0f32;
        let attack = 0.01f32;
        let release = 0.001f32;

        // Residue buffer for VAD to prevent sample loss
        let mut residue_i16: Vec<i16> = Vec::with_capacity(160);

        // Pre-roll buffer (500ms at 16kHz = 8000 samples) to prevent clipping starts of sentences
        let mut pre_roll_buffer = vec![0.0f32; 8000];
        let mut pre_roll_idx = 0;
        let mut in_speech_window = false;

        device
            .build_input_stream(
                config,
                move |data: &[T], _| {
                    for frame in data.chunks(channels) {
                        for (c, sample) in frame.iter().enumerate() {
                            input_buffer[c].push((*sample).into());
                        }
                    }

                    if input_buffer[0].len() >= 1024 {
                        if let Ok(output) = resampler.process(&input_buffer, None) {
                            let mut mono = vec![0.0; output[0].len()];
                            for chan in output {
                                for (i, s) in chan.iter().enumerate() {
                                    mono[i] += s;
                                }
                            }
                            for s in &mut mono {
                                *s /= channels as f32;
                            }

                            // 1. Software AEC (Ducking / Suppression)
                            // If video or media is playing on the output, duck the mic to prevent echo loop.
                            if aec_flag.load(Ordering::Relaxed) {
                                for s in &mut mono {
                                    *s *= 0.01; // heavy attenuation
                                }
                            }

                            // 2. Auto-Gain Control (AGC)
                            let mut rms = mono.iter().map(|s| s * s).sum::<f32>() / mono.len() as f32;
                            rms = rms.sqrt().max(1e-5);
                            let desired_gain = target_rms / rms;
                            if desired_gain > current_gain {
                                current_gain += attack * (desired_gain - current_gain);
                            } else {
                                current_gain += release * (desired_gain - current_gain);
                            }
                            current_gain = current_gain.clamp(0.1, 8.0);

                            for s in &mut mono {
                                *s *= current_gain;
                                *s = s.clamp(-1.0, 1.0);
                            }

                            // VU meter logic (before VAD dropping)
                            let energy = mono.iter().map(|s| s * s).sum::<f32>() / mono.len() as f32;
                            if let Some(ref ltx) = level_tx {
                                let _ = ltx.try_send(energy);
                            }

                            // 3. WebRTC VAD + Fallback Energy Threshold
                            let mut i16_samples: Vec<i16> = residue_i16.clone();
                            i16_samples.extend(mono.iter().map(|&s| (s * std::i16::MAX as f32).clamp(-32768.0, 32767.0) as i16));

                            let mut is_speech_now = false;
                            // WebRTC VAD needs 10ms (160 samples at 16kHz)
                            let mut processed_idx = 0;
                            for chunk in i16_samples.chunks_exact(160) {
                                if let Ok(active) = vad.is_voice_segment(chunk) {
                                    if active {
                                        is_speech_now = true;
                                    }
                                }
                                processed_idx += 160;
                            }
                            
                            // Store the remainder in residue_i16
                            residue_i16 = i16_samples[processed_idx..].to_vec();

                            let triggered = is_speech_now || energy > vad_threshold;

                            if triggered {
                                if !in_speech_window {
                                    // Transition to speech: flush pre-roll first
                                    in_speech_window = true;
                                    let mut pre_roll_flush = vec![0.0f32; 8000];
                                    for i in 0..8000 {
                                        pre_roll_flush[i] = pre_roll_buffer[(pre_roll_idx + i) % 8000];
                                    }
                                    let _ = prod.push_slice(&pre_roll_flush);
                                }
                                
                                // 4. Lock-free ring buffer push
                                let pushed = prod.push_slice(&mono);
                                if pushed < mono.len() {
                                    // Buffer is full — warn the operator; samples were dropped
                                    let _ = error_tx_inner.try_send(
                                        "WARNING: Audio ring buffer full; samples dropped. \
                                         Consider reducing transcription window or upgrading CPU.".to_string()
                                    );
                                }
                                if pushed > 0 {
                                    // Non-blocking wake up the async processing loop
                                    let _ = tx.try_send(());
                                }
                            } else {
                                in_speech_window = false;
                                // Add to pre-roll circular buffer
                                for &s in &mono {
                                    pre_roll_buffer[pre_roll_idx] = s;
                                    pre_roll_idx = (pre_roll_idx + 1) % 8000;
                                }
                            }
                        }
                        for chan in &mut input_buffer {
                            chan.clear();
                        }
                    }
                },
                move |err| {
                    let _ = error_tx.try_send(format!("Audio device error: {}", err));
                },
                None,
            )
            .map_err(Into::into)
    }

    pub fn stop(&mut self) {
        self.stream = None;
        self.active_tx = None;
        self.active_error_tx = None;
        self.active_level_tx = None;
    }
}
