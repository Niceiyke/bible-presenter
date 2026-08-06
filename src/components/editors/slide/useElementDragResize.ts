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
 */

import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { SlideElement } from "../../../types";

interface DragOptions {
  canvasRef: RefObject<HTMLDivElement | null>;
  activeElementIds: string[];
  elements: SlideElement[];
  /** Update with `save = false` on intermediate frames. */
  onMoved: (id: string, updates: Partial<SlideElement>) => void;
  /** Single final call per drag with `save = true`. */
  onCommitted: (id: string, updates: Partial<SlideElement>) => void;
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

      // Determine which elements move (excluding locked).
      const baseIds = opts.activeElementIds.includes(id)
        ? opts.activeElementIds
        : [id];
      const startPositions = opts.elements
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
        for (const sp of startPositions) {
          const nx = sp.ix + dx;
          const ny = sp.iy + dy;
          finalPositions.set(sp.id, { x: nx, y: ny });
          opts.onMoved(sp.id, { x: nx, y: ny });
        }
      };

      const up = () => {
        controller.abort();
        controllerRef.current = null;
        for (const sp of startPositions) {
          const final = finalPositions.get(sp.id);
          if (final) opts.onCommitted(sp.id, { x: final.x, y: final.y });
        }
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
        opts.onCommitted(id, { x: lx, y: ly, w: lw, h: lh });
      };
      window.addEventListener("pointermove", move, { signal: controller.signal });
      window.addEventListener("pointerup", up, { signal: controller.signal });
    },
    [opts],
  );
}