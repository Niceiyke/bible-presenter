use std::sync::Arc;
use parking_lot::Mutex;
use nokhwa::{
    pixel_format::RgbFormat,
    utils::{CameraIndex, RequestedFormat, RequestedFormatType},
    Camera,
};
use serde::{Serialize, Deserialize};
use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};
use base64::{Engine as _, engine::general_purpose};

pub struct CameraManager {
    camera: Option<Camera>,
    is_running: bool,
}

impl CameraManager {
    pub fn new() -> Self {
        Self {
            camera: None,
            is_running: false,
        }
    }
}

pub static CAMERA_MANAGER: Lazy<Arc<Mutex<CameraManager>>> = Lazy::new(|| {
    Arc::new(Mutex::new(CameraManager::new()))
});

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CameraDeviceInfo {
    pub index: u32,
    pub name: String,
}

#[tauri::command]
pub async fn list_native_cameras() -> Result<Vec<CameraDeviceInfo>, String> {
    use nokhwa::query_devices;
    let devices = query_devices(nokhwa::utils::ApiBackend::Auto)
        .map_err(|e| e.to_string())?;
    
    Ok(devices.into_iter().map(|d| CameraDeviceInfo {
        index: match d.index() {
            CameraIndex::Index(i) => *i,
            _ => 0,
        },
        name: d.human_name(),
    }).collect())
}

#[tauri::command]
pub async fn start_camera_stream(app: AppHandle, index: u32) -> Result<(), String> {
    let mut manager = CAMERA_MANAGER.lock();
    if manager.is_running {
        return Ok(());
    }

    let format = RequestedFormat::new::<RgbFormat>(RequestedFormatType::AbsoluteHighestFrameRate);
    let mut camera = Camera::new(CameraIndex::Index(index), format)
        .map_err(|e| format!("Failed to create camera: {}", e))?;
    
    camera.open_stream()
        .map_err(|e| format!("Failed to open stream: {}", e))?;

    manager.camera = Some(camera);
    manager.is_running = true;

    // Start a thread to pump frames
    std::thread::spawn(move || {
        loop {
            let mut manager = CAMERA_MANAGER.lock();
            if !manager.is_running { break; }
            
            if let Some(ref mut cam) = manager.camera {
                if let Ok(frame) = cam.frame() {
                    let buffer = frame.decode_image::<RgbFormat>().unwrap();
                    
                    // Option: Convert to JPEG to reduce pipe size
                    let mut jpeg_data = Vec::new();
                    let mut cursor = std::io::Cursor::new(&mut jpeg_data);
                    let _ = buffer.write_to(&mut cursor, image::ImageFormat::Jpeg);
                    
                    let b64 = general_purpose::STANDARD.encode(jpeg_data);
                    let _ = app.emit("native-camera-frame", b64);
                }
            }
            drop(manager);
            std::thread::sleep(std::io::Duration::from_millis(33)); // ~30fps
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_camera_stream() -> Result<(), String> {
    let mut manager = CAMERA_MANAGER.lock();
    manager.is_running = false;
    manager.camera = None;
    Ok(())
}
