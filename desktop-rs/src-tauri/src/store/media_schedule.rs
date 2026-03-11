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
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
}

fn default_media_fit_mode() -> String {
    "contain".to_string()
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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CameraBackground {
    pub device_id: String,
    pub opacity: f32,
    pub object_fit: String,
    pub mirrored: bool,
}

// ---------------------------------------------------------------------------
// Display item — what gets projected on the output window
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", content = "data")]
pub enum DisplayItem {
    Verse(Verse),
    Media(MediaItem),
    Camera(CameraBackground),
    CustomSlide(CustomSlideData),
    Scene(serde_json::Value),
    Timer(TimerData),
    Song(SongSlideData),
}

impl DisplayItem {
    pub fn to_label(&self) -> String {
        match self {
            DisplayItem::Verse(v) => format!("{} {}:{}", v.book, v.chapter, v.verse),
            DisplayItem::Media(m) => m.name.clone(),
            DisplayItem::Camera(_) => "Live Camera Feed".to_string(),
            DisplayItem::CustomSlide(c) => {
                format!("{} – slide {}", c.presentation_name, c.slide_index + 1)
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
    /// How the background logo should fit the screen: "contain" | "cover" | "fill"
    #[serde(default = "default_fit_mode")]
    pub background_logo_fit: String,
    /// Whether the output screen is currently blanked (black).
    #[serde(default)]
    pub is_blanked: bool,
    /// Base font size for scripture text (in pt or similar units used by frontend).
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    /// JPEG quality for native camera streaming (1-100). Defaults to 85.
    #[serde(default = "default_camera_quality")]
    pub native_camera_quality: u32,
    /// Width for native camera streaming. Defaults to 1920.
    #[serde(default = "default_camera_res_width")]
    pub native_camera_res_width: u32,
    /// Height for native camera streaming. Defaults to 1080.
    #[serde(default = "default_camera_res_height")]
    pub native_camera_res_height: u32,
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
    /// Automatically split long verses into multiple slides.
    #[serde(default = "default_auto_split_verses")]
    pub auto_split_verses: bool,
    /// Character limit before splitting a verse (if auto_split is enabled).
    #[serde(default = "default_verse_split_threshold")]
    pub verse_split_threshold: usize,
    /// Whether NDI streaming is enabled on startup.
    #[serde(default)]
    pub ndi_enabled: bool,
    /// Monitor name to send output to; None = auto (first secondary monitor).
    #[serde(default)]
    pub preferred_monitor: Option<String>,
    /// Whether to highlight divine words (e.g. Jesus' words in red).
    #[serde(default = "default_highlight_divine_words")]
    pub highlight_divine_words: bool,
    /// Hex color for the divine word highlight.
    #[serde(default = "default_highlight_color")]
    pub highlight_color: String,
    /// Custom theme color overrides.
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
fn default_camera_quality() -> u32 { 85 }
fn default_camera_res_width() -> u32 { 1920 }
fn default_camera_res_height() -> u32 { 1080 }
fn default_transition() -> String { "fade".to_string() }

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
            media_background: BackgroundSetting::default(),
            logo_path: None,
            background_logo_path: None,
            show_background_logo: false,
            background_logo_fit: default_fit_mode(),
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
            auto_split_verses: default_auto_split_verses(),
            verse_split_threshold: default_verse_split_threshold(),
            ndi_enabled: false,
            native_camera_quality: default_camera_quality(),
            native_camera_res_width: default_camera_res_width(),
            native_camera_res_height: default_camera_res_height(),
            preferred_monitor: None,
            highlight_divine_words: default_highlight_divine_words(),
            highlight_color: default_highlight_color(),
            custom_theme_colors: None,
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

/// A saved Lower Third content item (nameplate or free text) that can be
/// recalled instantly from the desktop operator UI.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LtPreset {
    pub id: String,
    /// Human-readable label shown in the preset list.
    pub label: String,
    pub template_id: Option<String>,
    pub data: LowerThirdData,
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
    studio_dir: PathBuf,
    songs_dir: PathBuf,
    scenes_dir: PathBuf,
    services_dir: PathBuf,
    /// Maps media ID -> absolute file path for O(1) lookups.
    media_cache: Mutex<HashMap<String, PathBuf>>,
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
        let store = Self {
            app_data_dir,
            media_dir,
            thumbnails_dir,
            studio_dir,
            songs_dir,
            scenes_dir,
            services_dir,
            media_cache: Mutex::new(HashMap::new()),
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
        Ok(())
    }

    pub fn get_media_dir(&self) -> PathBuf {
        self.media_dir.clone()
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
            let (description, tags, category) = self.read_media_metadata(path);

            items.push(MediaItem {
                id: id.clone(),
                name,
                path: path.to_string_lossy().to_string(),
                media_type,
                thumbnail_path,
                fit_mode,
                tags,
                description,
                category,
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

    fn description_sidecar(media_path: &PathBuf) -> PathBuf {
        media_path.with_extension(format!(
            "{}.description",
            media_path.extension().unwrap_or_default().to_string_lossy()
        ))
    }

    fn tags_sidecar(media_path: &PathBuf) -> PathBuf {
        media_path.with_extension(format!(
            "{}.tags",
            media_path.extension().unwrap_or_default().to_string_lossy()
        ))
    }

    fn category_sidecar(media_path: &PathBuf) -> PathBuf {
        media_path.with_extension(format!(
            "{}.category",
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

    fn read_media_metadata(&self, media_path: &PathBuf) -> (Option<String>, Vec<String>, Option<String>) {
        let description = fs::read_to_string(Self::description_sidecar(media_path)).ok();
        let tags = fs::read_to_string(Self::tags_sidecar(media_path))
            .ok()
            .map(|s| s.split(',').filter(|s| !s.trim().is_empty()).map(|s| s.trim().to_string()).collect())
            .unwrap_or_default();
        let category = fs::read_to_string(Self::category_sidecar(media_path)).ok();
        (description, tags, category)
    }

    fn write_media_metadata(&self, media_path: &PathBuf, description: &Option<String>, tags: &[String], category: &Option<String>) -> Result<()> {
        if let Some(desc) = description {
            fs::write(Self::description_sidecar(media_path), desc)?;
        } else {
            let _ = fs::remove_file(Self::description_sidecar(media_path));
        }

        let tags_str = tags.join(",");
        if !tags_str.is_empty() {
            fs::write(Self::tags_sidecar(media_path), tags_str)?;
        } else {
            let _ = fs::remove_file(Self::tags_sidecar(media_path));
        }

        if let Some(cat) = category {
            fs::write(Self::category_sidecar(media_path), cat)?;
        } else {
            let _ = fs::remove_file(Self::category_sidecar(media_path));
        }
        Ok(())
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

    pub fn update_media_metadata(&self, id: &str, description: Option<String>, tags: Vec<String>, category: Option<String>) -> Result<()> {
        let path = {
            let cache = self.media_cache.lock();
            cache.get(id).cloned()
        };

        if let Some(path) = path {
            self.write_media_metadata(&path, &description, &tags, &category)?;
            // No need to refresh caches as the changes are to sidecar files, not the core media files
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

        let ext_str = source_path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();

        let media_type = classify_extension(ext_str.as_str())
            .ok_or_else(|| anyhow::anyhow!("Unsupported media type: .{}", ext_str))?;

        let stem = source_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let dot_ext = source_path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();

        let mut dest_path = self.media_dir.join(&original_name);
        let mut dest_name = original_name.clone();
        let mut counter = 2u32;

        // Atomically "reserve" the destination path using create_new(true)
        let mut dest_file = loop {
            match fs::OpenOptions::new().write(true).create_new(true).open(&dest_path) {
                Ok(f) => break f,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    dest_name = format!("{}_{}{}", stem, counter, dot_ext);
                    dest_path = self.media_dir.join(&dest_name);
                    counter += 1;
                }
                Err(e) => return Err(e.into()),
            }
        };

        // Copy source content into the reserved destination file
        let mut source_file = fs::File::open(&source_path)?;
        if let Err(e) = std::io::copy(&mut source_file, &mut dest_file) {
            let _ = fs::remove_file(&dest_path);
            return Err(e.into());
        }

        let id = self.get_or_create_id(&dest_path);
        // Write initial empty metadata
        self.write_media_metadata(&dest_path, &None, &[], &None)?;

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
            tags: Vec::new(),
            description: None,
            category: None,
        })
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
            let desc_sidecar = Self::description_sidecar(&path);
            let tags_sidecar = Self::tags_sidecar(&path);
            let category_sidecar = Self::category_sidecar(&path);

            fs::remove_file(&path)?;
            let _ = fs::remove_file(id_sidecar);
            let _ = fs::remove_file(fit_sidecar);
            let _ = fs::remove_file(thumb_path);
            let _ = fs::remove_file(desc_sidecar);
            let _ = fs::remove_file(tags_sidecar);
            let _ = fs::remove_file(category_sidecar);
            Ok(())
        } else {
            Err(anyhow::anyhow!("Media item not found: {}", id))
        }
    }

    pub fn bulk_delete_media(&self, ids: Vec<String>) -> Result<()> {
        let mut cache = self.media_cache.lock();
        for id in ids {
            if let Some(path) = cache.remove(&id) {
                let id_sidecar = path.with_extension(
                    format!(
                        "{}.mediaid",
                        path.extension().unwrap_or_default().to_string_lossy()
                    )
                );
                let fit_sidecar = Self::fit_sidecar(&path);
                let thumb_path = self.thumbnails_dir.join(format!("{}.jpg", id));
                let desc_sidecar = Self::description_sidecar(&path);
                let tags_sidecar = Self::tags_sidecar(&path);
                let category_sidecar = Self::category_sidecar(&path);

                let _ = fs::remove_file(&path);
                let _ = fs::remove_file(id_sidecar);
                let _ = fs::remove_file(fit_sidecar);
                let _ = fs::remove_file(thumb_path);
                let _ = fs::remove_file(desc_sidecar);
                let _ = fs::remove_file(tags_sidecar);
                let _ = fs::remove_file(category_sidecar);
            }
        }
        Ok(())
    }

    pub fn bulk_update_media(&self, ids: Vec<String>, tags_to_add: Vec<String>, tags_to_remove: Vec<String>, category: Option<String>) -> Result<()> {
        let cache = self.media_cache.lock();
        for id in ids {
            if let Some(path) = cache.get(&id) {
                // Read current metadata to preserve description
                let (current_description, mut current_tags, _) = self.read_media_metadata(path);

                // Update tags
                for tag in tags_to_add.iter() {
                    if !current_tags.contains(tag) {
                        current_tags.push(tag.clone());
                    }
                }
                current_tags.retain(|tag| !tags_to_remove.contains(tag));

                // Write back updated metadata, preserving existing description and applying new category
                self.write_media_metadata(path, &current_description, &current_tags, &category)?;
            }
        }
        Ok(())
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
        self.atomic_write(&path, json)?;
        Ok(())
    }

    fn atomic_write(&self, path: &std::path::PathBuf, content: String) -> Result<()> {
        let tmp_path = path.with_extension("tmp");
        fs::write(&tmp_path, content)?;
        fs::rename(tmp_path, path)?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Schedule
    // -----------------------------------------------------------------------

    pub fn save_schedule(&self, schedule: Schedule) -> Result<()> {
        let path = self.app_data_dir.join("schedule.json");
        let json = serde_json::to_string_pretty(&schedule)?;
        self.atomic_write(&path, json)?;
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
        self.atomic_write(&path, json)?;
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
        self.atomic_write(&path, json)?;
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
        self.atomic_write(&path, json)?;
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
    // Props layer persistence
    // -----------------------------------------------------------------------

    pub fn save_props(&self, props: &[PropItem]) -> Result<()> {
        let path = self.app_data_dir.join("props.json");
        let json = serde_json::to_string_pretty(props)?;
        self.atomic_write(&path, json)?;
        Ok(())
    }

    pub fn load_props(&self) -> Result<Vec<PropItem>> {
        let path = self.app_data_dir.join("props.json");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let json = fs::read_to_string(path)?;
        Ok(serde_json::from_str(&json).unwrap_or_default())
    }

    // -----------------------------------------------------------------------
    // Lower third templates
    // -----------------------------------------------------------------------

    pub fn save_lt_templates(&self, templates: &serde_json::Value) -> Result<()> {
        let path = self.app_data_dir.join("lt_templates.json");
        let json = serde_json::to_string_pretty(templates)?;
        self.atomic_write(&path, json)?;
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
    // Lower third presets (saved content items — Nameplate / FreeText)
    // -----------------------------------------------------------------------

    pub fn list_lt_presets(&self) -> Result<Vec<LtPreset>> {
        let path = self.app_data_dir.join("lt_presets.json");
        if path.exists() {
            let json = fs::read_to_string(path)?;
            Ok(serde_json::from_str(&json).unwrap_or_default())
        } else {
            Ok(vec![])
        }
    }

    pub fn save_lt_preset(&self, preset: LtPreset) -> Result<Vec<LtPreset>> {
        let mut presets = self.list_lt_presets()?;
        if let Some(existing) = presets.iter_mut().find(|p| p.id == preset.id) {
            *existing = preset;
        } else {
            presets.push(preset);
        }
        let path = self.app_data_dir.join("lt_presets.json");
        self.atomic_write(&path, serde_json::to_string_pretty(&presets)?)?;
        Ok(presets)
    }

    pub fn delete_lt_preset(&self, id: &str) -> Result<Vec<LtPreset>> {
        let mut presets = self.list_lt_presets()?;
        presets.retain(|p| p.id != id);
        let path = self.app_data_dir.join("lt_presets.json");
        self.atomic_write(&path, serde_json::to_string_pretty(&presets)?)?;
        Ok(presets)
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
        self.atomic_write(&path, json)?;
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
