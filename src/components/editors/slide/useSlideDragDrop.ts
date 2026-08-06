/**
 * `useSlideDragDrop`
 *
 * P1.4 — Replaces the HTML5 drag/drop API the slide-list panel used
 * previously (which required a `draggedRef + setTimeout(…, 50)` kludge
 * to suppress a spurious `onClick` after a drop). Pointer-based, so
 * the same event system as the canvas drag/resize hooks is used
 * throughout the editor.
 *
 * State the host owns: `dragSlideIdx` and `dragOverSlideIdx` are
 * surfaced via callbacks (callback firing on enter/leave) so the host
 * can render drop indicators if desired.
 *
 * Returned handlers are wired to each slide thumbnail button:
 *
 *   onPointerDownSlide(idx, ev)   — start a potential drag
 *   onPointerMoveSlide(idx, ev)   — track whether we crossed the drag
 *                                   threshold (5px); if so, switch to
 *                                   "dragging" mode and start emitting
 *                                   `onDragOver`
 *   onPointerUpSlide(idx, ev)     — if dragging, finalize the move
 *                                   (call `onMove(from, to)`); if not
 *                                   dragging, do nothing (the click
 *                                   handler still runs naturally)
 */

import { useCallback, useRef } from "react";

const DRAG_THRESHOLD_PX = 5;

interface UseSlideDragDropOptions {
  onMove: (from: number, to: number) => void;
  onDragStateChange?: (dragging: { from: number; over: number | null } | null) => void;
}

export function useSlideDragDrop({ onMove, onDragStateChange }: UseSlideDragDropOptions) {
  // In-flight drag state held in refs so we don't cause re-renders on
  // every mousemove. Mirrors the canvas drag/resize hook's pattern.
  const dragFromRef = useRef<number | null>(null);
  const dragToRef = useRef<number | null>(null);
  const startXRef = useRef<number>(0);
  const startYRef = useRef<number>(0);
  const draggingRef = useRef<boolean>(false);

  const onPointerDownSlide = useCallback((idx: number, ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    dragFromRef.current = idx;
    startXRef.current = ev.clientX;
    startYRef.current = ev.clientY;
    draggingRef.current = false;
  }, []);

  const onPointerEnterSlide = useCallback((idx: number) => {
    if (!draggingRef.current) return;
    if (dragToRef.current !== idx) {
      dragToRef.current = idx;
      onDragStateChange?.({ from: dragFromRef.current ?? -1, over: idx });
    }
  }, [onDragStateChange]);

  const onPointerMoveSlide = useCallback(
    (idx: number, ev: React.PointerEvent) => {
      if (dragFromRef.current === null || draggingRef.current) return;
      const dx = Math.abs(ev.clientX - startXRef.current);
      const dy = Math.abs(ev.clientY - startYRef.current);
      if (dx >= DRAG_THRESHOLD_PX || dy >= DRAG_THRESHOLD_PX) {
        draggingRef.current = true;
        dragToRef.current = idx;
        onDragStateChange?.({ from: dragFromRef.current, over: idx });
      }
    },
    [onDragStateChange],
  );

  const onPointerUpSlide = useCallback(
    (idx: number, ev: React.PointerEvent) => {
      const wasDragging = draggingRef.current;
      const from = dragFromRef.current;
      const to = dragToRef.current === null ? idx : dragToRef.current;

      // Reset for next drag.
      dragFromRef.current = null;
      dragToRef.current = null;
      draggingRef.current = false;
      onDragStateChange?.(null);

      if (!wasDragging || from === null || from === to) return;
      onMove(from, to);

      // Suppress the click that follows on pointerup while dragging.
      // The pointerup is followed by a synthetic `click` event (the
      // browser does this when a button's pointer releases while over
      // the same element). We capture + cancel it by stopping further
      // propagation. If the caller's click handler is already bound, we
      // rely on the caller guarding via `draggingRefPost` semantics —
      // see SlideListPanel's click handler for the canonical pattern.
      ev.preventDefault();
      ev.stopPropagation();
    },
    [onMove, onDragStateChange],
  );

  return {
    onPointerDownSlide,
    onPointerMoveSlide,
    onPointerEnterSlide,
    onPointerUpSlide,
    /** Live-ref snapshot for callers needing synchronous state on click. */
    isDragging: () => draggingRef.current,
  };
}