/**
 * EditorToolbar — the horizontal command bar above the canvas (P1.4).
 * Shows insert tools, multi-select actions, or per-element formatting
 * controls depending on the current selection.
 *
 * Phase 2: uses click/focus `EditorMenu` dropdowns (no hover-only menus),
 * semantic console tokens, and 40px+ hit targets on every control.
 */

import React from "react";
import {
  Type, Image as ImageIcon, Copy, Square,
  AlignCenter, AlignLeft, AlignRight, Trash2,
  BookOpen, Layers, Video, Grid3x3, Sparkles,
  WandSparkles, ShieldCheck, Palette, ListTree, Presentation,
} from "lucide-react";
import { Btn, ToggleBtn, Div, FontPicker, EditorMenu } from "./components";
import type { SlideElement } from "../../../types";
import type { AiSlideEditAction } from "../../../ai/presentations";
import { useFonts } from "../../../hooks/useFonts";
import { FONT_SIZE_MAX, FONT_SIZE_MIN, FONT_SIZE_STEP, stepFontSize } from "./textStyleSystem";
import type { SmartLayout } from "../../../presentations/editorFeatures";

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
  onAiAction?: (action: AiSlideEditAction) => void;
  onApplySmartLayout: (layout: SmartLayout) => void;
  canApplySmartLayout: boolean;
  onOpenBrandKit: () => void;
  onToggleOutline: () => void;
  outlineOpen: boolean;
  onTogglePreflight: () => void;
  preflightOpen: boolean;
  onOpenRehearsal: () => void;
}

const SHAPES: { value: "rect" | "rounded" | "circle" | "line" | "triangle"; label: string }[] = [
  { value: "rect", label: "Rectangle" },
  { value: "rounded", label: "Rounded" },
  { value: "circle", label: "Circle" },
  { value: "line", label: "Line" },
  { value: "triangle", label: "Triangle" },
];

const GRID_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Off" },
  { value: 4, label: "4%" },
  { value: 8, label: "8%" },
  { value: 16, label: "16%" },
];

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
  onAiAction,
  onApplySmartLayout,
  canApplySmartLayout,
  onOpenBrandKit,
  onToggleOutline,
  outlineOpen,
  onTogglePreflight,
  preflightOpen,
  onOpenRehearsal,
}: EditorToolbarProps) {
  // P2.5: merge user-installed @font-face families with the built-in list.
  const { availableFonts } = useFonts();
  return (
    <div className="h-[60px] border-b border-console-border flex items-center px-3 gap-1.5 bg-console-surface/90 shrink-0 overflow-x-auto custom-scrollbar shadow-md shadow-black/10 relative z-[80]">

      {/* ── No selection: Insert tools ── */}
      {selectedCount === 0 && <>
        <span className="mr-1 rounded-lg bg-console-canvas px-2 py-1 text-[8px] font-black uppercase tracking-[0.18em] text-console-text-subtle shrink-0">Add</span>
        <Btn onClick={onAddText} icon={<Type size={14} />} className="bg-tool-design/10 text-tool-design border-tool-design/25 hover:bg-tool-design hover:text-console-canvas">Text</Btn>
        <Btn onClick={onOpenImgPicker} icon={<ImageIcon size={14} />} className="bg-action-primary/10 text-action-primary border-action-primary/20 hover:bg-action-primary hover:text-black">Image</Btn>
        <Btn onClick={onOpenVideoPicker} icon={<Video size={14} />} className="border-console-border bg-console-surface-raised text-console-text-muted hover:bg-console-surface-strong hover:text-console-text">Video</Btn>
        <EditorMenu
          label="Insert shape"
          trigger={<><Square size={14} /> Shape</>}
          triggerClassName="bg-orange-500/10 text-orange-300 border-orange-400/20 hover:bg-orange-500 hover:text-white"
          items={SHAPES}
          onSelect={onAddShape}
        />
        <Div />
        <Btn onClick={onOpenBiblePicker} icon={<BookOpen size={14} />} className="bg-state-stage/10 hover:bg-state-stage text-state-stage hover:text-slate-950 border-state-stage/30">
          Bible
        </Btn>
        {insertVerseEnabled && (
          <Btn onClick={onInsertVerse} icon={<BookOpen size={14} />} className="text-state-stage bg-state-stage/10 hover:bg-state-stage hover:text-slate-950 border-state-stage/30">
            Insert Verse
          </Btn>
        )}
      </>}

      {/* ── Multi-select actions ── */}
      {multiSelectActive && <>
        <span className="text-[11px] text-tool-design font-bold shrink-0">{selectedCount} selected</span>
        <Btn onClick={onGroup} icon={<Layers size={14} />}>Group</Btn>
        {hasGroup && <Btn onClick={onUngroup} icon={<Layers size={14} />}>Ungroup</Btn>}
        <Btn onClick={onDuplicateSelected} icon={<Copy size={14} />}>Duplicate</Btn>
        <Btn onClick={onDeleteSelected} icon={<Trash2 size={14} />} className="hover:bg-state-live-soft hover:text-state-live hover:border-state-live/40">Delete</Btn>
        <Div />
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
            <div className="flex items-center bg-console-surface-raised border border-console-border rounded-lg shrink-0 overflow-hidden">
              <button
                onClick={() => onUpdateElement(activeEl.id, { font_size: stepFontSize(baseFs ?? 32, -FONT_SIZE_STEP) })}
                disabled={baseFs === null}
                aria-label="Decrease font size"
                className="h-10 px-2.5 text-console-text-muted hover:text-console-text hover:bg-console-surface-strong text-sm font-bold disabled:opacity-30">−</button>
              <input
                type="number"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                value={baseFs ?? ""}
                placeholder="—"
                disabled={baseFs === null}
                aria-label="Font size"
                onChange={e => onUpdateElement(activeEl.id, { font_size: Number(e.target.value) })}
                onKeyDown={e => e.stopPropagation()}
                className="w-11 bg-transparent py-1 text-xs text-console-text text-center outline-none tabular-nums disabled:opacity-30 placeholder:text-console-text-subtle" />
              <button
                onClick={() => onUpdateElement(activeEl.id, { font_size: stepFontSize(baseFs ?? 32, FONT_SIZE_STEP) })}
                disabled={baseFs === null}
                aria-label="Increase font size"
                className="h-10 px-2.5 text-console-text-muted hover:text-console-text hover:bg-console-surface-strong text-sm font-bold disabled:opacity-30">+</button>
            </div>
          );
        })()}
        <Div /><ToggleBtn active={!!activeEl.bold} onClick={() => onUpdateElement(activeEl.id, { bold: !activeEl.bold })} title="Bold"><span className="font-black text-sm">B</span></ToggleBtn>
        <ToggleBtn active={!!activeEl.italic} onClick={() => onUpdateElement(activeEl.id, { italic: !activeEl.italic })} title="Italic"><span className="font-serif italic text-sm">I</span></ToggleBtn>
        <Div />
        <ToggleBtn active={activeEl.align === "left"} onClick={() => onUpdateElement(activeEl.id, { align: "left" })} title="Align left"><AlignLeft size={15} /></ToggleBtn>
        <ToggleBtn active={activeEl.align === "center" || !activeEl.align} onClick={() => onUpdateElement(activeEl.id, { align: "center" })} title="Center"><AlignCenter size={15} /></ToggleBtn>
        <ToggleBtn active={activeEl.align === "right"} onClick={() => onUpdateElement(activeEl.id, { align: "right" })} title="Align right"><AlignRight size={15} /></ToggleBtn>
        <Div />
        <div className="flex items-center gap-1.5 shrink-0"><span className="text-[10px] font-bold text-console-text-subtle">Color</span><input type="color" value={activeEl.color} onChange={e => onUpdateElement(activeEl.id, { color: e.target.value })} className="w-8 h-8 rounded-lg cursor-pointer border border-console-border bg-console-surface-raised" aria-label="Text color" /></div>
        <label className="flex items-center gap-1.5 shrink-0 cursor-pointer ml-1"><input type="checkbox" checked={activeEl.shadow !== false} onChange={e => onUpdateElement(activeEl.id, { shadow: e.target.checked })} className="accent-state-stage" /><span className="text-[10px] font-bold text-console-text-subtle">Shadow</span></label>
      </>}

      {/* ── Shape selected ── */}
      {activeEl?.kind === "shape" && selectedCount === 1 && <>
        <span className="text-[10px] font-bold text-console-text-subtle shrink-0">Fill</span>
        <input type="color" value={activeEl.fillColor ?? activeEl.color ?? "#6366f1"} onChange={e => onUpdateElement(activeEl.id, { fillColor: e.target.value })} className="w-8 h-8 rounded-lg cursor-pointer border border-console-border bg-console-surface-raised shrink-0" aria-label="Fill color" />
        <Div /><span className="text-[10px] font-bold text-console-text-subtle shrink-0">Stroke</span>
        <input type="color" value={activeEl.strokeColor ?? "#000000"} onChange={e => onUpdateElement(activeEl.id, { strokeColor: e.target.value })} className="w-8 h-8 rounded-lg cursor-pointer border border-console-border bg-console-surface-raised shrink-0" aria-label="Stroke color" />
        <input type="number" min={0} max={50} value={Math.round(activeEl.strokeWidth ?? 0)} onChange={e => onUpdateElement(activeEl.id, { strokeWidth: Number(e.target.value) })} onKeyDown={e => e.stopPropagation()} className="w-14 bg-console-surface-raised border border-console-border rounded-lg px-2 py-1 text-xs text-console-text outline-none shrink-0" aria-label="Stroke width" />
        <Div /><span className="text-[10px] font-bold text-console-text-subtle shrink-0">Opacity</span>
        <input type="range" min={0} max={1} step={0.05} value={activeEl.opacity ?? 1} onChange={e => onUpdateElement(activeEl.id, { opacity: Number(e.target.value) })} className="w-20 accent-state-stage shrink-0" aria-label="Opacity" />
        <span className="text-[11px] text-console-text-muted font-mono shrink-0 w-8">{Math.round((activeEl.opacity ?? 1) * 100)}%</span>
      </>}

      {/* ── Image selected ── */}
      {activeEl?.kind === "image" && selectedCount === 1 && <>
        <Btn onClick={onOpenImgPicker} icon={<ImageIcon size={14} />}>Change Image</Btn>
      </>}

      {/* ── Video selected ── */}
      {activeEl?.kind === "video" && selectedCount === 1 && <>
        <Btn onClick={onOpenVideoPicker} icon={<Video size={14} />}>Change Video</Btn>
        <Div />
        <label className="flex items-center gap-1.5 shrink-0 cursor-pointer"><input type="checkbox" checked={activeEl.loop !== false} onChange={e => onUpdateElement(activeEl.id, { loop: e.target.checked })} className="accent-state-stage" /><span className="text-[10px] font-bold text-console-text-subtle">Loop</span></label>
        <label className="flex items-center gap-1.5 shrink-0 cursor-pointer"><input type="checkbox" checked={activeEl.muted !== false} onChange={e => onUpdateElement(activeEl.id, { muted: e.target.checked })} className="accent-state-stage" /><span className="text-[10px] font-bold text-console-text-subtle">Muted</span></label>
      </>}

      {onAiAction && <>
        <Div />
        <EditorMenu<AiSlideEditAction>
          label="AI slide assistant"
          trigger={<><Sparkles size={14} /> AI</>}
          triggerClassName="text-action-primary border-action-primary/40 bg-action-primary/10 hover:bg-action-primary hover:text-black"
          items={[
            ...(activeEl?.kind === "text" && !activeEl.locked && selectedCount === 1 ? [
              { value: "shorten" as const, label: "Shorten for projection" },
              { value: "rewrite" as const, label: "Rewrite clearly" },
              { value: "bullets" as const, label: "Convert to bullets" },
              { value: "highlight" as const, label: "Highlight key phrases" },
            ] : []),
            { value: "speaker-notes" as const, label: "Generate speaker notes" },
            { value: "regenerate-slide" as const, label: "Regenerate this slide" },
          ]}
          onSelect={onAiAction}
        />
      </>}

      <Div />
      {canApplySmartLayout && (
        <EditorMenu<SmartLayout>
          label="Smart layout"
          trigger={<><WandSparkles size={14} /> Layout</>}
          triggerClassName="text-action-primary border-action-primary/30 bg-action-primary/10 hover:bg-action-primary hover:text-black"
          items={[
            { value: "balanced", label: "Balanced" },
            { value: "hero", label: "Full-bleed hero" },
            { value: "split-left", label: "Media left" },
            { value: "split-right", label: "Media right" },
            { value: "stack", label: "Vertical stack" },
          ]}
          onSelect={onApplySmartLayout}
        />
      )}
      <Btn onClick={onOpenBrandKit} icon={<Palette size={14} />} className="text-orange-300 border-orange-400/25 bg-orange-500/10 hover:bg-orange-500 hover:text-white">Brand</Btn>
      <Btn onClick={onToggleOutline} icon={<ListTree size={14} />} className={outlineOpen ? "text-console-canvas border-tool-design bg-tool-design" : "text-tool-design border-tool-design/25 bg-tool-design/10 hover:bg-tool-design hover:text-console-canvas"}>Outline</Btn>
      <Btn onClick={onTogglePreflight} icon={<ShieldCheck size={14} />} className={preflightOpen ? "text-black border-state-warning bg-state-warning" : "text-state-warning border-state-warning/25 bg-state-warning/10 hover:bg-state-warning hover:text-black"}>Check</Btn>
      <Btn onClick={onOpenRehearsal} icon={<Presentation size={14} />} className="text-state-success border-state-success/25 bg-state-success/10 hover:bg-state-success hover:text-slate-950">Rehearse</Btn>

      <div className="flex-1" />
      <div className="flex items-center gap-1.5 border-l border-console-border pl-2 shrink-0">
        <EditorMenu
          label="Snap to grid"
          align="right"
          trigger={<Grid3x3 size={14} />}
          activeLabel={gridSize === 0 ? "—" : `${gridSize}%`}
          items={GRID_OPTIONS}
          value={gridSize}
          onSelect={onSetGridSize}
        />
        <Div />
        <Btn onClick={onDuplicateSlide} icon={<Copy size={14} />}>Duplicate</Btn>
        <button
          onClick={onDeleteSlide}
          disabled={!canDeleteSlide}
          aria-label="Delete slide"
          title="Delete slide"
          className="w-10 h-10 bg-console-surface-raised hover:bg-state-live-soft text-console-text-muted hover:text-state-live rounded-lg border border-console-border flex items-center justify-center transition-all disabled:opacity-20 focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
        ><Trash2 size={14} /></button>
      </div>
    </div>
  );
}
