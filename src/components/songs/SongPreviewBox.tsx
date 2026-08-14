import React from "react";
import type { SongSlideData } from "../../types";
import { useSlideFit } from "../../hooks/useSlideFit";
import { SongSlideRenderer } from "../shared/Renderers";
import { cn } from "../ui/cn";

/**
 * Measured 16:9 song preview. Instead of a hardcoded spot scale (0.26, 0.28…)
 * — which only looks right if the preview box happens to be that many × 1080 —
 * the 16:9 design is letterboxed inside the host box via `useSlideFit`: the
 * largest 16:9 sub-rectangle that fits in the card drives the font scale, so
 * the preview always matches the projected output proportions and never
 * overflows, regardless of operator window size or Windows DPI scaling.
 */
export function SongPreviewBox({
  data,
  showSectionLabel = false,
  fill = false,
  className,
}: {
  data: SongSlideData;
  showSectionLabel?: boolean;
  /** Fill an existing 16:9 parent box (`absolute inset-0`) instead of owning
   *  its own `aspect-video` box. */
  fill?: boolean;
  className?: string;
}) {
  const [boxRef, fit] = useSlideFit();
  const fitReady = fit.width > 0 && fit.height > 0;

  return (
    <div
      ref={boxRef}
      className={cn(
        "rounded-lg overflow-hidden bg-slate-950 flex items-center justify-center",
        fill ? "absolute inset-0 w-full h-full" : "relative w-full aspect-video",
        className,
      )}
    >
      {fitReady && (
        <div style={{ width: fit.width, height: fit.height }} aria-hidden>
          <SongSlideRenderer
            data={data}
            scale={fit.scale}
            showSectionLabel={showSectionLabel}
          />
        </div>
      )}
    </div>
  );
}