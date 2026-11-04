use crate::license::{ensure_active_tier, LicenseTier};
use crate::state::AppState;
use serde::Serialize;
#[cfg(any(feature = "ndi", test))]
use std::path::PathBuf;
use tauri::{command, State};

/// NDI remains strictly gated. The command surface is stable for the frontend,
/// while `supported` stays false until an SDK-built sender has passed an actual
/// receive test in OBS/vMix. Merely finding a vendor DLL must never enable a
/// production control that cannot send frames safely.
#[derive(Serialize)]
pub struct NdiStatus {
    pub supported: bool,
    pub reason: String,
    pub compiled: bool,
    pub runtime_present: bool,
    pub runtime_path: Option<String>,
}

#[cfg(not(feature = "ndi"))]
fn not_compiled_reason() -> String {
    "NDI output is not compiled into this build (requires the NDI 6 SDK and the `ndi` cargo feature).".to_string()
}

#[cfg(feature = "ndi")]
fn gated_reason() -> String {
    "NDI output is intentionally gated pending final SDK sender and receiver validation."
        .to_string()
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

/// Report compile and runtime readiness without prematurely advertising NDI as
/// usable. Diagnostics presents `reason`; streaming controls use `supported`.
#[command]
pub fn ndi_status() -> NdiStatus {
    #[cfg(feature = "ndi")]
    {
        let runtime = find_runtime();
        let runtime_path = runtime
            .as_ref()
            .map(|path| path.to_string_lossy().to_string());
        NdiStatus {
            supported: false,
            reason: if runtime.is_some() {
                "The NDI runtime is staged, but NDI output remains disabled until the SDK sender passes final build and receiver validation.".to_string()
            } else {
                "This NDI-enabled build cannot find Processing.NDI.Lib.x64.dll. Run scripts/prepare-ndi.ps1 before packaging.".to_string()
            },
            compiled: true,
            runtime_present: runtime.is_some(),
            runtime_path,
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

/// Reserved sender entrypoint. License enforcement already lives at the native
/// boundary, so enabling the SDK implementation later cannot bypass plan gates.
#[command]
pub fn ndi_start(
    state: State<'_, AppState>,
    session_id: String,
    _name: String,
) -> Result<(), String> {
    ensure_active_tier(&state, LicenseTier::Pro)?;
    let _ = session_id;
    #[cfg(feature = "ndi")]
    return Err(gated_reason());
    #[cfg(not(feature = "ndi"))]
    Err(not_compiled_reason())
}

/// Reserved frame ingress for the future SDK sender.
#[command]
pub fn ndi_send(session_id: String, _data_base64: String) -> Result<(), String> {
    let _ = session_id;
    #[cfg(feature = "ndi")]
    return Err(gated_reason());
    #[cfg(not(feature = "ndi"))]
    Err(not_compiled_reason())
}

/// Idempotent teardown, matching the RTMP command contract.
#[command]
pub fn ndi_stop(session_id: String) -> Result<(), String> {
    let _ = session_id;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_build_reports_ndi_as_safely_disabled() {
        #[cfg(not(feature = "ndi"))]
        {
            let status = ndi_status();
            assert!(!status.supported);
            assert!(!status.compiled);
            assert!(!status.runtime_present);
            assert!(status.reason.contains("not compiled"));
        }
    }

    #[test]
    fn runtime_candidates_use_the_vendor_filename() {
        assert!(runtime_candidates().iter().all(|path| {
            path.file_name().and_then(|value| value.to_str()) == Some("Processing.NDI.Lib.x64.dll")
        }));
    }
}
