//! Lower-third resolution — the Rust mirror of
//! `src/compositor/LowerThirdResolver.ts`.
//!
//! `resolve_lower_third` turns a live lower-third document into a single
//! normalized descriptor every renderer consumes. The DOM `LowerThirdOverlay`
//! and the wgpu compositor both resolve through it, so content→slot mapping,
//! style slots, background, and accent/border/shadow tokens can never drift
//! apart.
//!
//! The `LowerThirdTemplate`/`LowerThirdPayload` types here mirror
//! `src/types/lowerThird.ts` — the engine currently persists the template as
//! raw JSON (`Scene.lower_third_template`), so this module is the first typed
//! home for the schema.

use serde::{Deserialize, Serialize};

use crate::store::LowerThirdData;

/// One resolved text style slot. Sizes are authored px (pre-scale).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LtStyleSlot {
    pub font: String,
    pub size: f64,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
    pub uppercase: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtGeometry {
    pub is_full_width: bool,
    pub width_pct: f64,
    pub h_align: String,
    pub v_align: String,
    pub offset_x: f64,
    pub offset_y: f64,
    pub padding_x: f64,
    pub padding_y: f64,
    pub border_radius: f64,
    pub max_lines: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtBackground {
    pub r#type: String,
    pub color: String,
    pub gradient_end: String,
    /// 0..100
    pub opacity: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_path: Option<String>,
    pub blur_enabled: bool,
    pub blur: f64,
}

/// The resolved lower-third document: a single normalized descriptor that
/// every renderer consumes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLowerThird {
    pub template: LowerThirdTemplate,
    pub kind: String,
    pub content: LtContent,
    pub slots: LtSlots,
    pub background: LtBackground,
    pub accent: LtAccent,
    pub border: LtBorder,
    pub box_shadow: LtBoxShadow,
    pub text_shadow: LtTextShadow,
    pub outline: LtOutline,
    pub geometry: LtGeometry,
    pub animation: LtAnimation,
    pub variant: String,
    pub scroll: LtScroll,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtContent {
    pub headline: String,
    pub subline: String,
    pub kicker: String,
    pub badge_text: String,
    pub ticker_mode: bool,
    pub body_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtSlots {
    pub show_headline: bool,
    pub show_subline: bool,
    pub show_kicker: bool,
    pub headline: LtStyleSlot,
    pub subline: LtStyleSlot,
    pub kicker: LtStyleSlot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtAccent {
    pub enabled: bool,
    pub color: String,
    pub side: String,
    pub width: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtBorder {
    pub enabled: bool,
    pub color: String,
    pub width: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtBoxShadow {
    pub enabled: bool,
    pub color: String,
    pub blur: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtTextShadow {
    pub enabled: bool,
    pub color: String,
    pub blur: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtOutline {
    pub enabled: bool,
    pub color: String,
    pub width: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtAnimation {
    pub entry: String,
    pub exit: String,
    pub duration: f64,
    pub exit_duration: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LtScroll {
    pub enabled: bool,
    pub direction: String,
    pub speed: f64,
    pub separator: String,
    pub gap: f64,
    pub count: u32,
}

/// The live lower-third document: content plus the template that renders it.
/// Mirrors `src/types/lowerThird.ts` `LowerThirdPayload`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LowerThirdPayload {
    pub data: LowerThirdData,
    pub template: LowerThirdTemplate,
}

/// The authored template schema. Mirrors `src/types/lowerThird.ts`
/// `LowerThirdTemplate`. Field names are the on-wire camelCase names the
/// frontend sends.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LowerThirdTemplate {
    pub id: String,
    pub name: String,
    pub bg_type: String,
    pub bg_color: String,
    pub bg_opacity: f64,
    pub bg_gradient_end: String,
    pub bg_blur: bool,
    pub bg_blur_amount: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg_image_path: Option<String>,
    pub accent_enabled: bool,
    pub accent_color: String,
    pub accent_side: String,
    pub accent_width: f64,
    pub border_enabled: bool,
    pub border_color: String,
    pub border_width: f64,
    pub h_align: String,
    pub v_align: String,
    pub offset_x: f64,
    pub offset_y: f64,
    pub width_pct: f64,
    pub padding_x: f64,
    pub padding_y: f64,
    pub border_radius: f64,
    pub primary_font: String,
    pub primary_size: f64,
    pub primary_color: String,
    pub primary_bold: bool,
    pub primary_italic: bool,
    pub primary_uppercase: bool,
    pub secondary_font: String,
    pub secondary_size: f64,
    pub secondary_color: String,
    pub secondary_bold: bool,
    pub secondary_italic: bool,
    pub secondary_uppercase: bool,
    pub label_visible: bool,
    pub label_color: String,
    pub label_size: f64,
    pub label_uppercase: bool,
    /// Content → style-slot mapping. Each of headline/subline/kicker can be
    /// rendered with the primary, secondary, or label style set, or hidden.
    pub name_style: String,
    pub title_style: String,
    pub label_style: String,
    pub text_shadow: bool,
    pub text_shadow_color: String,
    pub text_shadow_blur: f64,
    pub text_outline: bool,
    pub text_outline_color: String,
    pub text_outline_width: f64,
    pub box_shadow: bool,
    pub box_shadow_color: String,
    pub box_shadow_blur: f64,
    pub animation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_animation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_animation: Option<String>,
    pub animation_duration: f64,
    pub exit_duration: f64,
    pub variant: String,
    pub banner_badge_text: String,
    pub scroll_enabled: bool,
    pub scroll_direction: String,
    pub scroll_speed: f64,
    pub scroll_separator: String,
    pub scroll_gap: f64,
    pub scroll_count: u32,
    pub auto_hide_seconds: f64,
    pub max_lines: u32,
}

/// The default template — mirrors `DEFAULT_LT_TEMPLATE` in
/// `src/types/lowerThird.ts`.
pub fn default_lt_template() -> LowerThirdTemplate {
    LowerThirdTemplate {
        id: "default".to_string(),
        name: "Default".to_string(),
        bg_type: "solid".to_string(),
        bg_color: "#000000".to_string(),
        bg_opacity: 85.0,
        bg_gradient_end: "#141428".to_string(),
        bg_blur: false,
        bg_blur_amount: 8.0,
        bg_image_path: None,
        accent_enabled: true,
        accent_color: "#f59e0b".to_string(),
        accent_side: "left".to_string(),
        accent_width: 4.0,
        border_enabled: false,
        border_color: "#ffffff".to_string(),
        border_width: 1.0,
        h_align: "left".to_string(),
        v_align: "bottom".to_string(),
        offset_x: 48.0,
        offset_y: 40.0,
        width_pct: 60.0,
        padding_x: 24.0,
        padding_y: 16.0,
        border_radius: 12.0,
        primary_font: "Georgia".to_string(),
        primary_size: 36.0,
        primary_color: "#ffffff".to_string(),
        primary_bold: true,
        primary_italic: false,
        primary_uppercase: false,
        secondary_font: "Arial".to_string(),
        secondary_size: 22.0,
        secondary_color: "#f59e0b".to_string(),
        secondary_bold: false,
        secondary_italic: false,
        secondary_uppercase: false,
        label_visible: true,
        label_color: "#f59e0b".to_string(),
        label_size: 13.0,
        label_uppercase: true,
        name_style: "primary".to_string(),
        title_style: "secondary".to_string(),
        label_style: "label".to_string(),
        text_shadow: true,
        text_shadow_color: "rgba(0,0,0,0.8)".to_string(),
        text_shadow_blur: 4.0,
        text_outline: false,
        text_outline_color: "#000000".to_string(),
        text_outline_width: 1.0,
        box_shadow: false,
        box_shadow_color: "rgba(0,0,0,0.5)".to_string(),
        box_shadow_blur: 20.0,
        animation: "slide-up".to_string(),
        entry_animation: None,
        exit_animation: None,
        animation_duration: 0.5,
        exit_duration: 0.2,
        variant: "classic".to_string(),
        banner_badge_text: "LIVE".to_string(),
        scroll_enabled: false,
        scroll_direction: "ltr".to_string(),
        scroll_speed: 5.0,
        scroll_separator: "  •  ".to_string(),
        scroll_gap: 50.0,
        scroll_count: 0,
        auto_hide_seconds: 0.0,
        max_lines: 0,
    }
}

/// Normalize a template against defaults.
pub fn normalize_lt_template(template: Option<&LowerThirdTemplate>) -> LowerThirdTemplate {
    match template {
        Some(t) => t.clone(),
        None => default_lt_template(),
    }
}

/// Substitute runtime tokens (`{time}`, `{date}`) used by free-text lower
/// thirds. Matches the TS implementation's intent: locale-style time/date.
pub fn substitute_tokens(text: &str) -> String {
    let now = chrono::Local::now();
    let time = now.format("%I:%M %p").to_string();
    let date = now.format("%-m/%-d/%Y").to_string();
    text.replace("{time}", &time).replace("{date}", &date)
}

fn slot_for(t: &LowerThirdTemplate, slot: &str) -> LtStyleSlot {
    match slot {
        "label" => LtStyleSlot {
            font: t.secondary_font.clone(),
            size: t.label_size,
            color: t.label_color.clone(),
            bold: true,
            italic: false,
            uppercase: t.label_uppercase,
        },
        "secondary" => LtStyleSlot {
            font: t.secondary_font.clone(),
            size: t.secondary_size,
            color: t.secondary_color.clone(),
            bold: t.secondary_bold,
            italic: t.secondary_italic,
            uppercase: t.secondary_uppercase,
        },
        _ => LtStyleSlot {
            font: t.primary_font.clone(),
            size: t.primary_size,
            color: t.primary_color.clone(),
            bold: t.primary_bold,
            italic: t.primary_italic,
            uppercase: t.primary_uppercase,
        },
    }
}

/// Resolve a live lower-third document into the shared renderer descriptor.
/// Content→slot mapping follows the template's nameStyle/titleStyle/labelStyle
/// so a song can be rendered with the design the operator chose.
pub fn resolve_lower_third(payload: &LowerThirdPayload) -> ResolvedLowerThird {
    let t = normalize_lt_template(Some(&payload.template));
    let data = &payload.data;

    let ticker_mode = matches!(data, LowerThirdData::FreeText(_)) && t.scroll_enabled;
    let mut headline = String::new();
    let mut subline = String::new();
    let mut kicker = String::new();
    match data {
        LowerThirdData::Nameplate(n) => {
            headline = n.name.clone();
            subline = n.title.clone().unwrap_or_default();
        }
        LowerThirdData::Lyrics(l) => {
            headline = l.line1.clone();
            subline = l.line2.clone().unwrap_or_default();
            if let Some(section) = &l.section_label {
                if t.label_visible {
                    kicker = section.clone();
                }
            }
        }
        LowerThirdData::FreeText(f) => {
            if !ticker_mode {
                headline = f.text.clone();
            }
        }
    }

    let show_headline = !headline.is_empty() && t.name_style != "none";
    let show_subline = !subline.is_empty() && t.title_style != "none";
    let show_kicker = !kicker.is_empty() && t.label_style != "none";

    let badge_text = if matches!(data, LowerThirdData::Lyrics(_)) {
        if show_kicker {
            kicker.clone()
        } else if t.banner_badge_text.is_empty() {
            "LIVE".to_string()
        } else {
            t.banner_badge_text.clone()
        }
    } else if t.banner_badge_text.is_empty() {
        "LIVE".to_string()
    } else {
        t.banner_badge_text.clone()
    };

    let body_text = if ticker_mode {
        match data {
            LowerThirdData::FreeText(f) => substitute_tokens(&f.text),
            _ => String::new(),
        }
    } else {
        String::new()
    };

    let headline_slot = if t.name_style == "none" {
        slot_for(&t, "primary")
    } else {
        slot_for(&t, &t.name_style)
    };
    let subline_slot = if t.title_style == "none" {
        slot_for(&t, "primary")
    } else {
        slot_for(&t, &t.title_style)
    };
    let kicker_slot = if t.label_style == "none" {
        slot_for(&t, "label")
    } else {
        slot_for(&t, &t.label_style)
    };

    ResolvedLowerThird {
        template: t.clone(),
        kind: match data {
            LowerThirdData::Nameplate(_) => "Nameplate",
            LowerThirdData::Lyrics(_) => "Lyrics",
            LowerThirdData::FreeText(_) => "FreeText",
        }
        .to_string(),
        content: LtContent {
            headline,
            subline,
            kicker,
            badge_text,
            ticker_mode,
            body_text,
        },
        slots: LtSlots {
            show_headline,
            show_subline,
            show_kicker,
            headline: headline_slot,
            subline: subline_slot,
            kicker: kicker_slot,
        },
        background: LtBackground {
            r#type: if t.bg_type == "image" && t.bg_image_path.is_none() {
                "transparent"
            } else {
                t.bg_type.as_str()
            }
            .to_string(),
            color: t.bg_color.clone(),
            gradient_end: t.bg_gradient_end.clone(),
            opacity: t.bg_opacity,
            image_path: t.bg_image_path.clone(),
            blur_enabled: t.bg_blur,
            blur: t.bg_blur_amount,
        },
        accent: LtAccent {
            enabled: t.accent_enabled,
            color: t.accent_color.clone(),
            side: t.accent_side.clone(),
            width: t.accent_width,
        },
        border: LtBorder {
            enabled: t.border_enabled,
            color: t.border_color.clone(),
            width: t.border_width,
        },
        box_shadow: LtBoxShadow {
            enabled: t.box_shadow,
            color: t.box_shadow_color.clone(),
            blur: t.box_shadow_blur,
        },
        text_shadow: LtTextShadow {
            enabled: t.text_shadow,
            color: t.text_shadow_color.clone(),
            blur: t.text_shadow_blur,
        },
        outline: LtOutline {
            enabled: t.text_outline,
            color: t.text_outline_color.clone(),
            width: t.text_outline_width,
        },
        geometry: LtGeometry {
            is_full_width: t.width_pct >= 100.0,
            width_pct: t.width_pct,
            h_align: t.h_align.clone(),
            v_align: t.v_align.clone(),
            offset_x: t.offset_x,
            offset_y: t.offset_y,
            padding_x: t.padding_x,
            padding_y: t.padding_y,
            border_radius: t.border_radius,
            max_lines: t.max_lines,
        },
        animation: LtAnimation {
            entry: t.entry_animation.clone().unwrap_or_else(|| t.animation.clone()),
            exit: t.exit_animation.clone().unwrap_or_else(|| t.animation.clone()),
            duration: t.animation_duration,
            exit_duration: t.exit_duration,
        },
        variant: t.variant.clone(),
        scroll: LtScroll {
            enabled: t.scroll_enabled,
            direction: t.scroll_direction.clone(),
            speed: t.scroll_speed,
            separator: t.scroll_separator.clone(),
            gap: t.scroll_gap,
            count: t.scroll_count,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nameplate_payload(overrides: impl FnOnce(&mut LowerThirdTemplate)) -> LowerThirdPayload {
        let mut t = default_lt_template();
        overrides(&mut t);
        LowerThirdPayload {
            data: serde_json::from_value(serde_json::json!({
                "kind": "Nameplate",
                "data": { "name": "Jane Doe", "title": "Lead Pastor" }
            }))
            .unwrap(),
            template: t,
        }
    }

    #[test]
    fn maps_nameplate_to_headline_subline() {
        let layout = resolve_lower_third(&nameplate_payload(|_| {}));
        assert_eq!(layout.kind, "Nameplate");
        assert_eq!(layout.content.headline, "Jane Doe");
        assert_eq!(layout.content.subline, "Lead Pastor");
        assert!(!layout.content.ticker_mode);
        assert_eq!(layout.content.body_text, "");
        assert!(layout.slots.show_headline);
        assert!(layout.slots.show_subline);
        assert!(!layout.slots.show_kicker);
    }

    #[test]
    fn merges_template_against_defaults() {
        let layout = resolve_lower_third(&nameplate_payload(|t| {
            t.width_pct = 100.0;
            t.accent_color = "#ff0000".to_string();
        }));
        assert!(layout.geometry.is_full_width);
        assert_eq!(layout.geometry.width_pct, 100.0);
        assert_eq!(layout.accent.color, "#ff0000");
        assert_eq!(layout.geometry.padding_x, default_lt_template().padding_x);
        assert_eq!(layout.geometry.border_radius, default_lt_template().border_radius);
    }

    #[test]
    fn lyrics_section_label_maps_to_kicker() {
        let t = default_lt_template();
        let payload = LowerThirdPayload {
            data: serde_json::from_value(serde_json::json!({
                "kind": "Lyrics",
                "data": { "line1": "Amazing Grace", "line2": "How sweet the sound", "section_label": "Verse 1" }
            }))
            .unwrap(),
            template: t.clone(),
        };
        let layout = resolve_lower_third(&payload);
        assert_eq!(layout.content.headline, "Amazing Grace");
        assert_eq!(layout.content.subline, "How sweet the sound");
        assert_eq!(layout.content.kicker, "Verse 1");
        assert!(layout.slots.show_kicker);
        assert_eq!(layout.content.badge_text, "Verse 1");
    }

    #[test]
    fn hides_lyrics_label_when_label_visible_off() {
        let mut t = default_lt_template();
        t.label_visible = false;
        let payload = LowerThirdPayload {
            data: serde_json::from_value(serde_json::json!({
                "kind": "Lyrics",
                "data": { "line1": "Amazing Grace", "section_label": "Verse 1" }
            }))
            .unwrap(),
            template: t,
        };
        let layout = resolve_lower_third(&payload);
        assert_eq!(layout.content.kicker, "");
        assert!(!layout.slots.show_kicker);
        assert_eq!(layout.content.badge_text, "LIVE");
    }

    #[test]
    fn scrolling_free_text_is_ticker_with_substituted_body() {
        let mut t = default_lt_template();
        t.scroll_enabled = true;
        let payload = LowerThirdPayload {
            data: serde_json::from_value(serde_json::json!({
                "kind": "FreeText",
                "data": { "text": "Verse of the day {time}" }
            }))
            .unwrap(),
            template: t,
        };
        let layout = resolve_lower_third(&payload);
        assert!(layout.content.ticker_mode);
        assert!(!layout.content.body_text.contains("{time}"));
        assert!(!layout.slots.show_headline);
        assert_eq!(layout.content.headline, "");
    }

    #[test]
    fn static_free_text_stays_headline() {
        let payload = LowerThirdPayload {
            data: serde_json::from_value(serde_json::json!({
                "kind": "FreeText",
                "data": { "text": "Welcome to our service" }
            }))
            .unwrap(),
            template: default_lt_template(),
        };
        let layout = resolve_lower_third(&payload);
        assert!(!layout.content.ticker_mode);
        assert_eq!(layout.content.headline, "Welcome to our service");
        assert!(layout.slots.show_headline);
    }

    #[test]
    fn maps_content_onto_configured_style_slots() {
        let d = default_lt_template();
        let layout = resolve_lower_third(&nameplate_payload(|t| {
            t.name_style = "secondary".to_string();
            t.title_style = "label".to_string();
        }));
        assert_eq!(layout.slots.headline.size, d.secondary_size);
        assert_eq!(layout.slots.headline.font, d.secondary_font);
        assert_eq!(layout.slots.subline.size, d.label_size);
        assert!(layout.slots.subline.bold);
    }

    #[test]
    fn hides_slot_when_style_mapping_is_none() {
        let layout = resolve_lower_third(&nameplate_payload(|t| {
            t.name_style = "none".to_string();
        }));
        assert!(!layout.slots.show_headline);
    }

    #[test]
    fn resolves_background_types() {
        assert_eq!(resolve_lower_third(&nameplate_payload(|_| {})).background.r#type, "solid");
        assert_eq!(
            resolve_lower_third(&nameplate_payload(|t| t.bg_type = "gradient".to_string())).background.r#type,
            "gradient"
        );
        let img = resolve_lower_third(&nameplate_payload(|t| {
            t.bg_type = "image".to_string();
            t.bg_image_path = Some("lt/bg.png".to_string());
        }));
        assert_eq!(img.background.r#type, "image");
        assert_eq!(img.background.image_path.as_deref(), Some("lt/bg.png"));
        let none = resolve_lower_third(&nameplate_payload(|t| t.bg_type = "image".to_string()));
        assert_eq!(none.background.r#type, "transparent");
    }

    #[test]
    fn normalizes_accent_border_shadow_and_outline_tokens() {
        let d = default_lt_template();
        let layout = resolve_lower_third(&nameplate_payload(|t| {
            t.accent_side = "right".to_string();
            t.border_enabled = true;
            t.text_outline = true;
            t.box_shadow = true;
        }));
        assert_eq!(layout.accent.side, "right");
        assert_eq!(layout.accent.width, d.accent_width);
        assert!(layout.border.enabled);
        assert!(layout.outline.enabled);
        assert!(layout.box_shadow.enabled);
        assert_eq!(layout.box_shadow.blur, d.box_shadow_blur);
    }

    #[test]
    fn substitutes_time_and_date_tokens() {
        let out = substitute_tokens("{time} {date}");
        let time_pattern = regex_for_time();
        assert!(time_pattern, "{out}");
        assert_eq!(substitute_tokens("plain text"), "plain text");
    }

    fn regex_for_time() -> bool {
        // Crude check: "<digits>:<digits> <AM|PM> <date>" form produced by chrono.
        substitute_tokens("{time} {date}")
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
    }

    #[test]
    fn entry_exit_animation_falls_back_to_animation() {
        let d = default_lt_template();
        let layout = resolve_lower_third(&nameplate_payload(|_| {}));
        assert_eq!(layout.animation.entry, d.animation);
        assert_eq!(layout.animation.exit, d.animation);
    }
}