//! Camera device enumeration (Phase I1).
//!
//! Media Foundation via the `windows` crate — stable friendly names, no
//! ffmpeg `-list_devices` output parsing. Capture itself still goes through
//! dshow ffmpeg (`compositor::media::camera_spawner`); enumeration only
//! answers "what can the operator pick".

use serde::Serialize;

/// One enumerable video capture device (webcam or UVC capture card).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CaptureDeviceInfo {
    /// Friendly name — what the operator sees AND what ffmpeg dshow accepts
    /// after `video=`.
    pub name: String,
}

/// Enumerate DirectShow/Media Foundation video capture devices.
#[cfg(windows)]
pub fn list_video_devices() -> Result<Vec<CaptureDeviceInfo>, String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::Media::MediaFoundation::{
        MFCreateAttributes, MFEnumDeviceSources, MFShutdown, MFStartup, IMFActivate, MF_VERSION,
        MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
        MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};

    unsafe {
        // COM apartment for MF. RPC_E_CHANGED_MODE means this thread already
        // has a different apartment — MF tolerates it, so only hard failures
        // abort.
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() && hr != RPC_E_CHANGED_MODE {
            return Err(format!("CoInitializeEx failed: {hr}"));
        }
        MFStartup(MF_VERSION, 0).map_err(|e| format!("MFStartup failed: {e}"))?;

        let result = (|| {
            let mut attrs = None;
            MFCreateAttributes(&mut attrs, 0)
                .map_err(|e| format!("MFCreateAttributes failed: {e}"))?;
            let attrs = attrs.ok_or("MFCreateAttributes returned no attributes")?;
            attrs
                .SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID)
                .map_err(|e| format!("SetGUID failed: {e}"))?;

            // Two-call pattern: query the count, then fill one allocation.
            let mut count = 0u32;
            let _ = MFEnumDeviceSources(&attrs, std::ptr::null_mut(), &mut count);
            if count == 0 {
                return Ok(Vec::new());
            }
            let mut buf: Vec<Option<IMFActivate>> = vec![None; count as usize];
            MFEnumDeviceSources(&attrs, &mut buf.as_mut_ptr(), &mut count)
                .map_err(|e| format!("MFEnumDeviceSources failed: {e}"))?;
            buf.set_len(count as usize);

            let mut devices: Vec<CaptureDeviceInfo> = Vec::new();
            for act in buf.into_iter().flatten() {
                // GetAllocatedString CoTaskMemAlloc's the string; free it after
                // copying (raw FFI signature in windows 0.62).
                let mut pw = PWSTR::null();
                let mut len = 0u32;
                if act
                    .GetAllocatedString(&MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &mut pw, &mut len)
                    .is_ok()
                    && !pw.is_null()
                {
                    let bytes = std::slice::from_raw_parts(pw.as_ptr() as *const u8, pw.len());
                    let name = String::from_utf8_lossy(bytes).to_string();
                    CoTaskMemFree(Some(pw.as_ptr() as *const _));
                    if !name.trim().is_empty()
                        && !devices.iter().any(|d: &CaptureDeviceInfo| d.name == name)
                    {
                        devices.push(CaptureDeviceInfo { name });
                    }
                }
            }
            Ok(devices)
        })();

        let _ = MFShutdown();
        result
    }
}

#[cfg(not(windows))]
pub fn list_video_devices() -> Result<Vec<CaptureDeviceInfo>, String> {
    Err("camera enumeration is only supported on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real MF walk runs on Windows CI/dev machines; it must never panic.
    /// An empty device list is a valid answer on headless runners.
    #[test]
    #[cfg(windows)]
    fn list_devices_returns_without_panicking() {
        let devices = list_video_devices();
        assert!(devices.is_ok(), "enumeration failed: {:?}", devices.err());
    }

    #[test]
    fn device_info_serializes_camel_case_friendly() {
        let json = serde_json::to_value(CaptureDeviceInfo { name: "HD Webcam".into() }).unwrap();
        assert_eq!(json["name"], "HD Webcam");
    }
}
