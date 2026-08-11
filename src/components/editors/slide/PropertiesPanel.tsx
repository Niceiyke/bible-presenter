/**
 * PropertiesPanel — the right-hand inspector (P1.4). Covers slide
 * background/notes/template actions plus single- and multi-element
 * controls. Callbacks are passed down; all state mutation stays in the
 * SlideEditor.
 */

import React, { useState } from "react";
import {
  AlignLeft, AlignCenter, AlignRight,
  ArrowUp, ArrowDown, MoveUp, MoveDown,
  Lock, Unlock, Copy, Trash2, Library, Layers,
} from "lucide-react";
import { Panel, IconBtn, TextBtn, TextInputModal, InspectorSection } from "./components";
import { LayersPanel, generatedLayerName } from "./LayersPanel";
import { ThemePicker, type ThemePreset } from "./ThemePicker";
import type { AlignmentAxis, ZDirection } from "./helpers";
import type { CustomSlide, SlideElement, SlideBackground, SlideTheme, SlideMaster } from "../../../types";

export interface PropertiesPanelProps {
  activeEl: SlideElement | null;
  selectedCount: number;
  hasGroup: boolean;
  slide: CustomSlide;
  theme?: SlideTheme;
  masters?: SlideMaster[];
  editingMasterId?: string | null;
  onUpdateSlide: (next: CustomSlide) => void;
  onUpdateTheme: (next: Partial<SlideTheme>) => void;
  /** P5: apply a whole-theme preset (merges; respects explicit overrides). */
  onApplyThemePreset: (preset: ThemePreset) => void;
  onUpdateElement: (id: string, updates: Partial<SlideElement>) => void;
  onOpenBgPicker: () => void;
  onOpenBgVideoPicker: () => void;
  onSetBackground: (bg: SlideBackground) => void;
  onSaveAsTemplate: () => void;
  onAlign: (type: AlignmentAxis) => void;
  onZOrder: (dir: ZDirection) => void;
  /** P4: per-element z-order from the Layers panel. */
  onZOrderElement: (id: string, dir: ZDirection) => void;
  /** P4: select a single element (or add to selection with additive). */
  onSelectElement: (id: string, additive: boolean) => void;
  onLock: () => void;
  onDuplicateElement: () => void;
  onDeleteElement: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  // P4.2 — master editing
  onEnterMasterEdit: (masterId: string) => void;
  onExitMasterEdit: () => void;
  onCreateMaster: (name: string) => void;
  onApplyMaster: (masterId: string) => void;
  onDeleteMaster: (masterId: string) => void;
}

export function PropertiesPanel({
  activeEl,
  selectedCount,
  hasGroup,
  slide,
  theme,
  masters,
  editingMasterId,
  onUpdateSlide,
  onUpdateTheme,
  onApplyThemePreset,
  onUpdateElement,
  onOpenBgPicker,
  onOpenBgVideoPicker,
  onSetBackground,
  onSaveAsTemplate,
  onAlign,
  onZOrder,
  onZOrderElement,
  onSelectElement,
  onLock,
  onDuplicateElement,
  onDeleteElement,
  onGroup,
  onUngroup,
  onEnterMasterEdit,
  onExitMasterEdit,
  onCreateMaster,
  onApplyMaster,
  onDeleteMaster,
}: PropertiesPanelProps) {
  const bg = slide.background;
  const [masterNameOpen, setMasterNameOpen] = useState(false);
  const hasElement = selectedCount === 1 && !!activeEl;
  const headerName = activeEl ? generatedLayerName(activeEl, slide.elements) : selectedCount > 1 ? `${selectedCount} elements` : "Slide";

  const toggleLockEl = (id: string) => {
    const el = slide.elements.find(e => e.id === id);
    if (el) onUpdateElement(id, { locked: !el.locked });
  };
  const toggleHideEl = (id: string) => {
    const el = slide.elements.find(e => e.id === id);
    if (el) onUpdateElement(id, { hidden: !el.hidden });
  };
  const renameEl = (id: string, name: string) => onUpdateElement(id, name ? { name } : { name: undefined });

  return (
    <aside className="w-60 border-l border-console-border bg-console-surface flex flex-col overflow-hidden shrink-0">
      <div className="px-3 py-2.5 border-b border-console-border-strong flex items-center justify-between shrink-0">
        <span className="op-control-label text-console-text-subtle">
          {editingMasterId ? "Master layout" : headerName}
        </span>
        {selectedCount > 1 && <span className="text-[8px] text-tool-design font-bold">Ctrl+G to group</span>}
      </div>

      {/* P4.2 — master edit banner */}
      {editingMasterId && (
        <div className="px-3 py-2 border-b border-state-warning/20 bg-state-warning/10 flex items-center justify-between shrink-0">
          <span className="text-[9px] text-state-warning font-bold">
            Editing master — style changes cascade to slides
          </span>
          <button onClick={onExitMasterEdit} className="text-[9px] text-state-warning hover:text-console-text font-bold underline shrink-0">
            Done
          </button>
        </div>
      )}

      {/* P4 — single scrollable column of collapsible sections replaces the
          equal-width tab bar (§5.6). Sections auto-open by context so the
          operator lands on the relevant controls and advanced options stay
          collapsed by default. */}
      <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-2.5 custom-scrollbar">

        <InspectorSection label="Layers" badge={`${slide.elements.length}`} defaultOpen={!hasElement}>
          <LayersPanel
            elements={slide.elements}
            activeElementIds={activeEl && selectedCount === 1 ? [activeEl.id] : []}
            onSelectElement={onSelectElement}
            onToggleLock={toggleLockEl}
            onToggleHide={toggleHideEl}
            onRenameElement={renameEl}
            onZOrderElement={onZOrderElement}
          />
        </InspectorSection>

        {/* ── Slide section (always shown; default-open with no selection) ── */}
        <InspectorSection label="Slide" defaultOpen={!hasElement}>
          <Panel label="Background">
            <div className="flex flex-wrap gap-1">
              {(["color", "image", "video", "gradient"] as const).map(t => (
                <button key={t} onClick={() => {
                  if (t === "color") onSetBackground({ type: "color", value: bg.type === "color" ? bg.value : "#1a1a2e" });
                  else if (t === "gradient") onSetBackground({ type: "gradient", from: bg.type === "gradient" ? bg.from : "#1a1a2e", to: bg.type === "gradient" ? bg.to : "#0a0a18", angle: bg.type === "gradient" ? bg.angle : 135 });
                  else onSetBackground({ type: t, value: "" });
                }} className={`flex-1 py-1.5 text-[9px] font-bold rounded-lg capitalize transition-all ${bg.type === t ? "bg-tool-design text-console-text" : "bg-console-surface-raised text-console-text-muted hover:text-console-text hover:bg-console-surface-strong"}`}>
                  {t}
                </button>
              ))}
            </div>

            {bg.type === "color" && (
              <div className="flex items-center gap-3 mt-1">
                <input type="color" value={bg.value} onChange={e => onSetBackground({ type: "color", value: e.target.value })} className="w-9 h-9 rounded-lg cursor-pointer border border-console-border bg-transparent shrink-0" />
                <span className="text-xs text-console-text-muted font-mono">{bg.value}</span>
              </div>
            )}

            {bg.type === "image" && <>
              <button onClick={onOpenBgPicker} className="w-full px-3 py-2 bg-console-surface-raised hover:bg-console-surface-strong text-console-text-muted hover:text-console-text text-[11px] font-semibold rounded-lg transition-all text-left mt-1">
                {bg.value ? "Change Image…" : "Set Image…"}
              </button>
              {bg.value && (
                <>
                  <div className="flex items-center justify-between bg-console-surface-raised p-2 rounded-lg border border-console-border mt-1">
                    <span className="text-[9px] text-console-text-muted truncate">{bg.value.split(/[/\\]/).pop()}</span>
                    <button onClick={() => onSetBackground({ type: "color", value: "#1a1a2e" })} className="text-state-live text-[9px] font-bold ml-2 shrink-0 hover:text-state-live">✕</button>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[9px] text-console-text-muted w-10">Fit</span>
                    <div className="flex gap-1 flex-1">
                      {(["cover", "contain", "fill"] as const).map(fit => (
                        <button
                          key={fit}
                          onClick={() => onSetBackground({ ...bg, objectFit: fit })}
                          className={`flex-1 py-1 text-[9px] font-bold rounded-lg capitalize transition-all ${(bg.objectFit ?? "cover") === fit ? "bg-tool-design text-console-text" : "bg-console-surface-raised text-console-text-muted hover:text-console-text hover:bg-console-surface-strong"}`}
                        >
                          {fit === "contain" ? "Fit" : fit === "cover" ? "Crop" : "Stretch"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[9px] text-console-text-muted w-10">Opacity</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={bg.opacity ?? 1}
                      onChange={e => onSetBackground({ ...bg, opacity: Number(e.target.value) })}
                      className="flex-1 accent-tool-design"
                    />
                    <span className="text-[9px] text-console-text-muted tabular-nums w-8 text-right">{Math.round((bg.opacity ?? 1) * 100)}%</span>
                  </div>
                </>
              )}
            </>}

            {bg.type === "video" && <>
              <button onClick={onOpenBgVideoPicker} className="w-full px-3 py-2 bg-tool-design/10 hover:bg-tool-design/20 text-tool-design hover:text-tool-design text-[11px] font-semibold rounded-lg transition-all text-left border border-tool-design/10 mt-1">
                {bg.value ? "Change Video…" : "Set Video…"}
              </button>
              {bg.value && (
                <div className="flex flex-col gap-2 bg-console-surface-raised p-2 rounded-lg border border-console-border mt-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-console-text-muted truncate">{bg.value.split(/[/\\]/).pop()}</span>
                    <button onClick={() => onSetBackground({ type: "color", value: "#1a1a2e" })} className="text-state-live text-[9px] font-bold ml-2 shrink-0 hover:text-state-live">✕</button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-console-text-muted w-10">Fit</span>
                    <div className="flex gap-1 flex-1">
                      {(["cover", "contain", "fill"] as const).map(fit => (
                        <button
                          key={fit}
                          onClick={() => onSetBackground({ ...bg, objectFit: fit })}
                          className={`flex-1 py-1 text-[9px] font-bold rounded-lg capitalize transition-all ${(bg.objectFit ?? "cover") === fit ? "bg-tool-design text-console-text" : "bg-console-surface-raised text-console-text-muted hover:text-console-text hover:bg-console-surface-strong"}`}
                        >
                          {fit === "contain" ? "Fit" : fit === "cover" ? "Crop" : "Stretch"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-console-text-muted w-10">Opacity</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={bg.opacity ?? 1}
                      onChange={e => onSetBackground({ ...bg, opacity: Number(e.target.value) })}
                      className="flex-1 accent-tool-design"
                    />
                    <span className="text-[9px] text-console-text-muted tabular-nums w-8 text-right">{Math.round((bg.opacity ?? 1) * 100)}%</span>
                  </div>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={bg.loop !== false} onChange={e => onSetBackground({ ...bg, loop: e.target.checked })} className="accent-tool-design" />
                    <span className="text-[9px] text-console-text-muted">Loop</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={bg.muted !== false} onChange={e => onSetBackground({ ...bg, muted: e.target.checked })} className="accent-tool-design" />
                    <span className="text-[9px] text-console-text-muted">Muted</span>
                  </label>
                </div>
              )}
            </>}

            {bg.type === "gradient" && (
              <div className="flex flex-col gap-2 mt-1">
                <div className="flex items-center gap-2">
                  <input type="color" value={bg.from} onChange={e => onSetBackground({ ...bg, from: e.target.value })} className="w-8 h-8 rounded-lg cursor-pointer border border-console-border bg-transparent shrink-0" />
                  <input type="color" value={bg.to} onChange={e => onSetBackground({ ...bg, to: e.target.value })} className="w-8 h-8 rounded-lg cursor-pointer border border-console-border bg-transparent shrink-0" />
                  <input type="number" min={0} max={360} value={bg.angle} onChange={e => onSetBackground({ ...bg, angle: Number(e.target.value) })} onKeyDown={e => e.stopPropagation()} className="w-12 bg-console-surface-raised border border-console-border rounded-lg px-2 py-1 text-xs text-console-text outline-none focus:border-tool-design/60 transition-colors" />
                  <span className="text-[9px] text-console-text-subtle">°</span>
                </div>
                <div className="h-6 rounded-lg border border-console-border" style={{ background: `linear-gradient(${bg.angle}deg, ${bg.from}, ${bg.to})` }} />
              </div>
            )}
          </Panel>

          <Panel label="Theme">
            <label className="text-[9px] text-console-text-muted uppercase font-bold">Default font</label>
            <input
              type="text"
              value={theme?.defaultFontFamily ?? ""}
              onChange={e => onUpdateTheme({ defaultFontFamily: e.target.value })}
              onKeyDown={e => e.stopPropagation()}
              placeholder="Arial"
              className="w-full bg-console-surface-raised border border-console-border rounded-lg px-2 py-1 text-[11px] text-console-text outline-none focus:border-tool-design/60 transition-colors"
            />
            <label className="text-[9px] text-console-text-muted uppercase font-bold mt-1">Default size</label>
            <input
              type="number"
              min={8}
              max={200}
              value={theme?.defaultFontSize ?? 32}
              onChange={e => onUpdateTheme({ defaultFontSize: Number(e.target.value) })}
              onKeyDown={e => e.stopPropagation()}
              className="w-full bg-console-surface-raised border border-console-border rounded-lg px-2 py-1 text-[11px] text-console-text outline-none focus:border-tool-design/60 transition-colors"
            />
            <div className="flex items-center gap-3 mt-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-console-text-muted">{`Text`}</span>
                <input
                  type="color"
                  value={theme?.textColor ?? "#ffffff"}
                  onChange={e => onUpdateTheme({ textColor: e.target.value })}
                  className="w-7 h-7 rounded-lg cursor-pointer border border-console-border bg-transparent"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-console-text-muted">Accent</span>
                <input
                  type="color"
                  value={theme?.accentColor ?? "#f59e0b"}
                  onChange={e => onUpdateTheme({ accentColor: e.target.value })}
                  className="w-7 h-7 rounded-lg cursor-pointer border border-console-border bg-transparent"
                />
              </div>
            </div>
          </Panel>

          <Panel label="Theme presets">
            <ThemePicker theme={theme} onApplyPreset={onApplyThemePreset} />
            <p className="text-[8px] text-console-text-subtle leading-relaxed mt-1">
              Presets set theme colors &amp; fonts — elements using "inherit" update; explicit overrides are kept.
            </p>
          </Panel>

          <Panel label="Speaker Notes">
            <textarea
              value={slide.notes || ""}
              onChange={e => onUpdateSlide({ ...slide, notes: e.target.value })}
              onKeyDown={e => e.stopPropagation()}
              placeholder="Notes for this slide (not shown on output)..."
              className="w-full bg-console-surface-raised border border-console-border rounded-lg px-3 py-2 text-[11px] text-console-text placeholder:text-console-text-subtle outline-none focus:border-tool-design/60 transition-colors resize-none h-20 custom-scrollbar"
            />
          </Panel>
        </InspectorSection>

        {/* ── Element sections (shown when a single element is selected) ── */}
        {hasElement && <>
          <InspectorSection label="Layout" defaultOpen>
            <div className="flex gap-1.5">
              <button onClick={onLock}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[10px] font-bold transition-all border ${activeEl!.locked ? "bg-state-warning/15 border-state-warning/30 text-state-warning" : "bg-console-surface-raised border-console-border text-console-text-muted hover:text-console-text"}`}>
                {activeEl!.locked ? <Lock size={11} /> : <Unlock size={11} />}{activeEl!.locked ? "Locked" : "Lock"}
              </button>
              <button onClick={onDuplicateElement} className="px-3 py-2 bg-console-surface-raised hover:bg-console-surface-strong border border-console-border text-console-text-muted hover:text-console-text rounded-xl transition-all" aria-label="Duplicate element" title="Duplicate"><Copy size={13} /></button>
              <button onClick={onDeleteElement} disabled={!!activeEl!.locked} className="px-3 py-2 bg-console-surface-raised hover:bg-state-live-soft border border-console-border text-console-text-muted hover:text-state-live rounded-xl transition-all disabled:opacity-30" aria-label="Delete element" title="Delete"><Trash2 size={13} /></button>
            </div>

            <Panel label="Position & Size">
              <div className="grid grid-cols-2 gap-2">
                {([["X %", "x"], ["Y %", "y"], ["W %", "w"], ["H %", "h"]] as const).map(([lbl, key]) => (
                  <div key={key}>
                    <span className="op-control-label text-console-text-subtle">{lbl}</span>
                    <input type="number" value={Math.round((activeEl as any)[key])} onChange={e => onUpdateElement(activeEl!.id, { [key]: Number(e.target.value) })} onKeyDown={e => e.stopPropagation()} className="mt-1 w-full bg-console-surface-raised border border-console-border rounded-lg px-2 py-1.5 text-xs text-console-text outline-none focus:border-tool-design/60 transition-colors" />
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

            <Panel label="Rotate & Flip">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={Math.round(activeEl!.rotation ?? 0)}
                  onChange={e => onUpdateElement(activeEl!.id, { rotation: Number(e.target.value) })}
                  onKeyDown={e => e.stopPropagation()}
                  className="w-16 bg-console-surface-raised border border-console-border rounded-lg px-2 py-1.5 text-xs text-console-text outline-none focus:border-tool-design/60 transition-colors"
                />
                <span className="text-[9px] text-console-text-subtle">° (R / Shift+R ±15°)</span>
              </div>
              <div className="grid grid-cols-2 gap-1 mt-1">
                <button
                  onClick={() => onUpdateElement(activeEl!.id, { flipX: !activeEl!.flipX })}
                  className={`py-2 text-[10px] font-bold rounded-lg transition-all ${activeEl!.flipX ? "bg-state-warning/30 text-console-text" : "bg-console-surface-raised text-console-text-muted hover:text-console-text hover:bg-console-surface-strong"}`}
                >
                  Flip H
                </button>
                <button
                  onClick={() => onUpdateElement(activeEl!.id, { flipY: !activeEl!.flipY })}
                  className={`py-2 text-[10px] font-bold rounded-lg transition-all ${activeEl!.flipY ? "bg-state-warning/30 text-console-text" : "bg-console-surface-raised text-console-text-muted hover:text-console-text hover:bg-console-surface-strong"}`}
                >
                  Flip V
                </button>
              </div>
            </Panel>
          </InspectorSection>

          {activeEl!.kind === "text" && (() => {
            const el = activeEl as any;
            return (
            <InspectorSection label="Text" defaultOpen>
              <Panel label="Vertical Align">
                <div className="flex gap-1">
                  {(["top", "middle", "bottom"] as const).map(a => (
                    <button key={a} onClick={() => onUpdateElement(activeEl!.id, { v_align: a })} className={`flex-1 py-2 text-[10px] font-bold rounded-lg capitalize transition-all ${el.v_align === a || (!el.v_align && a === "top") ? "bg-tool-design text-console-text" : "bg-console-surface-raised text-console-text-muted hover:text-console-text hover:bg-console-surface-strong"}`}>
                      {a[0].toUpperCase() + a.slice(1)}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-1.5 cursor-pointer mt-1.5">
                  <input
                    type="checkbox"
                    checked={activeEl!.font_family === "inherit"}
                    onChange={e => onUpdateElement(activeEl!.id, { font_family: e.target.checked ? "inherit" : undefined })}
                    className="accent-tool-design"
                  />
                  <span className="text-[9px] text-console-text-muted">Inherit theme font</span>
                </label>
              </Panel>

              <Panel label="Auto-Size">
                <div className="flex gap-1">
                  {(["fixed", "shrink", "grow"] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => onUpdateElement(activeEl!.id, { autoSize: m })}
                      className={`flex-1 py-2 text-[10px] font-bold rounded-lg capitalize transition-all ${(el.autoSize ?? "fixed") === m ? "bg-tool-design text-console-text" : "bg-console-surface-raised text-console-text-muted hover:text-console-text hover:bg-console-surface-strong"}`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <p className="text-[8px] text-console-text-subtle leading-relaxed mt-1">
                  Fixed: keep declared size &nbsp;·&nbsp; Shrink: search largest size that fits the box &nbsp;·&nbsp; Grow: expand box to fit content.
                </p>
              </Panel>
            </InspectorSection>
            );
          })()}

          <InspectorSection label="Style" defaultOpen>
            {activeEl!.kind === "shape" && (
              <Panel label="Shape">
                <div className="flex flex-wrap gap-1">
                  {(["rect", "rounded", "circle", "line", "triangle"] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => onUpdateElement(activeEl!.id, { shape: s })}
                      className={`flex-1 min-w-[60px] py-1.5 text-[10px] font-bold rounded-lg capitalize transition-all ${((activeEl as any).shape ?? "rect") === s ? "bg-tool-design text-console-text" : "bg-console-surface-raised text-console-text-muted hover:text-console-text hover:bg-console-surface-strong"}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                {(activeEl as any).shape !== "line" && (
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[9px] text-console-text-muted w-8">Fill</span>
                    <input
                      type="color"
                      value={(activeEl as any).fillColor ?? (activeEl as any).color ?? "#6366f1"}
                      onChange={e => onUpdateElement(activeEl!.id, { fillColor: e.target.value })}
                      className="w-7 h-7 rounded-lg cursor-pointer border border-console-border bg-transparent"
                    />
                  </div>
                )}
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[9px] text-console-text-muted w-8">Stroke</span>
                  <input
                    type="color"
                    value={(activeEl as any).strokeColor ?? "#000000"}
                    onChange={e => onUpdateElement(activeEl!.id, { strokeColor: e.target.value })}
                    className="w-7 h-7 rounded-lg cursor-pointer border border-console-border bg-transparent"
                  />
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={Math.round((activeEl as any).strokeWidth ?? 0)}
                    placeholder="0"
                    onChange={e => onUpdateElement(activeEl!.id, { strokeWidth: Number(e.target.value) })}
                    onKeyDown={e => e.stopPropagation()}
                    className="w-14 bg-console-surface-raised border border-console-border rounded-lg px-2 py-1 text-xs text-console-text outline-none focus:border-tool-design/60 transition-colors"
                  />
                  <span className="text-[9px] text-console-text-subtle">px</span>
                </div>
                {(!(activeEl as any).shape || (activeEl as any).shape === "rect" || (activeEl as any).shape === "rounded") && (
                  <label className="flex items-center gap-2 mt-1 cursor-pointer">
                    <span className="text-[9px] text-console-text-muted w-8">Radius</span>
                    <input
                      type="range"
                      min={0}
                      max={96}
                      value={(activeEl as any).borderRadius ?? 0}
                      onChange={e => onUpdateElement(activeEl!.id, { borderRadius: Number(e.target.value) })}
                      className="flex-1 accent-tool-design"
                    />
                    <span className="text-[9px] text-console-text-muted tabular-nums w-6 text-right">{Math.round((activeEl as any).borderRadius ?? 0)}</span>
                  </label>
                )}
              </Panel>
            )}

            {activeEl!.kind === "image" && (
              <Panel label="Image">
                <label className="flex items-center gap-2 cursor-pointer">
                  <span className="text-[9px] text-console-text-muted w-16">Opacity</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={activeEl!.opacity ?? 1}
                    onChange={e => onUpdateElement(activeEl!.id, { opacity: Number(e.target.value) })}
                    className="flex-1 accent-tool-design"
                  />
                  <span className="text-[9px] text-console-text-muted tabular-nums w-6 text-right">{Math.round((activeEl!.opacity ?? 1) * 100)}%</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <span className="text-[9px] text-console-text-muted w-16">Fit</span>
                  <select
                    value={(activeEl as any).objectFit ?? "contain"}
                    onChange={e => onUpdateElement(activeEl!.id, { objectFit: e.target.value as "contain" | "cover" | "fill" })}
                    onKeyDown={e => e.stopPropagation()}
                    className="flex-1 bg-console-surface-raised border border-console-border rounded-lg px-2 py-1 text-[11px] text-console-text outline-none"
                    style={{ colorScheme: "dark" }}
                  >
                    <option value="contain">Contain</option>
                    <option value="cover">Cover</option>
                    <option value="fill">Fill</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 cursor-pointer mt-1">
                  <span className="text-[9px] text-console-text-muted w-16">Position</span>
                  <select
                    value={(activeEl as any).objectPosition ?? "center"}
                    onChange={e => onUpdateElement(activeEl!.id, { objectPosition: e.target.value })}
                    onKeyDown={e => e.stopPropagation()}
                    className="flex-1 bg-console-surface-raised border border-console-border rounded-lg px-2 py-1 text-[11px] text-console-text outline-none"
                    style={{ colorScheme: "dark" }}
                  >
                    {["top left","top center","top right","center left","center","center right","bottom left","bottom center","bottom right"].map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-2 cursor-pointer mt-1">
                  <span className="text-[9px] text-console-text-muted w-16">Filter</span>
                  <select
                    value={(activeEl as any).filter ?? "none"}
                    onChange={e => onUpdateElement(activeEl!.id, { filter: e.target.value as "none" | "grayscale" | "sepia" | "blur" | "brightness" })}
                    onKeyDown={e => e.stopPropagation()}
                    className="flex-1 bg-console-surface-raised border border-console-border rounded-lg px-2 py-1 text-[11px] text-console-text outline-none"
                    style={{ colorScheme: "dark" }}
                  >
                    <option value="none">None</option>
                    <option value="grayscale">Grayscale</option>
                    <option value="sepia">Sepia</option>
                    <option value="blur">Blur</option>
                    <option value="brightness">Brightness</option>
                  </select>
                </label>
                {((activeEl as any).filter && (activeEl as any).filter !== "none") && (
                  <label className="flex items-center gap-2 cursor-pointer mt-1">
                    <span className="text-[9px] text-console-text-muted w-16">Strength</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={(activeEl as any).filterValue ?? 0}
                      onChange={e => onUpdateElement(activeEl!.id, { filterValue: Number(e.target.value) })}
                      className="flex-1 accent-tool-design"
                    />
                    <span className="text-[9px] text-console-text-muted tabular-nums w-6 text-right">{Math.round((activeEl as any).filterValue ?? 0)}</span>
                  </label>
                )}
                <label className="flex items-center gap-2 cursor-pointer mt-1">
                  <span className="text-[9px] text-console-text-muted w-16">Radius</span>
                  <input
                    type="range"
                    min={0}
                    max={96}
                    value={(activeEl as any).borderRadius ?? 0}
                    onChange={e => onUpdateElement(activeEl!.id, { borderRadius: Number(e.target.value) })}
                    className="flex-1 accent-tool-design"
                  />
                  <span className="text-[9px] text-console-text-muted tabular-nums w-6 text-right">{Math.round((activeEl as any).borderRadius ?? 0)}</span>
                </label>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[9px] text-console-text-muted w-16">Border</span>
                  <input
                    type="color"
                    value={(activeEl as any).border?.color ?? "#ffffff"}
                    onChange={e => onUpdateElement(activeEl!.id, { border: { color: e.target.value, width: (activeEl as any).border?.width ?? 1 } })}
                    className="w-7 h-7 rounded-lg cursor-pointer border border-console-border bg-transparent"
                  />
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={(activeEl as any).border?.width ?? 0}
                    onChange={e => onUpdateElement(activeEl!.id, { border: { color: (activeEl as any).border?.color ?? "#ffffff", width: Number(e.target.value) } })}
                    onKeyDown={e => e.stopPropagation()}
                    className="w-14 bg-console-surface-raised border border-console-border rounded-lg px-2 py-1 text-xs text-console-text outline-none focus:border-tool-design/60 transition-colors"
                  />
                  <span className="text-[9px] text-console-text-subtle">px</span>
                </div>
              </Panel>
            )}

            {activeEl!.kind === "video" && (
              <Panel label="Video">
                <label className="flex items-center gap-2 cursor-pointer">
                  <span className="text-[9px] text-console-text-muted w-16">Opacity</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={activeEl!.opacity ?? 1}
                    onChange={e => onUpdateElement(activeEl!.id, { opacity: Number(e.target.value) })}
                    className="flex-1 accent-tool-design"
                  />
                  <span className="text-[9px] text-console-text-muted tabular-nums w-6 text-right">{Math.round((activeEl!.opacity ?? 1) * 100)}%</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer mt-1">
                  <span className="text-[9px] text-console-text-muted w-16">Fit</span>
                  <select
                    value={(activeEl as any).objectFit ?? "contain"}
                    onChange={e => onUpdateElement(activeEl!.id, { objectFit: e.target.value as "contain" | "cover" | "fill" })}
                    onKeyDown={e => e.stopPropagation()}
                    className="flex-1 bg-console-surface-raised border border-console-border rounded-lg px-2 py-1 text-[11px] text-console-text outline-none"
                    style={{ colorScheme: "dark" }}
                  >
                    <option value="contain">Contain</option>
                    <option value="cover">Cover</option>
                    <option value="fill">Fill</option>
                  </select>
                </label>
              </Panel>
            )}
          </InspectorSection>

          <InspectorSection label="Motion" defaultOpen={false}>
            <Panel label="Entrance Animation">
              <select
                value={(activeEl as any).entrance?.type ?? "none"}
                onChange={e => {
                  const t = e.target.value as any;
                  onUpdateElement(activeEl!.id, t === "none"
                    ? { entrance: undefined }
                    : { entrance: { type: t, duration: 400, delay: 0 } });
                }}
                onKeyDown={e => e.stopPropagation()}
                className="w-full bg-console-surface-raised border border-console-border rounded-lg px-2 py-1.5 text-xs text-console-text outline-none focus:border-tool-design/60"
                style={{ colorScheme: "dark" }}
              >
                <option value="none">None</option>
                <option value="fade">Fade</option>
                <option value="slide-up">Slide up</option>
                <option value="slide-left">Slide left</option>
                <option value="zoom">Zoom</option>
              </select>
              {(activeEl as any).entrance && (activeEl as any).entrance.type !== "none" && (
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <label className="block">
                    <span className="text-[9px] text-console-text-muted block mb-1">Duration (ms)</span>
                    <input
                      type="number" min={0} step={50}
                      value={(activeEl as any).entrance.duration}
                      onChange={e => onUpdateElement(activeEl!.id, { entrance: { ...(activeEl as any).entrance!, duration: Number(e.target.value) } })}
                      onKeyDown={e => e.stopPropagation()}
                      className="w-full bg-console-surface-raised border border-console-border rounded-lg px-2 py-1.5 text-xs text-console-text outline-none focus:border-tool-design/60"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[9px] text-console-text-muted block mb-1">Delay (ms)</span>
                    <input
                      type="number" min={0} step={100}
                      value={(activeEl as any).entrance.delay}
                      onChange={e => onUpdateElement(activeEl!.id, { entrance: { ...(activeEl as any).entrance!, delay: Number(e.target.value) } })}
                      onKeyDown={e => e.stopPropagation()}
                      className="w-full bg-console-surface-raised border border-console-border rounded-lg px-2 py-1.5 text-xs text-console-text outline-none focus:border-tool-design/60"
                    />
                  </label>
                </div>
              )}
            </Panel>
          </InspectorSection>
        </>}

        {selectedCount > 1 && (
          <InspectorSection label="Arrange" defaultOpen>
            <div className="flex flex-col gap-2">
              <button onClick={onGroup} className="w-full flex items-center justify-center gap-1.5 py-2 bg-tool-design/20 hover:bg-tool-design/30 text-tool-design text-[10px] font-bold rounded-lg transition-all border border-tool-design/20">
                <Layers size={12} /> Group ({selectedCount} elements)
              </button>
              {hasGroup && (
                <button onClick={onUngroup} className="w-full flex items-center justify-center gap-1.5 py-2 bg-state-warning/15 hover:bg-state-warning/25 text-state-warning text-[10px] font-bold rounded-lg transition-all border border-state-warning/20">
                  <Layers size={12} /> Ungroup
                </button>
              )}
              <div className="grid grid-cols-3 gap-1">
                <IconBtn onClick={() => onAlign("left")} title="Left edge"><AlignLeft size={12} /></IconBtn>
                <IconBtn onClick={() => onAlign("center")} title="Center H"><AlignCenter size={12} /></IconBtn>
                <IconBtn onClick={() => onAlign("right")} title="Right edge"><AlignRight size={12} /></IconBtn>
              </div>
            </div>
          </InspectorSection>
        )}

        <InspectorSection label="Advanced" defaultOpen={false}>
          <Panel label="Template">
            <button onClick={onSaveAsTemplate} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-tool-design/20 hover:bg-tool-design/30 text-tool-design hover:text-tool-design text-[10px] font-bold rounded-lg transition-all border border-tool-design/20">
              <Library size={12} /> Save Slide as Template
            </button>
          </Panel>

          <Panel label="Create Master">
            <button
              onClick={() => setMasterNameOpen(true)}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-state-warning/15 hover:bg-state-warning/25 text-state-warning hover:text-state-warning text-[10px] font-bold rounded-lg transition-all border border-state-warning/20"
            >
              <Layers size={12} /> Create Master from this Slide
            </button>
            <p className="text-[8px] text-console-text-subtle leading-relaxed">
              Text elements auto-role (title/body/footer). Editing the master styles dependent slides.
            </p>
          </Panel>
          {masterNameOpen && (
            <TextInputModal
              title="Create Master"
              placeholder={`Master ${(masters?.length ?? 0) + 1}`}
              defaultValue={`Master ${(masters?.length ?? 0) + 1}`}
              confirmLabel="Create"
              onConfirm={name => { setMasterNameOpen(false); onCreateMaster(name); }}
              onCancel={() => setMasterNameOpen(false)}
            />
          )}

          <Panel label="Masters">
            {(masters && masters.length > 0) ? masters.map(m => (
              <div key={m.id} className="flex items-center justify-between bg-console-surface-raised p-2 rounded-lg border border-console-border">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-console-text truncate">{m.name}</p>
                  <p className="text-[8px] text-console-text-subtle">{m.elements.length} elements</p>
                </div>
                <div className="flex gap-1 shrink-0 ml-2">
                  <button onClick={() => onEnterMasterEdit(m.id)} className={`px-2 py-1 rounded-lg text-[9px] font-bold transition-all ${editingMasterId === m.id ? "bg-action-primary text-black" : "bg-console-surface-raised hover:bg-console-surface-strong text-console-text"}`} title="Edit master">{editingMasterId === m.id ? "Editing" : "Edit"}</button>
                  <button onClick={() => onApplyMaster(m.id)} className="px-2 py-1 rounded-lg bg-tool-design/20 hover:bg-tool-design/30 text-tool-design text-[9px] font-bold transition-all" title="Apply to this slide">Apply</button>
                  <button onClick={() => onDeleteMaster(m.id)} className="px-2 py-1 rounded-lg bg-state-live/10 hover:bg-state-live-soft text-state-live text-[9px] font-bold transition-all" title="Delete master">✕</button>
                </div>
              </div>
            )) : (
              <p className="text-[9px] text-console-text-subtle">No masters yet. Create one from the current slide.</p>
            )}
          </Panel>
        </InspectorSection>

        {selectedCount === 0 && (
          <p className="text-[10px] text-console-text-subtle text-center pt-2 leading-relaxed">
            Click to select · Ctrl+click for multi
          </p>
        )}
      </div>
    </aside>
  );
}