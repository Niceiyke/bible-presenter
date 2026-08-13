import { useEffect, useRef, useState } from "react";
import { LowerThirdOverlay } from "./shared/Renderers";
import { cn } from "./ui/cn";
import type { LowerThirdData, LowerThirdTemplate } from "../types";

const BG_CLASSES: Record<string, string> = {
  dark: "bg-slate-900",
  green: "bg-[#00b140]",
  checkered:
    "bg-[length:20px_20px] [background-image:linear-gradient(45deg,#333_25%,transparent_25%),linear-gradient(-45deg,#333_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#333_75%),linear-gradient(-45deg,transparent_75%,#333_75%)] [background-position:0_0,0_10px,10px_-10px,-10px_0px] bg-[#1e1e1e]",
};

/**
 * A WYSIWYG lower-third preview. Renders the overlay on a reference-size
 * 16:9 canvas (reference output height, default 1080) that is measured and
 * scaled to fit the component's box, so the preview always matches what the
 * output window shows.
 */
export function LowerThirdPreview({
  data,
  template,
  refHeight = 1080,
  background = "dark",
  className,
}: {
  data: LowerThirdData;
  template: LowerThirdTemplate;
  refHeight?: number;
  background?: "dark" | "green" | "checkered";
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  const refWidth = Math.max(1, Math.round((refHeight * 16) / 9));

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      setScale(Math.min(width / refWidth, height / refHeight));
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    window.addEventListener("resize", update);
    return () => {
      obs.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [refHeight, refWidth]);

  return (
    <div ref={boxRef} className={cn("relative overflow-hidden rounded-lg", BG_CLASSES[background], className)}>
      <div
        className="absolute"
        style={{
          width: refWidth,
          height: refHeight,
          left: "50%",
          top: "50%",
          transform: scale > 0 ? `translate(-50%, -50%) scale(${scale})` : undefined,
          transformOrigin: "top left",
        }}
      >
        <LowerThirdOverlay data={data} template={template} />
      </div>
      {scale > 0 && (
        <span className="absolute bottom-1 right-2 text-[9px] text-slate-600 font-mono pointer-events-none select-none">
          {Math.round(scale * 100)}%
        </span>
      )}
    </div>
  );
}