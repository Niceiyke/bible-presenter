/**
 * Pure-functional slide editor helpers.
 *
 * P1.4 of the slide-modernization plan. Centralizing these functions so
 * they can be shared between SlideEditor, SlideCanvas, and (in Phase 2)
 * master-slide / template editors without circular imports.
 *
 * - `alignElement`         — multi-element canvas alignment
 * - `adjustZOrder`         — bring-forward / send-backward swaps (atomic)
 * - `groupOps`              — group-id mutation helpers
 * - `migratePresentation`  — convert legacy header/body slides to elements[],
 *                            rebuild the `SlideBackground` union from the
 *                            pre-v2 flat background fields, swap
 *                            `TextElement.content` from HTML-string to
 *                            ProseMirror JSON, and synthesize a default
 *                            `SlideTheme` for the cascade (P2.1+P2.2+P2.3+P2.4).
 *
 * Each helper returns a *delta* (an `updates` map or a fresh `elements`
 * array) rather than directly mutating state. Callers own the actual
 * `setPres` commit, so the helpers can be memoized independently.
 */

import type {
  CustomPresentation, SlideElement, SlideZone, SlideBackground, SlideTheme,
  CustomSlide,
} from "../../../types";
import { newTextElement, stableId } from "../../../utils";
import { migrateHtmlContentToJSON } from "./slideTextExtensions";

// Re-exported for ergonomic imports from the editor modules.
export { stableId };

// ─── Alignment ────────────────────────────────────────────────────────────

export type AlignmentAxis = "left" | "center" | "right" | "top" | "middle" | "bottom";

/**
 * Compute per-element position deltas so that each element's box aligns
 * on the requested axis. Returns a map of `{ elementId: Partial<SlideElement> }`
 * that the caller commits via `updateElements`.
 */
export function alignElements(
  els: SlideElement[],
  axis: AlignmentAxis,
): Record<string, Partial<SlideElement>> {
  const out: Record<string, Partial<SlideElement>> = {};
  for (const el of els) {
    const u: Partial<SlideElement> = {};
    if (axis === "left") u.x = 0;
    else if (axis === "right") u.x = 100 - el.w;
    else if (axis === "center") u.x = (100 - el.w) / 2;
    else if (axis === "top") u.y = 0;
    else if (axis === "bottom") u.y = 100 - el.h;
    else if (axis === "middle") u.y = (100 - el.h) / 2;
    out[el.id] = u;
  }
  return out;
}

// ─── Z-order ───────────────────────────────────────────────────────────────

export type ZDirection = "forward" | "backward" | "front" | "back";

/**
 * Compute a new `elements` array after a single-element z-order change.
 * The returned array is the *complete* elements array; callers should
 * commit it via `updateSlide({ ...slide, elements: result })`.
 *
 * If `targetId` is not found among `elements`, the array is returned
 * unchanged.
 */
export function adjustZOrder(
  elements: SlideElement[],
  targetId: string,
  dir: ZDirection,
): SlideElement[] {
  const sorted = [...elements].sort((a, b) => a.z_index - b.z_index);
  const i = sorted.findIndex((e) => e.id === targetId);
  if (i === -1) return elements;
  if (dir === "forward" && i < sorted.length - 1) {
    [sorted[i].z_index, sorted[i + 1].z_index] = [sorted[i + 1].z_index, sorted[i].z_index];
  } else if (dir === "backward" && i > 0) {
    [sorted[i].z_index, sorted[i - 1].z_index] = [sorted[i - 1].z_index, sorted[i].z_index];
  } else if (dir === "front") {
    sorted[i].z_index = Math.max(...sorted.map((e) => e.z_index)) + 1;
  } else if (dir === "back") {
    sorted[i].z_index = Math.min(...sorted.map((e) => e.z_index)) - 1;
  }
  return sorted as SlideElement[];
}

// ─── Group ops ─────────────────────────────────────────────────────────────

/**
 * Returns the id for a new group (use stableId directly). The grouping
 * operation simply stamps `groupId` on every selected element; callers
 * find siblings via `getGroupMembers(elements, groupId)`.
 */
export function collectGroupMembers(elements: SlideElement[], groupId: string): string[] {
  return elements.filter((e) => e.groupId === groupId).map((e) => e.id);
}

// ─── Theme master synthesis (P2.4) ─────────────────────────────────────────

/**
 * Build a sensible default `SlideTheme` for a presentation that has none.
 * Used by `migratePresentation` so v0/v1 decks restored from disk inherit
 * a cascade even when their authors never touched the theme tab.
 */
export function synthesizeDefaultTheme(): SlideTheme {
  return {
    id: stableId(),
    name: "Default",
    defaultFontFamily: "Arial",
    defaultFontSize: 32,
    titleStyle: { font_family: "Arial", font_size: 60, color: "#ffffff", bold: true },
    bodyStyle: { font_family: "Arial", font_size: 32, color: "#ffffff" },
    textColor: "#ffffff",
    accentColor: "#f59e0b",
    background: { type: "color", value: "#1a1a2e" },
    // P4.3 — sensible built-in paragraph styles for the inline editor's
    // dropdown. Slide authors can override these in the theme tab; decks
    // saved before P4.3 get these defaults via `migratePresentation`.
    paragraphStyles: {
      Body: { font_size: 32, color: "#ffffff" },
      Quote: { font_family: "Georgia", font_size: 28, italic: true, color: "#e2e8f0", indent: "1.2em" },
      Header: { font_size: 48, bold: true, color: "#ffffff" },
    },
  };
}

// ─── Migration ────────────────────────────────────────────────────────────────

/**
 * Convert a legacy (pre-v2) `CustomPresentation` into the current shape.
 *
 * Upgrades performed:
 *
 *   v0 → v1  Legacy `header`/`body` zones (if any) become individual
 *            `TextElement`s inside `elements[]`.
 *   v1 → v2  The flat `backgroundColor`/`backgroundImage`/`backgroundVideo`/
 *            `backgroundVideoLoop`/`backgroundVideoMuted` fields are folded
 *            into the single `background: SlideBackground` union (priority:
 *            video > image > colour, matching the legacy renderer's
 *            behaviour).
 *            Every `TextElement.content` carrying a string (HTML) is
 *            migrated to ProseMirror JSON via `generateJSON`.
 *            The presentation gets a synthesized default `SlideTheme` if
 *            none exists, so the P2.4 cascade has a base to inherit from.
 *
 * Idempotent — presentations already at `version >= 2` are returned unchanged.
 */
export function migratePresentation(p: CustomPresentation): CustomPresentation {
  if (p.version && p.version >= 2) return p;

  const theme = p.theme ?? synthesizeDefaultTheme();

  return {
    ...p,
    version: 2,
    theme,
    masters: p.masters,
    slides: p.slides.map((s) => migrateSlide(s)),
  };
}

/**
 * Migrate a single `CustomSlide` from the v0/v1 shape to the current v2
 * shape. Exposed as a separate function so the slide editor can re-migrate
 * a single slide (e.g. an imported template) without touching the rest
 * of the presentation.
 */
export function migrateSlide(raw: any): CustomSlide {
  // ── background union ───────────────────────────────────────────────────
  let background: SlideBackground | undefined = raw?.background;
  if (!background) {
    background = buildBackgroundFromLegacy(raw);
  }

  // ── elements[] (v0 → v1) ────────────────────────────────────────────────
  let elements: SlideElement[] = Array.isArray(raw?.elements) ? (raw.elements as SlideElement[]) : [];
  if (elements.length === 0) {
    elements = buildElementsFromLegacyZones(raw);
  }

  // ── content string → JSON (v1 → v2) ──────────────────────────────────────
  elements = elements.map(migrateElementContent);

  return {
    id: raw.id,
    background,
    elements,
    notes: raw.notes,
    masterRef: raw.masterRef,
  };
}

function buildBackgroundFromLegacy(s: any): SlideBackground {
  const bgVideo = s?.backgroundVideo ?? s?.background_video;
  const bgImage = s?.backgroundImage ?? s?.background_image;
  const bgColor = s?.backgroundColor ?? s?.background_color ?? "#1a1a2e";
  const bgVideoLoop = s?.backgroundVideoLoop ?? s?.background_video_loop;
  const bgVideoMuted = s?.backgroundVideoMuted ?? s?.background_video_muted;

  if (bgVideo) {
    return { type: "video", value: bgVideo, loop: bgVideoLoop !== false, muted: bgVideoMuted !== false };
  }
  if (bgImage) {
    return { type: "image", value: bgImage, objectFit: "cover" };
  }
  return { type: "color", value: bgColor };
}

function buildElementsFromLegacyZones(s: any): SlideElement[] {
  const out: SlideElement[] = [];
  if (s?.headerEnabled !== false && s?.header) {
    out.push(zoneToTextElement(s.header, s.headerHeightPct ?? 35, 1));
  }
  if (s?.body) {
    out.push(zoneToTextElement(s.body, (s.headerHeightPct ?? 35) + 15, 2));
  }
  return out;
}

function migrateElementContent(el: SlideElement): SlideElement {
  // P3.5 — shape taxonomy: backfill `shape: "rect"` and copy the
  // legacy `color` into `fillColor` so old decks round-trip cleanly.
  if (el.kind === "shape") {
    const shapeEl = el as any;
    return {
      ...shapeEl,
      shape: shapeEl.shape ?? "rect",
      fillColor: shapeEl.fillColor ?? shapeEl.color,
    } as SlideElement;
  }
  if (el.kind !== "text") return el;
  const content = (el as any).content;
  if (typeof content !== "string") return el;
  return {
    ...el,
    content: migrateHtmlContentToJSON(content),
  } as SlideElement;
}

function zoneToTextElement(zone: SlideZone, yPct: number, zIndex: number) {
  return newTextElement({
    x: 10, y: yPct, w: 80, h: 35, z_index: zIndex,
    content: zone.text,
    font_size: zone.fontSize,
    font_family: zone.fontFamily,
    color: zone.color,
    bold: zone.bold, italic: zone.italic,
    align: zone.align,
  });
}