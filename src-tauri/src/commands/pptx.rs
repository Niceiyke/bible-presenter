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
    //
    // Every COM step wraps its failure with the step name + HRESULT so a failed
    // import tells the desktop report exactly which operation could not run,
    // instead of a bare COMException trace back to the generated .ps1.
    const SCRIPT: &str = r#"param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference = 'Stop'
$powerpoint = $null
$presentation = $null
$clean = $null

function Report-Failure {
  param([string]$Step, [string]$Guidance, [System.Exception]$Underlying)
  $hresult = if ($null -ne $Underlying) { ("0x{0:X8}" -f $Underlying.HResult) } else { "" }
  Write-Error ("[Wordlyte pptx] {0} failed (hresult={1}) source={2}: {3} {4}" -f $Step, $hresult, $Source, $Underlying.Message, $Guidance) -ErrorAction Stop
}

try {
  # PowerPoint COM launches a fresh POWERPNT.EXE; the first launch can
  # transiently refuse right after boot or after an Office update, so it
  # retries once before reporting a failure.
  $createError = $null
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      $powerpoint = New-Object -ComObject PowerPoint.Application
      break
    } catch {
      $createError = $_
      $powerpoint = $null
      Start-Sleep -Seconds 2
    }
  }
  if ($null -eq $powerpoint) {
    Report-Failure 'start PowerPoint' 'Is desktop Microsoft PowerPoint installed and activated?' $createError.Exception
  }

  # Decks emailed or downloaded to the church carry a Mark-of-the-Web zone and
  # some Office zone policies refuse those files in automation. Convert from
  # the converter's own unzoned copy so the operator file stays untouched.
  try {
    $clean = Join-Path ([System.IO.Path]::GetTempPath()) ("pptx-import-" + [Guid]::NewGuid().ToString() + ".pptx")
    Copy-Item -LiteralPath $Source -Destination $clean -Force
    Unblock-File -LiteralPath $clean
  } catch {
    Report-Failure 'prepare conversion copy' 'Check the deck file is readable and not locked by another program.' $_.Exception
  }

  # ReadOnly: never modify the operator deck. Untitled: converts an opened
  # copy. WithWindow=false keeps the conversion window hidden.
  try {
    $presentation = $powerpoint.Presentations.Open($clean, $true, $true, $false)
  } catch {
    Report-Failure 'open presentation' 'Try closing PowerPoint and importing again.' $_.Exception
  }
  try {
    $presentation.Export($Output, 'PNG', 1920, 1080)
  } catch {
    Report-Failure 'render slides' 'Try closing PowerPoint and importing again.' $_.Exception
  }
} finally {
  if ($null -ne $presentation) { try { $presentation.Close() } catch { } }
  if ($null -ne $powerpoint) { try { $powerpoint.Quit() } catch { } }
  if ($null -ne $presentation) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) } catch { } }
  if ($null -ne $powerpoint) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerpoint) } catch { } }
  if ($null -ne $clean -and (Test-Path -LiteralPath $clean)) { Remove-Item -LiteralPath $clean -Force -ErrorAction SilentlyContinue }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
"#;
    fs::write(script_path, SCRIPT)
        .map_err(|e| format!("Could not prepare the PowerPoint converter: {e}"))?;
    let mut command = Command::new("powershell.exe");
    command
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
        .arg(output);
    let result = crate::binpaths::hide_console(&mut command)
        .output()
        .map_err(|e| format!("Could not start PowerPoint conversion: {e}"))?;
    if result.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
    let detail = if stderr.is_empty() {
        "no error detail was reported".into()
    } else {
        stderr
    };
    Err(format!("PowerPoint could not convert this deck. {detail}"))
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
