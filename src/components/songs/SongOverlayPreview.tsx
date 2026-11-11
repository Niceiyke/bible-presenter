import React from "react";
import type { LowerThirdData, LowerThirdTemplate } from "../../types";
import { useSlideFit } from "../../hooks/useSlideFit";
import { LowerThirdOverlay } from "../shared/Renderers";
import { cn } from "../ui/cn";

/** Lower-third preview at the same reference scale as the output. The template
 *  is authored in pixels for the 1920×1080 canvas; rendering it unscaled in a
 *  small editor card produced huge, clipped lyrics. `useSlideFit` provides the
 *  scale for the measured 16:9 sub-rectangle. */
export function SongOverlayPreview({
  data,
  template,
  className,
}: {
  data: LowerThirdData;
  template: LowerThirdTemplate;
  className?: string;
}) {
  const [boxRef, fit] = useSlideFit();
  return (
    <div ref={boxRef} className={cn("absolute inset-0 flex items-center justify-center overflow-hidden", className)} aria-hidden>
      {fit.width > 0 && fit.height > 0 && (
        <div className="relative" style={{ width: fit.width, height: fit.height }}>
          <LowerThirdOverlay data={data} template={template} scale={fit.scale} />
        </div>
      )}
    </div>
  );
}
