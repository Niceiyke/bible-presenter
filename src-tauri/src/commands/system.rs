use crate::commands::rtmp;
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
    SystemInfo {
        cpu_model: cpu.unwrap_or_else(|| "Unknown CPU".into()),
        physical_cores: sys.physical_core_count(),
        total_ram_mb: sys.total_memory() / (1024 * 1024),
        total_disk_mb: total_disk / (1024 * 1024),
        ffmpeg_available: rtmp::ffmpeg_available(),
    }
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
        (sys.global_cpu_usage(), sys.total_memory(), sys.used_memory())
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