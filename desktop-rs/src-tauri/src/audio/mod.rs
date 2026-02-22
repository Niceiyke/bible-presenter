use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tokio::sync::mpsc;
use rubato::{Resampler, SincFixedIn, SincInterpolationType, SincInterpolationParameters, WindowFunction};

pub struct AudioEngine {
    stream: Option<cpal::Stream>,
    selected_device_name: Option<String>,
    active_tx: Option<mpsc::Sender<Vec<f32>>>,
    vad_threshold: f32,
}

impl AudioEngine {
    pub fn new() -> Self {
        Self { 
            stream: None,
            selected_device_name: None,
            active_tx: None,
            vad_threshold: 0.005,
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
                // Using name as ID for simplicity
                list.push((name.clone(), name));
            }
        }
        Ok(list)
    }

    pub fn select_device(&mut self, device_name: &str) -> anyhow::Result<()> {
        self.selected_device_name = Some(device_name.to_string());
        
        // If we are currently capturing, restart with the new device
        if let Some(tx) = self.active_tx.clone() {
            self.stop();
            self.start_capturing(tx)?;
        }
        Ok(())
    }

    pub fn start_capturing(&mut self, tx: mpsc::Sender<Vec<f32>>) -> anyhow::Result<()> {
        self.active_tx = Some(tx.clone());
        let host = cpal::default_host();
        
        let device = if let Some(ref name) = self.selected_device_name {
            let mut devices = host.input_devices()?;
            devices.find(|d| d.name().map(|n| n == *name).unwrap_or(false))
                .ok_or_else(|| anyhow::anyhow!("Selected device not found"))?
        } else {
            host.default_input_device()
                .ok_or_else(|| anyhow::anyhow!("No input device"))?
        };

        let config = device.default_input_config()?;
        let sample_rate = config.sample_rate().0 as f64;
        let target_rate = 16000.0;

        println!("Audio: Hardware is {}Hz. Resampling to 16kHz via Sinc Interpolation.", sample_rate);

        let vad = self.vad_threshold;
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => self.build_stream::<f32>(&device, &config.into(), sample_rate, target_rate, vad, tx)?,
            cpal::SampleFormat::I16 => self.build_stream::<i16>(&device, &config.into(), sample_rate, target_rate, vad, tx)?,
            cpal::SampleFormat::U16 => self.build_stream::<u16>(&device, &config.into(), sample_rate, target_rate, vad, tx)?,
            _ => return Err(anyhow::anyhow!("Unsupported sample format")),
        };

        stream.play()?;
        self.stream = Some(stream);
        Ok(())
    }

    fn build_stream<T>(&self, device: &cpal::Device, config: &cpal::StreamConfig, source_rate: f64, target_rate: f64, vad_threshold: f32, tx: mpsc::Sender<Vec<f32>>) 
    -> anyhow::Result<cpal::Stream> 
    where T: cpal::Sample + Into<f32> + 'static + cpal::SizedSample {
        let channels = config.channels as usize;
        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            window: WindowFunction::BlackmanHarris2,
            oversampling_factor: 256,
        };
        
        let mut resampler = SincFixedIn::<f32>::new(
            target_rate / source_rate,
            2.0,
            params,
            1024,
            channels,
        )?;

        let mut input_buffer = vec![Vec::with_capacity(2048); channels];

        device.build_input_stream(
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
                            for (i, s) in chan.iter().enumerate() { mono[i] += s; }
                        }
                        for s in &mut mono { *s /= channels as f32; }

                        let energy = mono.iter().map(|s| s * s).sum::<f32>() / mono.len() as f32;
                        if energy > vad_threshold {
                            let _ = tx.try_send(mono);
                        }
                    }
                    for chan in &mut input_buffer { chan.clear(); }
                }
            },
            |err| eprintln!("Audio error: {}", err),
            None
        ).map_err(Into::into)
    }

    pub fn stop(&mut self) { 
        self.stream = None; 
    }
}
