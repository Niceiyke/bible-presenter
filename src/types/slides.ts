/**
 * Slide data model.
 *
 * Phase 2 of the slide-modernization plan. `SlideElement` is a
 * discriminated union on `kind`; `CustomSlide.background` is a
 * discriminated union on `type`; `TextElement.content` is ProseMirror
 * JSON (with a legacy HTML-string escape hatch for one release cycle).
 * Every consumer branch is exhaustive and the compiler enforces it.
 *
 * Field names are snake_case to match the on-wire JSON persisted by the
 * Rust serde layer. Legacy `header`/`body`/`SlideZone` fields were removed
 * in P2.3; `migratePresentation` rebuilds them into `elements[]` and the
 * `background` union from the v0/v1 on-wire shape on first load.
 */

// ─── ProseMirror JSON doc shape (Tiptap getJSON / setContent) ───────────────

/**
 * Minimal structural type for ProseMirror JSON documents. Tiptap's
 * `editor.getJSON()` returns objects matching this shape; we keep the
 * field as a `Record<string, unknown>` so the renderer / migration can
 * pass it through without depending on Tiptap's runtime at type-time.
 */
export type ProseMirrorJSON = { type: string; [key: string]: unknown };

// ─── Slide background (discriminated union by `type`) ────────────────────────

export type SlideBackground =
  | { type: "color"; value: string }
  | { type: "image"; value: string; objectFit?: "cover" | "contain" | "fill"; opacity?: number }
  | { type: "video"; value: string; loop?: boolean; muted?: boolean; objectFit?: "cover" | "contain" | "fill"; opacity?: number }
  | { type: "gradient"; from: string; to: string; angle: number };

/** Default fallback background when none is set on a slide. */
export const DEFAULT_SLIDE_BACKGROUND: SlideBackground = {
  type: "color",
  value: "#1a1a2e",
};

// ─── Legacy zones (used ONLY for migration) ─────────────────────────────────

export interface SlideZone {
  text: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
}

/** @deprecated alias kept for migration callers; use `SlideZone` */
export type TextZone = SlideZone;

// ─── Slide elements (discriminated union by `kind`) ──────────────────────────

export type SlideElementKind = "text" | "image" | "video" | "shape";

interface BaseElement {
  id: string;
  /** X position as percentage of canvas (0–100). */
  x: number;
  /** Y position as percentage of canvas (0–100). */
  y: number;
  /** Width as percentage of canvas (0–100). */
  w: number;
  /** Height as percentage of canvas (0–100). */
  h: number;
  /** Stacking order; higher renders on top. */
  z_index: number;
  /** Optional grouping id (set by `Ctrl+G`). Members move together. */
  groupId?: string;
  /** 0–1 opacity multiplier. */
  opacity?: number;
  /** If true, the element is non-interactive on the canvas. */
  locked?: boolean;
  /** P3.4: rotation in degrees, clockwise. Default `0`. The renderer
   *  applies `transform: rotate(${rotation}deg)` about the element's
   *  box center. */
  rotation?: number;
  /** P3.4: mirror the element along the X axis. */
  flipX?: boolean;
  /** P3.4: mirror the element along the Y axis. */
  flipY?: boolean;
  /** P4.5: per-element entrance animation. When the slide goes live,
   *  each element animates in with the configured effect, starting
   *  `delay` ms after the slide transitions. Default: no animation. */
  entrance?: {
    type: "fade" | "slide-up" | "slide-left" | "zoom" | "none";
    duration: number;
    delay: number;
  };
}

export interface TextElement extends BaseElement {
  kind: "text";
  /**
   * ProseMirror JSON document (Tiptap `editor.getJSON()`). Migration
   * converts legacy HTML-string content to JSON via `generateJSON`
   * on first load; the `string` member of the union is the temporary
   * bridge used while the migration runs and for legacy pres files
   * that have not been re-saved yet (P2.2 risk mitigation).
   */
  content: ProseMirrorJSON | string;
  /**
   * Per-element style overrides. Each accepts `"inherit"` (P2.4) to
   * resolve from the presentation's `SlideTheme` so a master/theme
   * cascade can update many slides at once. A plain number/string is
   * a concrete override that wins over the theme.
   */
  font_size?: number | "inherit";
  font_family?: string | "inherit";
  color?: string | "inherit";
  align?: "left" | "center" | "right";
  v_align?: "top" | "middle" | "bottom";
  bold?: boolean;
  italic?: boolean;
  shadow?: boolean;
  shadow_color?: string;
  /**
   * Phase 3.3 — auto-fit behaviour for the element's text box.
   *   - `fixed`  (default): current behaviour. Box is a fixed size; text
   *                 overflows or underfills depending on length.
   *   - `shrink`: binary-search the largest font size (capped at the
   *                 declared `font_size`) such that `scrollHeight ≤ clientHeight`.
   *                 Useful for long verses / lyrics that must remain on-screen.
   *   - `grow`:   box height is grown to fit content; min-h is the declared
   *                 `h` percentage. Useful for self-sizing caption / footer
   *                 boxes whose content length is unknown at author time.
   */
  autoSize?: "grow" | "shrink" | "fixed";
  /**
   * Optional master-placeholder role, set when the element was cloned
   * from a `SlideMaster` (P2.4). Masters declare roles so dependent
   * slides can type into a known slot; the field has no rendering
   * effect on its own.
   */
  role?: "title" | "body" | "footer";
}

export interface ImageElement extends BaseElement {
  kind: "image";
  /** Relativized or absolute media path resolved via `resolvePath`. */
  content: string;
  /** P3.6: how the image fits its box. Defaults to `contain` for
   *  back-compat with the pre-P3.6 renderer (which always applied
   *  Tailwind's `object-contain`). */
  objectFit?: "contain" | "cover" | "fill";
  /** `object-position` override; defaults to `center`. Accepts the
   *  9-point grid values `top|center|bottom left|center|right`. */
  objectPosition?: string;
  /** P3.6: CSS filter chain. `none` is the default. */
  filter?: "none" | "grayscale" | "sepia" | "blur" | "brightness";
  /** 0–100 strength applied to the active filter. The renderer
   *  translates it to the appropriate CSS percentage / px value. */
  filterValue?: number;
  /** Border-radius in CSS px at the 1080p reference height. */
  borderRadius?: number;
  /** Optional border. The renderer translates this to `border:
   *  ${width}px solid ${color}`. */
  border?: { color: string; width: number };
}

export interface VideoElement extends BaseElement {
  kind: "video";
  /** Relativized or absolute media path resolved via `resolvePath`. */
  content: string;
  loop?: boolean;
  muted?: boolean;
  /** P4.7: how the video fits its box. Defaults to `contain` for
   *  back-compat with the pre-P4.7 renderer (which always applied
   *  `object-contain`). */
  objectFit?: "contain" | "cover" | "fill";
}

export interface ShapeElement extends BaseElement {
  kind: "shape";
  /** P3.5: shape variant. `rect` keeps back-compat with v0/v1
   *  presentations (an untyped shape element defaults to `rect`). */
  shape?: "rect" | "rounded" | "circle" | "line" | "triangle";
  /** Alias of `shape` for back-compat with the pre-P3.5 `color` field.
   *  The renderer prefers `fillColor` and falls back to `color`. */
  fillColor?: string;
  /** Pre-P3.5 alias retained so un-migrated decks still render. */
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  /** Px-equivalent corner radius for `rect`/`rounded`. The renderer
   *  converts to the SVG `<rect rx=…>` attribute; values are in CSS
   *  px at the slide's reference 1080p height (so `borderRadius: 24`
   *  renders as 24px on a 1080p output). */
  borderRadius?: number;
}

export type SlideElement = TextElement | ImageElement | VideoElement | ShapeElement;

// ─── Type guards ────────────────────────────────────────────────────────────

export function isTextElement(el: SlideElement): el is TextElement {
  return el.kind === "text";
}
export function isImageElement(el: SlideElement): el is ImageElement {
  return el.kind === "image";
}
export function isVideoElement(el: SlideElement): el is VideoElement {
  return el.kind === "video";
}
export function isShapeElement(el: SlideElement): el is ShapeElement {
  return el.kind === "shape";
}

// ─── Slide + presentation ────────────────────────────────────────────────────

export interface CustomSlide {
  id: string;
  /**
   * Background. Phase 2: a discriminated union on `type`. `migratePresentation`
   * rebuilds this from the legacy `backgroundColor`/`backgroundImage`/etc.
   * fields on load; new presentations set it once via the factories in
   * `utils/index.ts`.
   */
  background: SlideBackground;
  elements: SlideElement[];
  notes?: string;
  /** Optional reference to a master layout this slide was cloned from
   *  (P2.4). Editing the master propagates through the cascade. */
  masterRef?: string;
}

/**
 * Subset of `TextElement.style` props that can be promoted into a theme
 * for inheritance. `Partial<TextStyle>` keeps the cascade logic lenient.
 */
export interface TextStyle {
  font_family: string;
  font_size: number;
  color: string;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
}

export interface SlideTheme {
  id: string;
  name: string;
  defaultFontFamily: string;
  defaultFontSize: number;
  titleStyle: Partial<TextStyle>;
  bodyStyle: Partial<TextStyle>;
  textColor: string;
  accentColor: string;
  background: SlideBackground;
  /**
   * P4.3 — named paragraph styles offered in the inline text editor's
   * dropdown. Each is a `TextStyle`-shaped recipe (with an avoidable
   * `indent` for quote-style columns). Stored per-paragraph as ProseMirror
   * JSON node attrs (`style`), so applying one just rewrites the paragraph's
   * node attrs and the renderer emits the inline CSS unchanged.
   */
  paragraphStyles?: Record<string, Partial<TextStyle> & { indent?: string }>;
}

/**
 * Reusable master layout (P2.4). Placeholders are normal `TextElement`s
 * keyed by their `role` field; cloning a master copies the placeholders
 * onto the new slide so the operator types into them.
 */
export interface SlideMaster {
  id: string;
  name: string;
  /** Background inherited by dependent slides that have
   *  `background: { ... masterBackground }` mapping (kept loose here
   *  because dependent slides own their own `background` once cloned). */
  background: SlideBackground;
  elements: SlideElement[];
}

export interface CustomPresentation {
  id: string;
  name: string;
  slides: CustomSlide[];
  version?: number;
  /** P2.4: theme defaults; `migratePresentation` synthesizes a theme
   *  for pre-v2 presentations when none is present. */
  theme?: SlideTheme;
  /** Optional reusable master layouts (P2.4). */
  masters?: SlideMaster[];
}

export interface PresentationSummary {
  id: string;
  name: string;
  slide_count: number;
  version: number;
  updated_at: number;
}

export interface SlideTemplate {
  id: string;
  name: string;
  category: string;
  /**
   * Single-slide template (P1.x). Exactly one of `slide` / `slides` is
   * set: `slide` for a classic single-slide template, `slides` for a
   * deck template (P4.1) carrying a whole presentation's worth of slides.
   */
  slide?: CustomSlide;
  /** Deck template (P4.1): a sequence of slides inserted together. */
  slides?: CustomSlide[];
  created_at: number;
}

/** P4.1: all slides carried by a template, whether single or a deck. */
export function templateSlides(tpl: SlideTemplate): CustomSlide[] {
  if (tpl.slides && tpl.slides.length > 0) return tpl.slides;
  return tpl.slide ? [tpl.slide] : [];
}

export interface PresentationExport {
  version: number;
  presentation: CustomPresentation;
  exported_at: number;
}

/**
 * On-wire shape of a slide rendered to the output window. Carries the
 * slide content (`background` + `elements` + `notes`) plus the small
 * amount of metadata the items registry needs (`presentation_id`,
 * `presentation_name`, `slide_index`, `slide_count`). The legacy
 * `header`/`body`/`header_enabled`/`header_height_pct` and the
 * flat `background_color`/`background_image`/... fields have been
 * folded into `background` and `elements` (P2.3).
 */
export interface CustomSlideDisplayData {
  presentation_id: string;
  presentation_name: string;
  slide_index: number;
  slide_count: number;
  background: SlideBackground;
  elements?: SlideElement[];
  notes?: string;
  /**
   * Optional cascade theme (P2.4). Embedded by `buildCustomSlideItem`
   * when the caller has the presentation's theme in hand, so the
   * output / stage renderers can resolve `"inherit"` element styles
   * without an extra presentation lookup. `undefined` falls back to
   * the renderer's hardcoded defaults.
   */
  theme?: SlideTheme;
}