/**
 * SlideListPanel — the left-hand slide thumbnail rail + Add-slide menu
 * (SLIDE_EDITOR_MODERNIZATION_PLAN §5.3). Reordering uses the Pointer-based
 * `useSlideDragDrop` hook; the active slide gets an "Editing" label plus
 * visible duplicate / move-up / move-down / delete actions. Each thumbnail is
 * a `role="button"` div so the nested action buttons stay valid HTML.
 */

import React, { useRef } from "react";
import {
  Plus, Library, Type, Heading1, Quote, Image as ImageIcon, Megaphone, Square, BookOpen,
  ChevronUp, ChevronDown, Copy, Trash2, GripVertical,
} from "lucide-react";
import { SlideThumbnail } from "./SlideThumbnail";
import { EditorMenu } from "./components";
import type { AddSlideKind } from "./useSlideEditor";
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
  onAddSlide: (type: AddSlideKind) => void;
  onOpenTemplates: () => void;
  /** P3: active-slide context actions. */
  onDuplicateSlide: () => void;
  onDeleteSlide: () => void;
  onMoveSlide: (dir: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canDeleteSlide: boolean;
  appDataDir: string | null;
  theme?: SlideTheme;
}

const ADD_MENU_ITEMS: { value: AddSlideKind | "template"; label: React.ReactNode }[] = [
  { value: "title", label: <span className="flex items-center gap-2"><Heading1 size={13} /> Title</span> },
  { value: "default", label: <span className="flex items-center gap-2"><Type size={13} /> Title and content</span> },
  { value: "quote", label: <span className="flex items-center gap-2"><Quote size={13} /> Quote</span> },
  { value: "imageCaption", label: <span className="flex items-center gap-2"><ImageIcon size={13} /> Image with caption</span> },
  { value: "announcement", label: <span className="flex items-center gap-2"><Megaphone size={13} /> Announcement</span> },
  { value: "scripture", label: <span className="flex items-center gap-2"><BookOpen size={13} /> Scripture</span> },
  { value: "blank", label: <span className="flex items-center gap-2"><Square size={13} /> Blank</span> },
  { value: "template", label: <span className="flex items-center gap-2"><Library size={13} /> From template…</span> },
];

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
  onDuplicateSlide,
  onDeleteSlide,
  onMoveSlide,
  canMoveUp,
  canMoveDown,
  canDeleteSlide,
  appDataDir,
  theme,
}: SlideListPanelProps) {
  const slidePanelRef = useRef<HTMLDivElement>(null);

  return (
    <aside className="w-48 border-r border-console-border bg-console-surface flex flex-col overflow-hidden shrink-0">
      <div className="px-3 py-2 border-b border-console-border flex items-center justify-between shrink-0">
        <span className="op-control-label text-console-text-subtle">Slides</span>
        <span className="text-[10px] font-bold text-console-text-subtle">{slides.length}</span>
      </div>

      <div
        ref={slidePanelRef}
        tabIndex={0}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-2 custom-scrollbar outline-none"
      >
        {slides.map((s, i) => {
          const isActive = i === activeSlideIdx;
          return (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              aria-label={`Slide ${i + 1}${isActive ? ", editing" : ""}`}
              aria-pressed={isActive}
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(i);
                }
              }}
              onPointerDown={(e) => onPointerDownSlide(i, e)}
              onPointerMove={(e) => onPointerMoveSlide(i, e)}
              onPointerEnter={() => onPointerEnterSlide(i)}
              onPointerUp={(e) => onPointerUpSlide(i, e)}
              onClick={() => onSelect(i)}
              className={`relative aspect-video rounded-xl overflow-hidden border-2 transition-all shrink-0 group cursor-grab focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
                isActive
                  ? "border-tool-design shadow-lg shadow-tool-design/20"
                  : dragOverSlideIdx === i
                    ? "border-tool-design border-dashed shadow-lg shadow-tool-design/20"
                    : dragSlideIdx === i
                      ? "border-console-border-strong opacity-50"
                      : "border-console-border hover:border-console-border-strong"
              } ${dragSlideIdx !== null ? "cursor-grabbing" : ""}`}
            >
              <SlideThumbnail slide={s} className="absolute inset-0 w-full h-full" appDataDir={appDataDir} theme={theme} alt={`Slide ${i + 1}`} />
              <span className={`absolute top-1.5 left-1.5 w-5 h-5 rounded flex items-center justify-center text-[9px] font-black ${
                isActive ? "bg-tool-design text-console-canvas" : "bg-black/60 text-console-text-subtle"
              }`}>
                {i + 1}
              </span>
              {isActive && (
                <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 bg-tool-design text-console-canvas text-[7px] font-black uppercase rounded">
                  Editing
                </span>
              )}
              {isActive && (
                <div
                  className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex items-center gap-0.5"
                  onPointerDown={e => e.stopPropagation()}
                  onClick={e => e.stopPropagation()}
                >
                  <button onClick={() => onMoveSlide(-1)} disabled={!canMoveUp} aria-label="Move slide up" title="Move slide up (Alt+↑)" className="w-6 h-6 rounded-md bg-console-surface-strong hover:bg-console-surface-raised text-console-text-muted hover:text-console-text flex items-center justify-center disabled:opacity-20 transition-all border border-console-border"><ChevronUp size={12} /></button>
                  <button onClick={onDuplicateSlide} aria-label="Duplicate slide" title="Duplicate slide" className="w-6 h-6 rounded-md bg-console-surface-strong hover:bg-console-surface-raised text-console-text-muted hover:text-console-text flex items-center justify-center transition-all border border-console-border"><Copy size={11} /></button>
                  <button onClick={() => onMoveSlide(1)} disabled={!canMoveDown} aria-label="Move slide down" title="Move slide down (Alt+↓)" className="w-6 h-6 rounded-md bg-console-surface-strong hover:bg-console-surface-raised text-console-text-muted hover:text-console-text flex items-center justify-center disabled:opacity-20 transition-all border border-console-border"><ChevronDown size={12} /></button>
                  <button onClick={onDeleteSlide} disabled={!canDeleteSlide} aria-label="Delete slide" title="Delete slide" className="w-6 h-6 rounded-md bg-console-surface-strong hover:bg-state-live-soft text-console-text-muted hover:text-state-live flex items-center justify-center disabled:opacity-20 transition-all border border-console-border"><Trash2 size={11} /></button>
                </div>
              )}
              <div className="absolute bottom-1 right-1 text-console-text-subtle group-hover:text-console-text-muted transition-colors pointer-events-none">
                <GripVertical size={10} />
              </div>
              {dragOverSlideIdx === i && dragSlideIdx !== i && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-tool-design" />
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-console-border p-2 flex flex-col gap-1.5 shrink-0">
        <EditorMenu
          label="Add slide"
          trigger={<span className="flex items-center gap-1.5"><Plus size={13} /> Add slide</span>}
          items={ADD_MENU_ITEMS}
          onSelect={v => (v === "template" ? onOpenTemplates() : onAddSlide(v))}
          className="w-full"
          triggerClassName="w-full justify-center bg-tool-design/15 hover:bg-tool-design/25 text-tool-design hover:text-tool-design border-tool-design/30"
        />
      </div>
    </aside>
  );
}
