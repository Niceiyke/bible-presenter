use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;

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

pub struct AudioEngine {
    stream: Option<Arc<StreamHandle>>,
    selected_device_name: Option<String>,
    /// Persistent across hot-swaps; set at session start, cleared at session end.
    session_audio_tx: Option<mpsc::Sender<Vec<f32>>>,
    session_error_tx: Option<mpsc::Sender<String>>,
    session_level_tx: Option<mpsc::Sender<f32>>,
    pub media_playing: Arc<AtomicBool>,
    pub is_muted: Arc<AtomicBool>,
}

impl AudioEngine {
    pub fn new() -> Self {
        Self {
            stream: None,
            selected_device_name: None,
            session_audio_tx: None,
            session_error_tx: None,
            session_level_tx: None,
            media_playing: Arc::new(AtomicBool::new(false)),
            is_muted: Arc::new(AtomicBool::new(false)),
        }
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
        self.selected_device_name = if device_name.is_empty() {
            None
        } else {
            Some(device_name.to_string())
        };
        Ok(())
    }

    /// Returns the currently selected device name, or None if using system default.
    pub fn selected_device(&self) -> Option<&str> {
        self.selected_device_name.as_deref()
    }

    /// Returns true if there is an active session (audio_tx is set).
    pub fn session_active(&self) -> bool {
        self.session_audio_tx.is_some()
    }

    /// Start capturing audio, storing the senders for future hot-swaps.
    pub fn start_capturing(
        &mut self,
        audio_tx: mpsc::Sender<Vec<f32>>,
        error_tx: mpsc::Sender<String>,
        level_tx: Option<mpsc::Sender<f32>>,
    ) -> anyhow::Result<()> {
        // Stop any existing stream before starting a new one (prevents double-stream)
        self.stop();
        self.session_audio_tx = Some(audio_tx.clone());
        self.session_error_tx = Some(error_tx.clone());
        self.session_level_tx = level_tx.clone();
        self.open_stream(audio_tx, error_tx, level_tx)
    }

    /// Hot-swap to a different audio device mid-session.
    /// Drops the old CPAL stream and opens a new one using the same stored senders.
    /// If no session is active, just updates the selected device name.
    pub fn hot_swap_device(&mut self, device_name: &str) -> anyhow::Result<()> {
        self.selected_device_name = if device_name.is_empty() {
            None
        } else {
            Some(device_name.to_owned())
        };

        if let (Some(atx), Some(etx)) = (
            self.session_audio_tx.clone(),
            self.session_error_tx.clone(),
        ) {
            // Drop old CPAL stream only — keep senders so the processing task continues
            self.stream = None;
            self.open_stream(atx, etx, self.session_level_tx.clone())?;
        }
        Ok(())
    }

    /// Internal: open a CPAL stream using the given senders.
    fn open_stream(
        &mut self,
        audio_tx: mpsc::Sender<Vec<f32>>,
        error_tx: mpsc::Sender<String>,
        level_tx: Option<mpsc::Sender<f32>>,
    ) -> anyhow::Result<()> {
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

        let aec_flag = self.media_playing.clone();
        let mute_flag = self.is_muted.clone();

        let build_result = match config.sample_format() {
            cpal::SampleFormat::F32 => self.build_stream::<f32>(
                &device, &config.into(), sample_rate, target_rate, aec_flag, mute_flag,
                audio_tx, error_tx, level_tx,
            ),
            cpal::SampleFormat::I16 => self.build_stream::<i16>(
                &device, &config.into(), sample_rate, target_rate, aec_flag, mute_flag,
                audio_tx, error_tx, level_tx,
            ),
            cpal::SampleFormat::U16 => self.build_stream::<u16>(
                &device, &config.into(), sample_rate, target_rate, aec_flag, mute_flag,
                audio_tx, error_tx, level_tx,
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
        aec_flag: Arc<AtomicBool>,
        mute_flag: Arc<AtomicBool>,
        audio_tx: mpsc::Sender<Vec<f32>>,
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

        // Auto-Gain Control State
        let target_rms = 0.05f32; // ~ -26 dBFS target average
        let mut current_gain = 1.0f32;
        let attack = 0.01f32;
        let release = 0.001f32;

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
                                    *s *= 0.05; // slightly less heavy attenuation (5% instead of 1%)
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

                            // VU meter logic - Use RMS and apply a scaling factor for better UI visibility
                            let rms = (mono.iter().map(|s| s * s).sum::<f32>() / mono.len() as f32).sqrt();
                            let ui_level = (rms * 5.0).min(1.0); // Boost small signals for the meter
                            if let Some(ref ltx) = level_tx {
                                let _ = ltx.try_send(ui_level);
                            }

                            // --- HARD MUTE CHECK ---
                            // If muted, we zero out the buffer immediately AFTER the VU calculation
                            // This keeps the meters alive for visual feedback but kills the audio for 
                            // cloud, transcription, and processing.
                            if mute_flag.load(Ordering::Relaxed) {
                                for s in &mut mono { *s = 0.0; }
                            }

                            // Since VAD is handled in hardware now, simply send every chunk forward.
                            if audio_tx.try_send(mono.clone()).is_err() {
                                let _ = error_tx_inner.try_send(
                                    "WARNING: Audio channel full; samples dropped.".to_string()
                                );
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
        // Dropping the senders signals the processing task's receiver to return None → task exits
        self.session_audio_tx = None;
        self.session_error_tx = None;
        self.session_level_tx = None;
    }
}
