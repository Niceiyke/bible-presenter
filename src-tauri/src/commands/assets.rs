use std::path::PathBuf;
use std::sync::atomic::Ordering;
use serde::{Serialize, Deserialize};
use crate::state::AppState;
use crate::store;
use store::log_msg;
use tauri::{AppHandle, Emitter, State};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

pub const BIBLE_DATA_ZIP_URL: &str = "https://github.com/Niceiyke/bible-presenter/releases/download/v1.0-models/bible_data.zip";
pub const BIBLE_DB_FILENAME: &str = "wordlyte_bible.db";

// ---------------------------------------------------------------------------
// Download progress
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub model_id: String,
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    pub percent: f32,
    pub done: bool,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

pub fn user_data_dir(app_data: &std::path::Path) -> PathBuf {
    app_data.join("bible_data")
}

pub fn bible_db_path(app_data: &std::path::Path, resource_path: &std::path::Path) -> PathBuf {
    let user_path = user_data_dir(app_data).join(BIBLE_DB_FILENAME);
    if user_path.exists() { return user_path; }
    resource_path.join(format!("bible_data/{}", BIBLE_DB_FILENAME))
}

// ---------------------------------------------------------------------------
// Download utilities
// ---------------------------------------------------------------------------

pub async fn download_and_extract_zip<F>(
    url: &str,
    model_id: &str,
    target_dir: &std::path::Path,
    cancel_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    mut progress_cb: F,
) -> anyhow::Result<()>
where
    F: FnMut(DownloadProgress) + Send + 'static,
{
    use anyhow::Context;
    use futures_util::StreamExt;
    use reqwest::Client;

    std::fs::create_dir_all(target_dir)
        .with_context(|| format!("Cannot create dir {:?}", target_dir))?;

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .context("Failed to build HTTP client")?;

    let response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("GET {} failed", url))?;

    if !response.status().is_success() {
        anyhow::bail!("HTTP {} for {}", response.status(), url);
    }

    let total_bytes = response.content_length().unwrap_or(0);
    let mut bytes_downloaded: u64 = 0;
    let mut data = if total_bytes > 0 {
        Vec::with_capacity(total_bytes as usize)
    } else {
        Vec::new()
    };

    let mut stream = response.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        if !cancel_flag.load(Ordering::Relaxed) {
            anyhow::bail!("Download cancelled");
        }
        let chunk = chunk_result.context("Stream error")?;
        data.extend_from_slice(&chunk);
        bytes_downloaded += chunk.len() as u64;

        let percent = if total_bytes > 0 {
            (bytes_downloaded as f32 / total_bytes as f32) * 100.0
        } else {
            0.0
        };
        progress_cb(DownloadProgress {
            model_id: model_id.to_string(),
            bytes_downloaded,
            total_bytes,
            percent,
            done: false,
            error: None,
        });
    }

    let reader = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(reader).context("Failed to parse zip archive")?;

    let target_folder_name = target_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).context("Failed to get file from zip")?;
        let name = file.name();

        let mut parts: Vec<&str> = name.split('/')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();

        if !parts.is_empty() {
            let first = parts[0];
            if first == target_folder_name || first == "bible_data" || first == "models" {
                parts.remove(0);
            }
        }

        if parts.is_empty() {
            continue;
        }

        let processed_path: PathBuf = parts.iter().collect();
        let outpath = target_dir.join(processed_path);

        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath).context("Failed to create dir")?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    std::fs::create_dir_all(p).context("Failed to create parent dir")?;
                }
            }
            let mut outfile = std::fs::File::create(&outpath).context("Failed to create output file")?;
            std::io::copy(&mut file, &mut outfile).context("Failed to copy file contents")?;
        }
    }

    progress_cb(DownloadProgress {
        model_id: model_id.to_string(),
        bytes_downloaded,
        total_bytes,
        percent: 100.0,
        done: true,
        error: None,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Asset commands
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct StartupStatus {
    pub db_ok: bool,
    pub db_path: String,
    pub issues: Vec<String>,
}

#[tauri::command]
pub async fn get_startup_status(app: AppHandle, state: State<'_, AppState>) -> Result<StartupStatus, String> {
    let mut issues = Vec::new();
    let resource_path = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));

    let db_path = bible_db_path(&state.app_data_dir, &resource_path);
    let db_ok = db_path.exists();

    if !db_ok {
        issues.push("Bible database not found. Please download it in Settings.".to_string());
    }

    Ok(StartupStatus { db_ok, db_path: db_path.display().to_string(), issues })
}

#[tauri::command]
pub async fn download_bible_db_cmd(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    log_msg(&app, "Command received: download_bible_db_cmd");
    if state.download_in_progress.load(Ordering::Relaxed) {
        return Err("Another download is already in progress.".into());
    }
    state.download_in_progress.store(true, Ordering::SeqCst);
    let app_data = state.app_data_dir.clone();
    let cancel_flag = state.download_in_progress.clone();
    let app_handle = app.clone();

    tokio::spawn(async move {
        let res = download_and_extract_zip(
            BIBLE_DATA_ZIP_URL, "bible_db",
            &user_data_dir(&app_data), cancel_flag.clone(),
            { let app_handle = app_handle.clone(); move |progress| { let _ = app_handle.emit("download-progress", progress); } },
        ).await;
        cancel_flag.store(false, Ordering::SeqCst);
        match res {
            Ok(_) => {
                log_msg(&app_handle, "Bible data ZIP downloaded and extracted successfully.");
                let path = user_data_dir(&app_data).join(BIBLE_DB_FILENAME);
                let _ = app_handle.emit("bible-db-ready", path.to_string_lossy());
            }
            Err(e) => {
                log_msg(&app_handle, &format!("Bible data ZIP download failed: {}", e));
                let _ = app_handle.emit("download-error", e.to_string());
            }
        }
    });
    Ok(())
}
