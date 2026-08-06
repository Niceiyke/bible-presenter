/**
 * SlideCanvas — the 16:9 authoring surface (P1.4). Renders the slide via
 * `CustomSlideRenderer` plus the interactive selection/resize overlay, and
 * hosts the Tiptap `InlineTextEditor` while an element is being edited.
 */

import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { CustomSlideRenderer } from "../../shared/Renderers";
import { InlineTextEditor } from "./InlineTextEditor";
import type { Handle } from "./useElementDragResize";
import type { CustomSlide, SlideElement } from "../../../types";

const HANDLES: Record<Handle, React.CSSProperties> = {
  nw: { top: -5, left: -5, cursor: "nwse-resize" },
  n:  { top: -5, left: "50%", transform: "translateX(-50%)", cursor: "ns-resize" },
  ne: { top: -5, right: -5, cursor: "nesw-resize" },
  e:  { top: "50%", right: -5, transform: "translateY(-50%)", cursor: "ew-resize" },
  se: { bottom: -5, right: -5, cursor: "nwse-resize" },
  s:  { bottom: -5, left: "50%", transform: "translateX(-50%)", cursor: "ns-resize" },
  sw: { bottom: -5, left: -5, cursor: "nesw-resize" },
  w:  { top: "50%", left: -5, transform: "translateY(-50%)", cursor: "ew-resize" },
};

export interface SlideCanvasProps {
  slide: CustomSlide;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  canvasScale: number;
  appDataDir: string | null;
  activeElementIds: string[];
  editingElementId: string | null;
  slideIndex: number;
  slideCount: number;
  onCanvasClick: (e: React.MouseEvent) => void;
  onElementClick: (id: string, e: React.MouseEvent) => void;
  onDblClick: (id: string, e: React.MouseEvent) => void;
  onDrag: (id: string, e: React.PointerEvent) => void;
  onResize: (id: string, e: React.PointerEvent, h: Handle) => void;
  onCommit: (id: string, html: string) => void;
  onNavigate: (delta: 1 | -1) => void;
}

export function SlideCanvas({
  slide,
  canvasRef,
  canvasScale,
  appDataDir,
  activeElementIds,
  editingElementId,
  slideIndex,
  slideCount,
  onCanvasClick,
  onElementClick,
  onDblClick,
  onDrag,
  onResize,
  onCommit,
  onNavigate,
}: SlideCanvasProps) {
  return (
    <div
      className={`flex-1 flex items-center justify-center p-10 overflow-hidden relative ${editingElementId ? '' : 'select-none'}`}
      style={{ background: "radial-gradient(circle, #252540 1px, transparent 1px)", backgroundSize: "22px 22px", backgroundColor: "#0b0b18" }}
      onClick={onCanvasClick}
    >
      <div ref={canvasRef} className="relative shadow-2xl shadow-black/80 ring-1 ring-white/8" style={{ aspectRatio: "16/9", backgroundColor: slide.backgroundColor, width: "min(100%, calc((100vh - 140px) * 16 / 9))" }}>
        <CustomSlideRenderer slide={slide} scale={canvasScale} appDataDir={appDataDir} hiddenElementIds={editingElementId ? [editingElementId] : []} />

        <div className="absolute inset-0 z-50">
          {slide.elements.slice().sort((a, b) => a.z_index - b.z_index).map(el => {
            const isActive = activeElementIds.includes(el.id);
            const isEditing = editingElementId === el.id;
            const isGroupedSelected = el.groupId && activeElementIds.some(id => {
              const sel = slide.elements.find(e => e.id === id);
              return sel?.groupId === el.groupId;
            });

            return (
              <div key={el.id}
                className={`absolute pointer-events-auto transition-all ${isEditing ? "cursor-text" : isActive ? "cursor-move" : "cursor-pointer"}`}
                style={{
                  left: `${el.x}%`, top: `${el.y}%`, width: `${el.w}%`, height: `${el.h}%`,
                  zIndex: el.z_index + 100,
                  outline: isEditing ? "2px solid #34d399" : isActive ? "2px solid #818cf8" : isGroupedSelected ? "2px dashed #818cf8" : "2px solid transparent",
                  outlineOffset: "1px",
                }}
                onClick={e => onElementClick(el.id, e)}
                onPointerDown={e => { if (!isEditing) onDrag(el.id, e); }}
                onDoubleClick={e => onDblClick(el.id, e)}
              >
                {isEditing && el.kind === "text" && <InlineTextEditor el={el} canvasScale={canvasScale} onCommit={html => onCommit(el.id, html)} />}
                {isActive && !isEditing && Object.entries(HANDLES).map(([h, style]) => (
                  <div key={h} onPointerDown={e => onResize(el.id, e, h as Handle)} className="absolute w-2.5 h-2.5 bg-white border-2 border-indigo-400 rounded-full shadow-md" style={{ position: "absolute", ...style }} />
                ))}
                {isActive && !isEditing && el.kind === "text" && (
                  <span className="absolute top-full left-0 mt-1 px-1.5 py-0.5 bg-indigo-500 text-white text-[7px] font-bold rounded whitespace-nowrap pointer-events-none z-[200]">↕ drag · double-click to edit</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 backdrop-blur border border-white/10 rounded-full px-3 py-1.5 z-[70]">
        <button disabled={slideIndex === 0} onClick={e => { e.stopPropagation(); onNavigate(-1); }} className="text-slate-400 hover:text-white disabled:opacity-20 transition-all"><ChevronLeft size={16} /></button>
        <span className="text-xs text-slate-300 font-bold tabular-nums min-w-[40px] text-center">{slideIndex + 1} / {slideCount}</span>
        <button disabled={slideIndex === slideCount - 1} onClick={e => { e.stopPropagation(); onNavigate(1); }} className="text-slate-400 hover:text-white disabled:opacity-20 transition-all"><ChevronRight size={16} /></button>
      </div>
    </div>
  );
}