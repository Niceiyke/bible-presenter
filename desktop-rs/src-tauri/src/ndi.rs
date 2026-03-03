use std::sync::Arc;
use parking_lot::Mutex;
use serde::{Serialize, Deserialize};
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NdiConfig {
    pub enabled: bool,
    pub source_name: String,
    pub width: u32,
    pub height: u32,
    pub frame_rate: u32,
}

impl Default for NdiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            source_name: "Bible Presenter Output".to_string(),
            width: 1920,
            height: 1080,
            frame_rate: 30,
        }
    }
}

pub struct NdiManager {
    pub config: Arc<Mutex<NdiConfig>>,
    // In a full implementation, we would hold the NdiInstance and NdiSender here.
}

impl NdiManager {
    pub fn new() -> Self {
        Self {
            config: Arc::new(Mutex::new(NdiConfig::default())),
        }
    }

    /// This would be called by the frontend whenever a new "frame" is rendered.
    /// To keep it efficient, instead of sending raw pixels, we can send the
    /// SVG or render state and have a headless worker generate the NDI frame.
    pub fn send_frame(&self, _pixels: Vec<u8>) {
        // NDI Sending Logic:
        // 1. Create NDI video frame structure
        // 2. Point it to the pixel buffer (BGRA/RGBA)
        // 3. call ndi_send_video_v2
    }
}
