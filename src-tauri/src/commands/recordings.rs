use crate::license::{ensure_active_tier, LicenseTier};
use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

/// A saved recording file on disk.
#[derive(Debug, Clone, Serialize)]
pub struct RecordingFile {
    pub name: String,
    pub size: u64,
    /// Unix ms of last modification.
    pub modified: u64,
}

/// Resolve the recordings directory (app-data/recordings), creating it if
/// needed. MediaRecorder files live outside the SQLite data DB — they are
/// large binary assets, like the media library's files.
fn recordings_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    let dir = base.join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create recordings dir: {}", e))?;
    Ok(dir)
}

/// Documented maximum accepted recording size. The frontend refuses to convert
/// larger blobs to base64, and the backend rejects them before decoding — an
/// unbounded IPC payload could spike memory or stall the runtime workers.
const MAX_RECORDING_BYTES: usize = 2 * 1024 * 1024 * 1024; // 2 GiB

fn safe_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Recording name is empty".into());
    }
    // Keep the extension (should be .webm) but strip any path traversal.
    let file = Path::new(name)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(name);
    Ok(file.to_string())
}

/// List saved recordings, newest first.
#[tauri::command]
pub async fn recordings_list(app: AppHandle) -> Result<Vec<RecordingFile>, String> {
    let dir = recordings_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(RecordingFile {
            name: entry.file_name().to_string_lossy().to_string(),
            size: meta.len(),
            modified,
        });
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.modified));
    Ok(out)
}

/// Persist a completed recording's bytes to the recordings dir. The frontend
/// sends the assembled WebM blob as a base64 string (same transport as
/// `save_camera_snapshot`) — large files over the IPC channel are decoded
/// off the runtime worker thread and written atomically (temp + rename), so a
/// save can never stall the command pipeline or leave a truncated file behind.
#[tauri::command]
pub async fn recording_save(
    app: AppHandle,
    state: State<'_, AppState>,
    file_name: String,
    data_base64: String,
) -> Result<RecordingFile, String> {
    // Recording is a paid feature — enforce on the backend, not just the UI.
    ensure_active_tier(&state, LicenseTier::Pro)?;

    // Reject oversized payloads BEFORE decoding: base64 of N bytes is ~4N/3
    // characters, so an oversized string cannot possibly hold a valid recording.
    let max_b64 = MAX_RECORDING_BYTES.div_ceil(3) * 4;
    if data_base64.len() > max_b64 {
        return Err(format!(
            "Recording exceeds the {} GiB limit.",
            MAX_RECORDING_BYTES / (1024 * 1024 * 1024)
        ));
    }

    let name = safe_name(&file_name)?;
    let dir = recordings_dir(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let data = base64::engine::general_purpose::STANDARD
            .decode(data_base64)
            .map_err(|e| format!("Invalid recording data: {}", e))?;
        if data.len() > MAX_RECORDING_BYTES {
            return Err(format!(
                "Recording exceeds the {} GiB limit.",
                MAX_RECORDING_BYTES / (1024 * 1024 * 1024)
            ));
        }
        let path = dir.join(&name);
        // Atomic write: temp file in the same directory, then rename over the
        // target so a crash mid-write can never leave a truncated recording.
        let tmp = dir.join(format!(".{}.part", name));
        std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok(RecordingFile {
            name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
            size: meta.len(),
            modified,
        })
    })
    .await
    .map_err(|e| format!("recording_save join error: {e}"))?
}

/// Delete a saved recording.
#[tauri::command]
pub async fn recording_delete(app: AppHandle, file_name: String) -> Result<(), String> {
    let name = safe_name(&file_name)?;
    let dir = recordings_dir(&app)?;
    let path = dir.join(name);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Reveal the recordings folder in the OS file manager.
#[tauri::command]
pub async fn recordings_open_folder(app: AppHandle) -> Result<(), String> {
    let dir = recordings_dir(&app)?;
    open_path(&dir);
    Ok(())
}

/// Best-effort platform reveal (Windows Explorer / macOS Finder / Linux).
fn open_path(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(path).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(path).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(path).spawn();
    }
}