/**
 * PropertiesPanel — the right-hand inspector (P1.4). Covers slide
 * background/notes/template actions plus single- and multi-element
 * controls. Callbacks are passed down; all state mutation stays in the
 * SlideEditor.
 */

import React from "react";
import {
  AlignLeft, AlignCenter, AlignRight,
  ArrowUp, ArrowDown, MoveUp, MoveDown,
  Lock, Unlock, Copy, Trash2, Library, Layers,
} from "lucide-react";
import { Panel, IconBtn, TextBtn } from "./components";
import type { AlignmentAxis, ZDirection } from "./helpers";
import type { CustomSlide, SlideElement } from "../../../types";

export interface PropertiesPanelProps {
  activeEl: SlideElement | null;
  selectedCount: number;
  hasGroup: boolean;
  slide: CustomSlide;
  onUpdateSlide: (next: CustomSlide) => void;
  onUpdateElement: (id: string, updates: Partial<SlideElement>) => void;
  onOpenBgPicker: () => void;
  onOpenBgVideoPicker: () => void;
  onSaveAsTemplate: () => void;
  onAlign: (type: AlignmentAxis) => void;
  onZOrder: (dir: ZDirection) => void;
  onLock: () => void;
  onDuplicateElement: () => void;
  onDeleteElement: () => void;
  onGroup: () => void;
  onUngroup: () => void;
}

export function PropertiesPanel({
  activeEl,
  selectedCount,
  hasGroup,
  slide,
  onUpdateSlide,
  onUpdateElement,
  onOpenBgPicker,
  onOpenBgVideoPicker,
  onSaveAsTemplate,
  onAlign,
  onZOrder,
  onLock,
  onDuplicateElement,
  onDeleteElement,
  onGroup,
  onUngroup,
}: PropertiesPanelProps) {
  return (
    <aside className="w-60 border-l border-white/8 bg-[#131326] flex flex-col overflow-hidden shrink-0">
      <div className="px-3 py-2.5 border-b border-white/8 flex items-center justify-between shrink-0">
        <span className="text-[8px] font-black uppercase tracking-widest text-slate-600">
          {activeEl ? `${activeEl.kind} element` : selectedCount > 1 ? `${selectedCount} elements` : "Slide"}
        </span>
        {selectedCount > 1 && <span className="text-[8px] text-indigo-400 font-bold">Ctrl+G to group</span>}
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3 custom-scrollbar">

        {/* ── Slide background ── */}
        <Panel label="Background">
          <div className="flex items-center gap-3">
            <input type="color" value={slide.backgroundColor} onChange={e => onUpdateSlide({ ...slide, backgroundColor: e.target.value, backgroundImage: undefined, backgroundVideo: undefined })} className="w-9 h-9 rounded-lg cursor-pointer border border-white/20 bg-transparent shrink-0" />
            <span className="text-xs text-slate-400 font-mono">{slide.backgroundColor}</span>
          </div>
          <button onClick={onOpenBgPicker} className="w-full px-3 py-2 bg-white/6 hover:bg-white/10 text-slate-400 hover:text-slate-200 text-[11px] font-semibold rounded-lg transition-all text-left">
            {slide.backgroundImage ? "Change Image…" : "Set Image…"}
          </button>
          {slide.backgroundImage && (
            <div className="flex items-center justify-between bg-white/4 p-2 rounded-lg border border-white/8">
              <span className="text-[9px] text-slate-500 truncate">{slide.backgroundImage.split(/[/\\]/).pop()}</span>
              <button onClick={() => onUpdateSlide({ ...slide, backgroundImage: undefined })} className="text-red-400 text-[9px] font-bold ml-2 shrink-0 hover:text-red-300">✕</button>
            </div>
          )}
          <div className="w-full h-px bg-white/5 my-0.5" />
          <button onClick={onOpenBgVideoPicker} className="w-full px-3 py-2 bg-purple-600/10 hover:bg-purple-600/20 text-purple-400 hover:text-purple-300 text-[11px] font-semibold rounded-lg transition-all text-left border border-purple-500/10">
            {slide.backgroundVideo ? "Change Video…" : "Set Video…"}
          </button>
          {slide.backgroundVideo && (
            <div className="flex flex-col gap-2 bg-white/4 p-2 rounded-lg border border-white/8">
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-slate-500 truncate">{slide.backgroundVideo.split(/[/\\]/).pop()}</span>
                <button onClick={() => onUpdateSlide({ ...slide, backgroundVideo: undefined })} className="text-red-400 text-[9px] font-bold ml-2 shrink-0 hover:text-red-300">✕</button>
              </div>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={slide.backgroundVideoLoop !== false} onChange={e => onUpdateSlide({ ...slide, backgroundVideoLoop: e.target.checked })} className="accent-purple-500" />
                <span className="text-[9px] text-slate-500">Loop</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={slide.backgroundVideoMuted !== false} onChange={e => onUpdateSlide({ ...slide, backgroundVideoMuted: e.target.checked })} className="accent-purple-500" />
                <span className="text-[9px] text-slate-500">Muted</span>
              </label>
            </div>
          )}
        </Panel>

        {/* ── Slide Notes ── */}
        <Panel label="Speaker Notes">
          <textarea
            value={slide.notes || ""}
            onChange={e => onUpdateSlide({ ...slide, notes: e.target.value })}
            onKeyDown={e => e.stopPropagation()}
            placeholder="Notes for this slide (not shown on output)..."
            className="w-full bg-white/6 border border-white/10 rounded-lg px-3 py-2 text-[11px] text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500/50 transition-colors resize-none h-20 custom-scrollbar"
          />
        </Panel>

        {/* ── Template actions ── */}
        <Panel label="Template">
          <button onClick={onSaveAsTemplate} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 hover:text-purple-300 text-[10px] font-bold rounded-lg transition-all border border-purple-500/20">
            <Library size={12} /> Save Slide as Template
          </button>
        </Panel>

        {/* ── Element controls ── */}
        {activeEl && selectedCount === 1 && <>
          <div className="flex gap-1.5">
            <button onClick={onLock}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[10px] font-bold transition-all border ${activeEl.locked ? "bg-amber-500/15 border-amber-500/30 text-amber-400" : "bg-white/6 border-white/8 text-slate-400 hover:text-white"}`}>
              {activeEl.locked ? <Lock size={11} /> : <Unlock size={11} />}{activeEl.locked ? "Locked" : "Lock"}
            </button>
            <button onClick={onDuplicateElement} className="px-3 py-2 bg-white/6 hover:bg-white/12 border border-white/8 text-slate-400 hover:text-white rounded-xl transition-all" title="Duplicate"><Copy size={13} /></button>
            <button onClick={onDeleteElement} className="px-3 py-2 bg-white/6 hover:bg-red-500/20 border border-white/8 text-slate-500 hover:text-red-400 rounded-xl transition-all" title="Delete"><Trash2 size={13} /></button>
          </div>

          <Panel label="Position & Size">
            <div className="grid grid-cols-2 gap-2">
              {([["X %", "x"], ["Y %", "y"], ["W %", "w"], ["H %", "h"]] as const).map(([lbl, key]) => (
                <div key={key}>
                  <span className="text-[8px] text-slate-600 uppercase font-black">{lbl}</span>
                  <input type="number" value={Math.round(activeEl[key])} onChange={e => onUpdateElement(activeEl.id, { [key]: Number(e.target.value) })} onKeyDown={e => e.stopPropagation()} className="mt-1 w-full bg-white/6 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-indigo-500/50 transition-colors" />
                </div>
              ))}
            </div>
          </Panel>

          <Panel label="Arrange">
            <div className="grid grid-cols-3 gap-1">
              <IconBtn onClick={() => onAlign("left")} title="Left edge"><AlignLeft size={12} /></IconBtn>
              <IconBtn onClick={() => onAlign("center")} title="Center H"><AlignCenter size={12} /></IconBtn>
              <IconBtn onClick={() => onAlign("right")} title="Right edge"><AlignRight size={12} /></IconBtn>
              <TextBtn onClick={() => onAlign("top")} title="Top">Top</TextBtn>
              <TextBtn onClick={() => onAlign("middle")} title="Center V">Mid</TextBtn>
              <TextBtn onClick={() => onAlign("bottom")} title="Bottom">Bot</TextBtn>
            </div>
            <div className="grid grid-cols-4 gap-1 mt-1">
              <IconBtn onClick={() => onZOrder("back")} title="Send to Back"><MoveDown size={12} /></IconBtn>
              <IconBtn onClick={() => onZOrder("backward")} title="Send Backward"><ArrowDown size={12} /></IconBtn>
              <IconBtn onClick={() => onZOrder("forward")} title="Bring Forward"><ArrowUp size={12} /></IconBtn>
              <IconBtn onClick={() => onZOrder("front")} title="Bring to Front"><MoveUp size={12} /></IconBtn>
            </div>
          </Panel>

          {activeEl.kind === "text" && (
            <Panel label="Vertical Align">
              <div className="flex gap-1">
                {(["top", "middle", "bottom"] as const).map(a => (
                  <button key={a} onClick={() => onUpdateElement(activeEl.id, { v_align: a })} className={`flex-1 py-2 text-[10px] font-bold rounded-lg capitalize transition-all ${(activeEl.v_align === a || (!activeEl.v_align && a === "top")) ? "bg-indigo-500 text-white" : "bg-white/6 text-slate-500 hover:text-white hover:bg-white/10"}`}>
                    {a[0].toUpperCase() + a.slice(1)}
                  </button>
                ))}
              </div>
            </Panel>
          )}
        </>}

        {selectedCount > 1 && (
          <div className="flex flex-col gap-2">
            <button onClick={onGroup} className="w-full flex items-center justify-center gap-1.5 py-2 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 text-[10px] font-bold rounded-lg transition-all border border-indigo-500/20">
              <Layers size={12} /> Group ({selectedCount} elements)
            </button>
            {hasGroup && (
              <button onClick={onUngroup} className="w-full flex items-center justify-center gap-1.5 py-2 bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 text-[10px] font-bold rounded-lg transition-all border border-amber-500/20">
                <Layers size={12} /> Ungroup
              </button>
            )}
          </div>
        )}

        {selectedCount === 0 && (
          <p className="text-[10px] text-slate-700 text-center pt-4 leading-relaxed">
            Click to select · Ctrl+click for multi<br />
            <span className="text-[8px] text-slate-800">Drag slides to reorder · Ctrl+G group</span>
          </p>
        )}
      </div>
    </aside>
  );
}