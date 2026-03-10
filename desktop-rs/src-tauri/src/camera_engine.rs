use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use nokhwa::{
    pixel_format::RgbFormat,
    utils::{CameraIndex, RequestedFormat, RequestedFormatType},
    Camera,
};
use serde::{Serialize, Deserialize};
use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};
use base64::{Engine as _, engine::general_purpose};

pub static IS_CAMERA_RUNNING: Lazy<Arc<AtomicBool>> = Lazy::new(|| {
    Arc::new(AtomicBool::new(false))
});

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CameraDeviceInfo {
    pub index: u32,
    pub name: String,
}

#[tauri::command]
pub async fn list_native_cameras() -> Result<Vec<CameraDeviceInfo>, String> {
    // nokhwa 0.10: query_devices is at the root of nokhwa crate if features are correct.
    // If it's missing from root, we try to use it with the correct path or backend.
    let devices = nokhwa::query(nokhwa::utils::ApiBackend::Auto)
        .map_err(|e: nokhwa::NokhwaError| e.to_string())?;
    
    Ok(devices.into_iter().map(|d: nokhwa::utils::CameraInfo| CameraDeviceInfo {
        index: match d.index() {
            CameraIndex::Index(i) => *i,
            _ => 0,
        },
        name: d.human_name(),
    }).collect())
}

#[tauri::command]
pub async fn start_camera_stream(app: AppHandle, index: u32) -> Result<(), String> {
    if IS_CAMERA_RUNNING.load(Ordering::SeqCst) {
        return Ok(());
    }

    IS_CAMERA_RUNNING.store(true, Ordering::SeqCst);

    // Start a thread to own the camera and pump frames
    std::thread::spawn(move || {
        let format = RequestedFormat::new::<RgbFormat>(RequestedFormatType::AbsoluteHighestFrameRate);
        let mut camera = match Camera::new(CameraIndex::Index(index), format) {
            Ok(c) => c,
            Err(_) => {
                IS_CAMERA_RUNNING.store(false, Ordering::SeqCst);
                return;
            }
        };
        
        if camera.open_stream().is_err() {
            IS_CAMERA_RUNNING.store(false, Ordering::SeqCst);
            return;
        }

        loop {
            if !IS_CAMERA_RUNNING.load(Ordering::SeqCst) { break; }
            
            if let Ok(frame) = camera.frame() {
                if let Ok(buffer) = frame.decode_image::<RgbFormat>() {
                    // Convert to JPEG to reduce pipe size
                    let mut jpeg_data = Vec::new();
                    let mut cursor = std::io::Cursor::new(&mut jpeg_data);
                    let _ = buffer.write_to(&mut cursor, image::ImageFormat::Jpeg);
                    
                    let b64 = general_purpose::STANDARD.encode(jpeg_data);
                    let _ = app.emit("native-camera-frame", b64);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(33)); // ~30fps
        }
        
        IS_CAMERA_RUNNING.store(false, Ordering::SeqCst);
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_camera_stream() -> Result<(), String> {
    IS_CAMERA_RUNNING.store(false, Ordering::SeqCst);
    Ok(())
}
