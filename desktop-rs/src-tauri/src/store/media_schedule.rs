use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;
use anyhow::Result;
use uuid::Uuid;
use crate::store::Verse;

// ---------------------------------------------------------------------------
// Media types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Presentation types
// ---------------------------------------------------------------------------

/// A .pptx file stored in the presentations directory.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PresentationFile {
    pub id: String,
    pub name: String,
    pub path: String,
    /// Slide count as determined by the frontend after parsing; 0 = not yet known.
    pub slide_count: u32,
}

/// Payload sent with a DisplayItem when a specific slide goes live.
/// Carries everything the output window needs to render the slide without
/// an extra Tauri round-trip.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PresentationSlideData {
    pub presentation_id: String,
    pub presentation_name: String,
    /// Absolute path to the .pptx file so the output window can load it directly.
    pub presentation_path: String,
    /// Zero-based slide index.
    pub slide_index: u32,
    /// Total slides in the presentation (for prev/next UX).
    pub slide_count: u32,
}

// ---------------------------------------------------------------------------
// Custom studio slide types
// ---------------------------------------------------------------------------

/// A single text zone (header or body) in a custom studio slide.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomSlideZone {
    pub text: String,
    pub font_size: f64,
    pub font_family: String,
    /// CSS hex color string, e.g. "#ffffff".
    pub color: String,
    pub bold: bool,
    pub italic: bool,
    /// "left" | "center" | "right"
    pub align: String,
}

/// Payload sent when a custom studio slide goes live.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomSlideData {
    pub presentation_id: String,
    pub presentation_name: String,
    /// Zero-based slide index.
    pub slide_index: u32,
    /// Total slides in the presentation.
    pub slide_count: u32,
    /// CSS hex background color, e.g. "#0a1628".
    pub background_color: String,
    /// Absolute path to a background image, or None.
    pub background_image: Option<String>,
    /// Whether the header/title zone is shown (default true).
    #[serde(default = "default_header_enabled")]
    pub header_enabled: bool,
    /// Header zone height as a percentage of the slide (10–60, default 35).
    #[serde(default = "default_header_height_pct")]
    pub header_height_pct: f64,
    pub header: CustomSlideZone,
    pub body: CustomSlideZone,
}

fn default_header_enabled() -> bool { true }
fn default_header_height_pct() -> f64 { 35.0 }

/// A live camera feed from a local video device.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CameraFeedData {
    pub device_id: String,
    pub label: String,
}

// ---------------------------------------------------------------------------
// Display item — what gets projected on the output window
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", content = "data")]
pub enum DisplayItem {
    Verse(Verse),
    Media(MediaItem),
    PresentationSlide(PresentationSlideData),
    CustomSlide(CustomSlideData),
    CameraFeed(CameraFeedData),
    Scene(serde_json::Value),
}

/// A schedule entry with a stable ID so the frontend can use it as a React key.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScheduleEntry {
    pub id: String,
    pub item: DisplayItem,
}

// ---------------------------------------------------------------------------
// Presentation settings
// ---------------------------------------------------------------------------

/// How the output-window background is rendered — independently of the theme.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", content = "value")]
pub enum BackgroundSetting {
    /// Use the active theme's background color (default).
    None,
    /// A solid CSS hex color string, e.g. "#1a1a2e".
    Color(String),
    /// Absolute path to a local image file.
    Image(String),
    /// A live camera feed by deviceId string.
    Camera(String),
}

impl Default for BackgroundSetting {
    fn default() -> Self {
        BackgroundSetting::None
    }
}

/// User-facing presentation settings persisted to settings.json.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PresentationSettings {
    /// Output theme name: "dark" | "light" | "navy" | "maroon" | "forest" | "slate"
    pub theme: String,
    /// Where the scripture reference (Book Ch:V) is shown: "top" | "bottom"
    pub reference_position: String,
    /// Global output window background override. Defaults to None (use theme color).
    #[serde(default)]
    pub background: BackgroundSetting,
    /// Per-content background override for Bible verse slides.
    #[serde(default)]
    pub bible_background: BackgroundSetting,
    /// Per-content background override for PowerPoint/PPTX slides.
    #[serde(default)]
    pub presentation_background: BackgroundSetting,
    /// Per-content background override for media (image/video) items.
    #[serde(default)]
    pub media_background: BackgroundSetting,
    /// Path to a logo image to display on the output window.
    pub logo_path: Option<String>,
    /// Whether the output screen is currently blanked (black).
    #[serde(default)]
    pub is_blanked: bool,
    /// Base font size for scripture text (in pt or similar units used by frontend).
    #[serde(default = "default_font_size")]
    pub font_size: f64,
}

fn default_font_size() -> f64 {
    72.0
}

impl Default for PresentationSettings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            reference_position: "bottom".to_string(),
            background: BackgroundSetting::default(),
            bible_background: BackgroundSetting::default(),
            presentation_background: BackgroundSetting::default(),
            media_background: BackgroundSetting::default(),
            logo_path: None,
            is_blanked: false,
            font_size: default_font_size(),
        }
    }
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LyricSection {
    pub label: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Song {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub author: Option<String>,
    pub sections: Vec<LyricSection>,
}

// ---------------------------------------------------------------------------
// Lower third
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LowerThirdNameplate {
    pub name: String,
    pub title: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LowerThirdLyrics {
    pub line1: String,
    pub line2: Option<String>,
    pub section_label: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LowerThirdFreeText {
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", content = "data")]
pub enum LowerThirdData {
    Nameplate(LowerThirdNameplate),
    Lyrics(LowerThirdLyrics),
    FreeText(LowerThirdFreeText),
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub items: Vec<ScheduleEntry>,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

pub struct MediaScheduleStore {
    app_data_dir: PathBuf,
    media_dir: PathBuf,
    presentations_dir: PathBuf,
    studio_dir: PathBuf,
    songs_dir: PathBuf,
    scenes_dir: PathBuf,
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
        let presentations_dir = app_data_dir.join("presentations");
        if !presentations_dir.exists() {
            fs::create_dir_all(&presentations_dir)?;
        }
        let studio_dir = app_data_dir.join("studio");
        if !studio_dir.exists() {
            fs::create_dir_all(&studio_dir)?;
        }
        let songs_dir = app_data_dir.join("songs");
        if !songs_dir.exists() {
            fs::create_dir_all(&songs_dir)?;
        }
        let scenes_dir = app_data_dir.join("scenes");
        if !scenes_dir.exists() {
            fs::create_dir_all(&scenes_dir)?;
        }
        Ok(Self {
            app_data_dir,
            media_dir,
            presentations_dir,
            studio_dir,
            songs_dir,
            scenes_dir,
        })
    }

    pub fn get_media_dir(&self) -> PathBuf {
        self.media_dir.clone()
    }

    // -----------------------------------------------------------------------
    // Media
    // -----------------------------------------------------------------------

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

            // Skip ID-sidecar files
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

            let id = self.get_or_create_id(&path);

            items.push(MediaItem {
                id,
                name,
                path: path.to_string_lossy().to_string(),
                media_type,
                thumbnail_path: None,
            });
        }

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
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Presentations
    // -----------------------------------------------------------------------

    pub fn list_presentations(&self) -> Result<Vec<PresentationFile>> {
        let mut items = Vec::new();
        let entries = fs::read_dir(&self.presentations_dir)?;

        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }

            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if name.ends_with(".presid") {
                continue;
            }

            let ext = path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();

            if ext != "pptx" {
                continue;
            }

            let id = self.get_or_create_pres_id(&path);

            items.push(PresentationFile {
                id,
                name,
                path: path.to_string_lossy().to_string(),
                slide_count: 0, // populated by the frontend after ZIP parsing
            });
        }

        items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(items)
    }

    pub fn add_presentation(&self, source_path: PathBuf) -> Result<PresentationFile> {
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

        if ext != "pptx" {
            return Err(anyhow::anyhow!("Only .pptx files are supported"));
        }

        let dest_path = self.unique_pres_dest_path(&original_name);
        let dest_name = dest_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();

        fs::copy(&source_path, &dest_path)?;

        let id = self.get_or_create_pres_id(&dest_path);

        Ok(PresentationFile {
            id,
            name: dest_name,
            path: dest_path.to_string_lossy().to_string(),
            slide_count: 0,
        })
    }

    pub fn delete_presentation(&self, id: String) -> Result<()> {
        let entries = fs::read_dir(&self.presentations_dir)?;
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) == Some("presid") {
                continue;
            }
            if self.get_or_create_pres_id(&path) == id {
                let sidecar = path.with_extension(
                    format!(
                        "{}.presid",
                        path.extension().unwrap_or_default().to_string_lossy()
                    )
                );
                fs::remove_file(&path)?;
                let _ = fs::remove_file(sidecar);
                return Ok(());
            }
        }
        Ok(())
    }

    fn get_or_create_pres_id(&self, pres_path: &PathBuf) -> String {
        let sidecar = pres_path.with_extension(
            format!(
                "{}.presid",
                pres_path.extension().unwrap_or_default().to_string_lossy()
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

    fn unique_pres_dest_path(&self, name: &str) -> PathBuf {
        let base = self.presentations_dir.join(name);
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
            let candidate = self.presentations_dir.join(format!("{}_{}{}", stem, counter, ext));
            if !candidate.exists() {
                return candidate;
            }
            counter += 1;
        }
    }

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    pub fn load_settings(&self) -> Result<PresentationSettings> {
        let path = self.app_data_dir.join("settings.json");
        if path.exists() {
            let json = fs::read_to_string(path)?;
            Ok(serde_json::from_str(&json).unwrap_or_default())
        } else {
            Ok(PresentationSettings::default())
        }
    }

    pub fn save_settings(&self, settings: &PresentationSettings) -> Result<()> {
        let path = self.app_data_dir.join("settings.json");
        let json = serde_json::to_string_pretty(settings)?;
        fs::write(path, json)?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Schedule
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Studio presentations
    // -----------------------------------------------------------------------

    /// Returns a list of `{ id, name, slide_count }` objects for the Studio tab.
    pub fn list_studio_presentations(&self) -> Result<Vec<serde_json::Value>> {
        let mut items = Vec::new();
        let entries = fs::read_dir(&self.studio_dir)?;
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let ext = path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            if ext != "json" {
                continue;
            }
            if let Ok(json) = fs::read_to_string(&path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json) {
                    let id = val.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string();
                    let slide_count = val
                        .get("slides")
                        .and_then(|v| v.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0);
                    if !id.is_empty() {
                        items.push(serde_json::json!({
                            "id": id,
                            "name": name,
                            "slide_count": slide_count,
                        }));
                    }
                }
            }
        }
        items.sort_by(|a, b| {
            let na = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let nb = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
            na.to_lowercase().cmp(&nb.to_lowercase())
        });
        Ok(items)
    }

    /// Writes the full presentation JSON to `studio/{id}.json`.
    pub fn save_studio_presentation(&self, data: &serde_json::Value) -> Result<()> {
        let id = data
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("Presentation JSON missing 'id' field"))?;
        let path = self.studio_dir.join(format!("{}.json", id));
        let json = serde_json::to_string_pretty(data)?;
        fs::write(path, json)?;
        Ok(())
    }

    /// Reads and returns the full presentation JSON for the given id.
    pub fn load_studio_presentation(&self, id: &str) -> Result<serde_json::Value> {
        let path = self.studio_dir.join(format!("{}.json", id));
        let json = fs::read_to_string(&path)
            .map_err(|_| anyhow::anyhow!("Studio presentation '{}' not found", id))?;
        Ok(serde_json::from_str(&json)?)
    }

    /// Deletes `studio/{id}.json`.
    pub fn delete_studio_presentation(&self, id: &str) -> Result<()> {
        let path = self.studio_dir.join(format!("{}.json", id));
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Songs
    // -----------------------------------------------------------------------

    pub fn list_songs(&self) -> Result<Vec<Song>> {
        let mut songs = Vec::new();
        let entries = fs::read_dir(&self.songs_dir)?;
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() { continue; }
            let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
            if ext != "json" { continue; }
            if let Ok(json) = fs::read_to_string(&path) {
                if let Ok(song) = serde_json::from_str::<Song>(&json) {
                    songs.push(song);
                }
            }
        }
        songs.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        Ok(songs)
    }

    pub fn save_song(&self, mut song: Song) -> Result<Song> {
        if song.id.is_empty() {
            song.id = Uuid::new_v4().to_string();
        }
        let path = self.songs_dir.join(format!("{}.json", song.id));
        let json = serde_json::to_string_pretty(&song)?;
        fs::write(path, json)?;
        Ok(song)
    }

    pub fn delete_song(&self, id: &str) -> Result<()> {
        let path = self.songs_dir.join(format!("{}.json", id));
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Lower third templates
    // -----------------------------------------------------------------------

    pub fn save_lt_templates(&self, templates: &serde_json::Value) -> Result<()> {
        let path = self.app_data_dir.join("lt_templates.json");
        let json = serde_json::to_string_pretty(templates)?;
        fs::write(path, json)?;
        Ok(())
    }

    pub fn load_lt_templates(&self) -> Result<serde_json::Value> {
        let path = self.app_data_dir.join("lt_templates.json");
        if path.exists() {
            let json = fs::read_to_string(path)?;
            Ok(serde_json::from_str(&json).unwrap_or(serde_json::json!([])))
        } else {
            Ok(serde_json::json!([]))
        }
    }

    // -----------------------------------------------------------------------
    // Scenes
    // -----------------------------------------------------------------------

    /// Returns a list of `{ id, name }` objects for each saved scene.
    pub fn list_scenes(&self) -> Result<Vec<serde_json::Value>> {
        let mut items = Vec::new();
        let entries = fs::read_dir(&self.scenes_dir)?;
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() { continue; }
            let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
            if ext != "json" { continue; }
            if let Ok(json) = fs::read_to_string(&path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json) {
                    let id = val.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if !id.is_empty() {
                        items.push(val);
                    }
                }
            }
        }
        items.sort_by(|a, b| {
            let na = a.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let nb = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
            na.to_lowercase().cmp(&nb.to_lowercase())
        });
        Ok(items)
    }

    /// Writes the full scene JSON to `scenes/{id}.json`.
    pub fn save_scene(&self, data: &serde_json::Value) -> Result<()> {
        let id = data
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("Scene JSON missing 'id' field"))?;
        let path = self.scenes_dir.join(format!("{}.json", id));
        let json = serde_json::to_string_pretty(data)?;
        fs::write(path, json)?;
        Ok(())
    }

    /// Deletes `scenes/{id}.json`.
    pub fn delete_scene(&self, id: &str) -> Result<()> {
        let path = self.scenes_dir.join(format!("{}.json", id));
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }
}
