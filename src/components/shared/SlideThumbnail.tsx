/**
 * SlideThumbnail — canonical thumbnail for a single `CustomSlide`.
 *
 * The single source of truth used by the slide rail (`SlideListPanel`),
 * the slide-editor template/preview modals (`SlideEditorModals`), and the
 * Studio grid card (`StudioSlideCard`). Renders the actual
 * `CustomSlideRenderer` at the slot's dimensions using the renderer's own
 * `scale` prop (which scales font sizing relative to the thumbnail box), so
 * the rail shows real slide content — backgrounds, shapes, text, images.
 *
 * The 16:9 slide design is letterboxed inside the (possibly non-16:9) slot
 * via `useSlideFit`: the largest 16:9 sub-rectangle that fits inside the
 * card is what the renderer fills, and its height derives the font scale.
 * Slots that happen to be 16:9 behave exactly as before; odd-shaped slots
 * no longer stretch or overflow text.
 *
 * This intentionally does NOT use `html-to-image` / `toPng`: in the Tauri
 * webview those fail to serialize `asset://localhost` media and custom
 * `@font-face` sources (CORS/canvas taint), yielding black snapshots.
 * Rendering the live renderer is always correct and cheap enough for a
 * slide rail — each thumbnail is a few percent-sized nodes.
 */

import React, { useRef } from "react";
import { CustomSlideRenderer } from "./Renderers";
import type { CustomSlide, SlideTheme } from "../../types";
import { useSlideFit } from "../../hooks/useSlideFit";

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
  const { width: fitW, height: fitH, scale } = useSlideFit(boxRef);

  const ready = fitW > 0 && fitH > 0;

  return (
    <div
      ref={boxRef}
      className={className}
      style={{
        width,
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0f0f1f",
        overflow: "hidden",
        pointerEvents: "none",
      }}
      aria-hidden
    >
      {ready && (
        <div style={{ width: fitW, height: fitH }}>
          <CustomSlideRenderer slide={slide} scale={scale} appDataDir={appDataDir} theme={theme} />
        </div>
      )}
    </div>
  );
}