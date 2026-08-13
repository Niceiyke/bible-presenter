/**
 * StudioSlideCard — interactive slide tile for the Studio workspace grid.
 *
 * Composes the canonical `SlideThumbnail` (shared measuring/scaling) with
 * the Studio-only chrome: index badge, hover actions, and click-to-stage.
 */

import React from "react";
import { SlideThumbnail } from "./shared/SlideThumbnail";
import type { CustomSlide } from "../types";

interface StudioSlideCardProps {
  slide: CustomSlide;
  index: number;
  onStage?: () => void;
  onLive?: () => void;
  onAddToSchedule?: () => void;
  appDataDir?: string | null;
}

export function StudioSlideCard({
  slide,
  index,
  onStage,
  onLive,
  onAddToSchedule,
  appDataDir,
}: StudioSlideCardProps) {
  const showOverlay = onStage || onLive || onAddToSchedule;

  return (
    <div
      className="group relative aspect-video rounded overflow-hidden border border-slate-700 hover:border-amber-500/50 transition-all cursor-pointer"
      onClick={onStage}
    >
      <SlideThumbnail slide={slide} className="absolute inset-0 w-full h-full" appDataDir={appDataDir} />
      <div className="absolute bottom-0 left-0 px-1 py-0.5 bg-black/50">
        <span className="text-[7px] text-white/70">{index + 1}</span>
      </div>
      {showOverlay && (
        <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-all flex flex-col items-center justify-center gap-1 p-1">
          {onStage && (
            <button
              onClick={(e) => { e.stopPropagation(); onStage(); }}
              className="w-full bg-slate-600 hover:bg-slate-500 text-white text-[9px] font-bold py-1 rounded"
            >
              STAGE
            </button>
          )}
          {onLive && (
            <button
              onClick={(e) => { e.stopPropagation(); onLive(); }}
              className="w-full bg-amber-500 hover:bg-amber-400 text-black text-[9px] font-bold py-1 rounded"
            >
              DISPLAY
            </button>
          )}
          {onAddToSchedule && (
            <button
              onClick={(e) => { e.stopPropagation(); onAddToSchedule(); }}
              className="w-full bg-purple-600/40 hover:bg-purple-600 text-purple-300 text-[9px] font-bold py-1 rounded"
            >
              + SERVICE
            </button>
          )}
        </div>
      )}
    </div>
  );
}