/**
 * `useCanvasScale`
 *
 * Returns the canvas's `clientHeight / 1080` so slide elements (whose
 * font sizes are authored against a 1080p reference) scale correctly
 * at any preview size — slide thumbnails, the editor canvas, and the
 * output window.
 *
 * Listens to `ResizeObserver` instead of the window `resize` event so
 * the canvas stays correct when only its container dimensions change
 * (e.g., side-panel collapse) — a tighter, less-noisy subscription
 * than the previous window-only listener, which had to be debounced
 * with a 120ms `setTimeout` for good measure.
 */

import { useEffect, useState, type RefObject } from "react";

const REFERENCE_HEIGHT = 1080;

export function useCanvasScale(canvasRef: RefObject<HTMLDivElement | null>): number {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    if (!canvasRef.current) return;
    const el = canvasRef.current;

    const update = () => setScale(el.clientHeight / REFERENCE_HEIGHT);
    update();

    const ro = new ResizeObserver(() => update());
    ro.observe(el);

    // Window resize still matters: when the *window* shrinks, the canvas
    // sometimes keeps the same `clientHeight` because its width is
    // constrained and its height is `aspect-ratio`-derived — so a window
    // resize can change canvas dimensions without firing the element
    // observer.
    window.addEventListener("resize", update);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [canvasRef]);

  return scale;
}