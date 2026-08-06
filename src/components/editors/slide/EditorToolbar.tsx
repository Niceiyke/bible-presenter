/**
 * EditorToolbar — the horizontal command bar above the canvas (P1.4).
 * Shows insert tools, multi-select actions, or per-element formatting
 * controls depending on the current selection.
 */

import React from "react";
import {
  Type, Image as ImageIcon, Copy, Square,
  AlignCenter, AlignLeft, AlignRight, Trash2,
  BookOpen, Layers, Video,
} from "lucide-react";
import { Btn, ToggleBtn, Div } from "./components";
import type { SlideElement } from "../../../types";
import { FONTS } from "../../../types";

export interface EditorToolbarProps {
  activeEl: SlideElement | null;
  selectedCount: number;
  multiSelectActive: boolean;
  hasGroup: boolean;
  insertVerseEnabled: boolean;
  canDeleteSlide: boolean;
  onInsertVerse: () => void;
  onAddText: () => void;
  onAddShape: () => void;
  onAddVideo: () => void;
  onOpenImgPicker: () => void;
  onOpenVideoPicker: () => void;
  onOpenBiblePicker: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onDuplicateSelected: () => void;
  onDeleteSelected: () => void;
  onUpdateElement: (id: string, updates: Partial<SlideElement>) => void;
  onDuplicateSlide: () => void;
  onDeleteSlide: () => void;
}

export function EditorToolbar({
  activeEl,
  selectedCount,
  multiSelectActive,
  hasGroup,
  insertVerseEnabled,
  canDeleteSlide,
  onInsertVerse,
  onAddText,
  onAddShape,
  onAddVideo,
  onOpenImgPicker,
  onOpenVideoPicker,
  onOpenBiblePicker,
  onGroup,
  onUngroup,
  onDuplicateSelected,
  onDeleteSelected,
  onUpdateElement,
  onDuplicateSlide,
  onDeleteSlide,
}: EditorToolbarProps) {
  return (
    <div className="h-11 border-b border-white/8 flex items-center px-3 gap-1 bg-[#131326] shrink-0 overflow-x-auto">

      {/* ── No selection: Insert tools ── */}
      {selectedCount === 0 && <>
        <span className="text-[8px] font-black uppercase tracking-widest text-slate-600 mr-1 shrink-0">Insert</span>
        <Btn onClick={onAddText} icon={<Type size={13} />}>Text</Btn>
        <Btn onClick={onOpenImgPicker} icon={<ImageIcon size={13} />}>Image</Btn>
        <Btn onClick={onOpenVideoPicker} icon={<Video size={13} />}>Video</Btn>
        <Btn onClick={onAddShape} icon={<Square size={13} />}>Shape</Btn>
        <div className="w-px h-5 bg-white/10 mx-1 shrink-0" />
        <Btn onClick={onOpenBiblePicker} icon={<BookOpen size={13} />} className="bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/20">
          Bible
        </Btn>
        {insertVerseEnabled && (
          <Btn onClick={onInsertVerse} icon={<BookOpen size={13} />} className="text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20">
            Insert Verse
          </Btn>
        )}
      </>}

      {/* ── Multi-select actions ── */}
      {multiSelectActive && <>
        <span className="text-[9px] text-indigo-400 font-bold shrink-0">{selectedCount} selected</span>
        <Btn onClick={onGroup} icon={<Layers size={13} />}>Group</Btn>
        {hasGroup && <Btn onClick={onUngroup} icon={<Layers size={13} />}>Ungroup</Btn>}
        <Btn onClick={onDuplicateSelected} icon={<Copy size={13} />}>Dup All</Btn>
        <Btn onClick={onDeleteSelected} icon={<Trash2 size={13} />} className="hover:bg-red-500/20 hover:text-red-400">Del All</Btn>
        <div className="w-px h-5 bg-white/10 mx-1 shrink-0" />
      </>}

      {/* ── Text element selected ── */}
      {activeEl?.kind === "text" && selectedCount === 1 && <>
        <select value={activeEl.font_family} onChange={e => onUpdateElement(activeEl.id, { font_family: e.target.value })} onKeyDown={e => e.stopPropagation()} className="bg-white/8 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-slate-300 outline-none max-w-[130px] shrink-0">
          {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        <div className="flex items-center bg-white/8 border border-white/10 rounded-lg shrink-0 overflow-hidden">
          <button onClick={() => onUpdateElement(activeEl.id, { font_size: Math.max(8, (activeEl.font_size ?? 32) - 2) })} className="px-2 py-1 text-slate-400 hover:text-white hover:bg-white/10 text-sm font-bold">−</button>
          <input type="number" value={activeEl.font_size ?? 32} onChange={e => onUpdateElement(activeEl.id, { font_size: Number(e.target.value) })} onKeyDown={e => e.stopPropagation()} className="w-10 bg-transparent py-1 text-xs text-white text-center outline-none tabular-nums" />
          <button onClick={() => onUpdateElement(activeEl.id, { font_size: (activeEl.font_size ?? 32) + 2 })} className="px-2 py-1 text-slate-400 hover:text-white hover:bg-white/10 text-sm font-bold">+</button>
        </div>
        <Div /><ToggleBtn active={!!activeEl.bold} onClick={() => onUpdateElement(activeEl.id, { bold: !activeEl.bold })} title="Bold"><span className="font-black text-sm">B</span></ToggleBtn>
        <ToggleBtn active={!!activeEl.italic} onClick={() => onUpdateElement(activeEl.id, { italic: !activeEl.italic })} title="Italic"><span className="font-serif italic text-sm">I</span></ToggleBtn>
        <Div />
        <ToggleBtn active={activeEl.align === "left"} onClick={() => onUpdateElement(activeEl.id, { align: "left" })} title="Align left"><AlignLeft size={14} /></ToggleBtn>
        <ToggleBtn active={activeEl.align === "center" || !activeEl.align} onClick={() => onUpdateElement(activeEl.id, { align: "center" })} title="Center"><AlignCenter size={14} /></ToggleBtn>
        <ToggleBtn active={activeEl.align === "right"} onClick={() => onUpdateElement(activeEl.id, { align: "right" })} title="Align right"><AlignRight size={14} /></ToggleBtn>
        <Div />
        <div className="flex items-center gap-1.5 shrink-0"><span className="text-[9px] text-slate-600">Color</span><input type="color" value={activeEl.color} onChange={e => onUpdateElement(activeEl.id, { color: e.target.value })} className="w-7 h-7 rounded-lg cursor-pointer border border-white/20 bg-transparent" /></div>
        <label className="flex items-center gap-1.5 shrink-0 cursor-pointer ml-1"><input type="checkbox" checked={activeEl.shadow !== false} onChange={e => onUpdateElement(activeEl.id, { shadow: e.target.checked })} className="accent-indigo-500" /><span className="text-[9px] text-slate-500">Shadow</span></label>
      </>}

      {/* ── Shape selected ── */}
      {activeEl?.kind === "shape" && selectedCount === 1 && <>
        <span className="text-[9px] text-slate-500 shrink-0">Fill</span><input type="color" value={activeEl.color} onChange={e => onUpdateElement(activeEl.id, { color: e.target.value })} className="w-8 h-8 rounded-lg cursor-pointer border border-white/20 bg-transparent shrink-0" />
        <Div /><span className="text-[9px] text-slate-500 shrink-0">Opacity</span><input type="range" min={0} max={1} step={0.05} value={activeEl.opacity ?? 1} onChange={e => onUpdateElement(activeEl.id, { opacity: Number(e.target.value) })} className="w-20 accent-indigo-500 shrink-0" />
        <span className="text-[10px] text-slate-400 font-mono shrink-0 w-8">{Math.round((activeEl.opacity ?? 1) * 100)}%</span>
      </>}

      {/* ── Image selected ── */}
      {activeEl?.kind === "image" && selectedCount === 1 && <>
        <Btn onClick={onOpenImgPicker} icon={<ImageIcon size={13} />}>Change Image</Btn>
      </>}

      {/* ── Video selected ── */}
      {activeEl?.kind === "video" && selectedCount === 1 && <>
        <Btn onClick={onOpenVideoPicker} icon={<Video size={13} />}>Change Video</Btn>
        <Div />
        <label className="flex items-center gap-1.5 shrink-0 cursor-pointer"><input type="checkbox" checked={activeEl.loop !== false} onChange={e => onUpdateElement(activeEl.id, { loop: e.target.checked })} className="accent-indigo-500" /><span className="text-[9px] text-slate-500">Loop</span></label>
        <label className="flex items-center gap-1.5 shrink-0 cursor-pointer"><input type="checkbox" checked={activeEl.muted !== false} onChange={e => onUpdateElement(activeEl.id, { muted: e.target.checked })} className="accent-indigo-500" /><span className="text-[9px] text-slate-500">Muted</span></label>
      </>}

      <div className="flex-1" />
      <div className="flex items-center gap-1 border-l border-white/8 pl-2 shrink-0">
        <Btn onClick={onDuplicateSlide} icon={<Copy size={13} />}>Dupe</Btn>
        <button onClick={onDeleteSlide} disabled={!canDeleteSlide} className="p-2 bg-white/6 hover:bg-red-500/20 text-slate-500 hover:text-red-400 rounded-lg transition-all disabled:opacity-20" title="Delete slide"><Trash2 size={13} /></button>
      </div>
    </div>
  );
}