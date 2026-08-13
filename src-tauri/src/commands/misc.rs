use crate::state::AppState;
use crate::store::{self, log_msg};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub async fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    app.path().app_local_data_dir()
        .or_else(|_| app.path().app_data_dir())
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// P2.5: a single user-installed font variant returned by `list_fonts`.
///
/// `family_name` is the `font-family` value the frontend injects into
/// `@font-face` (and the value the operator picks in the font dropdown).
/// `file_name` is the bare file name (for display); `path` is the
/// absolute filesystem path the frontend hands to `convertFileSrc` so
/// the webview can fetch the font via the `asset:` protocol.
#[derive(Debug, Clone, Serialize)]
pub struct FontFile {
    pub file_name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FontMeta {
    pub family_name: String,
    pub files: Vec<FontFile>,
}

/// P2.5: scan `{AppLocalData}/com.biblepresenter.rs/fonts/` for
/// user-installed fonts. Files are grouped by their stem (everything up
/// to the first `-` or `_`); e.g. `Montserrat-Regular.ttf`,
/// `Montserrat-Bold.ttf`, `Montserrat-Italic.ttf` all fold into the
/// single family `Montserrat`. The grouping is intentionally naive —
/// Tauri's webview handles the actual weight/style assignment via the
/// `@font-face` rule the frontend emits.
///
/// Returns an empty vector if the directory does not exist yet (the
/// frontend creates it on demand when the user adds a font).
#[tauri::command]
pub async fn list_fonts(app: AppHandle) -> Result<Vec<FontMeta>, String> {
    let base = font_dir(&app).map_err(|e| e.to_string())?;
    if !base.exists() {
        return Ok(Vec::new());
    }

    let mut families: std::collections::BTreeMap<String, Vec<FontFile>> = std::collections::BTreeMap::new();
    let read = match std::fs::read_dir(&base) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };

    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
        if !matches!(ext.as_str(), "ttf" | "otf" | "woff" | "woff2") {
            continue;
        }
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(&file_name).to_string();
        // Strip the conventional weight/style suffix so the family name
        // matches what the user expects in a dropdown. e.g.
        // `Montserrat-BoldItalic` -> `Montserrat`.
        let family = stem
            .split(['-', '_'])
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or(&stem)
            .trim()
            .to_string();
        families.entry(family).or_default().push(FontFile {
            file_name: file_name.clone(),
            path: path.to_string_lossy().to_string(),
        });
    }

    Ok(families
        .into_iter()
        .map(|(family_name, mut files)| {
            files.sort_by(|a, b| a.file_name.cmp(&b.file_name));
            FontMeta { family_name, files }
        })
        .collect())
}

/// Resolve the well-known fonts directory under the app's local data
/// folder. Exposed as a helper so the frontend can request an
/// `asset:` URL pointing straight at a font file without re-deriving
/// the path.
pub fn font_dir(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let base = app
        .path()
        .app_local_data_dir()
        .or_else(|_| app.path().app_data_dir())?;
    Ok(base.join("fonts"))
}

#[tauri::command]
pub async fn get_hymn_library(app: AppHandle) -> Result<Vec<store::Song>, String> {
    let resolver = app.path();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = resolver.resource_dir() { candidates.push(p); }
    if let Ok(exe) = std::env::current_exe() { if let Some(dir) = exe.parent() { candidates.push(dir.to_path_buf()); } }
    if let Ok(cwd) = std::env::current_dir() { candidates.push(cwd); }

    // Resolve the FIRST readable, non-empty file. If a candidate exists but is
    // empty or malformed (e.g. a stale copy or a manual edit elsewhere), log it
    // and fall through to the next candidate instead of silently shipping a
    // truncated library — a "only 2 hymns" symptom usually means the app read
    // the wrong file on disk.
    for p in candidates {
        let path = p.join("bible_data/hymns.json");
        if !path.exists() {
            continue;
        }
        let json = std::fs::read_to_string(&path)
            .map_err(|e| format!("hymns.json unreadable at {}: {e}", path.display()))?;
        match serde_json::from_str::<Vec<store::Song>>(&json) {
            Ok(hymns) if !hymns.is_empty() => {
                log_msg(&app, &format!("Hymn library: loaded {} hymns from {}", hymns.len(), path.display()));
                return Ok(hymns);
            }
            Ok(_) => {
                log_msg(&app, &format!("Hymn library: empty at {}, checking next source", path.display()));
            }
            Err(e) => {
                log_msg(&app, &format!("Hymn library: unparseable at {} ({e}), checking next source", path.display()));
            }
        }
    }
    Ok(Vec::new())
}

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Persist an arbitrary JSON blob (operator workspace: recents, schedule
/// undo/redo stacks) under a named key in the data DB.
#[tauri::command]
pub async fn save_workspace(state: State<'_, AppState>, key: String, value: serde_json::Value) -> Result<(), String> {
    state.media_schedule.save_workspace_blob(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_workspace(state: State<'_, AppState>, key: String) -> Result<Option<serde_json::Value>, String> {
    state.media_schedule.load_workspace_blob(&key).map_err(|e| e.to_string())
}
