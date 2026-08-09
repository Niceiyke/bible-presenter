/**
 * EditorToolbar — the horizontal command bar above the canvas (P1.4).
 * Shows insert tools, multi-select actions, or per-element formatting
 * controls depending on the current selection.
 */

import React from "react";
import {
  Type, Image as ImageIcon, Copy, Square,
  AlignCenter, AlignLeft, AlignRight, Trash2,
  BookOpen, Layers, Video, Grid3x3, Play,
} from "lucide-react";
import { Btn, ToggleBtn, Div, FontPicker } from "./components";
import type { SlideElement } from "../../../types";
import { useFonts } from "../../../hooks/useFonts";

export interface EditorToolbarProps {
  activeEl: SlideElement | null;
  selectedCount: number;
  multiSelectActive: boolean;
  hasGroup: boolean;
  insertVerseEnabled: boolean;
  canDeleteSlide: boolean;
  /** P3.2: current snap-to-grid size (0 disables snapping). */
  gridSize: number;
  onSetGridSize: (n: number) => void;
  onInsertVerse: () => void;
  onAddText: () => void;
  onAddShape: (shape: "rect" | "rounded" | "circle" | "line" | "triangle") => void;
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
  /** P4.7: in-editor live preview PIP toggle (Space). */
  previewOpen: boolean;
  onTogglePreview: () => void;
}

export function EditorToolbar({
  activeEl,
  selectedCount,
  multiSelectActive,
  hasGroup,
  insertVerseEnabled,
  canDeleteSlide,
  gridSize,
  onSetGridSize,
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
  previewOpen,
  onTogglePreview,
}: EditorToolbarProps) {
  // P2.5: merge user-installed @font-face families with the built-in list.
  const { availableFonts } = useFonts();
  return (
    <div className="h-11 border-b border-white/[0.06] flex items-center px-3 gap-1 bg-slate-900/70 backdrop-blur-xl shrink-0 overflow-x-auto">

      {/* ── No selection: Insert tools ── */}
      {selectedCount === 0 && <>
        <span className="text-[8px] font-black uppercase tracking-widest text-slate-600 mr-1 shrink-0">Insert</span>
        <Btn onClick={onAddText} icon={<Type size={13} />}>Text</Btn>
        <Btn onClick={onOpenImgPicker} icon={<ImageIcon size={13} />}>Image</Btn>
        <Btn onClick={onOpenVideoPicker} icon={<Video size={13} />}>Video</Btn>
        {/* P3.5: Insert Shape dropdown — surface rect/rounded/circle/line/triangle.
            A small hover popover sits next to the Btn so inserting any
            shape is one click + pick. */}
        <div className="relative group shrink-0">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white/8 hover:bg-white/14 text-slate-300 hover:text-white text-[11px] font-semibold rounded-lg transition-all shrink-0">
            <Square size={13} /> Shape
          </div>
          <div className="absolute left-0 top-full mt-1 hidden group-hover:flex flex-col bg-slate-900/95 backdrop-blur-xl border border-white/10 rounded-lg p-1 z-[80] shadow-2xl min-w-[110px]">
            {([
              { s: "rect", label: "Rectangle" },
              { s: "rounded", label: "Rounded" },
              { s: "circle", label: "Circle" },
              { s: "line", label: "Line" },
              { s: "triangle", label: "Triangle" },
            ] as const).map(o => (
              <button
                key={o.s}
                onClick={() => onAddShape(o.s)}
                className="px-2 py-1 text-[10px] font-bold rounded text-left text-slate-400 hover:text-white hover:bg-white/10 transition-all"
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
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
        <div className="relative shrink-0">
          <FontPicker
            fonts={availableFonts}
            value={typeof activeEl.font_family === "string" ? activeEl.font_family : "inherit"}
            canInherit
            onSelect={f => onUpdateElement(activeEl.id, { font_family: f === "inherit" ? "inherit" : f })}
          />
        </div>
        {(() => {
          const baseFs = typeof activeEl.font_size === "number" ? activeEl.font_size : null;
          return (
            <div className="flex items-center bg-white/8 border border-white/10 rounded-lg shrink-0 overflow-hidden">
              <button
                onClick={() => onUpdateElement(activeEl.id, { font_size: Math.max(8, (baseFs ?? 32) - 2) })}
                disabled={baseFs === null}
                className="px-2 py-1 text-slate-400 hover:text-white hover:bg-white/10 text-sm font-bold disabled:opacity-30">−</button>
              <input
                type="number"
                value={baseFs ?? ""}
                placeholder="—"
                disabled={baseFs === null}
                onChange={e => onUpdateElement(activeEl.id, { font_size: Number(e.target.value) })}
                onKeyDown={e => e.stopPropagation()}
                className="w-10 bg-transparent py-1 text-xs text-white text-center outline-none tabular-nums disabled:opacity-30 placeholder:text-slate-600" />
              <button
                onClick={() => onUpdateElement(activeEl.id, { font_size: (baseFs ?? 32) + 2 })}
                disabled={baseFs === null}
                className="px-2 py-1 text-slate-400 hover:text-white hover:bg-white/10 text-sm font-bold disabled:opacity-30">+</button>
            </div>
          );
        })()}
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
        <span className="text-[9px] text-slate-500 shrink-0">Fill</span>
        <input type="color" value={activeEl.fillColor ?? activeEl.color ?? "#6366f1"} onChange={e => onUpdateElement(activeEl.id, { fillColor: e.target.value })} className="w-8 h-8 rounded-lg cursor-pointer border border-white/20 bg-transparent shrink-0" />
        <Div /><span className="text-[9px] text-slate-500 shrink-0">Stroke</span>
        <input type="color" value={activeEl.strokeColor ?? "#000000"} onChange={e => onUpdateElement(activeEl.id, { strokeColor: e.target.value })} className="w-8 h-8 rounded-lg cursor-pointer border border-white/20 bg-transparent shrink-0" />
        <input type="number" min={0} max={50} value={Math.round(activeEl.strokeWidth ?? 0)} onChange={e => onUpdateElement(activeEl.id, { strokeWidth: Number(e.target.value) })} onKeyDown={e => e.stopPropagation()} className="w-12 bg-white/8 border border-white/10 rounded-lg px-2 py-1 text-xs text-white outline-none shrink-0" />
        <Div /><span className="text-[9px] text-slate-500 shrink-0">Opacity</span>
        <input type="range" min={0} max={1} step={0.05} value={activeEl.opacity ?? 1} onChange={e => onUpdateElement(activeEl.id, { opacity: Number(e.target.value) })} className="w-20 accent-indigo-500 shrink-0" />
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
      <div className="flex items-center gap-1 border-l border-white/[0.06] pl-2 shrink-0">
        {/* P3.2: snap-to-grid. Clicking the icon cycles
            0 (off) → 4 → 8 → 16 → 0; hold the dropdown for an explicit pick. */}
        <div className="relative group shrink-0">
          <button
            onClick={() => onSetGridSize(gridSize === 0 ? 4 : gridSize === 4 ? 8 : gridSize === 8 ? 16 : 0)}
            title={`Snap to grid: ${gridSize === 0 ? "Off" : gridSize + "%"}`}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg transition-all ${gridSize > 0 ? "bg-indigo-500/30 text-white" : "bg-white/6 hover:bg-white/12 text-slate-400 hover:text-white"}`}
          >
            <Grid3x3 size={13} />
            <span className="text-[10px] font-bold tabular-nums w-5 text-center">{gridSize === 0 ? "—" : gridSize}</span>
          </button>
          <div className="absolute right-0 top-full mt-1 hidden group-hover:flex flex-col bg-slate-900/95 backdrop-blur-xl border border-white/10 rounded-lg p-1 z-[80] shadow-2xl min-w-[80px]">
            {[
              { v: 0, label: "Off" },
              { v: 4, label: "4%" },
              { v: 8, label: "8%" },
              { v: 16, label: "16%" },
            ].map(o => (
              <button
                key={o.v}
                onClick={() => onSetGridSize(o.v)}
                className={`px-2 py-1 text-[10px] font-bold rounded text-left transition-all ${gridSize === o.v ? "bg-indigo-500 text-white" : "text-slate-400 hover:text-white hover:bg-white/10"}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <Div />
        <Btn onClick={onDuplicateSlide} icon={<Copy size={13} />}>Dupe</Btn>
        <button onClick={onDeleteSlide} disabled={!canDeleteSlide} className="p-2 bg-white/6 hover:bg-red-500/20 text-slate-500 hover:text-red-400 rounded-lg transition-all disabled:opacity-20" title="Delete slide"><Trash2 size={13} /></button>
        <div className="flex-1" />
        <button
          onClick={onTogglePreview}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-all ${previewOpen ? "bg-emerald-500/30 text-emerald-300" : "bg-white/6 hover:bg-white/12 text-slate-400 hover:text-white"}`}
          title="Live preview (Space) — plays entrance animation, nothing is broadcast"
        >
          <Play size={13} />
          <span className="text-[10px] font-bold">{previewOpen ? "Previewing" : "Preview"}</span>
        </button>
      </div>
    </div>
  );
}