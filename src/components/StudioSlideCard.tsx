/**
 * StudioSlideCard — interactive slide tile for the Studio workspace grid.
 *
 * Composes the canonical `SlideThumbnail` (shared measuring/scaling) with
 * the Studio-only chrome: index badge, hover actions, and click-to-stage.
 */

import React from "react";
import { CalendarPlus, Radio, Send } from "lucide-react";
import { SlideThumbnail } from "./shared/SlideThumbnail";
import { setDisplayItemDragData } from "../utils/dragItem";
import type { CustomSlide, DisplayItem, SlideTheme } from "../types";

interface StudioSlideCardProps {
  slide: CustomSlide;
  index: number;
  onStage?: () => void;
  onLive?: () => void;
  onAddToSchedule?: () => void;
  /** Display item used when the slide is dragged into Up Next. */
  dragItem?: DisplayItem;
  appDataDir?: string | null;
  theme?: SlideTheme;
}

export function StudioSlideCard({
  slide,
  index,
  onStage,
  onLive,
  onAddToSchedule,
  dragItem,
  appDataDir,
  theme,
}: StudioSlideCardProps) {
  const showOverlay = onStage || onLive || onAddToSchedule;

  return (
    <div
      className="group overflow-hidden rounded-lg border border-console-border bg-black shadow-sm transition-all hover:border-state-stage/60 hover:shadow-lg hover:shadow-black/30"
    >
      <div
        className="relative aspect-video cursor-pointer"
        onClick={onStage}
        draggable={!!dragItem}
        title={dragItem ? "Drag to Up Next" : undefined}
        onDragStart={(event) => dragItem && setDisplayItemDragData(event, dragItem)}
      >
        <SlideThumbnail slide={slide} theme={theme} className="absolute inset-0 h-full w-full" appDataDir={appDataDir} />
        <div className="absolute bottom-1.5 left-1.5 flex h-5 min-w-5 items-center justify-center rounded-md border border-white/10 bg-black/70 px-1.5 backdrop-blur-sm">
          <span className="text-[8px] font-black text-white/80">{index + 1}</span>
        </div>
      </div>
      {showOverlay && (
        <div className="flex h-7 items-center gap-1 border-t border-console-border bg-console-surface px-1 py-1">
          {onStage && (
            <button
              onClick={(e) => { e.stopPropagation(); onStage(); }}
              className="flex h-5 flex-1 items-center justify-center gap-1 rounded bg-state-stage px-1.5 text-[7px] font-black text-slate-950 transition-colors hover:bg-state-stage/90"
              title="Stage slide"
            >
              <Send size={8} /> STAGE
            </button>
          )}
          {onLive && (
            <button
              onClick={(e) => { e.stopPropagation(); onLive(); }}
              className="flex h-5 flex-1 items-center justify-center gap-1 rounded bg-state-live px-1.5 text-[7px] font-black text-white transition-colors hover:bg-state-live/90"
              title="Send slide live"
            >
              <Radio size={8} /> LIVE
            </button>
          )}
          {onAddToSchedule && (
            <button
              onClick={(e) => { e.stopPropagation(); onAddToSchedule(); }}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-tool-design/20 text-tool-design transition-colors hover:bg-tool-design hover:text-white"
              title="Add slide to service plan"
              aria-label="Add slide to service plan"
            >
              <CalendarPlus size={9} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
