use crate::state::AppState;
use crate::store;
use crate::events::emit_checked;
use tauri::{AppHandle, State};

/// Reject prop paths that fall outside the app data directory (or are not
/// already-relative to it). This keeps the output window from rendering
/// arbitrary files on disk and makes prop libraries portable across machines.
fn validate_prop_path(path: &str, app_data_dir: &std::path::Path) -> Result<(), String> {
    // Relative paths (stored by relativizePath on the frontend) are always OK.
    let is_absolute = path.starts_with('/')
        || (path.len() >= 2 && path.as_bytes()[1] == b'\\')
        || (path.len() >= 2 && path.as_bytes()[1] == b':');
    if !is_absolute {
        return Ok(());
    }
    let canonical = std::fs::canonicalize(path).map_err(|e| format!("Prop path not accessible: {}", e))?;
    let base = std::fs::canonicalize(app_data_dir).unwrap_or_else(|_| app_data_dir.to_path_buf());
    if canonical.starts_with(&base) {
        Ok(())
    } else {
        Err(format!("Prop path must be inside the app data folder: {}", path))
    }
}

#[tauri::command]
pub async fn get_props(state: State<'_, AppState>) -> Result<Vec<store::PropItem>, String> {
    let current = state.presentation.props_layer.lock().clone();
    if current.is_empty() {
        if let Ok(loaded) = state.media_schedule.load_props() {
            if !loaded.is_empty() {
                *state.presentation.props_layer.lock() = loaded.clone();
                return Ok(loaded);
            }
        }
    }
    Ok(current)
}

#[tauri::command]
pub async fn set_props(app: AppHandle, state: State<'_, AppState>, props: Vec<store::PropItem>) -> Result<(), String> {
    // Validate any image prop paths before accepting the batch.
    for p in &props {
        if let Some(path) = &p.path {
            if p.kind == "image" && !path.is_empty() {
                validate_prop_path(path, &state.app_data_dir)?;
            }
        }
    }
    // Persist BEFORE mutating so a write failure never leaves the in-memory
    // and on-disk layers diverging, and the caller can roll back cleanly.
    state.media_schedule.save_props(&props).map_err(|e| e.to_string())?;
    *state.presentation.props_layer.lock() = props.clone();
    emit_checked(&app, "props-update", &props);
    Ok(())
}
