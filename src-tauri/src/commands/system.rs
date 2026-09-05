use crate::commands::rtmp;
use crate::commands::recordings;
use crate::state::AppState;
use serde::Serialize;
use sysinfo::{Disks, System};
use tauri::State;

/// System diagnostics (Phase 7).
///
/// Backs the Diagnostics workspace: a one-shot hardware snapshot (`system_info`)
/// for the readiness checklist, and a cheap polled metric (`system_metrics`) for
/// the live performance monitor. CPU/RAM/disk come from `sysinfo`; the ffmpeg
/// presence check reuses the RTMP module so the operator sees exactly what the
/// streamer depends on.
#[derive(Serialize)]
pub struct SystemInfo {
    pub cpu_model: String,
    pub physical_cores: Option<usize>,
    pub total_ram_mb: u64,
    pub total_disk_mb: u64,
pub ffmpeg_available: bool,
    /// The H.264 encoder the recorder/streamer would use right now. Surfaced so
    /// the operator can confirm hardware encode: `h264_mf` / `h264_qsv` /
    /// `h264_nvenc` / `h264_amf` are hardware-capable; `libx264` is software.
    pub h264_encoder: String,
    /// Whether this Windows installation exposes the native API required to
    /// capture the final DOM output window for recording and streaming.
    pub windows_graphics_capture_supported: bool,
    pub windows_graphics_capture_reason: String,
}

#[derive(Serialize)]
pub struct SystemMetrics {
    pub cpu_usage_percent: f32,
    pub used_ram_percent: f32,
    pub used_disk_percent: f32,
    /// Number of active RTMP sessions (from the streaming hub).
    pub active_rtmp_sessions: usize,
}

/// One-shot hardware + environment snapshot for the readiness checklist.
#[tauri::command]
pub fn system_info() -> SystemInfo {
    let mut sys = System::new_all();
    sys.refresh_cpu_all();
    sys.refresh_memory();
    let cpu = sys.cpus().first().map(|c| c.brand().to_string());
    let disks = Disks::new_with_refreshed_list();
    let total_disk: u64 = disks.iter().map(|d| d.total_space()).sum();
    let (windows_graphics_capture_supported, windows_graphics_capture_reason) =
        graphics_capture_probe();
    SystemInfo {
        cpu_model: cpu.unwrap_or_else(|| "Unknown CPU".into()),
        physical_cores: sys.physical_core_count(),
        total_ram_mb: sys.total_memory() / (1024 * 1024),
        total_disk_mb: total_disk / (1024 * 1024),
ffmpeg_available: rtmp::ffmpeg_available(),
        h264_encoder: if rtmp::ffmpeg_available() {
            recordings::pick_h264_encoder()
        } else {
            "unavailable".into()
        },
        windows_graphics_capture_supported,
        windows_graphics_capture_reason,
    }
}

/// Phase 0 capability check only. It confirms that Windows Graphics Capture can
/// be activated on this machine; it intentionally does not create a capture
/// session or alter the current canvas-based recorder/streamer paths.
#[cfg(target_os = "windows")]
fn graphics_capture_probe() -> (bool, String) {
    use windows::{
        Graphics::Capture::GraphicsCaptureSession,
        Win32::{
            Foundation::RPC_E_CHANGED_MODE,
            System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        },
    };

    let must_uninitialize = match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
        Ok(()) => true,
        // Tauri may already own this thread's apartment. Do not uninitialize
        // host-owned WinRT state, but the static capability call is still safe.
        Err(error) if error.code() == RPC_E_CHANGED_MODE => false,
        Err(error) => {
            return (
                false,
                format!("Windows Runtime initialization failed: {error}"),
            )
        }
    };

    let result = GraphicsCaptureSession::IsSupported();

    if must_uninitialize {
        unsafe { RoUninitialize() };
    }

    match result {
        Ok(true) => (true, "Windows Graphics Capture is available for the native output-capture spike.".into()),
        Ok(false) => (false, "Windows Graphics Capture is unavailable on this Windows installation or is disabled by policy.".into()),
        Err(error) => (false, format!("Windows Graphics Capture could not be activated: {error}")),
    }
}

#[cfg(not(target_os = "windows"))]
fn graphics_capture_probe() -> (bool, String) {
    (
        false,
        "Native output-window capture is currently implemented for Windows only.".into(),
    )
}

/// Cheap polled metric for the live performance monitor.
#[tauri::command]
pub fn system_metrics(state: State<'_, AppState>) -> SystemMetrics {
    // Reuse one `System` across polls: sysinfo needs a previous snapshot to
    // compute CPU usage, so a fresh System per call reports the cumulative
    // since-boot usage (busy ≈ total → stuck at 100%). The first poll seeds
    // the baseline and reports 0; later polls return the delta over the 3s
    // poll interval.
    let mut sampler = state.cpu_sampler.lock();
    let (cpu_usage_percent, total_ram, used_ram) = if let Some(sys) = sampler.as_mut() {
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        (
            sys.global_cpu_usage(),
            sys.total_memory(),
            sys.used_memory(),
        )
    } else {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let (total_ram, used_ram) = (sys.total_memory(), sys.used_memory());
        *sampler = Some(sys);
        (0.0, total_ram, used_ram)
    };

    let disks = Disks::new_with_refreshed_list();
    let total_disk: u64 = disks.iter().map(|d| d.total_space()).sum();
    let available_disk: u64 = disks.iter().map(|d| d.available_space()).sum();
    let used_disk = total_disk.saturating_sub(available_disk);
    SystemMetrics {
        cpu_usage_percent,
        used_ram_percent: ram_percent(total_ram, used_ram),
        used_disk_percent: percent(used_disk, total_disk),
        active_rtmp_sessions: state.rtmp.lock().len(),
    }
}

fn ram_percent(total: u64, used: u64) -> f32 {
    percent(used, total)
}

fn percent(part: u64, whole: u64) -> f32 {
    if whole == 0 {
        0.0
    } else {
        (part as f64 / whole as f64 * 100.0) as f32
    }
}
