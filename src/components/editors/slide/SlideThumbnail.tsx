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

import React from "react";
import { CustomSlideRenderer } from "../../shared/Renderers";
import type { CustomSlide, SlideTheme } from "../../../types";

interface SlideThumbnailProps {
  slide: CustomSlide;
  appDataDir?: string | null;
  theme?: SlideTheme;
  className?: string;
  alt?: string;
  width: number;
  height: number;
}

export function SlideThumbnail({
  slide,
  appDataDir = null,
  theme,
  className,
  width,
  height,
}: SlideThumbnailProps) {
  // The renderer authors font sizes against a 1080p reference (see
  // `useCanvasScale`), so the thumbnail's scale is its height ratio —
  // geometry is percentage-based so it already fills the box.
  const scale = height / 1080;

  return (
    <div
      className={className}
      style={{ width, height, background: "#0f0f1f", overflow: "hidden", pointerEvents: "none" }}
      aria-hidden
    >
      <CustomSlideRenderer slide={slide} scale={scale} appDataDir={appDataDir} theme={theme} />
    </div>
  );
}
