/**
 * SlideThumbnail — P4.6 slide-rail thumbnails.
 *
 * Renders the actual `CustomSlideRenderer` at the slot's dimensions using
 * the renderer's own `scale` prop (which scales font sizing relative to the
 * thumbnail box), so the rail shows real slide content — backgrounds,
 * shapes, text, images.
 *
 * This intentionally does NOT use `html-to-image` / `toPng`: in the Tauri
 * webview those fail to serialize `asset://localhost` media and custom
 * `@font-face` sources (CORS/canvas taint), yielding black snapshots.
 * Rendering the live renderer is always correct and cheap enough for a
 * slide rail — each thumbnail is a few percent-sized nodes.
 */

import React, { useLayoutEffect, useRef, useState } from "react";
import { CustomSlideRenderer } from "../../shared/Renderers";
import type { CustomSlide, SlideTheme } from "../../../types";

interface SlideThumbnailProps {
  slide: CustomSlide;
  appDataDir?: string | null;
  theme?: SlideTheme;
  className?: string;
  alt?: string;
  /** Optional explicit slot size. When omitted the thumbnail fills its
   *  parent (`w-full h-full` via `className`), so it always matches the
   *  actual slot — e.g. the rail button — instead of a fixed box. */
  width?: number;
  height?: number;
}

export function SlideThumbnail({
  slide,
  appDataDir = null,
  theme,
  className,
  width,
  height,
}: SlideThumbnailProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxH, setBoxH] = useState(0);

  // Measure the rendered slot height (ResizeObserver, so it stays correct
  // if the slot resizes) and scale against the 1080p reference — the same
  // policy `useCanvasScale` uses for the editor canvas, so thumbnails and
  // the main editor always agree on text proportions.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => setBoxH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scale = (boxH > 0 ? boxH : (height ?? 1080)) / 1080;

  return (
    <div
      ref={boxRef}
      className={className}
      style={{ width, height, background: "#0f0f1f", overflow: "hidden", pointerEvents: "none" }}
      aria-hidden
    >
      <CustomSlideRenderer slide={slide} scale={scale} appDataDir={appDataDir} theme={theme} />
    </div>
  );
}
