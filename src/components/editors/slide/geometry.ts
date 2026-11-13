/** Slide coordinates are percentages, so every element must stay inside 0–100. */
export interface ElementBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_ELEMENT_SIZE = 5;
const CANVAS_SIZE = 100;

/** Keep an element's complete box inside the 16:9 slide canvas. */
export function clampElementGeometry<T extends ElementBounds>(element: T): T {
  const w = Math.min(CANVAS_SIZE, Math.max(MIN_ELEMENT_SIZE, element.w));
  const h = Math.min(CANVAS_SIZE, Math.max(MIN_ELEMENT_SIZE, element.h));
  return {
    ...element,
    x: Math.min(CANVAS_SIZE - w, Math.max(0, element.x)),
    y: Math.min(CANVAS_SIZE - h, Math.max(0, element.y)),
    w,
    h,
  };
}

/**
 * Clamp a shared drag delta for a rigid selection. The delta is limited by the
 * member closest to each canvas edge, so a multi-select group cannot force any
 * element outside the slide.
 */
export function clampGroupDelta(
  elements: ElementBounds[],
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  if (elements.length === 0) return { dx, dy };

  let minDx = Number.NEGATIVE_INFINITY;
  let maxDx = Number.POSITIVE_INFINITY;
  let minDy = Number.NEGATIVE_INFINITY;
  let maxDy = Number.POSITIVE_INFINITY;

  for (const element of elements) {
    const box = clampElementGeometry(element);
    minDx = Math.max(minDx, -box.x);
    maxDx = Math.min(maxDx, CANVAS_SIZE - box.x - box.w);
    minDy = Math.max(minDy, -box.y);
    maxDy = Math.min(maxDy, CANVAS_SIZE - box.y - box.h);
  }

  const clampDelta = (value: number, min: number, max: number) => {
    const next = Math.max(min, Math.min(max, value));
    return next === 0 ? 0 : next;
  };

  return {
    dx: clampDelta(dx, minDx, maxDx),
    dy: clampDelta(dy, minDy, maxDy),
  };
}
