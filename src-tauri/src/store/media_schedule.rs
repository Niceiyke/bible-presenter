use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::fs;
use anyhow::Result;
use uuid::Uuid;
use crate::store::Verse;
use crate::store::data_db::DataDb;
use image::GenericImageView;
use std::sync::Arc;
use tauri::Emitter;

// ---------------------------------------------------------------------------
// Media types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum MediaItemType {
    Image,
    Video,
    Audio,
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
    /// P4.8: probe metadata + playback config persisted per item. `duration`
    /// is seconds (videos/audio), `width`/`height` are pixel dimensions,
    /// `content_hash` is a sha256 of the imported file (used for dedup).
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub width: Option<i64>,
    #[serde(default)]
    pub height: Option<i64>,
    #[serde(default)]
    pub content_hash: Option<String>,
    #[serde(default = "default_loop_playback")]
    pub loop_playback: bool,
    #[serde(default = "default_playback_rate")]
    pub playback_rate: f64,
    #[serde(default = "default_media_volume")]
    pub volume: f64,
}

fn default_media_fit_mode() -> String { "contain".to_string() }
fn default_loop_playback() -> bool { true }
fn default_playback_rate() -> f64 { 1.0 }
fn default_media_volume() -> f64 { 1.0 }

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
    /// P3.4: rotation (degrees, clockwise), flip flags. Stored as loose
    /// numbers/booleans so the renderer can apply `transform: rotate(…) /
    /// scaleX(-1) / scaleY(-1)` without touching Rust when new transform
    /// variants are added.
    #[serde(default, rename = "rotation")]
    pub rotation: Option<f64>,
    #[serde(default, rename = "flipX")]
    pub flip_x: Option<bool>,
    #[serde(default, rename = "flipY")]
    pub flip_y: Option<bool>,
    /// P4.5: per-element entrance animation recipe (type/duration/delay).
    /// Stored loosely so the renderer reads `entrance` without Rust owning
    /// the shape; mirrors `content`'s escape-hatch approach.
    #[serde(default)]
    pub entrance: Option<serde_json::Value>,
    /// Phase 2.2: TextElement.content is a ProseMirror JSON doc on the
    /// frontend; the legacy HTML-string escape hatch stays a JSON string
    /// for one release cycle. Image/video elements carry a plain path
    /// string. Storing the field as `serde_json::Value` lets both shapes
    /// round-trip through Rust without any per-kind marshalling here.
    #[serde(default = "default_content")]
    pub content: serde_json::Value,
    #[serde(default)]
    pub font_size: Option<f64>,
    #[serde(default)]
    pub font_family: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub align: Option<String>,
    #[serde(default)]
    pub v_align: Option<String>,
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
    // P1.3: renamed `loop_video` -> `loop` to match the frontend contract.
    // The `alias` keeps older saved presentations loadable.
    #[serde(rename = "loop", alias = "loop_video", default)]
    pub loop_video: Option<bool>,
    #[serde(default)]
    pub muted: Option<bool>,
    /// P2.4: optional master-placeholder role ("title" | "body" | "footer").
    /// Stored as a loose string (one of the allowed literals) so Rust's
    /// serde layer doesn't need to model the enum when round-tripping.
    #[serde(default, rename = "role")]
    pub role: Option<String>,
    /// Phase 3.3 — auto-fit behaviour. One of `"grow"` / `"shrink"` /
    /// `"fixed"`. Stored as a loose string so future modes don't require
    /// a Rust change.
    #[serde(default, rename = "autoSize")]
    pub auto_size: Option<String>,
    /// P3.5 — ShapeElement taxonomy. `shape` is one of `rect`/`rounded`/
    /// `circle`/`line`/`triangle`. Stroke and border-radius ride along
    /// as loose scalars; the frontend rehydrates per-kind.
    #[serde(default, rename = "shape")]
    pub shape: Option<String>,
    #[serde(default, rename = "fillColor", alias = "fill_color")]
    pub fill_color: Option<String>,
    #[serde(default, rename = "strokeColor")]
    pub stroke_color: Option<String>,
    #[serde(default, rename = "strokeWidth")]
    pub stroke_width: Option<f64>,
    #[serde(default, rename = "borderRadius")]
    pub border_radius: Option<f64>,
    /// P3.6 — image-specific presentation props. `filter` is one of
    /// the frontend's "none"/"grayscale"/"sepia"/"blur"/"brightness"
    /// literals stored as a loose string; `filterValue` is the 0–100
    /// strength; `objectFit`/`objectPosition` map straight to the
    /// corresponding CSS properties. `border` is a small inline
    /// {color,width} object the frontend emits as a single CSS rule.
    #[serde(default, rename = "objectFit")]
    pub object_fit: Option<String>,
    #[serde(default, rename = "objectPosition")]
    pub object_position: Option<String>,
    #[serde(default, rename = "filter")]
    pub filter: Option<String>,
    #[serde(default, rename = "filterValue")]
    pub filter_value: Option<f64>,
    // borderRadius is shared between ShapeElement (P3.5) and
    // ImageElement (P3.6) — declared once above, so no redeclaration.
    #[serde(default, rename = "border")]
    pub border: Option<serde_json::Value>,
}

/// `serde` default for `SlideElement.content`. Empty value; the real
/// content always arrives from the frontend. Picking `Value::Null`
/// would silently substitute the legacy-string contract many places
/// still touch, so we use an empty JSON string instead.
fn default_content() -> serde_json::Value {
    serde_json::Value::String(String::new())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomSlideData {
    pub presentation_id: String,
    pub presentation_name: String,
    pub slide_index: u32,
    pub slide_count: u32,
    /// P2.1: discriminated-union background. The legacy flat fields
    /// below remain on the Rust struct only for back-compat with old
    /// on-wire payloads; the renderer side reads `background` first
    /// and falls back to them when this is `None`.
    #[serde(default, rename = "background")]
    pub background: Option<serde_json::Value>,
    #[serde(rename = "backgroundColor", alias = "background_color", default)]
    pub background_color: Option<String>,
    #[serde(rename = "backgroundImage", alias = "background_image", default)]
    pub background_image: Option<String>,
    #[serde(rename = "backgroundVideo", alias = "background_video", default)]
    pub background_video: Option<String>,
    #[serde(rename = "backgroundVideoLoop", alias = "background_video_loop", default)]
    pub background_video_loop: Option<bool>,
    #[serde(rename = "backgroundVideoMuted", alias = "background_video_muted", default)]
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
    /// P2.4: optional cascade theme carried by the on-wire slide payload
    /// for the output window. The frontend embeds the presentation
    /// theme here when broadcasting a live custom slide so the renderer
    /// can resolve "inherit" element styles even though it does not
    /// have a presentation handle of its own.
    #[serde(default, rename = "theme")]
    pub theme: Option<serde_json::Value>,
    #[serde(default)]
    pub notes: Option<String>,
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
    /// Phase 6 (SONG_SYSTEM_MODERNIZATION_PLAN §10/§4.7): the display mode a
    /// committed song should render in. Survives `stage_item`/`commit_staged`
    /// so a round-trip never silently drops the full-screen vs overlay
    /// distinction. Frontend `SongSlideData.style` mirrors this.
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
    /// Per-song background override (settings-side `BackgroundSetting` union).
    /// When present and not `None`, wins over Settings → Backgrounds "Songs"
    /// content override and the global output background. Mirrors how a
    /// `CustomSlide` carries its own background field. Optional so legacy
    /// song JSON continues to deserialize.
    #[serde(default)]
    pub background: Option<BackgroundSetting>,
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
#[serde(rename_all = "camelCase")]
pub struct AudioBackground {
    pub path: String,
    #[serde(default = "vbg_default_true")]
    pub loop_audio: bool,
    #[serde(default = "vbg_default_one")]
    pub volume: f32,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageBackground {
    pub path: String,
    #[serde(default = "vbg_default_cover")]
    pub object_fit: String,
    #[serde(default = "vbg_default_one")]
    pub opacity: f32,
}

/// Deserialize a legacy `"path"` string into an `ImageBackground` so old
/// saved settings keep loading. Serde's tagged enums try the tagged
/// variant first; a plain string value still needs this lenient path.
impl<'de> serde::Deserialize<'de> for ImageBackground {
    fn deserialize<D>(d: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(serde::Deserialize)]
        #[serde(untagged)]
        enum Repr {
            New {
                path: String,
                #[serde(default = "vbg_default_cover", rename = "objectFit")]
                object_fit: String,
                #[serde(default = "vbg_default_one")]
                opacity: f32,
            },
            Legacy(String),
        }
        match Repr::deserialize(d)? {
            Repr::New { path, object_fit, opacity } => Ok(ImageBackground { path, object_fit, opacity }),
            Repr::Legacy(path) => Ok(ImageBackground { path, object_fit: "cover".to_string(), opacity: 1.0 }),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
#[serde(tag = "type", content = "value")]
pub enum BackgroundSetting {
    #[default]
    None,
    Color(String),
    Image(ImageBackground),
    Video(VideoBackground),
    Camera(CameraBackground),
    Audio(AudioBackground),
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
    #[serde(default)]
    pub song_background: BackgroundSetting,
    #[serde(default)]
    pub show_song_section_labels: bool,
    #[serde(default = "default_reference_output_height")]
    pub reference_output_height: f64,
    pub logo_path: Option<String>,
    pub background_logo_path: Option<String>,
    #[serde(default)]
    pub show_background_logo: bool,
    #[serde(default)]
    pub logo_text: Option<String>,
    #[serde(default)]
    pub logo_text_color: Option<String>,
    #[serde(default)]
    pub background_logo_text: Option<String>,
    #[serde(default)]
    pub background_logo_text_color: Option<String>,
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
    /// When true, sending an item live automatically hides the pre-service
    /// background logo. Exposed as a setting so the operator can keep the
    /// logo on during slides if desired. Defaults to true (legacy behaviour).
    #[serde(default = "default_auto_clear_background_logo")]
    pub auto_clear_background_logo: bool,
    /// When true, the stage monitor renders with the active theme instead of
    /// the hardcoded slate palette. Defaults to false (legacy behaviour).
    #[serde(default)]
    pub stage_uses_theme: bool,
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
fn default_auto_clear_background_logo() -> bool { true }
fn default_version_font() -> String { "Arial, sans-serif".to_string() }
fn default_version_size() -> f64 { 24.0 }
fn default_font_size() -> f64 { 72.0 }
fn default_reference_output_height() -> f64 { 1080.0 }
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
            media_background: BackgroundSetting::default(), song_background: BackgroundSetting::default(), show_song_section_labels: false, reference_output_height: default_reference_output_height(), logo_path: None, background_logo_path: None,
            show_background_logo: false, background_logo_fit: default_fit_mode(), is_blanked: false,
            logo_text: None, logo_text_color: None,
            background_logo_text: None, background_logo_text_color: None,
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
            auto_clear_background_logo: default_auto_clear_background_logo(),
            stage_uses_theme: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LyricSection {
    /// P1: stable section identity referenced by `arrangement_steps`. Optional
    /// so legacy JSON without ids still deserializes; `normalizeSong`
    /// backfills one before the next save.
    #[serde(default)]
    pub id: Option<String>,
    pub label: String,
    pub lines: Vec<String>,
}

/// P1: one step in the canonical (id-based) song arrangement.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SongArrangementStep {
    pub section_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Song {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub copyright: Option<String>,
    #[serde(default)]
    pub ccli: Option<String>,
    /// P1: musical key (e.g. "G"). Optional; survives import + save.
    #[serde(default)]
    pub key: Option<String>,
    pub sections: Vec<LyricSection>,
    /// Legacy field. Read during migration and written during the
    /// compatibility window so old consumers remain loadable.
    #[serde(default)]
    pub arrangement: Vec<String>,
    /// P1: canonical arrangement as ordered section-id references.
    #[serde(default)]
    pub arrangement_steps: Option<Vec<SongArrangementStep>>,
    /// Optional schema marker for future migrations.
    #[serde(default)]
    pub schema_version: Option<u32>,
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
    /// Per-song background override. See `SongSlideData::background`.
    #[serde(default)]
    pub background: Option<BackgroundSetting>,
}

#[cfg(test)]
mod song_tests {
    use super::*;

    const LEGACY_SONG: &str = r#"{
        "id": "s1",
        "title": "Amazing Grace",
        "author": "John Newton",
        "sections": [
            { "label": "Verse 1", "lines": ["Amazing grace", "How sweet the sound"] },
            { "label": "Chorus", "lines": ["Was blind but now I see"] }
        ],
        "arrangement": ["Chorus", "Verse 1"]
    }"#;

    const NEW_SONG: &str = r#"{
        "id": "s2",
        "title": "How Great",
        "author": "Carl Boberg",
        "key": "G",
        "sections": [
            { "id": "sec-a", "label": "Verse 1", "lines": ["O Lord my God"] },
            { "id": "sec-b", "label": "Chorus", "lines": ["Then sings my soul"] }
        ],
        "arrangement": ["Chorus", "Verse 1"],
        "arrangement_steps": [{ "section_id": "sec-b" }, { "section_id": "sec-a" }],
        "schema_version": 2
    }"#;

    #[test]
    fn legacy_song_json_deserializes_with_optional_fields_defaulted() {
        let song: Song = serde_json::from_str(LEGACY_SONG).expect("legacy song must load");
        assert_eq!(song.title, "Amazing Grace");
        assert_eq!(song.sections.len(), 2);
        assert!(song.sections[0].id.is_none(), "legacy sections have no id");
        assert!(song.key.is_none());
        assert!(song.arrangement_steps.is_none());
        assert!(song.schema_version.is_none());
    }

    #[test]
    fn new_song_json_round_trips_id_and_arrangement_steps() {
        let song: Song = serde_json::from_str(NEW_SONG).expect("new song must load");
        assert_eq!(song.sections[0].id.as_deref(), Some("sec-a"));
        assert_eq!(song.key.as_deref(), Some("G"));
        let steps = song.arrangement_steps.as_ref().expect("steps present");
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].section_id, "sec-b");
        assert_eq!(song.schema_version, Some(2));

        let json = serde_json::to_string(&song).expect("serialize");
        let again: Song = serde_json::from_str(&json).expect("round trip");
        assert_eq!(again.sections[0].id.as_deref(), Some("sec-a"));
        assert_eq!(again.arrangement_steps.as_ref().unwrap()[1].section_id, "sec-a");
    }

    #[test]
    fn save_round_trip_preserves_legacy_arrangement_field() {
        let song: Song = serde_json::from_str(LEGACY_SONG).unwrap();
        let json = serde_json::to_string(&song).unwrap();
        let again: Song = serde_json::from_str(&json).unwrap();
        assert_eq!(again.arrangement, vec!["Chorus", "Verse 1"]);
    }

    #[test]
    fn song_slide_data_round_trips_full_slide_style() {
        let data = SongSlideData {
            song_id: "s1".into(),
            title: "Amazing Grace".into(),
            author: Some("Newton".into()),
            section_label: "Verse 1".into(),
            lines: vec!["Amazing grace".into()],
            slide_index: 0,
            total_slides: 3,
            style: Some("FullSlide".into()),
            font: None,
            font_size: None,
            font_weight: None,
            color: None,
            background: None,
        };
        let json = serde_json::to_string(&data).unwrap();
        let again: SongSlideData = serde_json::from_str(&json).unwrap();
        assert_eq!(again.style.as_deref(), Some("FullSlide"));
    }

    #[test]
    fn song_slide_data_round_trips_lower_third_style() {
        let data = SongSlideData {
            song_id: "s1".into(),
            title: "Amazing Grace".into(),
            author: None,
            section_label: "Chorus".into(),
            lines: vec!["line".into()],
            slide_index: 1,
            total_slides: 4,
            style: Some("LowerThird".into()),
            font: Some("Georgia".into()),
            font_size: Some(40.0),
            font_weight: Some("bold".into()),
            color: Some("#ffffff".into()),
            background: None,
        };
        let json = serde_json::to_string(&data).unwrap();
        let again: SongSlideData = serde_json::from_str(&json).unwrap();
        assert_eq!(again.style.as_deref(), Some("LowerThird"));
        assert_eq!(again.font.as_deref(), Some("Georgia"));
        assert_eq!(again.font_size, Some(40.0));
    }

    #[test]
    fn display_item_song_round_trips_style_through_enum() {
        let item = DisplayItem::Song(SongSlideData {
            song_id: "s1".into(),
            title: "T".into(),
            author: None,
            section_label: "Verse".into(),
            lines: vec!["x".into()],
            slide_index: 0,
            total_slides: 1,
            style: Some("LowerThird".into()),
            font: None,
            font_size: None,
            font_weight: None,
            color: None,
            background: None,
        });
        let json = serde_json::to_string(&item).unwrap();
        let again: DisplayItem = serde_json::from_str(&json).unwrap();
        match again {
            DisplayItem::Song(s) => assert_eq!(s.style.as_deref(), Some("LowerThird")),
            _ => panic!("expected Song variant"),
        }
    }
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
// Scenes (recallable bundles of settings + props + lower-third)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Scene {
    pub id: String,
    pub name: String,
    pub settings: PresentationSettings,
    pub props: Vec<PropItem>,
    /// Stored lower-third content (Nameplate/Lyrics/FreeText). The template
    /// is stored separately as a raw JSON value to avoid a hard dependency on
    /// the frontend's template schema.
    pub lower_third_data: Option<LowerThirdData>,
    pub lower_third_template: Option<serde_json::Value>,
    pub created_at: u64,
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
    /// P2.1: discriminated-union background. The flat legacy fields
    /// below remain (defaulted) for back-compat with on-disk v0/v1
    /// presentations and round-trip through old builders; new saves
    /// set this and the frontend's `migratePresentation` repopulates
    /// it on load if it's missing.
    #[serde(default, rename = "background")]
    pub background: Option<serde_json::Value>,
    #[serde(rename = "backgroundColor", alias = "background_color", default = "default_background_color")]
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
    /// P2.4: optional master layout reference. Round-trips as a loose
    /// string so the frontend's cascade logic can trace dependent
    /// slides back to their `SlideMaster` definition.
    #[serde(default, rename = "masterRef")]
    pub master_ref: Option<String>,
}

/// `serde` default for the legacy `background_color` field. Empty string
/// rather than the historical "#1a1a2e" because new presentations set
/// the `background` union directly and never reach this fallback.
fn default_background_color() -> String { String::new() }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CustomPresentation {
    pub id: String,
    pub name: String,
    pub slides: Vec<CustomSlide>,
    #[serde(default)]
    pub version: Option<u32>,
    /// P2.4: theme defaults applied to elements whose own style props
    /// carry the `"inherit"` sentinel. Loose `serde_json::Value` so new
    /// `SlideTheme` fields round-trip without re-publishing the Rust
    /// types on every extension.
    #[serde(default, rename = "theme")]
    pub theme: Option<serde_json::Value>,
    /// P2.4: optional reusable master layouts. Same permissive
    /// `serde_json::Value` for round-tripping.
    #[serde(default, rename = "masters")]
    pub masters: Option<serde_json::Value>,
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
    /// Single-slide template. One of `slide` / `slides` is set (P4.1).
    #[serde(default)]
    pub slide: Option<CustomSlide>,
    /// Deck template (P4.1): a sequence of slides inserted together.
    #[serde(default)]
    pub slides: Option<Vec<CustomSlide>>,
    pub created_at: u64,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

fn classify_extension(ext: &str) -> Option<MediaItemType> {
    match ext {
        "jpg"|"jpeg"|"png"|"gif"|"webp"|"bmp"|"svg" => Some(MediaItemType::Image),
        "mp4"|"webm"|"mov"|"mkv"|"avi" => Some(MediaItemType::Video),
        "mp3"|"wav"|"ogg"|"m4a"|"aac"|"flac" => Some(MediaItemType::Audio),
        _ => None,
    }
}

pub struct MediaScheduleStore {
    app_data_dir: PathBuf,
    media_dir: PathBuf,
    thumbnails_dir: PathBuf,
    data_db: Arc<DataDb>,
}

// Derive Clone manually since the struct stores an Arc (cheap clone) plus
// PathBufs; the command layer clones it into `spawn_blocking` tasks for
// streaming imports + offloaded thumbnail generation.
impl Clone for MediaScheduleStore {
    fn clone(&self) -> Self {
        Self {
            app_data_dir: self.app_data_dir.clone(),
            media_dir: self.media_dir.clone(),
            thumbnails_dir: self.thumbnails_dir.clone(),
            data_db: self.data_db.clone(),
        }
    }
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
                    if path.extension().is_some_and(|e| e == "json") {
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
                    if path.extension().is_some_and(|e| e == "json") {
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
                    if path.extension().is_some_and(|e| e == "json") {
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
                                    let media_type = match mt { MediaItemType::Image => "Image", MediaItemType::Video => "Video", MediaItemType::Audio => "Audio" };
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
        for (id, filename, path, media_type, fit_mode, description, tags, category,
             thumbnail_path, duration, width, height, content_hash, loop_playback,
             playback_rate, volume) in rows {
            let media_type = match media_type.as_str() {
                "Image" => MediaItemType::Image,
                "Audio" => MediaItemType::Audio,
                _ => MediaItemType::Video,
            };
            let tags: Vec<String> = serde_json::from_str(&tags).unwrap_or_default();
            // Resolve stored path: if it's already absolute, use as-is (legacy
            // records); otherwise treat it as relative to the media dir.
            let resolved_path = if PathBuf::from(&path).is_absolute() {
                path
            } else {
                self.media_dir.join(&path).to_string_lossy().to_string()
            };
            let thumb = if thumbnail_path.is_empty() { None } else {
                // Stored thumbnail paths are absolute; resolve legacy relative
                // entries (pre-P4.8) against the thumbnails dir.
                let p = if PathBuf::from(&thumbnail_path).is_absolute() {
                    thumbnail_path
                } else {
                    self.thumbnails_dir.join(&thumbnail_path).to_string_lossy().to_string()
                };
                Some(p)
            };
            items.push(MediaItem {
                id,
                name: filename,
                path: resolved_path,
                media_type,
                thumbnail_path: thumb,
                fit_mode,
                tags,
                description: if description.is_empty() { None } else { Some(description) },
                category: if category.is_empty() { None } else { Some(category) },
                duration,
                width,
                height,
                content_hash: if content_hash.is_empty() { None } else { Some(content_hash) },
                loop_playback,
                playback_rate,
                volume,
            });
        }
        Ok(items)
    }

    fn get_or_create_thumbnail_static(thumb_dir: &Path, media_path: &str, id: &str) -> Option<String> {
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

    /// Best-effort video metadata + thumbnail extraction via ffmpeg. Returns
    /// (thumbnail_path, duration_secs, width, height) where None values mean
    /// "could not determine". ffmpeg is not bundled; if it isn't on PATH the
    /// whole probe degrades to (None, None, None, None) instead of erroring.
    fn probe_video(thumb_dir: &Path, media_path: &str, id: &str) -> (Option<String>, Option<f64>, Option<i64>, Option<i64>) {
        use std::process::Command;
        let thumb_path = thumb_dir.join(format!("{}.jpg", id));

        // 1) Frame extraction (thumbnail). -y overwrite, scale to 320w.
        if !thumb_path.exists() {
            let ok = Command::new("ffmpeg")
                .args(["-y", "-ss", "1", "-i", media_path, "-frames:v", "1", "-vf", "scale=320:-1", "-q:v", "4"])
                .arg(&thumb_path)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !ok {
                let _ = fs::remove_file(&thumb_path);
            }
        }
        let thumb = if thumb_path.exists() { Some(thumb_path.to_string_lossy().to_string()) } else { None };

        // 2) Duration + dimensions via ffprobe (stream of first video track).
        let mut duration: Option<f64> = None;
        let mut width: Option<i64> = None;
        let mut height: Option<i64> = None;
        if let Ok(out) = Command::new("ffprobe")
            .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration:stream=width,height", "-of", "json"])
            .arg(media_path)
            .output()
        {
            if out.status.success() {
                if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                    duration = json.pointer("/format/duration").and_then(|v| v.as_str())
                        .and_then(|s| s.parse::<f64>().ok()).or(duration);
                    width = json.pointer("/streams/0/width").and_then(|v| v.as_i64());
                    height = json.pointer("/streams/0/height").and_then(|v| v.as_i64());
                }
            }
        }
        (thumb, duration, width, height)
    }

    /// Best-effort audio duration via ffprobe (None if ffmpeg is unavailable).
    fn probe_audio_duration(media_path: &str) -> Option<f64> {
        use std::process::Command;
        if let Ok(out) = Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1"])
            .arg(media_path)
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if let Ok(d) = s.parse::<f64>() { return Some(d); }
            }
        }
        None
    }

    fn media_type_str(mt: &MediaItemType) -> &'static str {
        match mt { MediaItemType::Image => "Image", MediaItemType::Video => "Video", MediaItemType::Audio => "Audio" }
    }

    /// Compute a content hash for the media file. This is the dedup key —
    /// importing the same source twice returns the existing record instead of
    /// creating a copy. sha256 is fast enough on modern hardware for the
    /// streaming chunk loop below.
    fn content_hash(path: &std::path::Path) -> Option<String> {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let file = std::fs::File::open(path).ok()?;
        let mut hasher = Sha256::new();
        let mut reader = std::io::BufReader::with_capacity(1024 * 1024, file);
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => { hasher.update(&buf[..n]); }
                Err(_) => return None,
            }
        }
        Some(format!("{:x}", hasher.finalize()))
    }

    /// Resolve the destination path for an import with a unique name, then
    /// copy the source there (dedup on name handled by the caller loop).
    fn copy_into_media_dir(&self, source_path: &std::path::Path) -> Result<(String, PathBuf), anyhow::Error> {
        let original_name = source_path.file_name().ok_or_else(|| anyhow::anyhow!("Invalid source path"))?.to_string_lossy().to_string();
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

        let mut source_file = fs::File::open(source_path)?;
        if let Err(e) = std::io::copy(&mut source_file, &mut dest_file) {
            let _ = fs::remove_file(&dest_path);
            return Err(e.into());
        }
        Ok((dest_name, dest_path))
    }

    /// Shared tail of `add_media` / `add_media_streaming`. The destination
    /// record the fresh copy is deleted and the existing item is returned
    /// (dedup) — otherwise a new record is inserted and a background probe
    /// (thumbnail + duration/dimensions) is spawned.
    fn finalize_import(&self, app: Option<tauri::AppHandle>, dest_name: String, dest_path: PathBuf, media_type: MediaItemType, created_at: String) -> Result<MediaItem, anyhow::Error> {
        let id = Uuid::new_v4().to_string();
        let stored_path = dest_name.clone();

        // Dedup check before inserting the row so no orphan record is left.
        if let Some(hash) = Self::content_hash(&dest_path) {
            if let Ok(Some(existing_id)) = self.data_db.find_media_by_hash(&hash) {
                let _ = fs::remove_file(&dest_path);
                let _ = self.data_db.set_media_hash(&existing_id, &hash);
                return self.get_media(&existing_id);
            }
            let _ = self.data_db.insert_media(&id, &dest_name, &stored_path, Self::media_type_str(&media_type), &created_at);
            let _ = self.data_db.set_media_hash(&id, &hash);
            if let Some(app) = app { self.spawn_probe(app, &id); }
            return self.get_media(&id);
        }

        self.data_db.insert_media(&id, &dest_name, &stored_path, Self::media_type_str(&media_type), &created_at)
            .map_err(|e| anyhow::anyhow!(e))?;
        if let Some(app) = app { self.spawn_probe(app, &id); }
        self.get_media(&id)
    }

    pub fn get_media(&self, id: &str) -> Result<MediaItem> {
        let rows = self.list_media()?;
        rows.into_iter().find(|m| m.id == id)
            .ok_or_else(|| anyhow::anyhow!("Media '{}' not found", id))
    }

    pub fn set_media_fit(&self, id: &str, fit_mode: &str) -> Result<()> {
        self.data_db.set_media_fit(id, fit_mode).map_err(|e| anyhow::anyhow!(e))
    }

    pub fn set_media_playback(&self, id: &str, loop_playback: bool, playback_rate: f64, volume: f64) -> Result<()> {
        self.data_db.set_media_playback(id, loop_playback, playback_rate, volume).map_err(|e| anyhow::anyhow!(e))
    }

    pub fn update_media_metadata(&self, id: &str, description: Option<String>, tags: Vec<String>, category: Option<String>) -> Result<()> {
        let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
        self.data_db.update_media_metadata(id, &description, &tags_json, &category).map_err(|e| anyhow::anyhow!(e))
    }

    /// Relink a record to a new source file: copies the replacement in, updates
    /// the stored path/name, clears the stale thumbnail and regenerates it.
    pub fn relink_media(&self, id: &str, source_path: &std::path::Path) -> Result<MediaItem, anyhow::Error> {
        let ext_str = source_path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        let media_type = classify_extension(&ext_str).ok_or_else(|| anyhow::anyhow!("Unsupported media type: .{}", ext_str))?;
        let (dest_name, dest_path) = self.copy_into_media_dir(source_path)?;
        let _ = self.data_db.relink_media(id, &dest_name, &dest_name);
        // Regenerate thumbnail: existing thumb was for the old file.
        let thumb = self.thumbnails_dir.join(format!("{}.jpg", id));
        let _ = fs::remove_file(&thumb);
        let (thumb_path, duration, width, height) = match media_type {
            MediaItemType::Image => (
                Self::get_or_create_thumbnail_static(&self.thumbnails_dir, dest_path.to_string_lossy().as_ref(), id),
                None, None, None,
            ),
            MediaItemType::Video => Self::probe_video(&self.thumbnails_dir, dest_path.to_string_lossy().as_ref(), id),
            MediaItemType::Audio => (None, Self::probe_audio_duration(dest_path.to_string_lossy().as_ref()), None, None),
        };
        let _ = self.data_db.set_media_probe(id, thumb_path.as_deref(), duration, width, height);
        self.get_media(id)
    }

    /// Spawn a background thread that generates a thumbnail + probes metadata
    /// for a freshly imported item, persisting results to the DB. Emits
    /// `media-probed` (with the updated item) so the frontend can refresh the
    /// card without a full re-list.
    pub fn spawn_probe(&self, app: tauri::AppHandle, id: &str) {
        let store = self.clone();
        let id = id.to_string();
        let app2 = app.clone();
        std::thread::spawn(move || {
            let result = (|| -> Result<(), String> {
                let item = store.get_media(&id).map_err(|e| e.to_string())?;
                let (thumb_path, duration, width, height) = match item.media_type {
                    MediaItemType::Image => (
                        Self::get_or_create_thumbnail_static(&store.thumbnails_dir, &item.path, &id),
                        None, None, None,
                    ),
                    MediaItemType::Video => Self::probe_video(&store.thumbnails_dir, &item.path, &id),
                    MediaItemType::Audio => (None, Self::probe_audio_duration(&item.path), None, None),
                };
                store.data_db.set_media_probe(&id, thumb_path.as_deref(), duration, width, height)
                    .map_err(|e| e.to_string())?;
                Ok(())
            })();
            if let Ok(updated) = store.get_media(&id) {
                let _ = app2.emit("media-probed", &updated);
            }
            let _ = result;
        });
    }

    pub fn add_media(&self, app: Option<tauri::AppHandle>, source_path: PathBuf) -> Result<MediaItem> {
        let ext_str = source_path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        let media_type = classify_extension(&ext_str).ok_or_else(|| anyhow::anyhow!("Unsupported media type: .{}", ext_str))?;
        let (dest_name, dest_path) = self.copy_into_media_dir(&source_path)?;
        let created_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        self.finalize_import(app, dest_name, dest_path, media_type, created_at)
    }

    /// Streaming variant: copies the source in 1 MiB chunks, invoking
    /// `on_progress(fraction 0.0..1.0)` after each chunk so the command layer
    /// can emit a progress event. Keeps large video imports from freezing the
    /// async runtime thread.
    pub fn add_media_streaming<F: FnMut(f64)>(
        &self,
        app: Option<tauri::AppHandle>,
        source_path: PathBuf,
        mut on_progress: F,
    ) -> Result<MediaItem> {
        let ext_str = source_path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        let media_type = classify_extension(&ext_str).ok_or_else(|| anyhow::anyhow!("Unsupported media type: .{}", ext_str))?;

        let mut dest_path = self.media_dir.join(source_path.file_name().unwrap_or_default().to_string_lossy().to_string());
        let mut dest_name = source_path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let stem = source_path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let dot_ext = source_path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
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
        let total = source_file.metadata().map(|m| m.len()).unwrap_or(0);
        let mut copied: u64 = 0;
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            let n = match std::io::Read::read(&mut source_file, &mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    let _ = fs::remove_file(&dest_path);
                    return Err(e.into());
                }
            };
            if let Err(e) = std::io::Write::write_all(&mut dest_file, &buf[..n]) {
                let _ = fs::remove_file(&dest_path);
                return Err(e.into());
            }
            copied += n as u64;
            let frac = if total > 0 { (copied as f64) / (total as f64) } else { 0.0 };
            on_progress(frac.min(1.0));
        }

        let created_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        self.finalize_import(app, dest_name, dest_path, media_type, created_at)
    }

    /// Scan the hash-backed stores (services, presentations, scenes) for
    /// references to a media path so the operator can be warned before
    /// deleting something that is still scheduled or embedded. Returns a list
    /// of human-readable "where is it used" labels.
    pub fn find_media_references(&self, path: &str) -> Vec<String> {
        let mut refs = Vec::new();
        let tables = ["services", "presentations", "scenes"];
        for table in tables {
            if let Ok(rows) = self.data_db.hash_list(table) {
                for (_, data) in rows {
                    if data.contains(path) {
                        // Extract a friendly label: name field for the record.
                        let name = serde_json::from_str::<serde_json::Value>(&data)
                            .ok()
                            .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                            .unwrap_or_else(|| table.to_string());
                        refs.push(format!("{} · {}", table, name));
                    }
                }
            }
        }
        refs
    }

    pub fn delete_media(&self, id: String) -> Result<()> {
        self.delete_media_with_file(id, true)
    }

    /// Delete a media record. `remove_file` controls whether the on-disk file
    /// and thumbnail are also removed ("delete file") or the entry is only
    /// dropped from the library ("remove from library").
    pub fn delete_media_with_file(&self, id: String, remove_file: bool) -> Result<()> {
        if remove_file {
            if let Some(path) = self.data_db.get_media_path(&id).map_err(|e| anyhow::anyhow!(e))? {
                // Resolve relative stored paths to the media dir before deleting.
                let resolved = if PathBuf::from(&path).is_absolute() {
                    PathBuf::from(&path)
                } else {
                    self.media_dir.join(&path)
                };
                let thumb = self.thumbnails_dir.join(format!("{}.jpg", id));
                let _ = fs::remove_file(&resolved);
                let _ = fs::remove_file(&thumb);
            }
        }
        self.data_db.delete_media(&id).map_err(|e| anyhow::anyhow!(e))
    }

    pub fn bulk_delete_media(&self, ids: Vec<String>) -> Result<()> {
        self.bulk_delete_media_with_file(ids, true)
    }

    /// Delete many media records. `remove_file` controls whether the on-disk
    /// files and thumbnails are also removed ("delete file") or the entries
    /// are only dropped from the library ("remove from library").
    pub fn bulk_delete_media_with_file(&self, ids: Vec<String>, remove_file: bool) -> Result<()> {
        if remove_file {
            for id in &ids {
                if let Ok(Some(path)) = self.data_db.get_media_path(id) {
                    let resolved = if PathBuf::from(&path).is_absolute() {
                        PathBuf::from(&path)
                    } else {
                        self.media_dir.join(&path)
                    };
                    let thumb = self.thumbnails_dir.join(format!("{}.jpg", id));
                    let _ = fs::remove_file(&resolved);
                    let _ = fs::remove_file(&thumb);
                }
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
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&data) {
                let id = val.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("Untitled").to_string();
                let item_count = val.get("items").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
                // Use a stored updated_at if present, otherwise fall back to 0
                // rather than overwriting with now() on every read.
                let updated_at = val.get("updated_at").and_then(|v| v.as_u64()).unwrap_or(0);
                out.push(ServiceMeta { id, name, item_count, updated_at });
            }
        }
        out.sort_by_key(|a| a.name.to_lowercase());
        Ok(out)
    }

    pub fn save_service(&self, schedule: &Schedule) -> Result<()> {
        // Wrap with an updated_at timestamp so list_services can show a real
        // last-edit time instead of the read time.
        #[derive(Serialize)]
        struct StampedSchedule<'a> {
            id: &'a str,
            name: &'a str,
            items: &'a Vec<ScheduleEntry>,
            updated_at: u64,
        }
        let stamped = StampedSchedule {
            id: &schedule.id,
            name: &schedule.name,
            items: &schedule.items,
            updated_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        };
        let json = serde_json::to_string_pretty(&stamped)?;
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
                // Use a stored updated_at if present; otherwise 0. Previously
                // this was set to now() on every read, which made the field
                // meaningless for sorting.
                let updated_at = val.get("updated_at").and_then(|v| v.as_u64()).unwrap_or(0);
                items.push(PresentationSummary { id, name: name.to_string(), slide_count, version, updated_at });
            }
        }
        items.sort_by_key(|a| a.name.to_lowercase());
        Ok(items)
    }

    pub fn save_studio_presentation(&self, presentation: &CustomPresentation) -> Result<()> {
        #[derive(Serialize)]
        struct StampedPres<'a> {
            id: &'a str,
            name: &'a str,
            slides: &'a Vec<CustomSlide>,
            version: Option<u32>,
            theme: &'a Option<serde_json::Value>,
            masters: &'a Option<serde_json::Value>,
            updated_at: u64,
        }
        let stamped = StampedPres {
            id: &presentation.id,
            name: &presentation.name,
            slides: &presentation.slides,
            version: presentation.version,
            theme: &presentation.theme,
            masters: &presentation.masters,
            updated_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        };
        let json = serde_json::to_string_pretty(&stamped)?;
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
        templates.sort_by_key(|a| a.name.to_lowercase());
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
        songs.sort_by_key(|a| a.title.to_lowercase());
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

    // ---- Scenes ----

    pub fn list_scenes(&self) -> Result<Vec<Scene>> {
        let rows = self.data_db.hash_list("scenes").map_err(|e| anyhow::anyhow!(e))?;
        let mut scenes: Vec<Scene> = rows.iter().filter_map(|(_, data)| serde_json::from_str(data).ok()).collect();
        scenes.sort_by_key(|a| a.name.to_lowercase());
        Ok(scenes)
    }

    pub fn save_scene(&self, mut scene: Scene) -> Result<Scene> {
        if scene.id.is_empty() { scene.id = Uuid::new_v4().to_string(); }
        if scene.created_at == 0 {
            scene.created_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
        }
        let json = serde_json::to_string_pretty(&scene)?;
        self.data_db.hash_set("scenes", &scene.id, &json).map_err(|e| anyhow::anyhow!(e))?;
        Ok(scene)
    }

    pub fn delete_scene(&self, id: &str) -> Result<()> {
        self.data_db.hash_delete("scenes", id).map_err(|e| anyhow::anyhow!(e))
    }

    // ---- Operator workspace persistence (recents, schedule undo/redo) ----
    // Stored as opaque JSON blobs in kv_store so the frontend owns the shape.

    pub fn save_workspace_blob(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        let json = serde_json::to_string_pretty(value)?;
        self.data_db.kv_set(key, &json).map_err(|e| anyhow::anyhow!(e))
    }

    pub fn load_workspace_blob(&self, key: &str) -> Result<Option<serde_json::Value>> {
        match self.data_db.kv_get(key).map_err(|e| anyhow::anyhow!(e))? {
            Some(json) => Ok(Some(serde_json::from_str(&json)?)),
            None => Ok(None),
        }
    }
}
