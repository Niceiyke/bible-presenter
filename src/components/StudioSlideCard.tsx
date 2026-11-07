/**
 * StudioSlideCard — interactive slide tile for the Studio workspace grid.
 *
 * Composes the canonical `SlideThumbnail` (shared measuring/scaling) with
 * the Studio-only chrome: index badge, hover actions, and click-to-stage.
 */

import React from "react";
import { CalendarPlus, Radio, Send } from "lucide-react";
import { SlideThumbnail } from "./shared/SlideThumbnail";
import type { CustomSlide, SlideTheme } from "../types";

interface StudioSlideCardProps {
  slide: CustomSlide;
  index: number;
  onStage?: () => void;
  onLive?: () => void;
  onAddToSchedule?: () => void;
  appDataDir?: string | null;
  theme?: SlideTheme;
}

export function StudioSlideCard({
  slide,
  index,
  onStage,
  onLive,
  onAddToSchedule,
  appDataDir,
  theme,
}: StudioSlideCardProps) {
  const showOverlay = onStage || onLive || onAddToSchedule;

  return (
    <div
      className="group relative aspect-video cursor-pointer overflow-hidden rounded-lg border border-console-border bg-black shadow-sm transition-all hover:border-state-stage/60 hover:shadow-lg hover:shadow-black/30"
      onClick={onStage}
    >
      <SlideThumbnail slide={slide} theme={theme} className="absolute inset-0 w-full h-full" appDataDir={appDataDir} />
      <div className="absolute bottom-1.5 left-1.5 flex h-5 min-w-5 items-center justify-center rounded-md border border-white/10 bg-black/70 px-1.5 backdrop-blur-sm">
        <span className="text-[8px] font-black text-white/80">{index + 1}</span>
      </div>
      {showOverlay && (
        <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/75 p-2 opacity-0 backdrop-blur-[2px] transition-all group-hover:opacity-100 group-focus-within:opacity-100">
          {onStage && (
            <button
              onClick={(e) => { e.stopPropagation(); onStage(); }}
              className="flex h-8 flex-1 items-center justify-center gap-1 rounded-md bg-state-stage text-[9px] font-black text-slate-950 transition-colors hover:bg-state-stage/90"
              title="Stage slide"
            >
              <Send size={10} /> STAGE
            </button>
          )}
          {onLive && (
            <button
              onClick={(e) => { e.stopPropagation(); onLive(); }}
              className="flex h-8 flex-1 items-center justify-center gap-1 rounded-md bg-state-live text-[9px] font-black text-white transition-colors hover:bg-state-live/90"
              title="Send slide live"
            >
              <Radio size={10} /> LIVE
            </button>
          )}
          {onAddToSchedule && (
            <button
              onClick={(e) => { e.stopPropagation(); onAddToSchedule(); }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-tool-design/20 text-tool-design transition-colors hover:bg-tool-design hover:text-white"
              title="Add slide to service plan"
              aria-label="Add slide to service plan"
            >
              <CalendarPlus size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
