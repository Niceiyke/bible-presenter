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
 * - `migratePresentation`  — convert legacy header/body slides to elements[]
 *
 * Each helper returns a *delta* (an `updates` map or a fresh `elements`
 * array) rather than directly mutating state. Callers own the actual
 * `setPres` commit, so the helpers can be memoized independently.
 */

import type { CustomPresentation, SlideElement, SlideZone } from "../../../types";
import { newTextElement, stableId } from "../../../utils";

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

// ─── Migration ────────────────────────────────────────────────────────────────

/**
 * Convert a legacy (pre-`elements[]`) `CustomPresentation` into the
 * modern `elements[]` model. Slides with empty `elements` arrays have
 * their `header` and `body` zones converted into separate text
 * elements using `newTextElement` so the resulting shape stays
 * type-safe with the discriminated-union `SlideElement` contract.
 *
 * Idempotent — `presentation.version >= 1` is returned unchanged.
 */
export function migratePresentation(p: CustomPresentation): CustomPresentation {
  if (p.version && p.version >= 1) return p;
  return {
    ...p,
    version: 1,
    slides: p.slides.map((s) => {
      if (s.elements && s.elements.length > 0) return s;
      const elements: SlideElement[] = [];
      if (s.headerEnabled !== false && s.header) {
        elements.push(zoneToTextElement(s.header, s.headerHeightPct ?? 35, 1));
      }
      if (s.body) {
        elements.push(zoneToTextElement(s.body, (s.headerHeightPct ?? 35) + 15, 2));
      }
      return { ...s, elements };
    }),
  };
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