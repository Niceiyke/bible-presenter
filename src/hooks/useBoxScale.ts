import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Measure an element's on-screen height relative to a design-reference
 * height and return the ratio — the scale every rich renderer (slides,
 * songs) multiplies its authored pt sizes by, so a design authored at the
 * reference resolution projects proportionally at ANY rendered box size.
 *
 * Why this is "dynamic": `clientHeight` is measured in CSS px, so the
 * operator window's actual size is baked in automatically — a 1280×720
 * window at 150% DPI, a 1920×1080 window, a resized/collapsed side panel,
 * all reconcile to the same proportions as the projection window. Nothing
 * assumes a fixed canvas width or `100vh`.
 *
 * The default reference height is the 1080p design resolution, but it is a
 * parameter so it can track the actual output monitor (see the
 * `reference_output_height` setting).
 *
 * Listens to ResizeObserver (tighter than window resize) plus window resize
 * as a safety net for aspect-ratio-derived size changes.
 */
export function useBoxScale<T extends HTMLElement = HTMLElement>(
  ref: RefObject<T | null>,
  referenceHeight = 1080,
): number {
  const [scale, setScale] = useState(ref.current ? ref.current.clientHeight : 0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const h = el.clientHeight;
      if (h > 0) setScale(h / referenceHeight);
    };
    update();

    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [ref, referenceHeight]);

  return scale;
}