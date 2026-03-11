use std::sync::Arc;
use parking_lot::Mutex;
use gstreamer::prelude::*;
use serde::{Serialize, Deserialize};
use once_cell::sync::Lazy;
use tauri::{AppHandle, Manager};
use crate::store::log_msg;

pub fn init_bundled_gstreamer(app: &AppHandle) -> Result<(), String> {
    let resource_dir = app.path().resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    
    // Path to our bundled GStreamer root
    let gst_root = resource_dir.join("bin").join("gstreamer");
    
    if gst_root.exists() {
        let plugin_path = gst_root.join("lib").join("gstreamer-1.0");
        let bin_path = gst_root.join("bin");

        // 1. Tell GStreamer where to find plugins
        std::env::set_var("GST_PLUGIN_PATH", &plugin_path);
        std::env::set_var("GST_PLUGIN_SYSTEM_PATH", &plugin_path);
        
        // 2. On Windows, we must add the 'bin' folder to PATH so main DLLs are found
        #[cfg(target_os = "windows")]
        {
            if let Some(path) = std::env::var_os("PATH") {
                let mut paths = std::env::split_paths(&path).collect::<Vec<_>>();
                paths.insert(0, bin_path);
                let new_path = std::env::join_paths(paths).unwrap();
                std::env::set_var("PATH", new_path);
            }
        }

        log_msg(app, &format!("Bundled GStreamer initialized from: {:?}", gst_root));
    } else {
        log_msg(app, &format!("Bundled GStreamer not found at {:?}, falling back to system...", gst_root));
    }

    gstreamer::init().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum SourceType {
    Camera { index: u32 },
    NDI { source_name: String },
    VideoFile { path: String },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MediaSource {
    pub id: String,
    pub name: String,
    pub source_type: SourceType,
    pub z_index: i32,
    pub opacity: f32,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

pub struct MediaEngine {
    pipeline: Option<gstreamer::Pipeline>,
    compositor: Option<gstreamer::Element>,
    sources: Vec<MediaSource>,
    is_running: bool,
    pub first_frame_received: bool,
}

impl MediaEngine {
    pub fn new() -> Self {
        let _ = gstreamer::init();
        Self {
            pipeline: None,
            compositor: None,
            sources: Vec::new(),
            is_running: false,
            first_frame_received: false,
        }
    }

    pub fn setup_pipeline(&mut self, app: AppHandle, quality: u32) -> Result<(), String> {
        gstreamer::init().map_err(|e| format!("GStreamer init failed: {}", e))?;
        let pipeline = gstreamer::Pipeline::new();
        let compositor = gstreamer::ElementFactory::make("compositor").build()
            .map_err(|e| format!("Could not create compositor: {}", e))?;
        let capsfilter = gstreamer::ElementFactory::make("capsfilter").build()
            .map_err(|e| format!("Could not create capsfilter: {}", e))?;
        
        // Define final output resolution
        let caps = gstreamer::Caps::builder("video/x-raw")
            .field("format", "I420")
            .field("width", 1920i32)
            .field("height", 1080i32)
            .build();
        capsfilter.set_property("caps", &caps);

        let videoconvert = gstreamer::ElementFactory::make("videoconvert").build().unwrap();
        let jpegenc = gstreamer::ElementFactory::make("jpegenc").build().unwrap();
        jpegenc.set_property("quality", quality.clamp(1, 100));

        let appsink = gstreamer_app::AppSink::builder()
            .name("output_sink")
            .build();

        pipeline.add_many(&[
            compositor.upcast_ref::<gstreamer::Element>(),
            capsfilter.upcast_ref::<gstreamer::Element>(),
            videoconvert.upcast_ref::<gstreamer::Element>(),
            jpegenc.upcast_ref::<gstreamer::Element>(),
            appsink.upcast_ref::<gstreamer::Element>(),
        ]).unwrap();
        
        gstreamer::Element::link_many(&[
            compositor.upcast_ref::<gstreamer::Element>(),
            capsfilter.upcast_ref::<gstreamer::Element>(),
            videoconvert.upcast_ref::<gstreamer::Element>(),
            jpegenc.upcast_ref::<gstreamer::Element>(),
            appsink.upcast_ref::<gstreamer::Element>(),
        ]).unwrap();

        // Register appsink callback to update the SHARED_FRAME buffer
        let app_clone = app.clone();
        appsink.set_callbacks(
            gstreamer_app::AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let sample = sink.pull_sample().map_err(|_| gstreamer::FlowError::Error)?;
                    let buffer = sample.buffer().ok_or(gstreamer::FlowError::Error)?;
                    let map = buffer.map_readable().map_err(|_| gstreamer::FlowError::Error)?;
                    
                    {
                        let mut shared = SHARED_FRAME.lock();
                        shared.clear();
                        shared.extend_from_slice(map.as_slice());
                    }

                    // Log frame arrival every 300 frames (~10 seconds at 30fps)
                    static FRAME_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
                    let count = FRAME_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if count % 300 == 0 {
                        log_msg(&app_clone, &format!("Camera Mixer: Streaming active ({} bytes, frame {})", map.len(), count));
                    }
                    
                    Ok(gstreamer::FlowSuccess::Ok)
                })
                .build(),
        );

        self.pipeline = Some(pipeline);
        self.compositor = Some(compositor);
        Ok(())
    }

    pub fn add_source(&mut self, app: &AppHandle, source: MediaSource) -> Result<(), String> {
        let pipeline = self.pipeline.as_ref().ok_or("Pipeline not initialized")?;
        let compositor = self.compositor.as_ref().ok_or("Compositor not initialized")?;

        log_msg(app, &format!("Mixer: Adding source {} ({:?})", source.name, source.source_type));

        let src_element = match &source.source_type {
            SourceType::Camera { index } => {
                // Select platform-specific source and set the correct camera device/index
                if cfg!(target_os = "linux") {
                    let s = gstreamer::ElementFactory::make("v4l2src").build()
                        .map_err(|e| format!("Could not create v4l2src: {}", e))?;
                    s.set_property("device", format!("/dev/video{}", index));
                    s
                } else if cfg!(target_os = "windows") {
                    let s = gstreamer::ElementFactory::make("ksvideosrc").build()
                        .map_err(|e| format!("Could not create ksvideosrc: {}", e))?;
                    s.set_property("device-index", *index as i32);
                    s
                } else {
                    // Fallback for macOS (avfvideosrc) or other OSs
                    let s = gstreamer::ElementFactory::make("autovideosrc").build()
                        .map_err(|e| format!("Could not create autovideosrc: {}", e))?;
                    s
                }
            }
            SourceType::NDI { source_name } => {
                let ndisrc = gstreamer::ElementFactory::make("ndisrc").build()
                    .map_err(|e| format!("NDI Plugin not found. Please install NDI GStreamer plugin: {}", e))?;
                ndisrc.set_property("ndi-name", source_name);
                ndisrc
            }
            SourceType::VideoFile { path } => {
                let filesrc = gstreamer::ElementFactory::make("filesrc").build().unwrap();
                filesrc.set_property("location", path);
                filesrc
            }
        };

        let videoconvert = gstreamer::ElementFactory::make("videoconvert").build().unwrap();
        let scale = gstreamer::ElementFactory::make("videoscale").build().unwrap();
        
        pipeline.add_many(&[&src_element, &videoconvert, &scale]).unwrap();
        src_element.link(&videoconvert).unwrap();
        videoconvert.link(&scale).unwrap();

        // Link to compositor and set position/z-order/scaling
        let pad = compositor.request_pad_simple("sink_%u").ok_or("Could not request pad")?;
        
        // Use compositor properties for positioning and scaling
        pad.set_property("xpos", (source.x * 19.2) as i32); 
        pad.set_property("ypos", (source.y * 10.8) as i32);
        pad.set_property("width", (source.w * 19.2) as i32);
        pad.set_property("height", (source.h * 10.8) as i32);
        pad.set_property("zorder", source.z_index as u32);
        
        let scale_pad = scale.static_pad("src").unwrap();
        scale_pad.link(&pad).unwrap();

        self.sources.push(source);
        Ok(())
    }

    pub fn start(&mut self, app: &AppHandle) -> Result<(), String> {
        if let Some(p) = &self.pipeline {
            log_msg(app, "GStreamer: Starting pipeline...");
            p.set_state(gstreamer::State::Playing).map_err(|e| {
                let err = format!("GStreamer: Failed to set pipeline to Playing: {}", e);
                log_msg(app, &err);
                err
            })?;
            log_msg(app, "GStreamer: Pipeline state set to Playing.");
            self.is_running = true;
        } else {
            log_msg(app, "GStreamer: No pipeline to start!");
        }
        Ok(())
    }
}

pub static MEDIA_ENGINE: Lazy<Arc<Mutex<MediaEngine>>> = Lazy::new(|| {
    Arc::new(Mutex::new(MediaEngine::new()))
});

pub static SHARED_FRAME: Lazy<Arc<Mutex<Vec<u8>>>> = Lazy::new(|| {
    Arc::new(Mutex::new(Vec::new()))
});

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DependencyStatus {
    pub gstreamer_ok: bool,
    pub ndi_ok: bool,
    pub version: String,
}

#[tauri::command]
pub async fn get_mixer_frame() -> Result<Vec<u8>, String> {
    let frame = SHARED_FRAME.lock().clone();
    Ok(frame)
}

#[tauri::command]
pub async fn check_media_dependencies() -> DependencyStatus {
    let gs_ok = gstreamer::init().is_ok();
    let mut ndi_ok = false;
    let mut video_ok = false;

    if gs_ok {
        ndi_ok = gstreamer::ElementFactory::find("ndisrc").is_some();
        if cfg!(target_os = "linux") {
            video_ok = gstreamer::ElementFactory::find("v4l2src").is_some();
        } else if cfg!(target_os = "windows") {
            video_ok = gstreamer::ElementFactory::find("ksvideosrc").is_some();
        } else if cfg!(target_os = "macos") {
            video_ok = gstreamer::ElementFactory::find("avfvideosrc").is_some();
        }
    }

    DependencyStatus {
        gstreamer_ok: gs_ok && video_ok,
        ndi_ok,
        version: gstreamer::version_string().to_string(),
    }
}

#[tauri::command]
pub async fn list_ndi_sources() -> Result<Vec<String>, String> {
    // In a real environment, we'd use NDI SDK to probe.
    // For now, let's look at how GStreamer's ndisrc would see it.
    // This often requires the NDI plugin for GStreamer.
    Ok(vec!["NDI Source 1 (PTZ)".to_string(), "NDI Source 2 (OBS)".to_string()])
}

#[tauri::command]
pub async fn start_mixer(app: AppHandle, quality: Option<u32>) -> Result<(), String> {
    log_msg(&app, "Command: start_mixer");
    let mut engine = MEDIA_ENGINE.lock();
    if engine.is_running {
        return Ok(());
    }
    engine.setup_pipeline(app.clone(), quality.unwrap_or(85))?;
    engine.start(&app)?;
    Ok(())
}

#[tauri::command]
pub async fn set_mixer_source(app: AppHandle, source: MediaSource, quality: Option<u32>) -> Result<(), String> {
    log_msg(&app, &format!("Command: set_mixer_source ({})", source.name));
    let mut engine = MEDIA_ENGINE.lock();
    
    // 1. Fully tear down old pipeline
    if let Some(p) = engine.pipeline.take() {
        let _ = p.set_state(gstreamer::State::Null);
    }
    engine.compositor = None;
    engine.is_running = false;
    engine.sources.clear();
    
    // 2. Build fresh pipeline
    engine.setup_pipeline(app.clone(), quality.unwrap_or(85))?;
    engine.add_source(&app, source)?;
    engine.start(&app)?;
    
    Ok(())
}
