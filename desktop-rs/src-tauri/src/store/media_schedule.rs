use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::fs;
use std::collections::HashMap;
use parking_lot::Mutex;
use anyhow::Result;
use uuid::Uuid;
use crate::store::Verse;
use image::GenericImageView;

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
    /// How the media fills the output frame: "contain" | "cover" | "fill"
    #[serde(default = "default_media_fit_mode")]
    pub fit_mode: String,
}

fn default_media_fit_mode() -> String {
    "contain".to_string()
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SlideElement {
    pub id: String,
    pub kind: String, // "text" | "image" | "shape"
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
    
    // Legacy fields
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

fn default_header_enabled() -> bool { true }
fn default_header_height_pct() -> f64 { 35.0 }

/// A live camera feed — either a local getUserMedia device or a LAN WebRTC mobile stream.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CameraFeedData {
    pub device_id: String,
    pub label: String,
    /// true = LAN WebRTC stream from a mobile device; false = local getUserMedia camera
    #[serde(default)]
    pub lan: bool,
    /// Human-readable name for LAN sources (empty for local cameras)
    #[serde(default)]
    pub device_name: String,
}

/// A timer / clock overlay item.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TimerData {
    /// "countdown" | "countup" | "clock"
    pub timer_type: String,
    /// Countdown only: total duration in seconds.
    pub duration_secs: Option<u32>,
    /// Optional text label shown below the time.
    pub label: Option<String>,
    /// Unix milliseconds when the timer was started (None = not yet running).
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
    Timer(TimerData),
    Song(SongSlideData),
}

impl DisplayItem {
    pub fn to_label(&self) -> String {
        match self {
            DisplayItem::Verse(v) => format!("{} {}:{}", v.book, v.chapter, v.verse),
            DisplayItem::Media(m) => m.name.clone(),
            DisplayItem::PresentationSlide(p) => {
                format!("{} – slide {}", p.presentation_name, p.slide_index + 1)
            }
            DisplayItem::CustomSlide(c) => {
                format!("{} – slide {}", c.presentation_name, c.slide_index + 1)
            }
            DisplayItem::CameraFeed(cam) => {
                if !cam.label.is_empty() {
                    cam.label.clone()
                } else if !cam.device_name.is_empty() {
                    cam.device_name.clone()
                } else {
                    cam.device_id.clone()
                }
            }
            DisplayItem::Scene(s) => {
                s.get("name").and_then(|v| v.as_str()).unwrap_or("Scene").to_string()
            }
            DisplayItem::Timer(t) => {
                t.label.as_ref()
                    .filter(|l| !l.is_empty())
                    .cloned()
                    .unwrap_or_else(|| format!("Timer: {}", t.timer_type))
            }
            DisplayItem::Song(s) => {
                format!("{} ({})", s.title, s.section_label)
            }
        }
    }
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

/// Options for a video file used as a background.
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
    /// A looping video file as background.
    Video(VideoBackground),
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
    /// Path to a background logo image/video to cover the output window.
    pub background_logo_path: Option<String>,
    /// Whether the background logo is currently active.
    #[serde(default)]
    pub show_background_logo: bool,
    /// Whether the output screen is currently blanked (black).
    #[serde(default)]
    pub is_blanked: bool,
    /// Base font size for scripture text (in pt or similar units used by frontend).
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    /// Slide transition animation type: "fade" | "slide-up" | "slide-left" | "zoom" | "none"
    #[serde(default = "default_transition")]
    pub slide_transition: String,
    /// Duration of the slide transition in seconds (0.1–2.0).
    #[serde(default = "default_transition_duration")]
    pub slide_transition_duration: f32,
    /// Font family for the verse text body (e.g. "Georgia, serif").
    #[serde(default = "default_verse_font_family")]
    pub verse_font_family: String,
    /// Font size for the scripture reference line (in pt).
    #[serde(default = "default_reference_font_size")]
    pub reference_font_size: f64,
    /// Hex color override for the scripture reference. Empty string means use theme color.
    #[serde(default)]
    pub reference_color: String,
    /// Font family for the scripture reference line.
    #[serde(default = "default_reference_font_family")]
    pub reference_font_family: String,
    /// List of disabled Bible version names.
    #[serde(default)]
    pub disabled_bible_versions: Vec<String>,
    /// Font for the version tag (e.g. "(KJV)")
    #[serde(default = "default_version_font")]
    pub version_font_family: String,
    /// Size for the version tag
    #[serde(default = "default_version_size")]
    pub version_font_size: f64,
    /// Color for the version tag
    #[serde(default)]
    pub version_color: String,
}

fn default_version_font() -> String { "Arial, sans-serif".to_string() }
fn default_version_size() -> f64 { 24.0 }

fn default_font_size() -> f64 {
    72.0
}

fn default_transition() -> String {
    "fade".to_string()
}

fn default_transition_duration() -> f32 {
    0.4
}

fn default_verse_font_family() -> String {
    "Georgia, serif".to_string()
}

fn default_reference_font_size() -> f64 {
    36.0
}

fn default_reference_font_family() -> String {
    "Arial, sans-serif".to_string()
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
            background_logo_path: None,
            show_background_logo: false,
            is_blanked: false,
            font_size: default_font_size(),
            slide_transition: default_transition(),
            slide_transition_duration: default_transition_duration(),
            verse_font_family: default_verse_font_family(),
            reference_font_size: default_reference_font_size(),
            reference_color: String::new(),
            reference_font_family: default_reference_font_family(),
            disabled_bible_versions: Vec::new(),
            version_font_family: default_version_font(),
            version_font_size: default_version_size(),
            version_color: String::new(),
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
    /// Ordered section labels for playback (may repeat sections like choruses).
    /// If empty, sections are used in their natural order.
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

/// Lightweight summary returned by `list_services`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServiceMeta {
    pub id: String,
    pub name: String,
    pub item_count: usize,
    /// Unix milliseconds of the last write.
    pub updated_at: u64,
}

// ---------------------------------------------------------------------------
// Persistent props layer
// ---------------------------------------------------------------------------

/// A persistent on-screen graphic that survives slide changes.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PropItem {
    pub id: String,
    /// "image" | "clock"
    pub kind: String,
    /// Absolute path (image kind).
    pub path: Option<String>,
    /// Clock format string (e.g. "HH:mm:ss") or a text label.
    pub text: Option<String>,
    /// CSS color for clock text.
    pub color: Option<String>,
    /// Canvas position / size as percentages (0–100).
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Opacity 0–1.
    pub opacity: f64,
    pub visible: bool,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

pub struct MediaScheduleStore {
    app_data_dir: PathBuf,
    media_dir: PathBuf,
    thumbnails_dir: PathBuf,
    presentations_dir: PathBuf,
    studio_dir: PathBuf,
    songs_dir: PathBuf,
    scenes_dir: PathBuf,
    services_dir: PathBuf,
    /// Maps media ID -> absolute file path for O(1) lookups.
    media_cache: Mutex<HashMap<String, PathBuf>>,
    /// Maps presentation ID -> absolute file path for O(1) lookups.
    pres_cache: Mutex<HashMap<String, PathBuf>>,
}

fn classify_extension(ext: &str) -> Option<MediaItemType> {
    match ext {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" => Some(MediaItemType::Image),
        "mp4" | "webm" | "mov" | "mkv" | "avi" => Some(MediaItemType::Video),
        _ => None,
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomSlide {
    pub id: String,
    // Frontend uses camelCase; alias accepts legacy snake_case from old saved files
    #[serde(rename = "backgroundColor", alias = "background_color")]
    pub background_color: String,
    #[serde(rename = "backgroundImage", alias = "background_image", default)]
    pub background_image: Option<String>,
    pub elements: Vec<SlideElement>,

    // Legacy fields
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

impl MediaScheduleStore {
    pub fn new(app_data_dir: PathBuf) -> Result<Self> {
        let media_dir = app_data_dir.join("media");
        if !media_dir.exists() {
            fs::create_dir_all(&media_dir)?;
        }
        let thumbnails_dir = app_data_dir.join("thumbnails");
        if !thumbnails_dir.exists() {
            fs::create_dir_all(&thumbnails_dir)?;
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
        let services_dir = app_data_dir.join("services");
        if !services_dir.exists() {
            fs::create_dir_all(&services_dir)?;
        }
        let mut store = Self {
            app_data_dir,
            media_dir,
            thumbnails_dir,
            presentations_dir,
            studio_dir,
            songs_dir,
            scenes_dir,
            services_dir,
            media_cache: Mutex::new(HashMap::new()),
            pres_cache: Mutex::new(HashMap::new()),
        };
        let _ = store.refresh_caches();
        Ok(store)
    }

    pub fn refresh_caches(&self) -> Result<()> {
        {
            let mut cache = self.media_cache.lock();
            cache.clear();
            if let Ok(entries) = fs::read_dir(&self.media_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        let name = path.file_name().unwrap_or_default().to_string_lossy();
                        if !name.starts_with('.') && !name.ends_with(".mediaid") && !name.ends_with(".mediafit") {
                            let id = self.get_or_create_id(&path);
                            cache.insert(id, path);
                        }
                    }
                }
            }
        }
        {
            let mut cache = self.pres_cache.lock();
            cache.clear();
            if let Ok(entries) = fs::read_dir(&self.presentations_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        let name = path.file_name().unwrap_or_default().to_string_lossy();
                        if !name.starts_with('.') && !name.ends_with(".presid") && path.extension().and_then(|e| e.to_str()) == Some("pptx") {
                            let id = self.get_or_create_pres_id(&path);
                            cache.insert(id, path);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub fn get_media_dir(&self) -> PathBuf {
        self.media_dir.clone()
    }

    pub fn get_pptx_cache_dir(&self, pres_id: &str) -> PathBuf {
        self.app_data_dir.join("pptx_cache").join(pres_id)
    }

    // -----------------------------------------------------------------------
    // Media
    // -----------------------------------------------------------------------

    pub fn list_media(&self) -> Result<Vec<MediaItem>> {
        let _ = self.refresh_caches(); // Refresh so we pick up manual file additions
        let mut items = Vec::new();
        let cache = self.media_cache.lock();

        for (id, path) in cache.iter() {
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
            let media_type = match classify_extension(ext.as_str()) {
                Some(t) => t,
                None => continue,
            };

            let fit_mode = self.read_fit_mode(path);
            let thumbnail_path = if matches!(media_type, MediaItemType::Image) {
                self.get_or_create_thumbnail(path, id)
            } else {
                None
            };

            items.push(MediaItem {
                id: id.clone(),
                name,
                path: path.to_string_lossy().to_string(),
                media_type,
                thumbnail_path,
                fit_mode,
            });
        }

        items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(items)
    }

    fn get_or_create_thumbnail(&self, media_path: &PathBuf, id: &str) -> Option<String> {
        let thumb_name = format!("{}.jpg", id);
        let thumb_path = self.thumbnails_dir.join(&thumb_name);

        if thumb_path.exists() {
            return Some(thumb_path.to_string_lossy().to_string());
        }

        // Generate thumbnail for images
        if let Ok(img) = image::open(media_path) {
            let (w, h) = img.dimensions();
            let scale = 320.0 / (w.max(h) as f32);
            let nw = (w as f32 * scale) as u32;
            let nh = (h as f32 * scale) as u32;
            let thumb = img.resize(nw, nh, image::imageops::FilterType::Lanczos3);
            if thumb.save(&thumb_path).is_ok() {
                return Some(thumb_path.to_string_lossy().to_string());
            }
        }
        None
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

    fn fit_sidecar(media_path: &PathBuf) -> PathBuf {
        media_path.with_extension(format!(
            "{}.mediafit",
            media_path.extension().unwrap_or_default().to_string_lossy()
        ))
    }

    fn read_fit_mode(& self, media_path: &PathBuf) -> String {
        fs::read_to_string(Self::fit_sidecar(media_path))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| matches!(s.as_str(), "contain" | "cover" | "fill"))
            .unwrap_or_else(default_media_fit_mode)
    }

    pub fn set_media_fit(&self, id: &str, fit_mode: &str) -> Result<()> {
        let path = {
            let cache = self.media_cache.lock();
            cache.get(id).cloned()
        };

        if let Some(path) = path {
            fs::write(Self::fit_sidecar(&path), fit_mode)?;
            Ok(())
        } else {
            Err(anyhow::anyhow!("Media item not found: {}", id))
        }
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
        {
            let mut cache = self.media_cache.lock();
            cache.insert(id.clone(), dest_path.clone());
        }

        Ok(MediaItem {
            id,
            name: dest_name,
            path: dest_path.to_string_lossy().to_string(),
            media_type,
            thumbnail_path: None,
            fit_mode: default_media_fit_mode(),
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
        let path = {
            let mut cache = self.media_cache.lock();
            cache.remove(&id)
        };

        if let Some(path) = path {
            let id_sidecar = path.with_extension(
                format!(
                    "{}.mediaid",
                    path.extension().unwrap_or_default().to_string_lossy()
                )
            );
            let fit_sidecar = Self::fit_sidecar(&path);
            let thumb_path = self.thumbnails_dir.join(format!("{}.jpg", id));

            fs::remove_file(&path)?;
            let _ = fs::remove_file(id_sidecar);
            let _ = fs::remove_file(fit_sidecar);
            let _ = fs::remove_file(thumb_path);
            Ok(())
        } else {
            Err(anyhow::anyhow!("Media item not found: {}", id))
        }
    }

    // -----------------------------------------------------------------------
    // Presentations
    // -----------------------------------------------------------------------

    pub fn list_presentations(&self) -> Result<Vec<PresentationFile>> {
        let _ = self.refresh_caches(); // Refresh so we pick up manual file additions
        let mut items = Vec::new();
        let cache = self.pres_cache.lock();

        for (id, path) in cache.iter() {
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            items.push(PresentationFile {
                id: id.clone(),
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
        {
            let mut cache = self.pres_cache.lock();
            cache.insert(id.clone(), dest_path.clone());
        }

        Ok(PresentationFile {
            id,
            name: dest_name,
            path: dest_path.to_string_lossy().to_string(),
            slide_count: 0,
        })
    }

    pub fn delete_presentation(&self, id: String) -> Result<()> {
        let path = {
            let mut cache = self.pres_cache.lock();
            cache.remove(&id)
        };

        if let Some(path) = path {
            let sidecar = path.with_extension(
                format!(
                    "{}.presid",
                    path.extension().unwrap_or_default().to_string_lossy()
                )
            );
            fs::remove_file(&path)?;
            let _ = fs::remove_file(sidecar);
            Ok(())
        } else {
            Err(anyhow::anyhow!("Presentation not found: {}", id))
        }
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
    // Named services (persistent multi-service workflow)
    // -----------------------------------------------------------------------

    pub fn list_services(&self) -> Result<Vec<ServiceMeta>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(&self.services_dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() { continue; }
            let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
            if ext != "json" { continue; }
            if let Ok(json) = fs::read_to_string(&path) {
                if let Ok(sched) = serde_json::from_str::<Schedule>(&json) {
                    let updated_at = path.metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    out.push(ServiceMeta {
                        id: sched.id.clone(),
                        name: sched.name.clone(),
                        item_count: sched.items.len(),
                        updated_at,
                    });
                }
            }
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    pub fn save_service(&self, schedule: &Schedule) -> Result<()> {
        let path = self.services_dir.join(format!("{}.json", schedule.id));
        let json = serde_json::to_string_pretty(schedule)?;
        fs::write(path, json)?;
        Ok(())
    }

    pub fn load_service(&self, id: &str) -> Result<Schedule> {
        let path = self.services_dir.join(format!("{}.json", id));
        let json = fs::read_to_string(&path)
            .map_err(|_| anyhow::anyhow!("Service '{}' not found", id))?;
        Ok(serde_json::from_str(&json)?)
    }

    pub fn delete_service(&self, id: &str) -> Result<()> {
        let path = self.services_dir.join(format!("{}.json", id));
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
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
    pub fn save_studio_presentation(&self, presentation: &CustomPresentation) -> Result<()> {
        let path = self.studio_dir.join(format!("{}.json", presentation.id));
        let json = serde_json::to_string_pretty(presentation)?;
        fs::write(path, json)?;
        Ok(())
    }

    /// Reads and returns the full presentation JSON for the given id.
    pub fn load_studio_presentation(&self, id: &str) -> Result<CustomPresentation> {
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
