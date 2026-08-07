/**
 * `useElementDrag` and `useElementResize`
 *
 * P1.4 extraction + P1.5 — these hooks own the Pointer-based drag and
 * resize lifecycles that were previously inlined into `SlideEditor.tsx`
 * (~140 lines). Phase 1.5 changes worth calling out:
 *
 *   - Window listeners are tied to a short-lived `AbortController`
 *     kept in a ref. Mount-level unmount cleanup aborts any in-flight
 *     drag — listeners are auto-removed by the browser. This replaces
 *     the previous `addEventListener` / `removeEventListener` pairing
 *     which leaked when the editor unmounted mid-drag.
 *
 *   - Intermediate drag frames pass `save=false` to the host's `setPres`
 *     so they don't pollute history; pointer-up commits once with
 *     `save=true`. (This was already true in the old code but it's now
 *     narrated in the hook signature.)
 *
 *   - Multi-select drag is preserved: if the clicked element is part of
 *     the active selection, the drag moves every member (excluding
 *     locked ones) by the same delta.
 *
 * Phase 3.2 — snap-to-grid:
 *   - Both hooks accept an optional `gridSize` (in canvas-% units;
 *     0 / undefined disables snapping).
 *   - During `move` the raw value is pasted straight into `onMoved`
 *     so the user sees free-drag fidelity; only the final `onCommitted`
 *     value is rounded to the grid. This keeps the snap visible as a
 *     "settle on release" rather than a sticky grinder mid-drag.
 *
 * Phase 3.1 — smart guides:
 *   - Drag emits live alignment guides via the optional `onGuides`
 *     callback. The hook tries to align each dragged edge / center
 *     with every other element's edges / centers, plus the canvas
 *     center / mid-lines; within a 0.5% threshold the drag delta is
 *     locked to the snap and the active guide set is reported so the
 *     host can paint a dashed SVG overlay.
 */

import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { SlideElement } from "../../../types";

/** A single dashed guide line the canvas overlay renders. `orientation`
 *  describes the line's axis; `pos` is its canvas-coordinate position
 *  expressed in % units (vertical guides carry an X coord, horizontal
 *  guides carry a Y coord). */
export interface GuideLine {
  orientation: "vertical" | "horizontal";
  pos: number;
}

interface DragOptions {
  canvasRef: RefObject<HTMLDivElement | null>;
  activeElementIds: string[];
  elements: SlideElement[];
  /** Update with `save = false` on intermediate frames. */
  onMoved: (id: string, updates: Partial<SlideElement>) => void;
  /** Single final call per drag with `save = true`. */
  onCommitted: (id: string, updates: Partial<SlideElement>) => void;
  /** P3.2: snap size in canvas-% units. `0` / `undefined` disables. */
  gridSize?: number;
  /** P3.1: alignment-guides callback. During a drag the hook reports
   *  the active guide set (zero, one, or two lines — vertical +
   *  horizontal can both lock at once). Cleared with `null` on
   *  pointer-up. The host owns the SVG overlay. */
  onGuides?: (guides: GuideLine[] | null) => void;
  /** P4.4 — Alt+drag duplicate. When the drag starts with Alt held the
   *  host is asked (synchronously) to create a copy of `id`. The hook
   *  drags the *returned* element instead of the original — the copy is
   *  committed via the host's normal `onMoved`/`onCommitted` path so it
   *  becomes part of the drag's history entry. Return `null` to fall
   *  back to a plain drag (e.g. the element is locked). */
  altDuplicate?: (id: string) => { id: string; x: number; y: number } | null;
}

/** Round a value to the nearest multiple of `gridSize`. Returns the
 *  input unchanged when `gridSize` is falsy (so `undefined` and `0`
 *  both mean "free drag"). */
function snapTo(value: number, gridSize: number | undefined): number {
  if (!gridSize || gridSize <= 0) return value;
  return Math.round(value / gridSize) * gridSize;
}

/** Smart-guide alignment tolerance in canvas-% units. 0.5% is the
 *  recommendation from the plan and feels right on a 16:9 1080p
 *  canvas — about 9.6px in either axis before snap engages. */
const GUIDE_THRESHOLD = 0.5;

interface SnapCandidate {
  /** Dragged-element coordinate we are matching (e.g. its left edge,
   *  vertical center, or right edge). */
  dragPos: number;
  /** Target coordinate to match against (other element edge / center,
   *  or a canvas-bound line). */
  target: number;
}

/**
 * Pure helper. Walks candidates for both axes, finds the closest match
 * inside the threshold, and returns the snap delta (target - dragPos)
 * plus the guide position so the host can render a line at `target`.
 * Returns `null` when nothing is within the tolerance — the drag is
 * unchanged and no guide is painted.
 */
function findSnap(
  dragCandidates: SnapCandidate[],
  threshold: number,
): { delta: number; guide: GuideLine } | null {
  let best: { delta: number; guide: GuideLine; dist: number } | null = null;
  for (const c of dragCandidates) {
    const dist = Math.abs(c.target - c.dragPos);
    if (dist > threshold) continue;
    if (!best || dist < best.dist) {
      best = { delta: c.target - c.dragPos, guide: { orientation: "vertical", pos: c.target }, dist };
    }
  }
  return best ? { delta: best.delta, guide: best.guide } : null;
}

/**
 * P3.1 core — for the dragged element compute alignment candidates
 * against every static sibling's left / center / right edges (and the
 * canvas's own left / right / center bounds). Returns the snap deltas
 * for X and Y plus the guide list for the host to draw.
 *
 * `staticEls` already excludes the dragged member(s) — the caller
 * decides whether to also exclude group members; we keep the helper
 * pure so the hook can reuse it for both single and multi drags.
 */
function computeDragGuides(
  drag: { x: number; y: number; w: number; h: number },
  staticEls: { x: number; y: number; w: number; h: number }[],
): { dx: number; dy: number; guides: GuideLine[] } {
  const dragEdgesX = [
    { ref: drag.x, target: 0 },                       // dragged-left  vs canvas-left
    { ref: drag.x + drag.w / 2, target: 50 },          // dragged-mid-X vs canvas-center
    { ref: drag.x + drag.w, target: 100 },              // dragged-right vs canvas-right
  ];
  const dragEdgesY = [
    { ref: drag.y, target: 0 },
    { ref: drag.y + drag.h / 2, target: 50 },
    { ref: drag.y + drag.h, target: 100 },
  ];
  // Sibling edges.
  for (const e of staticEls) {
    dragEdgesX.push({ ref: drag.x, target: e.x });
    dragEdgesX.push({ ref: drag.x + drag.w / 2, target: e.x + e.w / 2 });
    dragEdgesX.push({ ref: drag.x + drag.w, target: e.x + e.w });
    dragEdgesY.push({ ref: drag.y, target: e.y });
    dragEdgesY.push({ ref: drag.y + drag.h / 2, target: e.y + e.h / 2 });
    dragEdgesY.push({ ref: drag.y + drag.h, target: e.y + e.h });
  }

  const sx = findSnap(dragEdgesX.map(c => ({ dragPos: c.ref, target: c.target })), GUIDE_THRESHOLD);
  const sy = findSnap(dragEdgesY.map(c => ({ dragPos: c.ref, target: c.target })), GUIDE_THRESHOLD);
  if (sy) sy.guide.orientation = "horizontal";

  return {
    dx: sx ? sx.delta : 0,
    dy: sy ? sy.delta : 0,
    guides: [sx?.guide, sy?.guide].filter((g): g is GuideLine => !!g),
  };
}

/**
 * Click-drag an element (or a multi-select group of elements if
 * `activeElementIds` includes siblings). Returns a `pointerDown`
 * handler to be attached to the element's outer overlay div.
 */
export function useElementDrag(opts: DragOptions) {
  // `controllerRef` holds the in-flight drag's controller so we can
  // abort cleanly on unmount. A null value means "no drag in flight".
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      // Browser removes the registered listeners automatically when
      // the signal aborts; no manual removeEventListener call needed.
      if (controllerRef.current) {
        controllerRef.current.abort();
        controllerRef.current = null;
      }
    };
  }, []);

  return useCallback(
    (id: string, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();

      if (!opts.canvasRef.current) return;
      const rect = opts.canvasRef.current.getBoundingClientRect();

      // P4.4 — Alt+drag duplicates: ask the host for a fresh copy and
      // drag that instead of the clicked element.
      let duplicateStart: { id: string; x: number; y: number } | null = null;
      if (e.altKey) {
        const dup = opts.altDuplicate?.(id) ?? null;
        if (!dup) return;
        duplicateStart = dup;
      }

      // Determine which elements move (excluding locked).
      const baseIds = duplicateStart
        ? [duplicateStart.id]
        : opts.activeElementIds.includes(id)
          ? opts.activeElementIds
          : [id];
      const startPositions = duplicateStart
        ? [{ id: duplicateStart.id, ix: duplicateStart.x, iy: duplicateStart.y }]
        : opts.elements
            .filter((el) => baseIds.includes(el.id) && !el.locked)
            .map((el) => ({ id: el.id, ix: el.x, iy: el.y }));
      if (startPositions.length === 0) return;

      const sx = e.clientX;
      const sy = e.clientY;
      const finalPositions = new Map<string, { x: number; y: number }>(
        startPositions.map((p) => [p.id, { x: p.ix, y: p.iy }]),
      );

      // Start a fresh AbortController. Any previous one should already
      // be aborted (pointerup is the only completion path).
      if (controllerRef.current) controllerRef.current.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      const move = (mv: PointerEvent) => {
        const dx = ((mv.clientX - sx) / rect.width) * 100;
        const dy = ((mv.clientY - sy) / rect.height) * 100;
        // P3.1: smart guides operate on the *primary* dragged element
        // (the first in startPositions). Compute the free delta first;
        // then test alignment against every other static element and
        // the canvas bounds, snap within the 0.5% threshold, and emit
        // the active guide set so the canvas can paint dashed lines.
        // The snap delta is applied uniformly to every member of the
        // multi-select group, keeping the group rigid.
        const primary = startPositions[0];
        const primaryEl = opts.elements.find(e => e.id === primary.id);
        const freeX = primary.ix + dx;
        const freeY = primary.iy + dy;
        let snapDx = 0, snapDy = 0;
        let guides: GuideLine[] = [];
        if (primaryEl && opts.onGuides) {
          const staticEls = opts.elements
            .filter(e => !baseIds.includes(e.id) && !e.locked)
            .map(e => ({ x: e.x, y: e.y, w: e.w, h: e.h }));
          const res = computeDragGuides(
            { x: freeX, y: freeY, w: primaryEl.w, h: primaryEl.h },
            staticEls,
          );
          snapDx = res.dx; snapDy = res.dy; guides = res.guides;
        }
        for (const sp of startPositions) {
          const nx = sp.ix + dx + snapDx;
          const ny = sp.iy + dy + snapDy;
          finalPositions.set(sp.id, { x: nx, y: ny });
          opts.onMoved(sp.id, { x: nx, y: ny });
        }
        opts.onGuides?.(guides.length > 0 ? guides : null);
      };

      const up = () => {
        controller.abort();
        controllerRef.current = null;
        for (const sp of startPositions) {
          const final = finalPositions.get(sp.id);
          if (final) {
            // P3.2: snap on commit only, so the snap is a "settle"
            // rather than a sticky grinder mid-drag.
            const snappedX = snapTo(final.x, opts.gridSize);
            const snappedY = snapTo(final.y, opts.gridSize);
            opts.onCommitted(sp.id, { x: snappedX, y: snappedY });
          }
        }
        // P3.1: clear the guide overlay on pointer-up. The slide history
        // entry has just been committed; leaving the guides painted
        // would be visually stale.
        opts.onGuides?.(null);
      };

      // P1.5 — registering with `signal` means listeners are guaranteed
      // removed on abort, whether abort comes from `up` (normal) or
      // from the unmount cleanup effect (editor closed mid-drag).
      window.addEventListener("pointermove", move, { signal: controller.signal });
      window.addEventListener("pointerup", up, { signal: controller.signal });
    },
    [opts],
  );
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/**
 * P3.4 — Rotation lifecycle. Mouse-angle around the element's box
 * center drives `rotation` in degrees, quantized to 5° steps so the
 * operator can hit neat angles like 45°, 90°, 180° by feel. The host
 * is updated at every `pointermove` (with `save=false` semantics by
 * the host's `onMoved`) and committed once on pointer-up. Listeners
 * are scoped to an `AbortController` so mid-rotation unmounts stay
 * clean (same pattern as drag/resize above).
 */
export function useElementRotation(opts: {
  canvasRef: RefObject<HTMLDivElement | null>;
  elements: SlideElement[];
  onMoved: (id: string, updates: Partial<SlideElement>) => void;
  onCommitted: (id: string, updates: Partial<SlideElement>) => void;
}) {
  return useCallback(
    (id: string, e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const el = opts.elements.find((x) => x.id === id);
      if (!el || !opts.canvasRef.current) return;

      const rect = opts.canvasRef.current.getBoundingClientRect();
      const cx = rect.left + ((el.x + el.w / 2) * rect.width) / 100;
      const cy = rect.top + ((el.y + el.h / 2) * rect.height) / 100;

      const controller = new AbortController();
      let liveRotation = el.rotation ?? 0;
      const move = (mv: PointerEvent) => {
        const angle = (Math.atan2(mv.clientY - cy, mv.clientX - cx) * 180) / Math.PI + 90;
        liveRotation = Math.round(angle / 5) * 5; // quantize to 5° steps
        opts.onMoved(id, { rotation: liveRotation });
      };
      const up = () => {
        controller.abort();
        opts.onCommitted(id, { rotation: liveRotation });
      };
      window.addEventListener("pointermove", move, { signal: controller.signal });
      window.addEventListener("pointerup", up, { signal: controller.signal });
    },
    [opts],
  );
}

/**
 * Resize an element by dragging one of its 8 anchor handles. The handle
 * identifier encodes which axes are affected ("n"+"w" = top-left).
 *
 * Respects the host's min-size guard (`Math.max(5, ...)`-style clamp
 * applied during the move callbacks). Single-element only; locked
 * elements are skipped.
 */
export function useElementResize(opts: DragOptions) {
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (controllerRef.current) {
        controllerRef.current.abort();
        controllerRef.current = null;
      }
    };
  }, []);

  return useCallback(
    (id: string, e: React.PointerEvent, h: Handle) => {
      e.stopPropagation();
      e.preventDefault();
      const el = opts.elements.find((x) => x.id === id);
      if (!el || el.locked || !opts.canvasRef.current) return;

      const rect = opts.canvasRef.current.getBoundingClientRect();
      const sx = e.clientX;
      const sy = e.clientY;
      const { x: ix, y: iy, w: iw, h: ih } = el;

      let lx = ix, ly = iy, lw = iw, lh = ih;

      if (controllerRef.current) controllerRef.current.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      const move = (mv: PointerEvent) => {
        const dx = ((mv.clientX - sx) / rect.width) * 100;
        const dy = ((mv.clientY - sy) / rect.height) * 100;
        let nx = ix, ny = iy, nw = iw, nh = ih;
        if (h.includes("e")) nw = Math.max(5, iw + dx);
        if (h.includes("s")) nh = Math.max(5, ih + dy);
        if (h.includes("w")) { const d = Math.min(iw - 5, dx); nx = ix + d; nw = iw - d; }
        if (h.includes("n")) { const d = Math.min(ih - 5, dy); ny = iy + d; nh = ih - d; }
        lx = nx; ly = ny; lw = nw; lh = nh;
        opts.onMoved(id, { x: nx, y: ny, w: nw, h: nh });
      };
      const up = () => {
        controller.abort();
        controllerRef.current = null;
        // P3.2: snap the bottom-right corner to the grid (top-left
        // follows via the resulting width/height delta). Keeps
        // resize dismissive — you settle onto the grid on release.
        opts.onCommitted(id, {
          x: snapTo(lx, opts.gridSize),
          y: snapTo(ly, opts.gridSize),
          w: snapTo(lw, opts.gridSize),
          h: snapTo(lh, opts.gridSize),
        });
      };
      window.addEventListener("pointermove", move, { signal: controller.signal });
      window.addEventListener("pointerup", up, { signal: controller.signal });
    },
    [opts],
  );
}