use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;
use anyhow::Result;
use uuid::Uuid;
use crate::store::Verse;
use crate::store::data_db::DataDb;
use image::GenericImageView;
use std::sync::Arc;

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
    #[serde(default = "default_media_fit_mode")]
    pub fit_mode: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
}

fn default_media_fit_mode() -> String { "contain".to_string() }

// ---------------------------------------------------------------------------
// Custom studio slide types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomSlideZone {
    pub text: String,
    pub font_size: f64,
    pub font_family: String,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
    pub align: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SlideElement {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub z_index: i32,
    pub content: String,
    #[serde(default)]
    pub font_size: Option<f64>,
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub align: Option<String>,
    #[serde(default)]
    pub bold: Option<bool>,
    #[serde(default)]
    pub italic: Option<bool>,
    #[serde(default)]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default)]
    pub shadow: Option<bool>,
    #[serde(default)]
    pub shadow_color: Option<String>,
    #[serde(rename = "groupId", alias = "group_id", default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub loop_video: Option<bool>,
    #[serde(default)]
    pub muted: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomSlideData {
    pub presentation_id: String,
    pub presentation_name: String,
    pub slide_index: u32,
    pub slide_count: u32,
    pub background_color: String,
    pub background_image: Option<String>,
    #[serde(rename = "background_video", default)]
    pub background_video: Option<String>,
    #[serde(rename = "background_video_loop", default)]
    pub background_video_loop: Option<bool>,
    #[serde(rename = "background_video_muted", default)]
    pub background_video_muted: Option<bool>,
    #[serde(default)]
    pub header_enabled: Option<bool>,
    #[serde(default)]
    pub header_height_pct: Option<f64>,
    #[serde(default)]
    pub header: Option<CustomSlideZone>,
    #[serde(default)]
    pub body: Option<CustomSlideZone>,
    #[serde(default)]
    pub elements: Vec<SlideElement>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TimerData {
    pub timer_type: String,
    pub duration_secs: Option<u32>,
    pub label: Option<String>,
    pub started_at: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SongSlideData {
    pub song_id: String,
    pub title: String,
    pub author: Option<String>,
    pub section_label: String,
    pub lines: Vec<String>,
    pub slide_index: u32,
    pub total_slides: u32,
    #[serde(default)]
    pub font: Option<String>,
    #[serde(default)]
    pub font_size: Option<f64>,
    #[serde(default)]
    pub font_weight: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CameraBackground {
    pub device_id: String,
    pub opacity: f32,
    pub object_fit: String,
    pub mirrored: bool,
}

// ---------------------------------------------------------------------------
// Display item
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", content = "data")]
pub enum DisplayItem {
    Verse(Verse),
    Media(MediaItem),
    Camera(CameraBackground),
    CustomSlide(CustomSlideData),
    Timer(TimerData),
    Song(SongSlideData),
}

impl DisplayItem {
    pub fn to_label(&self) -> String {
        match self {
            DisplayItem::Verse(v) => format!("{} {}:{}", v.book, v.chapter, v.verse),
            DisplayItem::Media(m) => m.name.clone(),
            DisplayItem::Camera(_) => "Live Camera Feed".to_string(),
            DisplayItem::CustomSlide(c) => format!("{} – slide {}", c.presentation_name, c.slide_index + 1),
            DisplayItem::Timer(t) => t.label.as_ref().filter(|l| !l.is_empty()).cloned().unwrap_or_else(|| format!("Timer: {}", t.timer_type)),
            DisplayItem::Song(s) => format!("{} ({})", s.title, s.section_label),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScheduleEntry {
    pub id: String,
    pub item: DisplayItem,
}

// ---------------------------------------------------------------------------
// Presentation settings
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoBackground {
    pub path: String,
    #[serde(default = "vbg_default_true")]
    pub loop_video: bool,
    #[serde(default = "vbg_default_true")]
    pub muted: bool,
    #[serde(default = "vbg_default_cover")]
    pub object_fit: String,
    #[serde(default = "vbg_default_one")]
    pub opacity: f32,
    #[serde(default = "vbg_default_one")]
    pub playback_rate: f32,
}

fn vbg_default_true() -> bool { true }
fn vbg_default_cover() -> String { "cover".to_string() }
fn vbg_default_one() -> f32 { 1.0 }

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", content = "value")]
pub enum BackgroundSetting {
    None,
    Color(String),
    Image(String),
    Video(VideoBackground),
}

impl Default for BackgroundSetting {
    fn default() -> Self { BackgroundSetting::None }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PresentationSettings {
    pub theme: String,
    pub reference_position: String,
    #[serde(default)]
    pub background: BackgroundSetting,
    #[serde(default)]
    pub bible_background: BackgroundSetting,
    #[serde(default)]
    pub media_background: BackgroundSetting,
    pub logo_path: Option<String>,
    pub background_logo_path: Option<String>,
    #[serde(default)]
    pub show_background_logo: bool,
    #[serde(default = "default_fit_mode")]
    pub background_logo_fit: String,
    #[serde(default)]
    pub is_blanked: bool,
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    #[serde(default = "default_transition")]
    pub slide_transition: String,
    #[serde(default = "default_transition_duration")]
    pub slide_transition_duration: f32,
    #[serde(default = "default_verse_font_family")]
    pub verse_font_family: String,
    #[serde(default = "default_reference_font_size")]
    pub reference_font_size: f64,
    #[serde(default)]
    pub reference_color: String,
    #[serde(default = "default_reference_font_family")]
    pub reference_font_family: String,
    #[serde(default)]
    pub disabled_bible_versions: Vec<String>,
    #[serde(default = "default_version_font")]
    pub version_font_family: String,
    #[serde(default = "default_version_size")]
    pub version_font_size: f64,
    #[serde(default)]
    pub version_color: String,
    #[serde(default = "default_auto_split_verses")]
    pub auto_split_verses: bool,
    #[serde(default = "default_verse_split_threshold")]
    pub verse_split_threshold: usize,
    #[serde(default)]
    pub preferred_monitor: Option<String>,
    #[serde(default = "default_highlight_divine_words")]
    pub highlight_divine_words: bool,
    #[serde(default = "default_highlight_color")]
    pub highlight_color: String,
    pub custom_theme_colors: Option<ThemeColors>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeColors {
    pub primary: String,
    pub secondary: String,
    pub accent: String,
    pub text: String,
}

fn default_auto_split_verses() -> bool { true }
fn default_verse_split_threshold() -> usize { 200 }
fn default_fit_mode() -> String { "contain".to_string() }
fn default_highlight_divine_words() -> bool { false }
fn default_highlight_color() -> String { "#ef4444".to_string() }
fn default_version_font() -> String { "Arial, sans-serif".to_string() }
fn default_version_size() -> f64 { 24.0 }
fn default_font_size() -> f64 { 72.0 }
fn default_transition() -> String { "fade".to_string() }
fn default_transition_duration() -> f32 { 0.4 }
fn default_verse_font_family() -> String { "Georgia, serif".to_string() }
fn default_reference_font_size() -> f64 { 36.0 }
fn default_reference_font_family() -> String { "Arial, sans-serif".to_string() }

impl Default for PresentationSettings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(), reference_position: "bottom".to_string(),
            background: BackgroundSetting::default(), bible_background: BackgroundSetting::default(),
            media_background: BackgroundSetting::default(), logo_path: None, background_logo_path: None,
            show_background_logo: false, background_logo_fit: default_fit_mode(), is_blanked: false,
            font_size: default_font_size(), slide_transition: default_transition(),
            slide_transition_duration: default_transition_duration(),
            verse_font_family: default_verse_font_family(),
            reference_font_size: default_reference_font_size(), reference_color: String::new(),
            reference_font_family: default_reference_font_family(),
            disabled_bible_versions: Vec::new(), version_font_family: default_version_font(),
            version_font_size: default_version_size(), version_color: String::new(),
            auto_split_verses: default_auto_split_verses(),
            verse_split_threshold: default_verse_split_threshold(), preferred_monitor: None,
            highlight_divine_words: default_highlight_divine_words(),
            highlight_color: default_highlight_color(), custom_theme_colors: None,
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
    #[serde(default)]
    pub arrangement: Vec<String>,
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub font: Option<String>,
    #[serde(default)]
    pub font_size: Option<f64>,
    #[serde(default)]
    pub font_weight: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

// ---------------------------------------------------------------------------
// Lower third
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LowerThirdNameplate { pub name: String, pub title: Option<String>, }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LowerThirdLyrics { pub line1: String, pub line2: Option<String>, pub section_label: Option<String>, }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LowerThirdFreeText { pub text: String }

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", content = "data")]
pub enum LowerThirdData {
    Nameplate(LowerThirdNameplate),
    Lyrics(LowerThirdLyrics),
    FreeText(LowerThirdFreeText),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LtPreset {
    pub id: String,
    pub label: String,
    pub template_id: Option<String>,
    pub data: LowerThirdData,
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Schedule { pub id: String, pub name: String, pub items: Vec<ScheduleEntry> }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServiceMeta { pub id: String, pub name: String, pub item_count: usize, pub updated_at: u64 }

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PropItem {
    pub id: String,
    pub kind: String,
    pub path: Option<String>,
    pub text: Option<String>,
    pub color: Option<String>,
    pub x: f64, pub y: f64, pub w: f64, pub h: f64,
    pub opacity: f64, pub visible: bool,
}

// ---------------------------------------------------------------------------
// Custom slide / presentation
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomSlide {
    pub id: String,
    #[serde(rename = "backgroundColor", alias = "background_color")]
    pub background_color: String,
    #[serde(rename = "backgroundImage", alias = "background_image", default)]
    pub background_image: Option<String>,
    #[serde(rename = "backgroundVideo", alias = "background_video", default)]
    pub background_video: Option<String>,
    #[serde(rename = "backgroundVideoLoop", alias = "background_video_loop", default)]
    pub background_video_loop: Option<bool>,
    #[serde(rename = "backgroundVideoMuted", alias = "background_video_muted", default)]
    pub background_video_muted: Option<bool>,
    pub elements: Vec<SlideElement>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(rename = "groupId", alias = "group_id", default)]
    pub group_id: Option<String>,
    #[serde(rename = "headerEnabled", alias = "header_enabled", default)]
    pub header_enabled: Option<bool>,
    #[serde(rename = "headerHeightPct", alias = "header_height_pct", default)]
    pub header_height_pct: Option<f64>,
    #[serde(default)]
    pub header: Option<CustomSlideZone>,
    #[serde(default)]
    pub body: Option<CustomSlideZone>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomPresentation {
    pub id: String,
    pub name: String,
    pub slides: Vec<CustomSlide>,
    #[serde(default)]
    pub version: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PresentationSummary {
    pub id: String,
    pub name: String,
    pub slide_count: u32,
    pub version: u32,
    pub updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SlideTemplate {
    pub id: String,
    pub name: String,
    pub category: String,
    pub slide: CustomSlide,
    pub created_at: u64,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

fn classify_extension(ext: &str) -> Option<MediaItemType> {
    match ext {
        "jpg"|"jpeg"|"png"|"gif"|"webp"|"bmp"|"svg" => Some(MediaItemType::Image),
        "mp4"|"webm"|"mov"|"mkv"|"avi" => Some(MediaItemType::Video),
        _ => None,
    }
}

pub struct MediaScheduleStore {
    app_data_dir: PathBuf,
    media_dir: PathBuf,
    thumbnails_dir: PathBuf,
    data_db: Arc<DataDb>,
}

impl MediaScheduleStore {
    pub fn new(app_data_dir: PathBuf) -> Result<Self> {
        let media_dir = app_data_dir.join("media");
        let thumbnails_dir = app_data_dir.join("thumbnails");
        for d in [&media_dir, &thumbnails_dir] {
            if !d.exists() { fs::create_dir_all(d)?; }
        }

        let db_path = app_data_dir.join("wordlyte_data.db");
        let data_db = Arc::new(DataDb::open(&db_path).map_err(|e| anyhow::anyhow!(e))?);

        let store = Self { app_data_dir, media_dir, thumbnails_dir, data_db };
        store.try_migrate_from_json()?;
        Ok(store)
    }

    pub fn in_memory(app_data_dir: PathBuf) -> Result<Self> {
        let media_dir = app_data_dir.join("media");
        let thumbnails_dir = app_data_dir.join("thumbnails");
        for d in [&media_dir, &thumbnails_dir] {
            if !d.exists() { fs::create_dir_all(d)?; }
        }
        let data_db = Arc::new(DataDb::open_in_memory().map_err(|e| anyhow::anyhow!(e))?);
        Ok(Self { app_data_dir, media_dir, thumbnails_dir, data_db })
    }

    fn try_migrate_from_json(&self) -> Result<()> {
        let migrated = self.data_db.kv_get("__migrated__").map_err(|e| anyhow::anyhow!(e))?;
        if migrated.as_deref() == Some("1") { return Ok(()); }

        // Migrate settings
        let settings_path = self.app_data_dir.join("settings.json");
        if settings_path.exists() {
            if let Ok(json) = fs::read_to_string(&settings_path) {
                let _ = self.data_db.kv_set("settings", &json);
            }
        }

        // Migrate schedule
        let sched_path = self.app_data_dir.join("schedule.json");
        if sched_path.exists() {
            if let Ok(json) = fs::read_to_string(&sched_path) {
                let _ = self.data_db.kv_set("schedule", &json);
            }
        }

        // Migrate props
        let props_path = self.app_data_dir.join("props.json");
        if props_path.exists() {
            if let Ok(json) = fs::read_to_string(&props_path) {
                let _ = self.data_db.kv_set("props", &json);
            }
        }

        // Migrate LT templates
        let lt_path = self.app_data_dir.join("lt_templates.json");
        if lt_path.exists() {
            if let Ok(json) = fs::read_to_string(&lt_path) {
                let _ = self.data_db.kv_set("lt_templates", &json);
            }
        }

        // Migrate LT presets
        let pre_path = self.app_data_dir.join("lt_presets.json");
        if pre_path.exists() {
            if let Ok(json) = fs::read_to_string(&pre_path) {
                let _ = self.data_db.kv_set("lt_presets", &json);
            }
        }

        // Migrate songs
        let songs_dir = self.app_data_dir.join("songs");
        if songs_dir.exists() {
            if let Ok(entries) = fs::read_dir(&songs_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().map_or(false, |e| e == "json") {
                        if let Ok(json) = fs::read_to_string(&path) {
                            if let Ok(song) = serde_json::from_str::<Song>(&json) {
                                let _ = self.data_db.hash_set("songs", &song.id, &json);
                            }
                        }
                    }
                }
            }
        }

        // Migrate presentations
        let studio_dir = self.app_data_dir.join("studio");
        if studio_dir.exists() {
            if let Ok(entries) = fs::read_dir(&studio_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().map_or(false, |e| e == "json") {
                        if let Ok(json) = fs::read_to_string(&path) {
                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json) {
                                let id = val.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                if !id.is_empty() {
                                    let _ = self.data_db.hash_set("presentations", id, &json);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Migrate services
        let services_dir = self.app_data_dir.join("services");
        if services_dir.exists() {
            if let Ok(entries) = fs::read_dir(&services_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().map_or(false, |e| e == "json") {
                        if let Ok(json) = fs::read_to_string(&path) {
                            if let Ok(sched) = serde_json::from_str::<Schedule>(&json) {
                                let _ = self.data_db.hash_set("services", &sched.id, &json);
                            }
                        }
                    }
                }
            }
        }

        // Migrate media: scan media dir for files and create records
        if self.media_dir.exists() {
            let media_count = self.data_db.list_media().map_err(|e| anyhow::anyhow!(e))?.len();
            if media_count == 0 {
                if let Ok(entries) = fs::read_dir(&self.media_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file() {
                            let name = path.file_name().unwrap_or_default().to_string_lossy();
                            if name.starts_with('.') { continue; }
                            let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
                            if !name.contains(".mediaid") && !name.contains(".mediafit") && !name.contains(".description") && !name.contains(".tags") && !name.contains(".category") {
                                if let Some(mt) = classify_extension(&ext) {
                                    let id = Uuid::new_v4().to_string();
                                    let media_type = match mt { MediaItemType::Image => "Image", MediaItemType::Video => "Video" };
                                    let created_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
                                    let _ = self.data_db.insert_media(&id, &name, &path.to_string_lossy(), media_type, &created_at);
                                }
                            }
                        }
                    }
                }
            }
        }

        let _ = self.data_db.kv_set("__migrated__", "1");
        Ok(())
    }

    // ---- Media ----

    pub fn list_media(&self) -> Result<Vec<MediaItem>> {
        let rows = self.data_db.list_media().map_err(|e| anyhow::anyhow!(e))?;
        let mut items = Vec::new();
        for (id, filename, path, media_type, fit_mode, description, tags, category) in rows {
            let media_type = match media_type.as_str() { "Image" => MediaItemType::Image, _ => MediaItemType::Video };
            let tags: Vec<String> = serde_json::from_str(&tags).unwrap_or_default();
            let thumbnail_path = if matches!(media_type, MediaItemType::Image) {
                Self::get_or_create_thumbnail_static(&self.thumbnails_dir, &path, &id)
            } else { None };
            items.push(MediaItem {
                id, name: filename, path, media_type, thumbnail_path, fit_mode,
                tags, description: if description.is_empty() { None } else { Some(description) },
                category: if category.is_empty() { None } else { Some(category) },
            });
        }
        Ok(items)
    }

    fn get_or_create_thumbnail_static(thumb_dir: &PathBuf, media_path: &str, id: &str) -> Option<String> {
        let thumb_path = thumb_dir.join(format!("{}.jpg", id));
        if thumb_path.exists() { return Some(thumb_path.to_string_lossy().to_string()); }
        if let Ok(img) = image::open(media_path) {
            let (w, h) = img.dimensions();
            let scale = 320.0 / (w.max(h) as f32);
            let nw = (w as f32 * scale) as u32;
            let nh = (h as f32 * scale) as u32;
            let thumb = img.resize(nw, nh, image::imageops::FilterType::Lanczos3);
            if thumb.save(&thumb_path).is_ok() { return Some(thumb_path.to_string_lossy().to_string()); }
        }
        None
    }

    pub fn set_media_fit(&self, id: &str, fit_mode: &str) -> Result<()> {
        self.data_db.set_media_fit(id, fit_mode).map_err(|e| anyhow::anyhow!(e))
    }

    pub fn update_media_metadata(&self, id: &str, description: Option<String>, tags: Vec<String>, category: Option<String>) -> Result<()> {
        let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
        self.data_db.update_media_metadata(id, &description, &tags_json, &category).map_err(|e| anyhow::anyhow!(e))
    }

    pub fn add_media(&self, source_path: PathBuf) -> Result<MediaItem> {
        let original_name = source_path.file_name().ok_or_else(|| anyhow::anyhow!("Invalid source path"))?.to_string_lossy().to_string();
        let ext_str = source_path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        let media_type = classify_extension(&ext_str).ok_or_else(|| anyhow::anyhow!("Unsupported media type: .{}", ext_str))?;

        let stem = source_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let dot_ext = source_path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();

        let mut dest_path = self.media_dir.join(&original_name);
        let mut dest_name = original_name.clone();
        let mut counter = 2u32;

        let mut dest_file = loop {
            match fs::OpenOptions::new().write(true).create_new(true).open(&dest_path) {
                Ok(f) => break f,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    dest_name = format!("{}_{}{}", stem, counter, dot_ext); dest_path = self.media_dir.join(&dest_name); counter += 1;
                }
                Err(e) => return Err(e.into()),
            }
        };

        let mut source_file = fs::File::open(&source_path)?;
        if let Err(e) = std::io::copy(&mut source_file, &mut dest_file) {
            let _ = fs::remove_file(&dest_path);
            return Err(e.into());
        }

        let id = Uuid::new_v4().to_string();
        let mt_str = match media_type { MediaItemType::Image => "Image", MediaItemType::Video => "Video" };
        let created_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        self.data_db.insert_media(&id, &dest_name, &dest_path.to_string_lossy(), mt_str, &created_at)
            .map_err(|e| anyhow::anyhow!(e))?;

        Ok(MediaItem { id, name: dest_name, path: dest_path.to_string_lossy().to_string(), media_type, thumbnail_path: None, fit_mode: default_fit_mode(), tags: vec![], description: None, category: None })
    }

    pub fn delete_media(&self, id: String) -> Result<()> {
        if let Some(path) = self.data_db.get_media_path(&id).map_err(|e| anyhow::anyhow!(e))? {
            let p = PathBuf::from(&path);
            let thumb = self.thumbnails_dir.join(format!("{}.jpg", id));
            let _ = fs::remove_file(&p);
            let _ = fs::remove_file(&thumb);
        }
        self.data_db.delete_media(&id).map_err(|e| anyhow::anyhow!(e))
    }

    pub fn bulk_delete_media(&self, ids: Vec<String>) -> Result<()> {
        for id in &ids {
            if let Ok(Some(path)) = self.data_db.get_media_path(id) {
                let thumb = self.thumbnails_dir.join(format!("{}.jpg", id));
                let _ = fs::remove_file(PathBuf::from(&path));
                let _ = fs::remove_file(&thumb);
            }
        }
        self.data_db.delete_media_bulk(&ids).map_err(|e| anyhow::anyhow!(e))
    }

    pub fn bulk_update_media(&self, ids: Vec<String>, tags_to_add: Vec<String>, tags_to_remove: Vec<String>, category: Option<String>) -> Result<()> {
        for id in &ids {
            if let Ok(existing_tags) = self.data_db.get_media_tags(id) {
                let mut tags: Vec<String> = serde_json::from_str(&existing_tags).unwrap_or_default();
                for tag in &tags_to_add { if !tags.contains(tag) { tags.push(tag.clone()); } }
                tags.retain(|t| !tags_to_remove.contains(t));
                let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
                let _ = self.data_db.update_media_metadata(id, &None, &tags_json, &category);
            }
        }
        Ok(())
    }

    // ---- Settings ----

    pub fn load_settings(&self) -> Result<PresentationSettings> {
        match self.data_db.kv_get("settings").map_err(|e| anyhow::anyhow!(e))? {
            Some(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
            None => Ok(PresentationSettings::default()),
        }
    }

    pub fn save_settings(&self, settings: &PresentationSettings) -> Result<()> {
        let json = serde_json::to_string_pretty(settings)?;
        self.data_db.kv_set("settings", &json).map_err(|e| anyhow::anyhow!(e))
    }

    // ---- Schedule ----

    pub fn save_schedule(&self, schedule: Schedule) -> Result<()> {
        let json = serde_json::to_string_pretty(&schedule)?;
        self.data_db.kv_set("schedule", &json).map_err(|e| anyhow::anyhow!(e))
    }

    pub fn load_schedule(&self) -> Result<Schedule> {
        match self.data_db.kv_get("schedule").map_err(|e| anyhow::anyhow!(e))? {
            Some(json) => Ok(serde_json::from_str(&json)?),
            None => Ok(Schedule { id: "default".to_string(), name: "Default Schedule".to_string(), items: vec![] }),
        }
    }

    // ---- Services ----

    pub fn list_services(&self) -> Result<Vec<ServiceMeta>> {
        let rows = self.data_db.hash_list("services").map_err(|e| anyhow::anyhow!(e))?;
        let mut out = Vec::new();
        for (_, data) in rows {
            if let Ok(sched) = serde_json::from_str::<Schedule>(&data) {
                out.push(ServiceMeta { id: sched.id.clone(), name: sched.name.clone(), item_count: sched.items.len(), updated_at: 0 });
            }
        }
        Ok(out)
    }

    pub fn save_service(&self, schedule: &Schedule) -> Result<()> {
        let json = serde_json::to_string_pretty(schedule)?;
        self.data_db.hash_set("services", &schedule.id, &json).map_err(|e| anyhow::anyhow!(e))
    }

    pub fn load_service(&self, id: &str) -> Result<Schedule> {
        match self.data_db.hash_get("services", id).map_err(|e| anyhow::anyhow!(e))? {
            Some(json) => Ok(serde_json::from_str(&json)?),
            None => Err(anyhow::anyhow!("Service '{}' not found", id)),
        }
    }

    pub fn delete_service(&self, id: &str) -> Result<()> {
        self.data_db.hash_delete("services", id).map_err(|e| anyhow::anyhow!(e))
    }

    // ---- Studio presentations ----

    pub fn list_studio_presentations(&self) -> Result<Vec<PresentationSummary>> {
        let rows = self.data_db.hash_list("presentations").map_err(|e| anyhow::anyhow!(e))?;
        let mut items = Vec::new();
        for (id, data) in rows {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&data) {
                let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled");
                let slide_count = val.get("slides").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0) as u32;
                let version = val.get("version").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let updated_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                items.push(PresentationSummary { id, name: name.to_string(), slide_count, version, updated_at });
            }
        }
        items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(items)
    }

    pub fn save_studio_presentation(&self, presentation: &CustomPresentation) -> Result<()> {
        let json = serde_json::to_string_pretty(presentation)?;
        self.data_db.hash_set("presentations", &presentation.id, &json).map_err(|e| anyhow::anyhow!(e))
    }

    pub fn load_studio_presentation(&self, id: &str) -> Result<CustomPresentation> {
        match self.data_db.hash_get("presentations", id).map_err(|e| anyhow::anyhow!(e))? {
            Some(json) => Ok(serde_json::from_str(&json)?),
            None => Err(anyhow::anyhow!("Presentation '{}' not found", id)),
        }
    }

    pub fn delete_studio_presentation(&self, id: &str) -> Result<()> {
        self.data_db.hash_delete("presentations", id).map_err(|e| anyhow::anyhow!(e))
    }

    // ---- Slide templates ----

    pub fn list_templates(&self) -> Result<Vec<SlideTemplate>> {
        let rows = self.data_db.hash_list("slide_templates").map_err(|e| anyhow::anyhow!(e))?;
        let mut templates: Vec<SlideTemplate> = rows.iter().filter_map(|(_, data)| serde_json::from_str(data).ok()).collect();
        templates.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(templates)
    }

    pub fn save_template(&self, mut template: SlideTemplate) -> Result<SlideTemplate> {
        if template.id.is_empty() { template.id = Uuid::new_v4().to_string(); }
        let json = serde_json::to_string_pretty(&template)?;
        self.data_db.hash_set("slide_templates", &template.id, &json).map_err(|e| anyhow::anyhow!(e))?;
        Ok(template)
    }

    pub fn delete_template(&self, id: &str) -> Result<()> {
        self.data_db.hash_delete("slide_templates", id).map_err(|e| anyhow::anyhow!(e))
    }

    // ---- Songs ----

    pub fn list_songs(&self) -> Result<Vec<Song>> {
        let rows = self.data_db.hash_list("songs").map_err(|e| anyhow::anyhow!(e))?;
        let mut songs: Vec<Song> = rows.iter().filter_map(|(_, data)| serde_json::from_str(data).ok()).collect();
        songs.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        Ok(songs)
    }

    pub fn save_song(&self, mut song: Song) -> Result<Song> {
        if song.id.is_empty() { song.id = Uuid::new_v4().to_string(); }
        let json = serde_json::to_string_pretty(&song)?;
        self.data_db.hash_set("songs", &song.id, &json).map_err(|e| anyhow::anyhow!(e))?;
        Ok(song)
    }

    pub fn delete_song(&self, id: &str) -> Result<()> {
        self.data_db.hash_delete("songs", id).map_err(|e| anyhow::anyhow!(e))
    }

    // ---- Props ----

    pub fn save_props(&self, props: &[PropItem]) -> Result<()> {
        let json = serde_json::to_string_pretty(props)?;
        self.data_db.kv_set("props", &json).map_err(|e| anyhow::anyhow!(e))
    }

    pub fn load_props(&self) -> Result<Vec<PropItem>> {
        match self.data_db.kv_get("props").map_err(|e| anyhow::anyhow!(e))? {
            Some(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
            None => Ok(vec![]),
        }
    }

    // ---- Lower third templates ----

    pub fn save_lt_templates(&self, templates: &serde_json::Value) -> Result<()> {
        let json = serde_json::to_string_pretty(templates)?;
        self.data_db.kv_set("lt_templates", &json).map_err(|e| anyhow::anyhow!(e))
    }

    pub fn load_lt_templates(&self) -> Result<serde_json::Value> {
        match self.data_db.kv_get("lt_templates").map_err(|e| anyhow::anyhow!(e))? {
            Some(json) => Ok(serde_json::from_str(&json).unwrap_or(serde_json::json!([]))),
            None => Ok(serde_json::json!([])),
        }
    }

    // ---- Lower third presets ----

    pub fn list_lt_presets(&self) -> Result<Vec<LtPreset>> {
        match self.data_db.kv_get("lt_presets").map_err(|e| anyhow::anyhow!(e))? {
            Some(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
            None => Ok(vec![]),
        }
    }

    pub fn save_lt_preset(&self, preset: LtPreset) -> Result<Vec<LtPreset>> {
        let mut presets = self.list_lt_presets()?;
        if let Some(existing) = presets.iter_mut().find(|p| p.id == preset.id) {
            *existing = preset;
        } else {
            presets.push(preset);
        }
        let json = serde_json::to_string_pretty(&presets)?;
        self.data_db.kv_set("lt_presets", &json).map_err(|e| anyhow::anyhow!(e))?;
        Ok(presets)
    }

    pub fn delete_lt_preset(&self, id: &str) -> Result<Vec<LtPreset>> {
        let mut presets = self.list_lt_presets()?;
        presets.retain(|p| p.id != id);
        let json = serde_json::to_string_pretty(&presets)?;
        self.data_db.kv_set("lt_presets", &json).map_err(|e| anyhow::anyhow!(e))?;
        Ok(presets)
    }
}
