use crate::license::{ensure_active_tier, LicenseTier};
use crate::state::AppState;
use serde::Serialize;
#[cfg(any(feature = "ndi", test))]
use std::path::PathBuf;
use tauri::{command, State};

/// NDI output status. The runtime DLL is intentionally not enough to enable
/// output: the SDK must initialize and report CPU support successfully.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NdiStatus {
    pub supported: bool,
    pub reason: String,
    pub compiled: bool,
    pub runtime_present: bool,
    pub runtime_path: Option<String>,
}

#[cfg(not(feature = "ndi"))]
fn not_compiled_reason() -> String {
    "NDI output is not available in this edition of Wordlyte.".to_string()
}

#[cfg(any(feature = "ndi", test))]
fn runtime_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = crate::binpaths::bundled_runtime("Processing.NDI.Lib.x64.dll") {
        paths.push(path);
    }
    if let Ok(dir) = std::env::var("NDI_RUNTIME_DIR") {
        paths.push(PathBuf::from(dir).join("Processing.NDI.Lib.x64.dll"));
    }
    if cfg!(target_os = "windows") {
        paths.push(PathBuf::from(
            r"C:\Program Files\NDI\NDI 6 Runtime\v6\Processing.NDI.Lib.x64.dll",
        ));
        paths.push(PathBuf::from(
            r"C:\Program Files\NDI\NDI 6 SDK\Bin\x64\Processing.NDI.Lib.x64.dll",
        ));
    }
    paths
}

#[cfg(feature = "ndi")]
fn find_runtime() -> Option<PathBuf> {
    runtime_candidates().into_iter().find(|path| path.is_file())
}

#[cfg(feature = "ndi")]
type InitializeFn = unsafe extern "C" fn() -> bool;
#[cfg(feature = "ndi")]
type IsSupportedCpuFn = unsafe extern "C" fn() -> bool;
#[cfg(feature = "ndi")]
type VersionFn = unsafe extern "C" fn() -> *const std::ffi::c_char;
#[cfg(feature = "ndi")]
type SendCreateFn = unsafe extern "C" fn(*const NdiSendCreate) -> *mut std::ffi::c_void;
#[cfg(feature = "ndi")]
type SendDestroyFn = unsafe extern "C" fn(*mut std::ffi::c_void);
#[cfg(feature = "ndi")]
type SendVideoFn = unsafe extern "C" fn(*mut std::ffi::c_void, *const NdiVideoFrame);

#[cfg(feature = "ndi")]
#[repr(C)]
struct NdiSendCreate {
    name: *const std::ffi::c_char,
    groups: *const std::ffi::c_char,
    clock_video: bool,
    clock_audio: bool,
}

#[cfg(feature = "ndi")]
#[repr(C)]
struct NdiVideoFrame {
    xres: i32,
    yres: i32,
    four_cc: i32,
    frame_rate_n: i32,
    frame_rate_d: i32,
    picture_aspect_ratio: f32,
    frame_format_type: i32,
    timecode: i64,
    data: *mut u8,
    line_stride_in_bytes: i32,
    metadata: *const std::ffi::c_char,
    timestamp: i64,
}

#[cfg(feature = "ndi")]
struct NdiApi {
    _library: libloading::Library,
    initialize: InitializeFn,
    is_supported_cpu: IsSupportedCpuFn,
    version: VersionFn,
    send_create: SendCreateFn,
    send_destroy: SendDestroyFn,
    send_video: SendVideoFn,
    destroy: unsafe extern "C" fn(),
}

#[cfg(feature = "ndi")]
unsafe impl Send for NdiApi {}
#[cfg(feature = "ndi")]
unsafe impl Sync for NdiApi {}

#[cfg(feature = "ndi")]
impl NdiApi {
    fn load() -> Result<std::sync::Arc<Self>, String> {
        let path = find_runtime().ok_or_else(|| {
            "The NDI runtime was not found. Reinstall Wordlyte or install the NDI runtime.".to_string()
        })?;
        let library = unsafe { libloading::Library::new(&path) }
            .map_err(|error| format!("Could not load the NDI runtime: {error}"))?;
        unsafe fn symbol<T: Copy>(library: &libloading::Library, name: &[u8]) -> Result<T, String> {
            library
                .get::<T>(name)
                .map(|symbol| *symbol)
                .map_err(|error| {
                    format!(
                        "NDI runtime is missing {}: {error}",
                        String::from_utf8_lossy(name)
                    )
                })
        }
        let api = unsafe {
            Self {
                initialize: symbol(&library, b"NDIlib_initialize\0")?,
                is_supported_cpu: symbol(&library, b"NDIlib_is_supported_CPU\0")?,
                version: symbol(&library, b"NDIlib_version\0")?,
                send_create: symbol(&library, b"NDIlib_send_create\0")?,
                send_destroy: symbol(&library, b"NDIlib_send_destroy\0")?,
                send_video: symbol(&library, b"NDIlib_send_send_video_v2\0")?,
                destroy: symbol(&library, b"NDIlib_destroy\0")?,
                _library: library,
            }
        };
        if !(unsafe { (api.initialize)() }) {
            return Err("NDIlib_initialize reported that NDI is unavailable.".into());
        }
        if !(unsafe { (api.is_supported_cpu)() }) {
            unsafe { (api.destroy)() };
            return Err("This CPU does not meet the NDI runtime requirements.".into());
        }
        Ok(std::sync::Arc::new(api))
    }

    fn shared() -> Result<std::sync::Arc<Self>, String> {
        static API: std::sync::OnceLock<Result<std::sync::Arc<NdiApi>, String>> =
            std::sync::OnceLock::new();
        API.get_or_init(Self::load)
            .as_ref()
            .map(std::sync::Arc::clone)
            .map_err(Clone::clone)
    }

    fn version_string(&self) -> String {
        let pointer = unsafe { (self.version)() };
        if pointer.is_null() {
            return "unknown version".into();
        }
        unsafe { std::ffi::CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(feature = "ndi")]
impl Drop for NdiApi {
    fn drop(&mut self) {
        unsafe { (self.destroy)() };
    }
}

/// A synchronous NDI video sender. Synchronous submission keeps the backing
/// NV12 frame alive until the SDK has finished reading it; the capture fan-out
/// remains best-effort because this sender is fed from its own bounded queue.
#[cfg(feature = "ndi")]
pub struct NdiVideoSender {
    api: std::sync::Arc<NdiApi>,
    sender: *mut std::ffi::c_void,
    _name: std::ffi::CString,
}

#[cfg(feature = "ndi")]
unsafe impl Send for NdiVideoSender {}

#[cfg(feature = "ndi")]
impl NdiVideoSender {
    pub fn new(name: &str) -> Result<Self, String> {
        let api = NdiApi::shared()?;
        let name = std::ffi::CString::new(name)
            .map_err(|_| "NDI source name contains NUL bytes.".to_string())?;
        let settings = NdiSendCreate {
            name: name.as_ptr(),
            groups: std::ptr::null(),
            clock_video: true,
            clock_audio: false,
        };
        let sender = unsafe { (api.send_create)(&settings) };
        if sender.is_null() {
            return Err("NDIlib_send_create could not create the NDI source.".into());
        }
        Ok(Self {
            api,
            sender,
            _name: name,
        })
    }

    pub fn send_frame(&self, frame: &crate::capture::CaptureFrame, fps: u32) {
        // NDIlib_FourCC_video_type_NV12 is the literal FourCC 'NV12'.
        let video = NdiVideoFrame {
            xres: frame.width as i32,
            yres: frame.height as i32,
            four_cc: 0x3231564e,
            frame_rate_n: fps.max(1) as i32,
            frame_rate_d: 1,
            picture_aspect_ratio: frame.width as f32 / frame.height.max(1) as f32,
            frame_format_type: 1, // progressive
            timecode: i64::MAX,   // synthesize from the NDI clock
            data: frame.pixels.as_ptr() as *mut u8,
            line_stride_in_bytes: frame.width as i32,
            metadata: std::ptr::null(),
            timestamp: 0,
        };
        unsafe { (self.api.send_video)(self.sender, &video) };
    }
}

#[cfg(feature = "ndi")]
impl Drop for NdiVideoSender {
    fn drop(&mut self) {
        unsafe { (self.api.send_destroy)(self.sender) };
    }
}

/// Report compile and runtime readiness. Diagnostics and Streaming use
/// `supported`; merely finding a vendor DLL never enables a broken sender.
#[command]
pub fn ndi_status() -> NdiStatus {
    #[cfg(feature = "ndi")]
    {
        let runtime = find_runtime();
        let runtime_path = runtime
            .as_ref()
            .map(|path| path.to_string_lossy().to_string());
        match NdiApi::shared() {
            Ok(api) => NdiStatus {
                supported: true,
                reason: format!(
                    "NDI {} is initialized and CPU support is available.",
                    api.version_string()
                ),
                compiled: true,
                runtime_present: runtime.is_some(),
                runtime_path,
            },
            Err(reason) => NdiStatus {
                supported: false,
                reason,
                compiled: true,
                runtime_present: runtime.is_some(),
                runtime_path,
            },
        }
    }
    #[cfg(not(feature = "ndi"))]
    {
        NdiStatus {
            supported: false,
            reason: not_compiled_reason(),
            compiled: false,
            runtime_present: false,
            runtime_path: None,
        }
    }
}

/// Compatibility command for callers that use the low-level sender API. The
/// Streaming Hub uses `NdiVideoSender` directly so it can share the capture
/// frame without a base64/IPC round trip.
#[command]
pub fn ndi_start(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    ensure_active_tier(&state, LicenseTier::Pro)?;
    let _ = (session_id, name);
    #[cfg(feature = "ndi")]
    return Err("Use the Streaming Hub to start an NDI destination.".into());
    #[cfg(not(feature = "ndi"))]
    Err(not_compiled_reason())
}

#[command]
pub fn ndi_send(session_id: String, _data_base64: String) -> Result<(), String> {
    let _ = session_id;
    #[cfg(feature = "ndi")]
    return Err("Use the Streaming Hub to send the shared program capture to NDI.".into());
    #[cfg(not(feature = "ndi"))]
    Err(not_compiled_reason())
}

#[command]
pub fn ndi_stop(session_id: String) -> Result<(), String> {
    let _ = session_id;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_candidates_use_the_vendor_filename() {
        assert!(runtime_candidates().iter().all(|path| {
            path.file_name().and_then(|value| value.to_str()) == Some("Processing.NDI.Lib.x64.dll")
        }));
    }

    #[test]
    fn default_build_reports_ndi_as_safely_disabled() {
        #[cfg(not(feature = "ndi"))]
        {
            let status = ndi_status();
            assert!(!status.supported);
            assert!(!status.compiled);
            assert!(!status.runtime_present);
            assert!(status.reason.contains("not available"));
        }
    }

    #[cfg(feature = "ndi")]
    #[test]
    fn ndi_feature_probe_initializes_the_staged_runtime() {
        let api = NdiApi::shared().expect("staged NDI runtime should initialize");
        assert!(api.version_string().contains('.'));
        assert!(unsafe { (api.is_supported_cpu)() });
    }

    #[cfg(feature = "ndi")]
    #[test]
    fn ndi_sender_can_create_and_destroy_a_source() {
        let sender = NdiVideoSender::new("Wordlyte test source")
            .expect("staged NDI runtime should create a sender");
        let frame = crate::capture::CaptureFrame {
            width: 2,
            height: 2,
            pixels: vec![128; 6],
            timestamp_ms: 0,
        };
        sender.send_frame(&frame, 30);
        drop(sender);
    }
}
