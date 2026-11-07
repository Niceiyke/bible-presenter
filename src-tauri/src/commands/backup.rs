use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, State};
use uuid::Uuid;
use zip::write::SimpleFileOptions;

const BACKUP_SCHEMA: u32 = 1;
const MANIFEST_NAME: &str = "manifest.json";
const DB_ENTRY: &str = "data/wordlyte_data.db";
const PENDING_MARKER: &str = "restore_pending.json";
const RESTORABLE_DIRS: &[&str] = &["media", "thumbnails", "fonts", "presentation_imports"];
const RESTORABLE_FILES: &[&str] = &["outputs.json"];
const DATABASE_SIDECARS: &[&str] = &["wordlyte_data.db-wal", "wordlyte_data.db-shm"];

#[derive(Debug, Serialize, Deserialize)]
struct BackupManifest {
    product: String,
    schema: u32,
    app_version: String,
    created_at: u64,
    includes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PendingRestore {
    staging_dir: String,
}

#[derive(Debug, Serialize)]
pub struct BackupResult {
    pub path: String,
    pub files: usize,
    pub verified: bool,
}

fn validate_backup_path(raw: &str, must_exist: bool) -> Result<PathBuf, String> {
    if raw.contains('\0') {
        return Err("Invalid backup path".into());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("Backup path must be absolute".into());
    }
    if raw.split(['/', '\\']).any(|part| part == "..") {
        return Err("Backup path must not contain traversal components".into());
    }
    let valid_ext = path
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| v.eq_ignore_ascii_case("wordlyte-backup"));
    if !valid_ext {
        return Err("Wordlyte backups must use the .wordlyte-backup extension".into());
    }
    if must_exist && !path.is_file() {
        return Err("Backup file does not exist".into());
    }
    Ok(path)
}

fn safe_archive_path(name: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(name.replace('\\', "/"));
    if path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(format!("Unsafe backup entry: {name}"));
    }
    Ok(path)
}

fn add_file(
    zip: &mut zip::ZipWriter<File>,
    source: &Path,
    archive_name: &str,
) -> Result<(), String> {
    zip.start_file(
        archive_name.replace('\\', "/"),
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
    )
    .map_err(|e| e.to_string())?;
    let mut file = File::open(source).map_err(|e| e.to_string())?;
    std::io::copy(&mut file, zip).map_err(|e| e.to_string())?;
    Ok(())
}

fn add_dir(
    zip: &mut zip::ZipWriter<File>,
    root: &Path,
    current: &Path,
    count: &mut usize,
) -> Result<(), String> {
    if !current.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(current).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            add_dir(zip, root, &path, count)?;
        } else if path.is_file() {
            let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
            add_file(
                zip,
                &path,
                &format!("data/{}", relative.to_string_lossy().replace('\\', "/")),
            )?;
            *count += 1;
        }
    }
    Ok(())
}

/// Re-open a completed archive before reporting success. This catches truncated
/// ZIPs and missing core entries immediately, rather than during a Sunday
/// morning restore. Full database integrity is checked again by
/// `backup_stage_restore` after extraction.
fn verify_backup_archive(path: &Path) -> Result<(), String> {
    let file = File::open(path).map_err(|e| format!("Could not reopen backup: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Backup verification failed: {e}"))?;
    {
        let mut manifest = archive
            .by_name(MANIFEST_NAME)
            .map_err(|_| "Backup verification failed: manifest is missing".to_string())?;
        let mut json = String::new();
        manifest
            .read_to_string(&mut json)
            .map_err(|e| format!("Backup verification failed reading manifest: {e}"))?;
        let manifest: BackupManifest = serde_json::from_str(&json)
            .map_err(|e| format!("Backup verification failed parsing manifest: {e}"))?;
        if manifest.product != "Wordlyte" || manifest.schema > BACKUP_SCHEMA {
            return Err("Backup verification failed: unsupported manifest".into());
        }
    }
    let mut database = archive
        .by_name(DB_ENTRY)
        .map_err(|_| "Backup verification failed: database is missing".to_string())?;
    let mut database_bytes = Vec::new();
    database
        .read_to_end(&mut database_bytes)
        .map_err(|e| format!("Backup verification failed reading database: {e}"))?;
    if database_bytes.is_empty() {
        return Err("Backup verification failed: database is empty".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn backup_create(
    state: State<'_, AppState>,
    path: String,
) -> Result<BackupResult, String> {
    let destination = validate_backup_path(&path, false)?;
    if destination.starts_with(&state.app_data_dir) {
        return Err("Save backups outside Wordlyte's app-data directory".into());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let temp_db = state
        .app_data_dir
        .join(format!(".backup-{}.db", Uuid::new_v4()));
    state
        .media_schedule
        .backup_database(&temp_db)
        .map_err(|e| format!("Could not snapshot database: {e}"))?;

    let result = (|| {
        let file = File::create(&destination).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(file);
        let manifest = BackupManifest {
            product: "Wordlyte".into(),
            schema: BACKUP_SCHEMA,
            app_version: env!("CARGO_PKG_VERSION").into(),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            includes: std::iter::once("database".to_string())
                .chain(RESTORABLE_DIRS.iter().map(|v| (*v).to_string()))
                .chain(RESTORABLE_FILES.iter().map(|v| (*v).to_string()))
                .collect(),
        };
        zip.start_file(MANIFEST_NAME, SimpleFileOptions::default())
            .map_err(|e| e.to_string())?;
        zip.write_all(
            serde_json::to_string_pretty(&manifest)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
        .map_err(|e| e.to_string())?;
        add_file(&mut zip, &temp_db, DB_ENTRY)?;
        let mut count = 1usize;
        for dir in RESTORABLE_DIRS {
            add_dir(
                &mut zip,
                &state.app_data_dir,
                &state.app_data_dir.join(dir),
                &mut count,
            )?;
        }
        for name in RESTORABLE_FILES {
            let source = state.app_data_dir.join(name);
            if source.is_file() {
                add_file(&mut zip, &source, &format!("data/{name}"))?;
                count += 1;
            }
        }
        zip.finish().map_err(|e| e.to_string())?;
        verify_backup_archive(&destination)?;
        Ok(BackupResult {
            path: destination.to_string_lossy().to_string(),
            files: count,
            verified: true,
        })
    })();
    let _ = fs::remove_file(temp_db);
    if result.is_err() {
        let _ = fs::remove_file(&destination);
    }
    result
}

#[tauri::command]
pub async fn backup_stage_restore(state: State<'_, AppState>, path: String) -> Result<(), String> {
    if state.app_data_dir.join(PENDING_MARKER).exists() {
        return Err("A validated restore is already pending. Restart Wordlyte before choosing another backup.".into());
    }
    let source = validate_backup_path(&path, true)?;
    let file = File::open(source).map_err(|e| e.to_string())?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Invalid backup archive: {e}"))?;
    let manifest: BackupManifest = {
        let mut entry = archive
            .by_name(MANIFEST_NAME)
            .map_err(|_| "Backup manifest is missing".to_string())?;
        let mut json = String::new();
        entry.read_to_string(&mut json).map_err(|e| e.to_string())?;
        serde_json::from_str(&json).map_err(|e| format!("Invalid backup manifest: {e}"))?
    };
    if manifest.product != "Wordlyte" {
        return Err("This is not a Wordlyte backup".into());
    }
    if manifest.schema > BACKUP_SCHEMA {
        return Err("This backup was created by a newer Wordlyte version".into());
    }

    let staging_name = format!("restore-{}", Uuid::new_v4());
    let staging_root = state
        .app_data_dir
        .join("restore-staging")
        .join(&staging_name);
    fs::create_dir_all(&staging_root).map_err(|e| e.to_string())?;
    let extraction = (|| {
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
            let name = entry.name().to_string();
            if name == MANIFEST_NAME {
                continue;
            }
            let relative = safe_archive_path(&name)?;
            let relative = relative
                .strip_prefix("data")
                .map_err(|_| format!("Unexpected backup entry: {name}"))?;
            let first = relative
                .components()
                .next()
                .and_then(|c| match c {
                    Component::Normal(v) => v.to_str(),
                    _ => None,
                })
                .unwrap_or("");
            let allowed = first == "wordlyte_data.db"
                || RESTORABLE_DIRS.contains(&first)
                || RESTORABLE_FILES.contains(&first);
            if !allowed {
                return Err(format!("Backup contains an unsupported entry: {name}"));
            }
            let output = staging_root.join(relative);
            if entry.is_dir() {
                fs::create_dir_all(&output).map_err(|e| e.to_string())?;
                continue;
            }
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = File::create(&output).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
        if !staging_root.join("wordlyte_data.db").is_file() {
            return Err("Backup database is missing".into());
        }
        // Prove the restored DB is readable before scheduling it for startup.
        let db = rusqlite::Connection::open_with_flags(
            staging_root.join("wordlyte_data.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("Backup database is invalid: {e}"))?;
        db.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .map_err(|e| format!("Backup database check failed: {e}"))
            .and_then(|v| {
                if v == "ok" {
                    Ok(())
                } else {
                    Err(format!("Backup database is corrupt: {v}"))
                }
            })?;
        Ok(())
    })();
    if let Err(error) = extraction {
        let _ = fs::remove_dir_all(&staging_root);
        return Err(error);
    }

    let marker = PendingRestore {
        staging_dir: staging_name,
    };
    fs::write(
        state.app_data_dir.join(PENDING_MARKER),
        serde_json::to_vec_pretty(&marker).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restart_application(app: AppHandle) {
    app.restart();
}

/// Apply a fully validated pending restore before SQLite or any media store is
/// opened. Existing data is retained in a timestamped pre-restore directory.
pub fn apply_pending_restore(app_data_dir: &Path) -> Result<Option<PathBuf>, String> {
    let marker_path = app_data_dir.join(PENDING_MARKER);
    if !marker_path.is_file() {
        return Ok(None);
    }
    let marker: PendingRestore =
        serde_json::from_slice(&fs::read(&marker_path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Invalid pending restore marker: {e}"))?;
    if marker.staging_dir.contains(['/', '\\']) || !marker.staging_dir.starts_with("restore-") {
        return Err("Invalid pending restore directory".into());
    }
    let staging = app_data_dir
        .join("restore-staging")
        .join(&marker.staging_dir);
    if !staging.join("wordlyte_data.db").is_file() {
        return Err("Pending restore database is missing".into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let previous = app_data_dir.join(format!("pre-restore-{stamp}-{}", Uuid::new_v4()));
    fs::create_dir_all(&previous).map_err(|e| e.to_string())?;

    let mut names = vec!["wordlyte_data.db"];
    names.extend_from_slice(RESTORABLE_DIRS);
    names.extend_from_slice(RESTORABLE_FILES);
    names.extend_from_slice(DATABASE_SIDECARS);
    let mut preserved = Vec::new();
    for name in &names {
        let current = app_data_dir.join(name);
        if current.exists() {
            if let Err(error) = fs::rename(&current, previous.join(name)) {
                for moved in preserved.iter().rev() {
                    let _ = fs::rename(previous.join(moved), app_data_dir.join(moved));
                }
                let _ = fs::remove_dir(&previous);
                return Err(format!("Could not preserve {name}: {error}"));
            }
            preserved.push(*name);
        }
    }
    let mut installed = Vec::new();
    for name in &names {
        let incoming = staging.join(name);
        if incoming.exists() {
            if let Err(error) = fs::rename(&incoming, app_data_dir.join(name)) {
                // Put incoming data back into staging, then restore every
                // preserved current item. The pending marker remains so the
                // operator can fix the filesystem issue and retry safely.
                for moved in installed.iter().rev() {
                    let _ = fs::rename(app_data_dir.join(moved), staging.join(moved));
                }
                for moved in preserved.iter().rev() {
                    let _ = fs::rename(previous.join(moved), app_data_dir.join(moved));
                }
                let _ = fs::remove_dir(&previous);
                return Err(format!("Could not restore {name}: {error}"));
            }
            installed.push(*name);
        }
    }
    fs::remove_file(marker_path).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(staging);
    Ok(Some(previous))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_paths_require_absolute_custom_extension() {
        assert!(validate_backup_path("backup.wordlyte-backup", false).is_err());
        assert!(validate_backup_path("C:/Users/test/backup.zip", false).is_err());
        assert!(validate_backup_path("C:/Users/test/backup.wordlyte-backup", false).is_ok());
    }

    #[test]
    fn archive_paths_reject_traversal() {
        assert!(safe_archive_path("data/media/picture.png").is_ok());
        assert!(safe_archive_path("data/../license.json").is_err());
        assert!(safe_archive_path("/absolute/file").is_err());
    }

    #[test]
    fn completed_backup_archive_can_be_reopened_and_verified() {
        let path = std::env::temp_dir().join(format!(
            "wordlyte_backup_verify_{}.wordlyte-backup",
            Uuid::new_v4()
        ));
        let file = File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file(MANIFEST_NAME, SimpleFileOptions::default())
            .unwrap();
        zip.write_all(
            serde_json::to_string(&BackupManifest {
                product: "Wordlyte".into(),
                schema: BACKUP_SCHEMA,
                app_version: "test".into(),
                created_at: 0,
                includes: vec!["database".into()],
            })
            .unwrap()
            .as_bytes(),
        )
        .unwrap();
        zip.start_file(DB_ENTRY, SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"SQLite format 3\0test").unwrap();
        zip.finish().unwrap();

        assert!(verify_backup_archive(&path).is_ok());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn pending_restore_replaces_data_and_preserves_previous_installation() {
        let root = std::env::temp_dir().join(format!("wordlyte_restore_test_{}", Uuid::new_v4()));
        let staging_name = format!("restore-{}", Uuid::new_v4());
        let staging = root.join("restore-staging").join(&staging_name);
        fs::create_dir_all(staging.join("media")).unwrap();
        fs::create_dir_all(root.join("media")).unwrap();
        fs::write(root.join("wordlyte_data.db"), b"old").unwrap();
        fs::write(root.join("wordlyte_data.db-wal"), b"old-wal").unwrap();
        fs::write(root.join("media/old.txt"), b"old-media").unwrap();
        fs::write(staging.join("wordlyte_data.db"), b"new").unwrap();
        fs::write(staging.join("media/new.txt"), b"new-media").unwrap();
        fs::write(
            root.join(PENDING_MARKER),
            serde_json::to_vec(&PendingRestore {
                staging_dir: staging_name,
            })
            .unwrap(),
        )
        .unwrap();

        let previous = apply_pending_restore(&root).unwrap().unwrap();
        assert_eq!(fs::read(root.join("wordlyte_data.db")).unwrap(), b"new");
        assert!(root.join("media/new.txt").is_file());
        assert_eq!(fs::read(previous.join("wordlyte_data.db")).unwrap(), b"old");
        assert!(previous.join("wordlyte_data.db-wal").is_file());
        assert!(previous.join("media/old.txt").is_file());
        assert!(!root.join(PENDING_MARKER).exists());
        let _ = fs::remove_dir_all(root);
    }
}
