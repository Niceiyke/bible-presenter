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
/// needed. The engine's MP4 files land here (Phase D); listing/delete/open
/// operate on whatever is in the folder, engine- or legacy-written.
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

/// Sanitize a user-supplied file name: keep the bare file name (stripping any
/// path traversal) and reject empty names.
fn safe_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Recording name is empty".into());
    }
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

/// Start recording the engine's program feed to `{recordings dir}/{file_name}`.
/// The engine boots the shared encoder (or reuses a running one) and muxes a
/// fragmented MP4 with `-c copy`. The `file_name` is sanitized so the resolved
/// path stays inside the recordings dir.
#[tauri::command]
pub async fn recording_start(
    app: AppHandle,
    state: State<'_, AppState>,
    file_name: String,
    fps: Option<u32>,
) -> Result<(), String> {
    // Recording is a paid feature — enforce on the backend, not just the UI.
    ensure_active_tier(&state, LicenseTier::Pro)?;
    let fps = fps.unwrap_or(30);
    crate::commands::rtmp::validate_fps(fps)?;
    let name = safe_name(&file_name)?;
    let dir = recordings_dir(&app)?;
    let path = dir.join(name);
    let (width, height) = crate::commands::engine::transport_geometry(&state, (1920, 1080));
    let reply = crate::commands::engine::invoke(
        &state,
        crate::engine::ipc::EngineCommand::RecordingStart {
            session_id: format!("recording-{}", path.display()),
            path: path.to_string_lossy().to_string(),
            fps,
            width,
            height,
        },
    )
    .await?;
    crate::commands::engine::response_err(&reply).map_or(Ok(()), Err)
}

/// Stop the active recording. Idempotent — stopping an unknown recording is a
/// no-op. The engine drops the session's feed (EOF to ffmpeg -> finalize the
/// MP4) and reaps the muxer.
#[tauri::command]
pub async fn recording_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    file_name: String,
) -> Result<(), String> {
    let name = safe_name(&file_name)?;
    let dir = recordings_dir(&app)?;
    let path = dir.join(name);
    let reply = crate::commands::engine::invoke(
        &state,
        crate::engine::ipc::EngineCommand::RecordingStop {
            session_id: format!("recording-{}", path.display()),
        },
    )
    .await?;
    crate::commands::engine::response_err(&reply).map_or(Ok(()), Err)
}

/// Runtime status of the engine's recording session (ephemeral, not
/// persisted). Never throws — an unreachable sidecar simply reports no
/// sessions, mirroring `rtmp_status`.
#[tauri::command]
pub async fn recording_status(state: State<'_, AppState>) -> Result<Vec<crate::commands::rtmp::RtmpStatus>, String> {
    let Ok(reply) = crate::commands::engine::invoke(
        &state,
        crate::engine::ipc::EngineCommand::RecordingStatus,
    )
    .await
    else {
        return Ok(Vec::new());
    };
    let sessions = reply
        .response
        .result
        .and_then(|r| r.get("sessions").cloned())
        .and_then(|s| serde_json::from_value::<Vec<crate::commands::rtmp::RtmpStatus>>(s).ok())
        .unwrap_or_default();
    Ok(sessions)
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