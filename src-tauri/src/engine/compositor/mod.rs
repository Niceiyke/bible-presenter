//! Compositor domain — the Rust mirror of `src/compositor/`.
//!
//! Phase B1: pure, unit-testable ports of `resolveProgramFrame` +
//! `resolveLowerThird` (`frame.rs` / `resolver.rs` / `lower_third.rs`). The
//! wgpu renderer (Phase B2) and fixture-parity harness (Phase B3) build on
//! these — the DOM renderers stay the parity oracle until then.

pub mod frame;
pub mod lower_third;
pub mod renderer;
pub mod resolver;

pub use frame::{
    dark_theme_colors, theme_colors, AudioProgramDescriptor, CanvasGeometry, LogoState,
    ProgramFrame, ProgramLayer, ProgramOverlays, ResolvedBackground, ResolvedOutputSource,
    ThemeColors,
};
pub use lower_third::{
    default_lt_template, normalize_lt_template, resolve_lower_third, substitute_tokens,
    LowerThirdPayload, LowerThirdTemplate, ResolvedLowerThird,
};
pub use resolver::{
    collect_frame_media_paths, derive_logo_state, get_effective_bg, resolve_program_frame,
    resolve_theme_colors, FrameMediaPaths, ProgramFrameInput, ResolverSnapshot,
};
pub use renderer::{render_frame_to_pixels, Compositor, ImageData, MediaResolver, MemoryMedia, parse_color};