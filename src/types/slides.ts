/**
 * Slide data model.
 *
 * Phase 1 of the slide-modernization plan: `SlideElement` is now a
 * discriminated union on `kind`. Every consumer must branch on `kind` and
 * gets compile-time enforcement. Field names are kept snake_case to match
 * the on-wire JSON persisted by the Rust serde layer and existing DB rows.
 *
 * Legacy `SlideZone` / `header` / `body` / `headerEnabled` fields are kept
 * on `CustomSlide` for one release cycle so `migratePresentation` can convert
 * them to `elements[]` on first load. The legacy fields are *not* honoured
 * by the renderer once `elements.length > 0`.
 */

// ─── Legacy zones (used only for migration) ────────────────────────────────

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
}

export interface TextElement extends BaseElement {
  kind: "text";
  /**
   * HTML string. Phase 1 preserves the HTML-string contract; P1.7
   * sanitizes render output via an allowlist. Phase 2 swaps this for
   * ProseMirror JSON.
   */
  content: string;
  font_size?: number;
  font_family?: string;
  color?: string;
  align?: "left" | "center" | "right";
  v_align?: "top" | "middle" | "bottom";
  bold?: boolean;
  italic?: boolean;
  shadow?: boolean;
  shadow_color?: string;
}

export interface ImageElement extends BaseElement {
  kind: "image";
  /** Relativized or absolute media path resolved via `resolvePath`. */
  content: string;
}

export interface VideoElement extends BaseElement {
  kind: "video";
  /** Relativized or absolute media path resolved via `resolvePath`. */
  content: string;
  loop?: boolean;
  muted?: boolean;
}

export interface ShapeElement extends BaseElement {
  kind: "shape";
  /** Fill color. */
  color?: string;
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
  backgroundColor: string;
  backgroundImage?: string;
  backgroundVideo?: string;
  backgroundVideoLoop?: boolean;
  backgroundVideoMuted?: boolean;
  elements: SlideElement[];
  notes?: string;
  /**
   * @deprecated Legacy pre-`elements[]` model. Kept for migration only;
   * the renderer ignores these when `elements.length > 0`.
   */
  headerEnabled?: boolean;
  headerHeightPct?: number;
  header?: SlideZone;
  body?: SlideZone;
}

export interface CustomPresentation {
  id: string;
  name: string;
  slides: CustomSlide[];
  version?: number;
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
  slide: CustomSlide;
  created_at: number;
}

export interface PresentationExport {
  version: number;
  presentation: CustomPresentation;
  exported_at: number;
}

/**
 * On-wire shape of a slide rendered to the output window. The `elements`
 * array reuses `SlideElement` from above (discriminated by `kind`) so the
 * output renderer can switch exhaustively.
 */
export interface CustomSlideDisplayData {
  presentation_id: string;
  presentation_name: string;
  slide_index: number;
  slide_count: number;
  background_color: string;
  background_image?: string;
  background_video?: string;
  background_video_loop?: boolean;
  background_video_muted?: boolean;
  elements?: SlideElement[];
  notes?: string;
  /**
   * @deprecated Legacy migration fields. Ignored by the renderer when
   * `elements.length > 0`. Kept so old saved presentations hydrate.
   */
  header_enabled?: boolean;
  header_height_pct?: number;
  header?: {
    text: string;
    font_size: number;
    font_family: string;
    color: string;
    bold: boolean;
    italic: boolean;
    align: string;
  };
  body?: {
    text: string;
    font_size: number;
    font_family: string;
    color: string;
    bold: boolean;
    italic: boolean;
    align: string;
  };
}