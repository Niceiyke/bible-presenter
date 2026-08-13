import React, { useRef } from "react";
import type { SongSlideData } from "../../types";
import { useBoxScale } from "../../hooks/useBoxScale";
import { useReferenceHeight } from "../../hooks/useReferenceHeight";
import { SongSlideRenderer } from "../shared/Renderers";
import { cn } from "../ui/cn";

/**
 * Measured 16:9 song preview. Instead of a hardcoded spot scale (0.26, 0.28…)
 * — which only looks right if the preview box happens to be that many × 1080 —
 * the scale is derived from the box's actual rendered height via `useBoxScale`,
 * so the preview always matches the projected output proportions and every
 * preview surface (editor modal, Use Song panel, cards, cockpit) agrees with
 * one another, regardless of operator window size or Windows DPI scaling.
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
  const boxRef = useRef<HTMLDivElement>(null);
  const referenceHeight = useReferenceHeight();
  const scale = useBoxScale(boxRef, referenceHeight);

  return (
    <div
      ref={boxRef}
      className={cn(
        "rounded-lg overflow-hidden bg-slate-950",
        fill ? "absolute inset-0 w-full h-full" : "relative w-full aspect-video",
        className,
      )}
    >
      <div className="absolute inset-0" aria-hidden>
        <SongSlideRenderer
          data={data}
          scale={scale}
          showSectionLabel={showSectionLabel}
        />
      </div>
    </div>
  );
}