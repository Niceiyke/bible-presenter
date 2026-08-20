//! Resolved program-frame model — the Rust mirror of
//! `src/compositor/ProgramFrame.ts`.
//!
//! Every output surface (projection, stage preview, recorder, streamer)
//! resolves the SAME `ProgramFrame` from its `OutputConfig` plus the
//! authoritative presentation snapshot via `resolve_program_frame`. An output
//! never independently reconstructs live state — it subscribes to a resolved
//! frame. The DOM outputs (`OutputWindow`/`StageWindow`) and the wgpu
//! compositor are both consumers of this model.
//!
//! `layers` is a declarative, ordered description of the same composition
//! (documentation + fixture parity). The canvas draw pass paints the resolved
//! fields directly; tests assert `layers` to lock the ordering contract.

use serde::{Deserialize, Serialize};

use crate::store::{
    BackgroundSetting, DisplayItem, PresentationSettings, PropItem, SceneZone,
};

use super::lower_third::LowerThirdPayload;

/// Theme colors the resolved frame carries — mirrors `src/types/settings.ts`
/// `ThemeColors`. Distinct from `store::ThemeColors` (the settings
/// `custom_theme_colors` shape); this is the render-time palette derived from
/// the `THEMES` table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors {
    pub background: String,
    pub verse_text: String,
    pub reference_text: String,
    pub waiting_text: String,
}

/// What the output is subscribed to, after resolution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ResolvedOutputSource {
    Live { item: Option<DisplayItem> },
    Staged { item: Option<DisplayItem> },
    Scene { item: Option<DisplayItem>, scene_id: String },
    Item { item: DisplayItem },
    Blank,
}

/// The background to paint — already accounting for content-type overrides
/// (bible/media/song) and output presentation overrides.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedBackground {
    pub setting: BackgroundSetting,
    /// Fallback color when the setting's media is unavailable.
    pub fallback: String,
}

/// Resolved persistent logo overlay.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub opacity: f64,
}

/// The audio the composited program carries (drives recorder/streamer
/// audio selection). Kept minimal on purpose.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AudioProgramDescriptor {
    None,
    Media { muted: bool },
}

/// Render surface geometry + capture cadence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasGeometry {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

/// Overlay payloads AFTER applying the output's overlay mask. An empty
/// vec / `None` means the layer is masked off (or empty) for this output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgramOverlays {
    pub props: Vec<PropItem>,
    pub lower_third: Option<LowerThirdPayload>,
    pub logo: Option<LogoState>,
}

/// Declarative paint-order description of a resolved frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ProgramLayer {
    #[serde(rename = "blank")]
    Blank,
    #[serde(rename = "background")]
    Background { setting: BackgroundSetting },
    #[serde(rename = "item")]
    Item { item: DisplayItem },
    #[serde(rename = "zone")]
    Zone { zone: SceneZone },
    #[serde(rename = "props")]
    Props { count: usize },
    #[serde(rename = "lower_third")]
    LowerThird { payload: Box<LowerThirdPayload> },
    #[serde(rename = "logo")]
    Logo,
    #[serde(rename = "waiting")]
    Waiting,
}

/// One fully-resolved program frame, shared by every output surface.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgramFrame {
    /// Presentation snapshot revision this frame resolves.
    pub revision: u64,
    /// When the frame was resolved.
    pub timestamp: u64,
    pub canvas: CanvasGeometry,
    pub source: ResolvedOutputSource,
    /// Declarative paint order.
    pub layers: Vec<ProgramLayer>,
    pub background: ResolvedBackground,
    pub overlays: ProgramOverlays,
    pub blackout: bool,
    /// Structural resource problems: empty media paths, missing scene
    /// `scene:<id>`, unmasked-without-resource overlays.
    pub missing: Vec<String>,
    pub audio: AudioProgramDescriptor,
    // Render material shared by the DOM + canvas compositors:
    pub settings: PresentationSettings,
    pub colors: ThemeColors,
    pub reference_output_height: u32,
    /// The frame's paint timestamp (timer/clock rendering reads this).
    pub now: u64,
    /// App data dir for resolving persisted (relativized) media paths. Set by
    /// the surface that materializes the frame; the resolver leaves it unset.
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "appDataDir")]
    pub app_data_dir: Option<String>,
}

impl ResolvedOutputSource {
    /// The content item of a non-blank source.
    pub fn item(&self) -> Option<&DisplayItem> {
        match self {
            ResolvedOutputSource::Live { item } => item.as_ref(),
            ResolvedOutputSource::Staged { item } => item.as_ref(),
            ResolvedOutputSource::Scene { item, .. } => item.as_ref(),
            ResolvedOutputSource::Item { item } => Some(item),
            ResolvedOutputSource::Blank => None,
        }
    }
}

/// The render-time theme table — mirrors `THEMES` in `src/types/settings.ts`.
pub fn theme_colors(name: &str) -> Option<ThemeColors> {
    let colors = match name {
        "dark" => ("#000000", "#ffffff", "#f59e0b", "#3f3f46"),
        "light" => ("#f8fafc", "#0f172a", "#b45309", "#94a3b8"),
        "navy" => ("#0a1628", "#e2e8f0", "#60a5fa", "#334155"),
        "maroon" => ("#1a0505", "#fef2f2", "#f87171", "#7f1d1d"),
        "forest" => ("#051a0a", "#f0fdf4", "#4ade80", "#14532d"),
        "slate" => ("#1e2a3a", "#cbd5e1", "#94a3b8", "#334155"),
        _ => return None,
    };
    Some(ThemeColors {
        background: colors.0.to_string(),
        verse_text: colors.1.to_string(),
        reference_text: colors.2.to_string(),
        waiting_text: colors.3.to_string(),
    })
}

/// The default ("Classic Dark") theme colors.
pub fn dark_theme_colors() -> ThemeColors {
    theme_colors("dark").expect("dark theme is defined")
}