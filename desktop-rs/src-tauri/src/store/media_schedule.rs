use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;
use anyhow::Result;
use uuid::Uuid;
use crate::store::Verse;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum MediaItemType {
    Image,
    Video,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MediaItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub media_type: MediaItemType,
    pub thumbnail_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", content = "data")]
pub enum DisplayItem {
    Verse(Verse),
    Media(MediaItem),
}

/// A schedule entry with a stable ID so the frontend can use it as a React key.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScheduleEntry {
    pub id: String,
    pub item: DisplayItem,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub items: Vec<ScheduleEntry>,
}

pub struct MediaScheduleStore {
    app_data_dir: PathBuf,
    media_dir: PathBuf,
}

fn classify_extension(ext: &str) -> Option<MediaItemType> {
    match ext {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" => Some(MediaItemType::Image),
        "mp4" | "webm" | "mov" | "mkv" | "avi" => Some(MediaItemType::Video),
        _ => None,
    }
}

impl MediaScheduleStore {
    pub fn new(app_data_dir: PathBuf) -> Result<Self> {
        let media_dir = app_data_dir.join("media");
        if !media_dir.exists() {
            fs::create_dir_all(&media_dir)?;
        }
        Ok(Self {
            app_data_dir,
            media_dir,
        })
    }

    pub fn get_media_dir(&self) -> PathBuf {
        self.media_dir.clone()
    }

    pub fn list_media(&self) -> Result<Vec<MediaItem>> {
        let mut items = Vec::new();
        let entries = fs::read_dir(&self.media_dir)?;

        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }

            let name = path.file_name().unwrap().to_string_lossy().to_string();

            // Skip hidden and metadata files (e.g. .DS_Store, thumbs.db)
            if name.starts_with('.') {
                continue;
            }

            // Skip ID-sidecar files (*.id files we write alongside media)
            if name.ends_with(".mediaid") {
                continue;
            }

            let ext = path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();

            let media_type = match classify_extension(ext.as_str()) {
                Some(t) => t,
                None => continue,
            };

            // Read stable ID from sidecar file, or create one
            let id = self.get_or_create_id(&path);

            items.push(MediaItem {
                id,
                name,
                path: path.to_string_lossy().to_string(),
                media_type,
                thumbnail_path: None,
            });
        }

        // Stable, deterministic order: sort by filename
        items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(items)
    }

    /// Reads a UUID from a `.mediaid` sidecar file next to `media_path`.
    /// If none exists, generates a new UUID and writes it.
    fn get_or_create_id(&self, media_path: &PathBuf) -> String {
        let sidecar = media_path.with_extension(
            format!(
                "{}.mediaid",
                media_path.extension().unwrap_or_default().to_string_lossy()
            )
        );
        if let Ok(id) = fs::read_to_string(&sidecar) {
            let id = id.trim().to_string();
            if !id.is_empty() {
                return id;
            }
        }
        let id = Uuid::new_v4().to_string();
        let _ = fs::write(&sidecar, &id);
        id
    }

    pub fn add_media(&self, source_path: PathBuf) -> Result<MediaItem> {
        let original_name = source_path
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("Invalid source path"))?
            .to_string_lossy()
            .to_string();

        let ext = source_path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();

        let media_type = classify_extension(ext.as_str())
            .ok_or_else(|| anyhow::anyhow!("Unsupported media type: .{}", ext))?;

        // Resolve a unique destination path (append _2, _3, ... on collision)
        let dest_path = self.unique_dest_path(&original_name);
        let dest_name = dest_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();

        fs::copy(&source_path, &dest_path)?;

        let id = self.get_or_create_id(&dest_path);

        Ok(MediaItem {
            id,
            name: dest_name,
            path: dest_path.to_string_lossy().to_string(),
            media_type,
            thumbnail_path: None,
        })
    }

    /// Returns a path in `media_dir` that does not yet exist.
    /// If `name` is taken, returns `stem_2.ext`, `stem_3.ext`, etc.
    fn unique_dest_path(&self, name: &str) -> PathBuf {
        let base = self.media_dir.join(name);
        if !base.exists() {
            return base;
        }
        let stem = base
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let ext = base
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mut counter = 2u32;
        loop {
            let candidate = self.media_dir.join(format!("{}_{}{}", stem, counter, ext));
            if !candidate.exists() {
                return candidate;
            }
            counter += 1;
        }
    }

    pub fn delete_media(&self, id: String) -> Result<()> {
        // Find the media file that owns this ID via its sidecar
        let entries = fs::read_dir(&self.media_dir)?;
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) == Some("mediaid") {
                continue;
            }
            if self.get_or_create_id(&path) == id {
                let sidecar = path.with_extension(
                    format!(
                        "{}.mediaid",
                        path.extension().unwrap_or_default().to_string_lossy()
                    )
                );
                fs::remove_file(&path)?;
                let _ = fs::remove_file(sidecar);
                return Ok(());
            }
        }
        Ok(()) // Not found is not an error (already deleted)
    }

    pub fn save_schedule(&self, schedule: Schedule) -> Result<()> {
        let path = self.app_data_dir.join("schedule.json");
        let json = serde_json::to_string_pretty(&schedule)?;
        fs::write(path, json)?;
        Ok(())
    }

    pub fn load_schedule(&self) -> Result<Schedule> {
        let path = self.app_data_dir.join("schedule.json");
        if path.exists() {
            let json = fs::read_to_string(path)?;
            Ok(serde_json::from_str(&json)?)
        } else {
            Ok(Schedule {
                id: "default".to_string(),
                name: "Default Schedule".to_string(),
                items: Vec::new(),
            })
        }
    }
}
