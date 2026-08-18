use std::path::PathBuf;
use std::sync::atomic::Ordering;
use serde::{Serialize, Deserialize};
use crate::state::AppState;
use crate::store;
use store::log_msg;
use tauri::{AppHandle, Emitter, Manager, State};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// DB-only Bible data asset: a zip containing just `wordlyte_bible.db` (no
/// sentence-transformer embeddings — the app only reads the SQLite text DB;
/// search is FTS5 keyword, not vector). Uploaded to the v2.0.0 release.
pub const BIBLE_DATA_ZIP_URL: &str = "https://github.com/Niceiyke/bible-presenter/releases/download/v2.0.0/wordlyte_bible.zip";
pub const BIBLE_DB_FILENAME: &str = "wordlyte_bible.db";
/// Pinned SHA-256 of the `wordlyte_bible.zip` asset (computed from the
/// published DB-only zip; recompute after any re-publish):
///   certutil -hashfile wordlyte_bible.zip SHA256
pub const BIBLE_DATA_ZIP_SHA256: Option<&str> =
    Some("3d05357e5d292b74547c544d2a78d58ce7cf1529d2df888de002d00f0c211281");

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

    // Integrity: when a release pins `BIBLE_DATA_ZIP_SHA256`, a mismatched or
    // tampered download is rejected before a single byte is extracted.
    if let Some(expected) = BIBLE_DATA_ZIP_SHA256 {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&data);
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(expected.trim()) {
            anyhow::bail!(
                "Bible data ZIP SHA-256 mismatch (expected {expected}, got {actual}) — refusing to extract a possibly tampered archive."
            );
        }
    }

    extract_zip_bytes(data, target_dir).context("Bible data ZIP extraction failed")?;

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

/// Validates + extracts a fully-downloaded ZIP under `target_dir`. Every entry
/// is validated (no traversal, no absolute paths, containment-checked) before
/// anything is written, and files are staged to temp names then atomically
/// renamed into place — a crash or write failure can never corrupt an existing
/// asset (audit #10).
fn extract_zip_bytes(data: Vec<u8>, target_dir: &std::path::Path) -> anyhow::Result<()> {
    use anyhow::Context;
    use std::path::Path;

    let reader = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(reader).context("Failed to parse zip archive")?;

    let target_folder_name = target_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");

    // ── Phase 1: validate EVERY entry before writing anything ──────────────
    // Path traversal is rejected outright (absolute paths, `..`, `.`, drive
    // letters, UNC roots) and every resolved output path is containment-checked
    // against the target directory.
    let mut plan: Vec<(usize, PathBuf, bool)> = Vec::new(); // (index, outpath, is_dir)
    for i in 0..archive.len() {
        let file = archive.by_index(i).context("Failed to get file from zip")?;
        let name = file.name();
        let is_dir = name.ends_with('/');

        let mut parts: Vec<&str> = name
            .split(['/', '\\'])
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();

        // Reject traversal / absolute components before doing anything else.
        if parts.iter().any(|p| *p == ".." || *p == ".") {
            anyhow::bail!("Archive contains a disallowed path component: {name}");
        }
        for p in &parts {
            if Path::new(p).is_absolute() {
                anyhow::bail!("Archive contains an absolute path: {name}");
            }
        }

        if !parts.is_empty() {
            let first = parts[0];
            if first == target_folder_name || first == "bible_data" || first == "wordlyte_bible" || first == "models" {
                parts.remove(0);
            }
        }

        if parts.is_empty() {
            continue;
        }

        let processed_path: PathBuf = parts.iter().collect();
        if processed_path.is_absolute() {
            anyhow::bail!("Archive entry resolves to an absolute path: {name}");
        }
        let outpath = target_dir.join(processed_path);
        if !outpath.starts_with(target_dir) {
            anyhow::bail!("Archive entry escapes the target directory: {name}");
        }
        plan.push((i, outpath, is_dir));
    }

    // ── Phase 2: extract every file to a temporary sibling, never in place ──
    // A crash or write failure mid-extraction can therefore never corrupt an
    // existing asset: the originals are only replaced atomically in phase 3.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new(); // (tmp, final)
    for (i, outpath, is_dir) in &plan {
        let mut file = archive.by_index(*i).context("Failed to get file from zip")?;
        if *is_dir {
            std::fs::create_dir_all(outpath).context("Failed to create dir")?;
            continue;
        }
        if let Some(p) = outpath.parent() {
            std::fs::create_dir_all(p).context("Failed to create parent dir")?;
        }
        let tmp = outpath.with_extension(format!("part-{stamp}"));
        let mut outfile = std::fs::File::create(&tmp).context("Failed to create output file")?;
        std::io::copy(&mut file, &mut outfile).context("Failed to copy file contents")?;
        staged.push((tmp, outpath.clone()));
    }

    // ── Phase 3: atomically promote the completed files into place ─────────
    for (tmp, final_path) in &staged {
        std::fs::rename(tmp, final_path).context("Failed to finalize extracted file")?;
    }
    for (tmp, _) in &staged {
        let _ = std::fs::remove_file(tmp);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            for (name, data) in entries {
                w.start_file(*name, opts).unwrap();
                w.write_all(data).unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    fn tmp_target(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wordlyte-zip-test-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_path_traversal() {
        let dir = tmp_target("traversal");
        let zip = zip_with(&[("../../evil.txt", b"pwned")]);
        assert!(
            extract_zip_bytes(zip, &dir).is_err(),
            "a traversal entry must be rejected"
        );
        // Nothing escaped the target directory.
        assert!(!dir.parent().unwrap().join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_absolute_paths() {
        let dir = tmp_target("absolute");
        let zip = zip_with(&[("C:/Windows/evil.txt", b"pwned")]);
        assert!(
            extract_zip_bytes(zip, &dir).is_err(),
            "an absolute entry must be rejected"
        );
        // Nothing was written outside the target directory.
        let entries: Vec<String> = std::fs::read_dir(&dir)
            .map(|es| es.filter_map(|x| x.ok()).map(|x| x.file_name().to_string_lossy().to_string()).collect())
            .unwrap_or_default();
        assert!(entries.is_empty(), "no file should be extracted: {entries:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_normally_within_target() {
        let dir = tmp_target("normal");
        let zip = zip_with(&[("bible_data/wordlyte_bible.db", b"sqlite-bytes")]);
        extract_zip_bytes(zip, &dir).unwrap();
        let out = dir.join("wordlyte_bible.db");
        assert!(out.exists());
        assert_eq!(std::fs::read(&out).unwrap(), b"sqlite-bytes");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_root_level_db_entry() {
        // The published DB-only asset lays the db at the zip root.
        let dir = tmp_target("rootdb");
        let zip = zip_with(&[("wordlyte_bible.db", b"sqlite-bytes")]);
        extract_zip_bytes(zip, &dir).unwrap();
        assert_eq!(std::fs::read(dir.join("wordlyte_bible.db")).unwrap(), b"sqlite-bytes");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

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

    // Storage failures set at startup (e.g. data DB fell back to in-memory) are
    // surfaced here so the operator banner shows them instead of hiding a valid
    // installation behind an empty workspace.
    issues.extend(state.startup_issues.lock().iter().cloned());
    issues.extend(state.media_schedule.startup_issues.lock().iter().cloned());

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
