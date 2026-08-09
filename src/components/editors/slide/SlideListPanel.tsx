/**
 * SlideListPanel — the left-hand slide thumbnail rail + add-slide buttons
 * (P1.4). Reordering uses the Pointer-based `useSlideDragDrop` hook.
 */

import React, { useRef } from "react";
import { GripVertical, Library } from "lucide-react";
import { SlideThumbnail } from "./SlideThumbnail";
import type { CustomSlide, SlideTheme } from "../../../types";

export interface SlideListPanelProps {
  slides: CustomSlide[];
  activeSlideIdx: number;
  dragSlideIdx: number | null;
  dragOverSlideIdx: number | null;
  onFocusChange: (focused: boolean) => void;
  onPointerDownSlide: (idx: number, ev: React.PointerEvent) => void;
  onPointerMoveSlide: (idx: number, ev: React.PointerEvent) => void;
  onPointerEnterSlide: (idx: number) => void;
  onPointerUpSlide: (idx: number, ev: React.PointerEvent) => void;
  onSelect: (idx: number) => void;
  onAddSlide: (type: "title" | "default" | "blank") => void;
  onOpenTemplates: () => void;
  appDataDir: string | null;
  theme?: SlideTheme;
}

export function SlideListPanel({
  slides,
  activeSlideIdx,
  dragSlideIdx,
  dragOverSlideIdx,
  onFocusChange,
  onPointerDownSlide,
  onPointerMoveSlide,
  onPointerEnterSlide,
  onPointerUpSlide,
  onSelect,
  onAddSlide,
  onOpenTemplates,
  appDataDir,
  theme,
}: SlideListPanelProps) {
  const slidePanelRef = useRef<HTMLDivElement>(null);

  return (
    <aside className="w-48 border-r border-white/[0.06] bg-slate-900/70 backdrop-blur-xl flex flex-col overflow-hidden shrink-0">
      <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between shrink-0">
        <span className="text-[8px] font-black uppercase tracking-widest text-slate-600">Slides</span>
        <span className="text-[8px] text-slate-700">{slides.length}</span>
      </div>

      <div
        ref={slidePanelRef}
        tabIndex={0}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-2 custom-scrollbar outline-none"
      >
        {slides.map((s, i) => (
          <button
            key={s.id}
            onPointerDown={(e) => onPointerDownSlide(i, e)}
            onPointerMove={(e) => onPointerMoveSlide(i, e)}
            onPointerEnter={() => onPointerEnterSlide(i)}
            onPointerUp={(e) => onPointerUpSlide(i, e)}
            onClick={() => onSelect(i)}
            className={`relative aspect-video rounded-xl overflow-hidden border-2 transition-all shrink-0 group ${
              i === activeSlideIdx
                ? "border-indigo-500 shadow-lg shadow-indigo-500/20"
                : dragOverSlideIdx === i
                  ? "border-purple-500 border-dashed shadow-lg shadow-purple-500/20"
                  : dragSlideIdx === i
                    ? "border-white/20 opacity-50"
                    : "border-white/[0.06] hover:border-white/20"
            } ${dragSlideIdx !== null ? "cursor-grabbing" : "cursor-grab"}`}
          >
            <SlideThumbnail slide={s} className="absolute inset-0 w-full h-full" appDataDir={appDataDir} theme={theme} alt={`Slide ${i + 1}`} />
            <span className={`absolute top-1.5 left-1.5 w-5 h-5 rounded flex items-center justify-center text-[8px] font-black ${
              i === activeSlideIdx ? "bg-indigo-500 text-white" : "bg-black/60 text-white/50"
            }`}>
              {i + 1}
            </span>
            <div className="absolute bottom-1 right-1 text-white/20 group-hover:text-white/40 transition-colors">
              <GripVertical size={10} />
            </div>
            {dragOverSlideIdx === i && dragSlideIdx !== i && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-400" />
            )}
          </button>
        ))}
      </div>

      <div className="border-t border-white/[0.06] p-2 flex gap-1 shrink-0">
        {(["Title", "Body", "Blank"] as const).map(t => (
          <button key={t}
            onClick={() => onAddSlide(t.toLowerCase() as "title" | "default" | "blank")}
            className="flex-1 py-1.5 bg-white/6 hover:bg-white/12 text-slate-500 hover:text-slate-300 text-[8px] font-bold rounded-lg transition-all"
          >
            +{t[0]}
          </button>
        ))}
        <button onClick={onOpenTemplates}
          className="flex-1 py-1.5 bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 hover:text-purple-300 text-[8px] font-bold rounded-lg transition-all border border-purple-500/20"
          title="Insert from Templates"
        >
          <Library size={10} className="inline mr-0.5" />Tpl
        </button>
      </div>
    </aside>
  );
}