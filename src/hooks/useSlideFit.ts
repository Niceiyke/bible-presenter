import { useCallback, useEffect, useRef, useState } from "react";
import { useReferenceHeight } from "./useReferenceHeight";

/** The slide/song design canvas is 16:9. Any preview box that isn't exactly
 *  that aspect distorts `%`-positioned elements and makes height-only font
 *  scaling overflow. `useSlideFit` measures the host box and returns the
 *  largest 16:9 sub-rectangle that fits inside it, plus the font scale that
 *  rectangle implies against the configured reference — so a preview always
 *  letterboxes the design (no clipped or overflowing text) no matter how
 *  wide/tall the card is. For a box that IS 16:9 this is identical to the
 *  old height-only `useBoxScale` policy; it only diverges on odd shapes.
 *
 * Returns `[ref, fit]` where `ref` is a callback ref. The measurement runs
 * whenever the tracked element (re)mounts — the host box may be rendered
 * conditionally (an empty cockpit preview card has no slide box yet, the
 * stage window mounts its slide box only when a custom slide is live), so a
 * one-shot mount-time effect over a `RefObject` would measure nothing and
 * never recover once the box appears. The callback ref fires on every mount
 * and unmount, so the fit is recomputed as soon as a box exists.
 *
 * Only one element is observed at a time: attaching a new node disconnects
 * the previous node's observer, and unmount (null) disconnects the current
 * one, so conditional boxes never leak observers. */
export const SLIDE_ASPECT = 16 / 9;

export interface SlideFit {
  width: number;
  height: number;
  scale: number;
}

const EMPTY: SlideFit = { width: 0, height: 0, scale: 0 };

export function useSlideFit(): [(node: HTMLDivElement | null) => void, SlideFit] {
  const referenceHeight = useReferenceHeight();
  const [fit, setFit] = useState<SlideFit>(EMPTY);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      // Replace the tracked element: disconnect the old observer first so a
      // stale one never fires on a node that left the layout.
      observerRef.current?.disconnect();
      observerRef.current = null;

      if (!node) {
        setFit(EMPTY);
        return;
      }
      const update = () => {
        const cw = node.clientWidth;
        const ch = node.clientHeight;
        if (cw <= 0 || ch <= 0) return;
        const width = Math.min(cw, ch * SLIDE_ASPECT);
        const height = width / SLIDE_ASPECT;
        setFit({ width, height, scale: height / referenceHeight });
      };
      update();
      const ro = new ResizeObserver(update);
      ro.observe(node);
      observerRef.current = ro;
    },
    [referenceHeight],
  );

  // On unmount, the final null callback already disconnects the observer;
  // this is a failsafe for hot-reload / strict-mode double-invoke.
  useEffect(() => {
    return () => observerRef.current?.disconnect();
  }, []);

  return [ref, fit];
}