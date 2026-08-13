import { useLayoutEffect, useState, type RefObject } from "react";
import { useReferenceHeight } from "./useReferenceHeight";

/** The slide/song design canvas is 16:9. Any preview box that isn't exactly
 *  that aspect distorts `%`-positioned elements and makes height-only font
 *  scaling overflow. `useSlideFit` measures the host box and returns the
 *  largest 16:9 sub-rectangle that fits inside it, plus the font scale that
 *  rectangle implies against the configured reference — so a preview always
 *  letterboxes the design (no clipped or overflowing text) no matter how
 *  wide/tall the card is. For a box that IS 16:9 this is identical to the
 *  old height-only `useBoxScale` policy; it only diverges on odd shapes. */
export const SLIDE_ASPECT = 16 / 9;

export interface SlideFit {
  width: number;
  height: number;
  scale: number;
}

export function useSlideFit(ref: RefObject<HTMLDivElement | null>): SlideFit {
  const referenceHeight = useReferenceHeight();
  const [fit, setFit] = useState<SlideFit>({ width: 0, height: 0, scale: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (cw <= 0 || ch <= 0) return;
      const width = Math.min(cw, ch * SLIDE_ASPECT);
      const height = width / SLIDE_ASPECT;
      setFit({ width, height, scale: height / referenceHeight });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [referenceHeight]);

  return fit;
}
