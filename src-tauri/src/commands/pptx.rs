use crate::state::AppState;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct RenderedPptxImport {
    pub id: String,
    pub name: String,
    /// Paths relative to Wordlyte's media directory. The normal slide renderer
    /// resolves these exactly like operator-imported image backgrounds.
    pub slide_paths: Vec<String>,
}

fn validate_source(raw: &str) -> Result<PathBuf, String> {
    if raw.contains('\0') {
        return Err("Invalid PowerPoint path".into());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() || !path.is_file() {
        return Err("The selected PowerPoint file does not exist".into());
    }
    let is_pptx = path
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| v.eq_ignore_ascii_case("pptx"));
    if !is_pptx {
        return Err("Only .pptx files can be imported".into());
    }
    path.canonicalize()
        .map_err(|e| format!("Could not open the PowerPoint file: {e}"))
}

fn slide_number(path: &Path) -> u32 {
    path.file_stem()
        .and_then(|v| v.to_str())
        .map(|name| {
            name.chars()
                .rev()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        })
        .and_then(|digits| digits.parse().ok())
        .unwrap_or(u32::MAX)
}

#[cfg(target_os = "windows")]
fn render_with_powerpoint(source: &Path, output: &Path, script_path: &Path) -> Result<(), String> {
    // `Presentations.Open(..., WithWindow = false)` preserves PowerPoint's own
    // font/layout/media rendering while keeping the conversion window hidden.
    // The source and output paths are positional arguments, never interpolated
    // into the script, so quotes or PowerShell metacharacters in church folder
    // names cannot become executable input.
    const SCRIPT: &str = r#"param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference = 'Stop'
$powerpoint = $null
$presentation = $null
try {
  $powerpoint = New-Object -ComObject PowerPoint.Application
  $presentation = $powerpoint.Presentations.Open($Source, $true, $true, $false)
  $presentation.Export($Output, 'PNG', 1920, 1080)
} finally {
  if ($null -ne $presentation) { $presentation.Close() }
  if ($null -ne $powerpoint) { $powerpoint.Quit() }
  if ($null -ne $presentation) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) }
  if ($null -ne $powerpoint) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerpoint) }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
"#;
    fs::write(script_path, SCRIPT)
        .map_err(|e| format!("Could not prepare the PowerPoint converter: {e}"))?;
    let result = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Sta",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script_path)
        .arg(source)
        .arg(output)
        .output()
        .map_err(|e| format!("Could not start PowerPoint conversion: {e}"))?;
    if result.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
    let detail = if stderr.is_empty() {
        "Microsoft PowerPoint could not render this deck".into()
    } else {
        stderr
    };
    Err(format!(
        "PowerPoint import failed. Install desktop Microsoft PowerPoint and try again. {detail}"
    ))
}

#[cfg(not(target_os = "windows"))]
fn render_with_powerpoint(
    _source: &Path,
    _output: &Path,
    _script_path: &Path,
) -> Result<(), String> {
    Err("Rendered PowerPoint import currently requires Wordlyte for Windows and desktop Microsoft PowerPoint".into())
}

/// Render every PowerPoint slide to a full-HD PNG using the desktop PowerPoint
/// engine. The frontend then stores a regular Wordlyte presentation whose slide
/// backgrounds point at these files; playback has no PowerPoint dependency.
#[tauri::command]
pub async fn import_pptx_rendered(
    state: State<'_, AppState>,
    path: String,
) -> Result<RenderedPptxImport, String> {
    crate::license::ensure_active_tier(&state, crate::license::LicenseTier::Pro)?;
    let source = validate_source(&path)?;
    let app_data = state.app_data_dir.clone();
    let id = Uuid::new_v4().to_string();
    let deck_name = source
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("Imported PowerPoint")
        .to_string();
    let output = app_data.join("media").join("presentations").join(&id);
    let script = app_data.join(format!(".pptx-import-{id}.ps1"));
    let id_for_task = id.clone();

    tokio::task::spawn_blocking(move || {
        fs::create_dir_all(&output)
            .map_err(|e| format!("Could not create the presentation media folder: {e}"))?;
        let conversion = render_with_powerpoint(&source, &output, &script);
        let _ = fs::remove_file(&script);
        if let Err(error) = conversion {
            let _ = fs::remove_dir_all(&output);
            return Err(error);
        }

        let mut images: Vec<PathBuf> = fs::read_dir(&output)
            .map_err(|e| format!("Could not read rendered slides: {e}"))?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .and_then(|v| v.to_str())
                    .is_some_and(|v| v.eq_ignore_ascii_case("png"))
            })
            .collect();
        images.sort_by_key(|path| {
            (
                slide_number(path),
                path.file_name().map(|v| v.to_os_string()),
            )
        });
        if images.is_empty() {
            let _ = fs::remove_dir_all(&output);
            return Err("PowerPoint did not render any slides".into());
        }

        let slide_paths = images
            .into_iter()
            .filter_map(|image| {
                image
                    .file_name()
                    .map(|name| format!("presentations/{id_for_task}/{}", name.to_string_lossy()))
            })
            .collect();
        Ok(RenderedPptxImport {
            id: id_for_task,
            name: deck_name,
            slide_paths,
        })
    })
    .await
    .map_err(|e| format!("PowerPoint import task failed: {e}"))?
}

/// Remove rendered files when persistence fails after conversion. UUID parsing
/// makes the path component traversal-proof.
#[tauri::command]
pub fn discard_pptx_import(state: State<'_, AppState>, id: String) -> Result<(), String> {
    Uuid::parse_str(&id).map_err(|_| "Invalid presentation import id".to_string())?;
    let path = state
        .app_data_dir
        .join("media")
        .join("presentations")
        .join(id);
    if path.exists() {
        fs::remove_dir_all(path).map_err(|e| format!("Could not clean up rendered slides: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_numeric_slide_order() {
        assert_eq!(slide_number(Path::new("Slide2.PNG")), 2);
        assert_eq!(slide_number(Path::new("Slide10.PNG")), 10);
        assert_eq!(slide_number(Path::new("cover.PNG")), u32::MAX);
    }

    #[test]
    fn rejects_non_pptx_source() {
        assert!(validate_source("C:/deck.ppt").is_err());
        assert!(validate_source("deck.pptx").is_err());
    }
}
