//! Program-frame resolver — the Rust mirror of
//! `src/compositor/ProgramFrameResolver.ts`.
//!
//! Pure function that turns an `OutputConfig` + the authoritative presentation
//! snapshot into a fully-resolved [`ProgramFrame`]. Every output surface calls
//! this with its own config and the same snapshot, so projection, stage
//! preview, recorder, and streamer all resolve the same frame: output source
//! (`live`/`staged`/`item`/`scene`/`blank`), presentation overrides
//! (theme / reference_output_height / background / blanked), overlay masks
//! (props / lower_third / logo), scene-zone compositions, blackout, and
//! structural resource problems.
//!
//! The resolver never mutates engine state and never touches a window — it is
//! a pure function of its inputs so it can be fixture-tested (Phase B3 parity).

use crate::engine::presentation::now_ms;
use crate::outputs::{OutputConfig, OutputSource};
use crate::store::{
    BackgroundSetting, DisplayItem, MediaItemType, PresentationSettings, PropItem, Scene,
    SceneCompositionData, SlideElement, CustomSlideData,
};

use super::frame::{
    dark_theme_colors, theme_colors, AudioProgramDescriptor, CanvasGeometry, LogoState,
    ProgramFrame, ProgramLayer, ProgramOverlays, ResolvedBackground, ResolvedOutputSource,
    ThemeColors,
};
use super::lower_third::LowerThirdPayload;

/// The subset of the authoritative presentation snapshot the resolver needs.
/// Surfaces that don't carry a full snapshot (e.g. the Cockpit preview) can
/// build it from their store slices.
#[derive(Debug, Clone)]
pub struct ResolverSnapshot {
    pub live: Option<DisplayItem>,
    pub staged: Option<DisplayItem>,
    pub settings: PresentationSettings,
    pub props: Vec<PropItem>,
    pub lower_third: Option<LowerThirdPayload>,
    pub revision: u64,
}

/// Inputs the resolver needs. Mirrors `ProgramFrameInput` in
/// `src/compositor/ProgramFrameResolver.ts`.
pub struct ProgramFrameInput {
    pub config: OutputConfig,
    pub snapshot: ResolverSnapshot,
    /// Saved scenes, used to resolve `scene` sources. Optional — a missing
    /// scene resolves to a safe "waiting" frame and reports `scene:<id>`.
    pub scenes: Option<Vec<Scene>>,
    /// Fallback theme colors when neither the output override nor the settings
    /// theme resolve.
    pub colors: Option<ThemeColors>,
    /// Paint timestamp. Defaults to `now_ms()`.
    pub timestamp: Option<u64>,
    /// Capture fps for the canvas. Defaults to `config.capture_fps` ?? 30.
    pub fps: Option<u32>,
}

/// Every media path a frame references, keyed by type. The compositor resource
/// pipeline uses this to load exactly what the draw pass needs.
#[derive(Debug, Clone, PartialEq)]
pub struct FrameMediaPaths {
    pub images: Vec<String>,
    pub videos: Vec<String>,
}

/// The effective background for an item, honoring content-type overrides
/// (bible/media/song) the same way the DOM outputs and the draw pass do.
pub fn get_effective_bg(settings: &PresentationSettings, item: Option<&DisplayItem>) -> BackgroundSetting {
    match item {
        Some(DisplayItem::Verse(_)) => {
            if !matches!(settings.bible_background, BackgroundSetting::None) {
                return settings.bible_background.clone();
            }
        }
        Some(DisplayItem::Media(_)) => {
            if !matches!(settings.media_background, BackgroundSetting::None) {
                return settings.media_background.clone();
            }
        }
        Some(DisplayItem::Song(song)) => {
            if let Some(bg) = &song.background {
                if !matches!(bg, BackgroundSetting::None) {
                    return bg.clone();
                }
            }
            if !matches!(settings.song_background, BackgroundSetting::None) {
                return settings.song_background.clone();
            }
        }
        _ => {}
    }
    settings.background.clone()
}

/// Resolve theme colors: output override > settings theme > fallback/dark.
pub fn resolve_theme_colors(
    config: &OutputConfig,
    settings: &PresentationSettings,
    fallback: Option<ThemeColors>,
) -> ThemeColors {
    if let Some(theme) = config.presentation.as_ref().and_then(|p| p.theme.as_ref()) {
        if let Some(t) = theme_colors(theme) {
            return t;
        }
    }
    theme_colors(&settings.theme).or(fallback).unwrap_or_else(dark_theme_colors)
}

/// Resolve the persistent logo overlay from settings.
pub fn derive_logo_state(settings: &PresentationSettings) -> Option<LogoState> {
    if settings.logo_text.as_deref().map(|s| !s.is_empty()).unwrap_or(false) {
        return Some(LogoState {
            text: settings.logo_text.clone(),
            text_color: Some(settings.logo_text_color.clone().unwrap_or_else(|| "#ffffff".to_string())),
            path: None,
            opacity: 0.6,
        });
    }
    if settings.logo_path.as_deref().map(|s| !s.is_empty()).unwrap_or(false) {
        return Some(LogoState {
            text: None,
            text_color: None,
            path: settings.logo_path.clone(),
            opacity: 0.5,
        });
    }
    None
}

fn resolve_scene_item(scene: Option<&Scene>, scene_id: &str) -> (Option<DisplayItem>, Vec<String>) {
    let Some(scene) = scene else {
        return (None, vec![format!("scene:{scene_id}")]);
    };
    if let Some(layout) = &scene.layout {
        if !layout.zones.is_empty() {
            let item = DisplayItem::SceneComposition(SceneCompositionData {
                scene_id: scene.id.clone(),
                name: scene.name.clone(),
                zones: layout.zones.clone(),
            });
            return (Some(item), vec![]);
        }
    }
    if let Some(camera) = &scene.camera {
        return (Some(camera.clone()), vec![]);
    }
    // Saved scene with no live content — safe frame.
    (None, vec![])
}

fn item_layers(item: Option<&DisplayItem>) -> Vec<ProgramLayer> {
    let Some(item) = item else {
        return vec![ProgramLayer::Waiting];
    };
    if let DisplayItem::SceneComposition(data) = item {
        let mut zones = data.zones.clone();
        zones.sort_by_key(|z| z.z);
        return zones.into_iter().map(|z| ProgramLayer::Zone { zone: z }).collect();
    }
    vec![ProgramLayer::Item { item: item.clone() }]
}

fn resolve_source(
    source: &OutputSource,
    snapshot: &ResolverSnapshot,
    scenes: Option<&[Scene]>,
) -> (ResolvedOutputSource, Vec<ProgramLayer>, Vec<String>) {
    match source {
        OutputSource::Blank => (
            ResolvedOutputSource::Blank,
            vec![ProgramLayer::Blank],
            vec![],
        ),
        OutputSource::Item { item } => {
            let item: &DisplayItem = item;
            (
                ResolvedOutputSource::Item { item: item.clone() },
                item_layers(Some(item)),
                vec![],
            )
        }
        OutputSource::Staged => {
            if let Some(staged) = &snapshot.staged {
                (
                    ResolvedOutputSource::Staged { item: Some(staged.clone()) },
                    item_layers(Some(staged)),
                    vec![],
                )
            } else {
                (
                    ResolvedOutputSource::Staged { item: None },
                    vec![ProgramLayer::Waiting],
                    vec![],
                )
            }
        }
        OutputSource::Scene { scene_id } => {
            let scene = scenes.and_then(|scs| scs.iter().find(|s| s.id == *scene_id));
            let (item, missing) = resolve_scene_item(scene, scene_id);
            (
                ResolvedOutputSource::Scene { item: item.clone(), scene_id: scene_id.clone() },
                item_layers(item.as_ref()),
                missing,
            )
        }
        OutputSource::Live => {
            if let Some(live) = &snapshot.live {
                (
                    ResolvedOutputSource::Live { item: Some(live.clone()) },
                    item_layers(Some(live)),
                    vec![],
                )
            } else {
                (
                    ResolvedOutputSource::Live { item: None },
                    vec![ProgramLayer::Waiting],
                    vec![],
                )
            }
        }
    }
}

fn slide_element_empty(el: &SlideElement) -> bool {
    let empty = el.content.as_str().map(|s| s.trim().is_empty()).unwrap_or(true);
    empty
}

/// Structural resource problems the resolver can see without loading files:
/// empty media/prop/logo paths. Runtime load failures (a file that is gone
/// from disk) are tracked by the compositor resource pipeline instead.
fn structural_missing(
    source: &ResolvedOutputSource,
    overlays: &ProgramOverlays,
    background: &ResolvedBackground,
) -> Vec<String> {
    let mut missing: Vec<String> = Vec::new();
    fn walk(item: &DisplayItem, missing: &mut Vec<String>) {
        match item {
            DisplayItem::Media(m) => {
                if m.path.trim().is_empty() {
                    missing.push("media".to_string());
                }
            }
            DisplayItem::CustomSlide(c) => {
                for el in &c.elements {
                    if (el.kind == "image" || el.kind == "video") && slide_element_empty(el) {
                        missing.push("slide:media".to_string());
                    }
                }
            }
            DisplayItem::SceneComposition(data) => {
                for zone in &data.zones {
                    walk(&zone.item, missing);
                }
            }
            _ => {}
        }
    }
    if !matches!(source, ResolvedOutputSource::Blank) {
        if let Some(item) = source.item() {
            walk(item, &mut missing);
        }
        match &background.setting {
            BackgroundSetting::Image(im) if im.path.trim().is_empty() => missing.push("background".to_string()),
            BackgroundSetting::Video(v) if v.path.trim().is_empty() => missing.push("background".to_string()),
            _ => {}
        }
    }
    for p in &overlays.props {
        if p.kind == "image" && p.path.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
            missing.push(format!("prop:{}", p.id));
        }
    }
    if let Some(logo) = &overlays.logo {
        let has_text = logo.text.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
        let has_path = logo.path.as_deref().map(|s| !s.is_empty()).unwrap_or(false);
        if !has_text && !has_path {
            missing.push("logo".to_string());
        }
    }
    missing
}

/// Every media path the frame references (backgrounds, item media, slide
/// elements, zone contents, props, logo) keyed by type.
pub fn collect_frame_media_paths(frame: &ProgramFrame) -> FrameMediaPaths {
    let mut images: Vec<String> = Vec::new();
    let mut videos: Vec<String> = Vec::new();

    fn add_bg(bg: &BackgroundSetting, images: &mut Vec<String>, videos: &mut Vec<String>) {
        match bg {
            BackgroundSetting::Image(im) => images.push(im.path.clone()),
            BackgroundSetting::Video(v) => videos.push(v.path.clone()),
            _ => {}
        }
    }
    fn add_slide(data: &CustomSlideData, images: &mut Vec<String>, videos: &mut Vec<String>) {
        if let Some(sb) = &data.background {
            if let Some(ty) = sb.get("type").and_then(|t| t.as_str()) {
                if ty == "image" {
                    if let Some(v) = sb.get("value").and_then(|v| v.as_str()) {
                        images.push(v.to_string());
                    }
                } else if ty == "video" {
                    if let Some(v) = sb.get("value").and_then(|v| v.as_str()) {
                        videos.push(v.to_string());
                    }
                }
            }
        }
        for el in &data.elements {
            if el.kind == "image" {
                if let Some(c) = el.content.as_str() {
                    images.push(c.to_string());
                }
            } else if el.kind == "video" {
                if let Some(c) = el.content.as_str() {
                    videos.push(c.to_string());
                }
            }
        }
    }
    fn add_item(item: Option<&DisplayItem>, settings: &PresentationSettings, images: &mut Vec<String>, videos: &mut Vec<String>) {
        let Some(item) = item else { return };
        match item {
            DisplayItem::Media(m) => match m.media_type {
                MediaItemType::Image => images.push(m.path.clone()),
                MediaItemType::Video => videos.push(m.path.clone()),
                MediaItemType::Audio => {}
            },
            DisplayItem::CustomSlide(c) => add_slide(c, images, videos),
            DisplayItem::SceneComposition(data) => {
                for zone in &data.zones {
                    add_bg(&get_effective_bg(settings, Some(&zone.item)), images, videos);
                    add_item(Some(&zone.item), settings, images, videos);
                }
            }
            _ => {}
        }
    }

    if !matches!(frame.source, ResolvedOutputSource::Blank) {
        add_bg(&frame.background.setting, &mut images, &mut videos);
        add_item(frame.source.item(), &frame.settings, &mut images, &mut videos);
    }
    for p in &frame.overlays.props {
        if p.kind == "image" {
            if let Some(path) = &p.path {
                images.push(path.clone());
            }
        }
    }
    if let Some(logo) = &frame.overlays.logo {
        if let Some(path) = &logo.path {
            images.push(path.clone());
        }
    }
    images.retain(|s| !s.is_empty());
    videos.retain(|s| !s.is_empty());
    FrameMediaPaths { images, videos }
}

fn derive_audio(item: Option<&DisplayItem>) -> AudioProgramDescriptor {
    if let Some(DisplayItem::Media(m)) = item {
        if !matches!(m.media_type, MediaItemType::Image) {
            return AudioProgramDescriptor::Media { muted: false };
        }
    }
    AudioProgramDescriptor::None
}

/// Resolve one authoritative program frame for an output.
///
/// Order of operations:
///  1. Source — what the output is subscribed to.
///  2. Presentation overrides — theme, reference height, background, blanked.
///  3. Background — override wins, else effective setting for the source item
///     (scene sources fall back to the scene's saved settings).
///  4. Overlays — masked per the output config.
///  5. Blackout, layers, missing, audio.
pub fn resolve_program_frame(input: ProgramFrameInput) -> ProgramFrame {
    let config = &input.config;
    let snapshot = &input.snapshot;
    let settings = &snapshot.settings;
    let now = input.timestamp.unwrap_or_else(now_ms);
    let canvas = CanvasGeometry {
        width: config.geometry.width,
        height: config.geometry.height,
        fps: input.fps.unwrap_or(config.capture_fps.unwrap_or(30)),
    };

    let (source, layers, source_missing) = resolve_source(&config.source, snapshot, input.scenes.as_deref());

    let colors = resolve_theme_colors(config, settings, input.colors);
    let reference_output_height = config
        .presentation
        .as_ref()
        .and_then(|p| p.reference_output_height)
        .unwrap_or(settings.reference_output_height as u32);

    let blank_source = matches!(source, ResolvedOutputSource::Blank);
    let blackout = if blank_source {
        true
    } else {
        config.presentation.as_ref().and_then(|p| p.blanked).unwrap_or(settings.is_blanked)
    };

    let background_setting = if blank_source {
        BackgroundSetting::Color("#000000".to_string())
    } else if let Some(bg) = config.presentation.as_ref().and_then(|p| p.background.as_ref()) {
        bg.clone()
    } else if let ResolvedOutputSource::Scene { scene_id, .. } = &source {
        let scene = input.scenes.as_deref().and_then(|scs| scs.iter().find(|s| s.id == *scene_id));
        get_effective_bg(scene.map(|s| &s.settings).unwrap_or(settings), source.item())
    } else {
        get_effective_bg(settings, source.item())
    };
    let background = ResolvedBackground { setting: background_setting.clone(), fallback: colors.background.clone() };

    let mask = &config.overlays;
    let overlays = if blank_source {
        ProgramOverlays { props: vec![], lower_third: None, logo: None }
    } else {
        ProgramOverlays {
            props: if mask.props { snapshot.props.clone() } else { vec![] },
            lower_third: if mask.lower_third { snapshot.lower_third.clone() } else { None },
            logo: if mask.logo { derive_logo_state(settings) } else { None },
        }
    };

    let audio = if blank_source {
        AudioProgramDescriptor::None
    } else {
        derive_audio(source.item())
    };

    let frame_layers = if blackout {
        vec![ProgramLayer::Blank]
    } else {
        let mut out: Vec<ProgramLayer> = Vec::new();
        if !blank_source {
            out.push(ProgramLayer::Background { setting: background_setting.clone() });
            out.extend(layers);
        }
        if overlays.logo.is_some() {
            out.push(ProgramLayer::Logo);
        }
        if !overlays.props.is_empty() {
            out.push(ProgramLayer::Props { count: overlays.props.len() });
        }
        if let Some(lt) = &overlays.lower_third {
            out.push(ProgramLayer::LowerThird { payload: Box::new(lt.clone()) });
        }
        out
    };

    let mut missing = source_missing;
    missing.extend(structural_missing(&source, &overlays, &background));

    ProgramFrame {
        revision: snapshot.revision,
        timestamp: now,
        canvas,
        source,
        layers: frame_layers,
        background,
        overlays,
        blackout,
        missing,
        audio,
        settings: settings.clone(),
        colors,
        reference_output_height,
        now,
        app_data_dir: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outputs::{OutputGeometry, OutputKind, OutputOverlays, OutputPresentation, OutputSource, OUTPUT_SCHEMA_VERSION};
    use crate::store::{CustomSlideData, MediaItem, MediaItemType, TimerData, Verse};
    use serde_json::json;

    fn base_settings() -> PresentationSettings {
    PresentationSettings {
        background: BackgroundSetting::None,
        is_blanked: false,
        ..PresentationSettings::default()
    }
}

    fn verse_item() -> DisplayItem {
        DisplayItem::Verse(Verse {
            book: "JHN".to_string(),
            chapter: 3,
            verse: 16,
            text: "For God so loved the world".to_string(),
            version: "KJV".to_string(),
            split_index: None,
            total_splits: None,
            score: None,
        })
    }

    fn media_image() -> DisplayItem {
        DisplayItem::Media(MediaItem {
            id: "m1".to_string(),
            name: "Banner".to_string(),
            path: "images/banner.png".to_string(),
            media_type: MediaItemType::Image,
            thumbnail_path: None,
            fit_mode: "contain".to_string(),
            tags: vec![],
            description: None,
            category: None,
            duration: None,
            width: None,
            height: None,
            content_hash: None,
            loop_playback: true,
            playback_rate: 1.0,
            volume: 1.0,
        })
    }

    fn camera_item() -> DisplayItem {
        serde_json::from_value(json!({
            "type": "Camera",
            "data": { "deviceId": "cam-1", "opacity": 1, "objectFit": "cover", "mirrored": false }
        }))
        .unwrap()
    }

    fn timer_item() -> DisplayItem {
        DisplayItem::Timer(TimerData {
            timer_type: "countup".to_string(),
            duration_secs: None,
            label: None,
            started_at: Some(0),
        })
    }

    fn song_item() -> DisplayItem {
        serde_json::from_value(json!({
            "type": "Song",
            "data": {
                "song_id": "s1",
                "title": "Amazing Grace",
                "section_label": "Chorus",
                "lines": ["Amazing grace", "how sweet the sound"],
                "slide_index": 0,
                "total_slides": 1,
                "style": "FullSlide"
            }
        }))
        .unwrap()
    }

    fn custom_slide_item() -> DisplayItem {
        DisplayItem::CustomSlide(CustomSlideData {
            presentation_id: "p1".to_string(),
            presentation_name: "Sermon".to_string(),
            slide_index: 0,
            slide_count: 1,
            background: Some(json!({ "type": "color", "value": "#1a1a2e" })),
            background_color: None,
            background_image: None,
            background_video: None,
            background_video_loop: None,
            background_video_muted: None,
            header_enabled: None,
            header_height_pct: None,
            header: None,
            body: None,
            elements: vec![serde_json::from_value(json!({
                "id": "e1",
                "kind": "image",
                "x": 10, "y": 10, "w": 80, "h": 20, "z_index": 1,
                "content": "slides/photo.jpg",
                "objectFit": "contain"
            }))
            .unwrap()],
            theme: None,
            notes: None,
        })
    }

    fn prop_clock() -> PropItem {
        serde_json::from_value(json!({
            "id": "pr1",
            "kind": "clock",
            "x": 5, "y": 5, "w": 10, "h": 10, "opacity": 1, "visible": true,
            "text": "HH:mm:ss",
            "color": "#ffffff"
        }))
        .unwrap()
    }

    fn lower_third_payload() -> LowerThirdPayload {
        LowerThirdPayload {
            data: serde_json::from_value(json!({ "kind": "Nameplate", "data": { "name": "Jane Doe", "title": "Pastor" } })).unwrap(),
            template: super::super::lower_third::default_lt_template(),
        }
    }

    fn make_config(source: OutputSource) -> OutputConfig {
        OutputConfig {
            schema_version: OUTPUT_SCHEMA_VERSION,
            id: "output".to_string(),
            kind: OutputKind::Window,
            label: "Output".to_string(),
            enabled: true,
            visible: true,
            source,
            geometry: OutputGeometry { width: 1920, height: 1080 },
            capture_fps: None,
            presentation: None,
            overlays: OutputOverlays { props: true, lower_third: true, logo: true },
            window_label: None,
            recording: None,
            streaming: None,
            stream_destinations: None,
        }
    }

    fn make_input(source: OutputSource, live: Option<DisplayItem>) -> ProgramFrameInput {
        ProgramFrameInput {
            config: make_config(source),
            snapshot: ResolverSnapshot {
                live,
                staged: None,
                settings: base_settings(),
                props: vec![prop_clock()],
                lower_third: Some(lower_third_payload()),
                revision: 7,
            },
            scenes: None,
            colors: None,
            timestamp: Some(1234),
            fps: Some(30),
        }
    }

    fn layer_kinds(frame: &ProgramFrame) -> Vec<&str> {
        frame.layers.iter().map(|l| match l {
            ProgramLayer::Blank => "blank",
            ProgramLayer::Background { .. } => "background",
            ProgramLayer::Item { .. } => "item",
            ProgramLayer::Zone { .. } => "zone",
            ProgramLayer::Props { .. } => "props",
            ProgramLayer::LowerThird { .. } => "lower_third",
            ProgramLayer::Logo => "logo",
            ProgramLayer::Waiting => "waiting",
        }).collect()
    }

    #[test]
    fn get_effective_bg_falls_back_to_settings_background() {
        assert_eq!(get_effective_bg(&base_settings(), None), BackgroundSetting::None);
    }

    #[test]
    fn get_effective_bg_uses_bible_background_for_verse() {
        let mut s = base_settings();
        s.bible_background = BackgroundSetting::Color("#123456".to_string());
        assert_eq!(get_effective_bg(&s, Some(&verse_item())), BackgroundSetting::Color("#123456".to_string()));
    }

    #[test]
    fn get_effective_bg_prefers_song_background_over_setting() {
        let mut s = base_settings();
        s.song_background = BackgroundSetting::Color("#111111".to_string());
        let song: DisplayItem = serde_json::from_value(json!({
            "type": "Song",
            "data": {
                "song_id": "s1", "title": "T", "section_label": "Chorus",
                "lines": ["x"], "slide_index": 0, "total_slides": 1,
                "background": { "type": "Color", "value": "#222222" }
            }
        }))
        .unwrap();
        assert_eq!(get_effective_bg(&s, Some(&song)), BackgroundSetting::Color("#222222".to_string()));
    }

    #[test]
    fn resolve_theme_colors_prefers_output_override() {
        let mut config = make_config(OutputSource::Live);
        config.presentation = Some(OutputPresentation {
            theme: Some("light".to_string()),
            reference_output_height: None,
            background: None,
            blanked: None,
        });
        let colors = resolve_theme_colors(&config, &base_settings(), None);
        assert_eq!(colors.background, "#f8fafc");
    }

    #[test]
    fn resolve_theme_colors_falls_back_to_settings_theme() {
        let mut settings = base_settings();
        settings.theme = "navy".to_string();
        let colors = resolve_theme_colors(&make_config(OutputSource::Live), &settings, None);
        assert_eq!(colors.background, "#0a1628");
    }

    #[test]
    fn resolve_theme_colors_falls_back_to_dark() {
        let colors = resolve_theme_colors(&make_config(OutputSource::Live), &base_settings(), None);
        assert_eq!(colors.background, "#000000");
    }

    #[test]
    fn derive_logo_state_text_logo() {
        let mut s = base_settings();
        s.logo_text = Some("Wordlyte".to_string());
        let logo = derive_logo_state(&s).unwrap();
        assert_eq!(logo.text.as_deref(), Some("Wordlyte"));
        assert_eq!(logo.opacity, 0.6);
    }

    #[test]
    fn derive_logo_state_image_logo() {
        let mut s = base_settings();
        s.logo_path = Some("logo.png".to_string());
        let logo = derive_logo_state(&s).unwrap();
        assert_eq!(logo.path.as_deref(), Some("logo.png"));
        assert_eq!(logo.opacity, 0.5);
    }

    #[test]
    fn derive_logo_state_none_when_unconfigured() {
        assert!(derive_logo_state(&base_settings()).is_none());
    }

    #[test]
    fn resolves_live_source() {
        let item = verse_item();
        let frame = resolve_program_frame(make_input(OutputSource::Live, Some(item.clone())));
        assert!(matches!(frame.source, ResolvedOutputSource::Live { .. }));
        assert!(matches!(frame.source.item(), Some(DisplayItem::Verse(_))));
        assert!(frame.layers.iter().any(|l| matches!(l, ProgramLayer::Item { item: DisplayItem::Verse(_) })));
    }

    #[test]
    fn resolves_staged_source() {
        let media = media_image();
        let frame = resolve_program_frame(make_input(OutputSource::Staged, Some(media.clone())));
        assert!(matches!(frame.source, ResolvedOutputSource::Staged { .. }));
        assert_eq!(frame.canvas.width, 1920);
        assert_eq!(frame.canvas.fps, 30);
    }

    #[test]
    fn resolves_item_source() {
        let timer = timer_item();
        let frame = resolve_program_frame(make_input(OutputSource::Item { item: Box::new(timer.clone()) }, None));
        assert!(matches!(frame.source, ResolvedOutputSource::Item { .. }));
        assert!(matches!(frame.source.item(), Some(DisplayItem::Timer(_))));
    }

    #[test]
    fn resolves_every_content_item_type() {
        for item in [verse_item(), media_image(), camera_item(), timer_item(), song_item(), custom_slide_item()] {
            let frame = resolve_program_frame(make_input(OutputSource::Live, Some(item.clone())));
            assert!(frame.source.item().is_some());
        }
    }

    #[test]
    fn shows_waiting_layer_when_live_empty() {
        let frame = resolve_program_frame(make_input(OutputSource::Live, None));
        assert!(frame.layers.iter().any(|l| matches!(l, ProgramLayer::Waiting)));
    }

    #[test]
    fn resolves_scene_source_with_layout() {
        let zone: crate::store::SceneZone = serde_json::from_value(json!({
            "id": "z1",
            "item": { "type": "Verse", "data": { "book": "JHN", "chapter": 3, "verse": 16, "text": "x", "version": "KJV" } },
            "x": 0, "y": 0, "w": 0.5, "h": 1, "fit": "cover", "opacity": 1, "z": 1
        }))
        .unwrap();
        let scenes = vec![crate::store::Scene {
            id: "sc1".to_string(),
            name: "Cam+Bible".to_string(),
            settings: base_settings(),
            props: vec![],
            lower_third_data: None,
            lower_third_template: None,
            camera: Some(camera_item()),
            layout: Some(crate::store::SceneLayout { zones: vec![zone.clone()] }),
            created_at: 0,
        }];
        let mut input = make_input(OutputSource::Scene { scene_id: "sc1".to_string() }, None);
        input.scenes = Some(scenes);
        let frame = resolve_program_frame(input);
        assert!(matches!(frame.source, ResolvedOutputSource::Scene { .. }));
        assert!(matches!(frame.source.item(), Some(DisplayItem::SceneComposition(_))));
        assert!(frame.layers.iter().any(|l| matches!(l, ProgramLayer::Zone { .. })));
        assert!(!frame.missing.iter().any(|m| m.starts_with("scene:")));
    }

    #[test]
    fn resolves_scene_source_camera_without_layout() {
        let scenes = vec![crate::store::Scene {
            id: "sc2".to_string(),
            name: "Cam".to_string(),
            settings: base_settings(),
            props: vec![],
            lower_third_data: None,
            lower_third_template: None,
            camera: Some(camera_item()),
            layout: None,
            created_at: 0,
        }];
        let mut input = make_input(OutputSource::Scene { scene_id: "sc2".to_string() }, None);
        input.scenes = Some(scenes);
        let frame = resolve_program_frame(input);
        assert!(matches!(frame.source.item(), Some(DisplayItem::Camera(_))));
    }

    #[test]
    fn resolves_missing_scene_to_waiting_and_reports() {
        let frame = resolve_program_frame(make_input(OutputSource::Scene { scene_id: "ghost".to_string() }, None));
        assert!(matches!(frame.source, ResolvedOutputSource::Scene { .. }));
        assert!(frame.source.item().is_none());
        assert!(frame.layers.iter().any(|l| matches!(l, ProgramLayer::Waiting)));
        assert!(frame.missing.iter().any(|m| m == "scene:ghost"));
    }

    #[test]
    fn blank_source_is_pure_black_no_overlays() {
        let frame = resolve_program_frame(make_input(OutputSource::Blank, None));
        assert!(matches!(frame.source, ResolvedOutputSource::Blank));
        assert!(frame.blackout);
        assert!(frame.overlays.props.is_empty());
        assert!(frame.overlays.lower_third.is_none());
        assert!(frame.overlays.logo.is_none());
        assert_eq!(layer_kinds(&frame), vec!["blank"]);
    }

    #[test]
    fn blanked_via_settings() {
        let mut input = make_input(OutputSource::Live, Some(verse_item()));
        input.snapshot.settings.is_blanked = true;
        let frame = resolve_program_frame(input);
        assert!(frame.blackout);
        assert_eq!(layer_kinds(&frame), vec!["blank"]);
    }

    #[test]
    fn blanked_via_output_override() {
        let mut config = make_config(OutputSource::Live);
        config.presentation = Some(OutputPresentation { theme: None, reference_output_height: None, background: None, blanked: Some(true) });
        let frame = resolve_program_frame(ProgramFrameInput {
            config,
            snapshot: ResolverSnapshot {
                live: Some(verse_item()),
                staged: None,
                settings: base_settings(),
                props: vec![],
                lower_third: None,
                revision: 0,
            },
            scenes: None,
            colors: None,
            timestamp: Some(1),
            fps: None,
        });
        assert!(frame.blackout);
    }

    #[test]
    fn output_blanked_false_overrides_blanked_settings() {
        let mut config = make_config(OutputSource::Live);
        config.presentation = Some(OutputPresentation { theme: None, reference_output_height: None, background: None, blanked: Some(false) });
        let mut input = make_input(OutputSource::Live, Some(verse_item()));
        input.snapshot.settings.is_blanked = true;
        input.config = config;
        let frame = resolve_program_frame(input);
        assert!(!frame.blackout);
    }

    #[test]
    fn applies_background_override() {
        let mut config = make_config(OutputSource::Live);
        config.presentation = Some(OutputPresentation {
            theme: None,
            reference_output_height: None,
            background: Some(BackgroundSetting::Color("#ff0000".to_string())),
            blanked: None,
        });
        let frame = resolve_program_frame(ProgramFrameInput {
            config,
            snapshot: ResolverSnapshot {
                live: Some(verse_item()),
                staged: None,
                settings: base_settings(),
                props: vec![],
                lower_third: None,
                revision: 0,
            },
            scenes: None,
            colors: None,
            timestamp: Some(1),
            fps: None,
        });
        assert_eq!(frame.background.setting, BackgroundSetting::Color("#ff0000".to_string()));
    }

    #[test]
    fn uses_content_type_effective_background() {
        let mut settings = base_settings();
        settings.bible_background = BackgroundSetting::Color("#123456".to_string());
        let frame = resolve_program_frame(ProgramFrameInput {
            config: make_config(OutputSource::Live),
            snapshot: ResolverSnapshot {
                live: Some(verse_item()),
                staged: None,
                settings,
                props: vec![],
                lower_third: None,
                revision: 0,
            },
            scenes: None,
            colors: None,
            timestamp: Some(1),
            fps: None,
        });
        assert_eq!(frame.background.setting, BackgroundSetting::Color("#123456".to_string()));
    }

    #[test]
    fn applies_reference_output_height_override() {
        let mut config = make_config(OutputSource::Live);
        config.presentation = Some(OutputPresentation { theme: None, reference_output_height: Some(1440), background: None, blanked: None });
        let frame = resolve_program_frame(ProgramFrameInput {
            config,
            snapshot: ResolverSnapshot {
                live: Some(verse_item()),
                staged: None,
                settings: base_settings(),
                props: vec![],
                lower_third: None,
                revision: 0,
            },
            scenes: None,
            colors: None,
            timestamp: Some(1),
            fps: None,
        });
        assert_eq!(frame.reference_output_height, 1440);
    }

    #[test]
    fn falls_back_to_settings_reference_height() {
        let mut settings = base_settings();
        settings.reference_output_height = 720.0;
        let frame = resolve_program_frame(ProgramFrameInput {
            config: make_config(OutputSource::Live),
            snapshot: ResolverSnapshot {
                live: Some(verse_item()),
                staged: None,
                settings,
                props: vec![],
                lower_third: None,
                revision: 0,
            },
            scenes: None,
            colors: None,
            timestamp: Some(1),
            fps: None,
        });
        assert_eq!(frame.reference_output_height, 720);
    }

    #[test]
    fn passes_props_through_when_mask_enabled() {
        let frame = resolve_program_frame(make_input(OutputSource::Live, Some(verse_item())));
        assert_eq!(frame.overlays.props.len(), 1);
        assert_eq!(frame.overlays.props[0].id, "pr1");
    }

    #[test]
    fn drops_props_when_mask_disabled() {
        let mut config = make_config(OutputSource::Live);
        config.overlays = OutputOverlays { props: false, lower_third: true, logo: true };
        let mut input = make_input(OutputSource::Live, Some(verse_item()));
        input.config = config;
        let frame = resolve_program_frame(input);
        assert!(frame.overlays.props.is_empty());
    }

    #[test]
    fn drops_lower_third_when_mask_disabled() {
        let mut config = make_config(OutputSource::Live);
        config.overlays = OutputOverlays { props: true, lower_third: false, logo: true };
        let mut input = make_input(OutputSource::Live, Some(verse_item()));
        input.config = config;
        let frame = resolve_program_frame(input);
        assert!(frame.overlays.lower_third.is_none());
    }

    #[test]
    fn drops_logo_when_mask_disabled() {
        let mut config = make_config(OutputSource::Live);
        config.overlays = OutputOverlays { props: true, lower_third: true, logo: false };
        let mut input = make_input(OutputSource::Live, Some(verse_item()));
        input.snapshot.settings.logo_text = Some("Wordlyte".to_string());
        input.config = config;
        let frame = resolve_program_frame(input);
        assert!(frame.overlays.logo.is_none());
    }

    #[test]
    fn orders_layers_background_content_logo_props_lower_third() {
        let mut input = make_input(OutputSource::Live, Some(verse_item()));
        input.snapshot.settings.logo_text = Some("Wordlyte".to_string());
        let frame = resolve_program_frame(input);
        assert_eq!(layer_kinds(&frame), vec!["background", "item", "logo", "props", "lower_third"]);
    }

    #[test]
    fn reports_media_with_empty_path() {
        let bad: DisplayItem = serde_json::from_value(json!({
            "type": "Media",
            "data": { "id": "m2", "name": "Broken", "path": "", "media_type": "Image", "tags": [] }
        }))
        .unwrap();
        let frame = resolve_program_frame(make_input(OutputSource::Live, Some(bad)));
        assert!(frame.missing.iter().any(|m| m == "media"));
    }

    #[test]
    fn reports_empty_prop_image_path() {
        let prop: PropItem = serde_json::from_value(json!({
            "id": "pr2", "kind": "image", "x": 0, "y": 0, "w": 10, "h": 10, "opacity": 1, "visible": true, "path": ""
        }))
        .unwrap();
        let mut input = make_input(OutputSource::Live, Some(verse_item()));
        input.snapshot.props = vec![prop];
        let frame = resolve_program_frame(input);
        assert!(frame.missing.iter().any(|m| m == "prop:pr2"));
    }

    #[test]
    fn audio_describes_media_video_as_program_audio() {
        let video: DisplayItem = serde_json::from_value(json!({
            "type": "Media",
            "data": { "id": "m3", "name": "Clip", "path": "videos/clip.mp4", "media_type": "Video", "tags": [] }
        }))
        .unwrap();
        let frame = resolve_program_frame(make_input(OutputSource::Live, Some(video)));
        assert!(matches!(frame.audio, AudioProgramDescriptor::Media { muted: false }));
    }

    #[test]
    fn audio_none_for_verse() {
        let frame = resolve_program_frame(make_input(OutputSource::Live, Some(verse_item())));
        assert!(matches!(frame.audio, AudioProgramDescriptor::None));
    }

    #[test]
    fn projection_and_record_resolve_different_frames_from_same_snapshot() {
        let snapshot = ResolverSnapshot {
            live: Some(verse_item()),
            staged: Some(media_image()),
            settings: base_settings(),
            props: vec![prop_clock()],
            lower_third: Some(lower_third_payload()),
            revision: 3,
        };
        let projection = make_config(OutputSource::Live);
        let record_config = OutputConfig {
            schema_version: OUTPUT_SCHEMA_VERSION,
            id: "record-main".to_string(),
            kind: OutputKind::Recorder,
            label: "Record".to_string(),
            enabled: true,
            visible: false,
            source: OutputSource::Staged,
            geometry: OutputGeometry { width: 1280, height: 720 },
            capture_fps: Some(24),
            presentation: None,
            overlays: OutputOverlays { props: false, lower_third: false, logo: false },
            window_label: None,
            recording: None,
            streaming: None,
            stream_destinations: None,
        };
        let proj = resolve_program_frame(ProgramFrameInput { config: projection, snapshot: snapshot.clone(), scenes: None, colors: None, timestamp: None, fps: Some(30) });
        let rec = resolve_program_frame(ProgramFrameInput { config: record_config, snapshot, scenes: None, colors: None, timestamp: None, fps: Some(24) });

        assert!(matches!(rec.source, ResolvedOutputSource::Staged { .. }));
        assert!(matches!(proj.source, ResolvedOutputSource::Live { .. }));
        assert!(rec.overlays.props.is_empty());
        assert!(rec.overlays.lower_third.is_none());
        assert!(rec.overlays.logo.is_none());
        assert_eq!(proj.overlays.props.len(), 1);
        assert!(proj.overlays.lower_third.is_some());
        assert_eq!(rec.canvas.width, 1280);
        assert_eq!(rec.canvas.height, 720);
        assert_eq!(rec.canvas.fps, 24);
        assert_eq!(proj.canvas.width, 1920);
        assert_eq!(proj.canvas.fps, 30);
    }

    #[test]
    fn collects_frame_media_paths() {
        let scene_zone: crate::store::SceneZone = serde_json::from_value(json!({
            "id": "z1",
            "item": { "type": "Media", "data": { "id": "m4", "name": "Zone", "path": "zones/zone.jpg", "media_type": "Image", "tags": [] } },
            "x": 0, "y": 0, "w": 0.5, "h": 1, "fit": "cover", "opacity": 1, "z": 1
        }))
        .unwrap();
        let scenes = vec![crate::store::Scene {
            id: "sc1".to_string(),
            name: "Scene".to_string(),
            settings: base_settings(),
            props: vec![],
            lower_third_data: None,
            lower_third_template: None,
            camera: None,
            layout: Some(crate::store::SceneLayout { zones: vec![scene_zone] }),
            created_at: 0,
        }];
        let mut settings = base_settings();
        settings.background = BackgroundSetting::Image(serde_json::from_value(json!({ "path": "bg/back.png", "objectFit": "cover", "opacity": 1 })).unwrap());
        settings.logo_path = Some("logo/wordlyte.png".to_string());
        let mut input = make_input(OutputSource::Scene { scene_id: "sc1".to_string() }, None);
        input.scenes = Some(scenes);
        input.snapshot.live = None;
        input.snapshot.settings = settings;
        input.snapshot.props = vec![
            prop_clock(),
            serde_json::from_value(json!({ "id": "pr3", "kind": "image", "x": 0, "y": 0, "w": 10, "h": 10, "opacity": 1, "visible": true, "path": "props/logo.png" })).unwrap(),
        ];
        let frame = resolve_program_frame(input);
        let paths = collect_frame_media_paths(&frame);
        for expected in ["bg/back.png", "zones/zone.jpg", "props/logo.png", "logo/wordlyte.png"] {
            assert!(paths.images.iter().any(|p| p == expected), "missing {expected} in {:?}", paths.images);
        }
    }
}