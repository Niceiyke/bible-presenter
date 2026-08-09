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
import { Panel, IconBtn, TextBtn } from "./components";
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
  onUpdateElement: (id: string, updates: Partial<SlideElement>) => void;
  onOpenBgPicker: () => void;
  onOpenBgVideoPicker: () => void;
  onSetBackground: (bg: SlideBackground) => void;
  onSaveAsTemplate: () => void;
  onAlign: (type: AlignmentAxis) => void;
  onZOrder: (dir: ZDirection) => void;
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
  onUpdateElement,
  onOpenBgPicker,
  onOpenBgVideoPicker,
  onSetBackground,
  onSaveAsTemplate,
  onAlign,
  onZOrder,
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
  // P3.7 — tabbed layout. Active tab auto-jumps to "Element" when an
  // element is selected so the operator lands on its controls; returns
  // to "Design" when the selection is cleared.
  type Tab = "design" | "element" | "notes" | "template" | "master";
  const [activeTab, setActiveTab] = useState<Tab>("design");

  // Auto-jump to Element tab on single-element select, back to Design
  // on clear. Multi-select stays on whatever tab was active (the group
  // action lives on the Element tab anyway).
  React.useEffect(() => {
    if (selectedCount === 1) setActiveTab("element");
    else if (selectedCount === 0 && activeTab === "element") setActiveTab("design");
  }, [selectedCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const TABS: { id: Tab; label: string }[] = [
    { id: "design", label: "Design" },
    { id: "element", label: "Element" },
    { id: "notes", label: "Notes" },
    { id: "template", label: "Template" },
    { id: "master", label: "Master" },
  ];

  return (
    <aside className="w-60 border-l border-white/[0.06] bg-slate-900/70 backdrop-blur-xl flex flex-col overflow-hidden shrink-0">
      <div className="px-3 py-2.5 border-b border-white/[0.06] flex items-center justify-between shrink-0">
        <span className="text-[8px] font-black uppercase tracking-widest text-slate-600">
          {editingMasterId ? "Master layout" : activeEl ? `${activeEl.kind} element` : selectedCount > 1 ? `${selectedCount} elements` : "Slide"}
        </span>
        {selectedCount > 1 && <span className="text-[8px] text-indigo-400 font-bold">Ctrl+G to group</span>}
      </div>

      {/* P4.2 — master edit banner */}
      {editingMasterId && (
        <div className="px-3 py-2 border-b border-indigo-400/25 bg-indigo-500/10 flex items-center justify-between shrink-0">
          <span className="text-[9px] text-amber-300 font-bold">
            Editing master — style changes cascade to slides
          </span>
          <button onClick={onExitMasterEdit} className="text-[9px] text-amber-300 hover:text-white font-bold underline shrink-0">
            Done
          </button>
        </div>
      )}

      {/* P3.7 — tab bar. Sticky under the header; the active tab content
          scrolls independently below. */}
      <div className="flex border-b border-white/[0.06] shrink-0">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex-1 py-2 text-[9px] font-bold uppercase tracking-wide transition-all ${
              activeTab === t.id
                ? "text-white border-b-2 border-indigo-500 bg-white/4"
                : "text-slate-500 hover:text-slate-300 border-b-2 border-transparent"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3 custom-scrollbar">

      {/* ════════ DESIGN TAB ════════ */}
      {activeTab === "design" && <>
        <Panel label="Background">
          <div className="flex flex-wrap gap-1">
            {(["color", "image", "video", "gradient"] as const).map(t => (
              <button key={t} onClick={() => {
                if (t === "color") onSetBackground({ type: "color", value: bg.type === "color" ? bg.value : "#1a1a2e" });
                else if (t === "gradient") onSetBackground({ type: "gradient", from: bg.type === "gradient" ? bg.from : "#1a1a2e", to: bg.type === "gradient" ? bg.to : "#0a0a18", angle: bg.type === "gradient" ? bg.angle : 135 });
                else onSetBackground({ type: t, value: "" });
              }} className={`flex-1 py-1.5 text-[9px] font-bold rounded-lg capitalize transition-all ${bg.type === t ? "bg-indigo-500 text-white" : "bg-white/6 text-slate-400 hover:text-white hover:bg-white/10"}`}>
                {t}
              </button>
            ))}
          </div>

          {bg.type === "color" && (
            <div className="flex items-center gap-3 mt-1">
              <input type="color" value={bg.value} onChange={e => onSetBackground({ type: "color", value: e.target.value })} className="w-9 h-9 rounded-lg cursor-pointer border border-white/20 bg-transparent shrink-0" />
              <span className="text-xs text-slate-400 font-mono">{bg.value}</span>
            </div>
          )}

          {bg.type === "image" && <>
            <button onClick={onOpenBgPicker} className="w-full px-3 py-2 bg-white/6 hover:bg-white/10 text-slate-400 hover:text-slate-200 text-[11px] font-semibold rounded-lg transition-all text-left mt-1">
              {bg.value ? "Change Image…" : "Set Image…"}
            </button>
            {bg.value && (
              <>
                <div className="flex items-center justify-between bg-white/4 p-2 rounded-lg border border-white/[0.06] mt-1">
                  <span className="text-[9px] text-slate-500 truncate">{bg.value.split(/[/\\]/).pop()}</span>
                  <button onClick={() => onSetBackground({ type: "color", value: "#1a1a2e" })} className="text-red-400 text-[9px] font-bold ml-2 shrink-0 hover:text-red-300">✕</button>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[9px] text-slate-500 w-10">Fit</span>
                  <div className="flex gap-1 flex-1">
                    {(["cover", "contain", "fill"] as const).map(fit => (
                      <button
                        key={fit}
                        onClick={() => onSetBackground({ ...bg, objectFit: fit })}
                        className={`flex-1 py-1 text-[9px] font-bold rounded-lg capitalize transition-all ${(bg.objectFit ?? "cover") === fit ? "bg-indigo-500 text-white" : "bg-white/6 text-slate-500 hover:text-white hover:bg-white/10"}`}
                      >
                        {fit === "contain" ? "Fit" : fit === "cover" ? "Crop" : "Stretch"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[9px] text-slate-500 w-10">Opacity</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={bg.opacity ?? 1}
                    onChange={e => onSetBackground({ ...bg, opacity: Number(e.target.value) })}
                    className="flex-1 accent-indigo-500"
                  />
                  <span className="text-[9px] text-slate-400 tabular-nums w-8 text-right">{Math.round((bg.opacity ?? 1) * 100)}%</span>
                </div>
              </>
            )}
          </>}

          {bg.type === "video" && <>
            <button onClick={onOpenBgVideoPicker} className="w-full px-3 py-2 bg-purple-600/10 hover:bg-purple-600/20 text-purple-400 hover:text-purple-300 text-[11px] font-semibold rounded-lg transition-all text-left border border-purple-500/10 mt-1">
              {bg.value ? "Change Video…" : "Set Video…"}
            </button>
            {bg.value && (
              <div className="flex flex-col gap-2 bg-white/4 p-2 rounded-lg border border-white/[0.06] mt-1">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] text-slate-500 truncate">{bg.value.split(/[/\\]/).pop()}</span>
                  <button onClick={() => onSetBackground({ type: "color", value: "#1a1a2e" })} className="text-red-400 text-[9px] font-bold ml-2 shrink-0 hover:text-red-300">✕</button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-slate-500 w-10">Fit</span>
                  <div className="flex gap-1 flex-1">
                    {(["cover", "contain", "fill"] as const).map(fit => (
                      <button
                        key={fit}
                        onClick={() => onSetBackground({ ...bg, objectFit: fit })}
                        className={`flex-1 py-1 text-[9px] font-bold rounded-lg capitalize transition-all ${(bg.objectFit ?? "cover") === fit ? "bg-purple-500 text-white" : "bg-white/6 text-slate-500 hover:text-white hover:bg-white/10"}`}
                      >
                        {fit === "contain" ? "Fit" : fit === "cover" ? "Crop" : "Stretch"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-slate-500 w-10">Opacity</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={bg.opacity ?? 1}
                    onChange={e => onSetBackground({ ...bg, opacity: Number(e.target.value) })}
                    className="flex-1 accent-purple-500"
                  />
                  <span className="text-[9px] text-slate-400 tabular-nums w-8 text-right">{Math.round((bg.opacity ?? 1) * 100)}%</span>
                </div>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={bg.loop !== false} onChange={e => onSetBackground({ ...bg, loop: e.target.checked })} className="accent-purple-500" />
                  <span className="text-[9px] text-slate-500">Loop</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={bg.muted !== false} onChange={e => onSetBackground({ ...bg, muted: e.target.checked })} className="accent-purple-500" />
                  <span className="text-[9px] text-slate-500">Muted</span>
                </label>
              </div>
            )}
          </>}

          {bg.type === "gradient" && (
            <div className="flex flex-col gap-2 mt-1">
              <div className="flex items-center gap-2">
                <input type="color" value={bg.from} onChange={e => onSetBackground({ ...bg, from: e.target.value })} className="w-8 h-8 rounded-lg cursor-pointer border border-white/20 bg-transparent shrink-0" />
                <input type="color" value={bg.to} onChange={e => onSetBackground({ ...bg, to: e.target.value })} className="w-8 h-8 rounded-lg cursor-pointer border border-white/20 bg-transparent shrink-0" />
                <input type="number" min={0} max={360} value={bg.angle} onChange={e => onSetBackground({ ...bg, angle: Number(e.target.value) })} onKeyDown={e => e.stopPropagation()} className="w-12 bg-white/6 border border-white/10 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-indigo-500/50 transition-colors" />
                <span className="text-[9px] text-slate-600">°</span>
              </div>
              <div className="h-6 rounded-lg border border-white/[0.06]" style={{ background: `linear-gradient(${bg.angle}deg, ${bg.from}, ${bg.to})` }} />
            </div>
          )}
        </Panel>

        {/* ── Theme (P2.4) ── */}
        <Panel label="Theme">
          <label className="text-[9px] text-slate-500 uppercase font-bold">Default font</label>
          <input
            type="text"
            value={theme?.defaultFontFamily ?? ""}
            onChange={e => onUpdateTheme({ defaultFontFamily: e.target.value })}
            onKeyDown={e => e.stopPropagation()}
            placeholder="Arial"
            className="w-full bg-white/6 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-white outline-none focus:border-indigo-500/50 transition-colors"
          />
          <label className="text-[9px] text-slate-500 uppercase font-bold mt-1">Default size</label>
          <input
            type="number"
            min={8}
            max={200}
            value={theme?.defaultFontSize ?? 32}
            onChange={e => onUpdateTheme({ defaultFontSize: Number(e.target.value) })}
            onKeyDown={e => e.stopPropagation()}
            className="w-full bg-white/6 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-white outline-none focus:border-indigo-500/50 transition-colors"
          />
          <div className="flex items-center gap-3 mt-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-slate-500">{`Text`}</span>
              <input
                type="color"
                value={theme?.textColor ?? "#ffffff"}
                onChange={e => onUpdateTheme({ textColor: e.target.value })}
                className="w-7 h-7 rounded-lg cursor-pointer border border-white/20 bg-transparent"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-slate-500">Accent</span>
              <input
                type="color"
                value={theme?.accentColor ?? "#f59e0b"}
                onChange={e => onUpdateTheme({ accentColor: e.target.value })}
                className="w-7 h-7 rounded-lg cursor-pointer border border-white/20 bg-transparent"
              />
            </div>
          </div>
        </Panel>
      </>}

        {/* ════════ NOTES TAB ════════ */}
        {activeTab === "notes" && <>
        <Panel label="Speaker Notes">
          <textarea
            value={slide.notes || ""}
            onChange={e => onUpdateSlide({ ...slide, notes: e.target.value })}
            onKeyDown={e => e.stopPropagation()}
            placeholder="Notes for this slide (not shown on output)..."
            className="w-full bg-white/6 border border-white/10 rounded-lg px-3 py-2 text-[11px] text-slate-300 placeholder-slate-600 outline-none focus:border-indigo-500/50 transition-colors resize-none h-20 custom-scrollbar"
          />
        </Panel>
        </>}

        {/* ════════ TEMPLATE TAB ════════ */}
        {activeTab === "template" && <>
        <Panel label="Template">
          <button onClick={onSaveAsTemplate} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-purple-600/20 hover:bg-purple-600/30 text-purple-400 hover:text-purple-300 text-[10px] font-bold rounded-lg transition-all border border-purple-500/20">
            <Library size={12} /> Save Slide as Template
          </button>
        </Panel>
        </>}

        {/* ════════ MASTER TAB (P4.2) ════════ */}
        {activeTab === "master" && <>
        <Panel label="Create Master">
          <button
            onClick={() => { const name = window.prompt("Master name", `Master ${(masters?.length ?? 0) + 1}`); if (name !== null) onCreateMaster(name || `Master ${(masters?.length ?? 0) + 1}`); }}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 hover:text-indigo-200 text-[10px] font-bold rounded-lg transition-all border border-indigo-400/25"
          >
            <Layers size={12} /> Create Master from this Slide
          </button>
          <p className="text-[8px] text-slate-600 leading-relaxed">
            Text elements auto-role (title/body/footer). Editing the master styles dependent slides.
          </p>
        </Panel>
        <Panel label="Masters">
          {(masters && masters.length > 0) ? masters.map(m => (
            <div key={m.id} className="flex items-center justify-between bg-white/4 p-2 rounded-lg border border-white/[0.06]">
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-slate-300 truncate">{m.name}</p>
                <p className="text-[8px] text-slate-600">{m.elements.length} elements</p>
              </div>
              <div className="flex gap-1 shrink-0 ml-2">
                <button onClick={() => onEnterMasterEdit(m.id)} className={`px-2 py-1 rounded-lg text-[9px] font-bold transition-all ${editingMasterId === m.id ? "bg-amber-500 text-black" : "bg-white/8 hover:bg-white/14 text-slate-300"}`} title="Edit master">{editingMasterId === m.id ? "Editing" : "Edit"}</button>
                <button onClick={() => onApplyMaster(m.id)} className="px-2 py-1 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 text-[9px] font-bold transition-all" title="Apply to this slide">Apply</button>
                <button onClick={() => onDeleteMaster(m.id)} className="px-2 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/30 text-red-400 text-[9px] font-bold transition-all" title="Delete master">✕</button>
              </div>
            </div>
          )) : (
            <p className="text-[9px] text-slate-600">No masters yet. Create one from the current slide.</p>
          )}
        </Panel>
        </>}

        {/* ════════ ELEMENT TAB ════════ */}
        {activeTab === "element" && <>
        {activeEl && selectedCount === 1 && <>
          <div className="flex gap-1.5">
            <button onClick={onLock}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[10px] font-bold transition-all border ${activeEl.locked ? "bg-indigo-500/15 border-indigo-400/35 text-indigo-300" : "bg-white/6 border-white/[0.06] text-slate-400 hover:text-white"}`}>
              {activeEl.locked ? <Lock size={11} /> : <Unlock size={11} />}{activeEl.locked ? "Locked" : "Lock"}
            </button>
            <button onClick={onDuplicateElement} className="px-3 py-2 bg-white/6 hover:bg-white/12 border border-white/[0.06] text-slate-400 hover:text-white rounded-xl transition-all" title="Duplicate"><Copy size={13} /></button>
            <button onClick={onDeleteElement} className="px-3 py-2 bg-white/6 hover:bg-red-500/20 border border-white/[0.06] text-slate-500 hover:text-red-400 rounded-xl transition-all" title="Delete"><Trash2 size={13} /></button>
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
              <label className="flex items-center gap-1.5 cursor-pointer mt-1.5">
                <input
                  type="checkbox"
                  checked={activeEl.font_family === "inherit"}
                  onChange={e => onUpdateElement(activeEl.id, { font_family: e.target.checked ? "inherit" : undefined })}
                  className="accent-indigo-500"
                />
                <span className="text-[9px] text-slate-500">Inherit theme font</span>
              </label>
            </Panel>
          )}

          {(
            <Panel label="Entrance Animation">
              <select
                value={activeEl.entrance?.type ?? "none"}
                onChange={e => {
                  const t = e.target.value as any;
                  onUpdateElement(activeEl.id, t === "none"
                    ? { entrance: undefined }
                    : { entrance: { type: t, duration: 400, delay: 0 } });
                }}
                onKeyDown={e => e.stopPropagation()}
                className="w-full bg-white/8 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-indigo-500/50"
                style={{ colorScheme: "dark" }}
              >
                <option value="none">None</option>
                <option value="fade">Fade</option>
                <option value="slide-up">Slide up</option>
                <option value="slide-left">Slide left</option>
                <option value="zoom">Zoom</option>
              </select>
              {activeEl.entrance && activeEl.entrance.type !== "none" && (
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <label className="block">
                    <span className="text-[9px] text-slate-500 block mb-1">Duration (ms)</span>
                    <input
                      type="number" min={0} step={50}
                      value={activeEl.entrance.duration}
                      onChange={e => onUpdateElement(activeEl.id, { entrance: { ...activeEl.entrance!, duration: Number(e.target.value) } })}
                      onKeyDown={e => e.stopPropagation()}
                      className="w-full bg-white/6 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-indigo-500/50"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[9px] text-slate-500 block mb-1">Delay (ms)</span>
                    <input
                      type="number" min={0} step={100}
                      value={activeEl.entrance.delay}
                      onChange={e => onUpdateElement(activeEl.id, { entrance: { ...activeEl.entrance!, delay: Number(e.target.value) } })}
                      onKeyDown={e => e.stopPropagation()}
                      className="w-full bg-white/6 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-indigo-500/50"
                    />
                  </label>
                </div>
              )}
            </Panel>
          )}

          {activeEl.kind === "text" && (
            <Panel label="Auto-Size">
              <div className="flex gap-1">
                {(["fixed", "shrink", "grow"] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => onUpdateElement(activeEl.id, { autoSize: m })}
                    className={`flex-1 py-2 text-[10px] font-bold rounded-lg capitalize transition-all ${(activeEl.autoSize ?? "fixed") === m ? "bg-indigo-500 text-white" : "bg-white/6 text-slate-500 hover:text-white hover:bg-white/10"}`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <p className="text-[8px] text-slate-600 leading-relaxed mt-1">
                Fixed: keep declared size &nbsp;·&nbsp; Shrink: search largest size that fits the box &nbsp;·&nbsp; Grow: expand box to fit content.
              </p>
            </Panel>
          )}

          {/* P3.4 — rotation & flip apply to every element kind. */}
          <Panel label="Rotate & Flip">
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={Math.round(activeEl.rotation ?? 0)}
                onChange={e => onUpdateElement(activeEl.id, { rotation: Number(e.target.value) })}
                onKeyDown={e => e.stopPropagation()}
                className="w-16 bg-white/6 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-indigo-500/50 transition-colors"
              />
              <span className="text-[9px] text-slate-600">° (R / Shift+R ±15°)</span>
            </div>
            <div className="grid grid-cols-2 gap-1 mt-1">
              <button
                onClick={() => onUpdateElement(activeEl.id, { flipX: !activeEl.flipX })}
                className={`py-2 text-[10px] font-bold rounded-lg transition-all ${activeEl.flipX ? "bg-indigo-500/30 text-white" : "bg-white/6 text-slate-500 hover:text-white hover:bg-white/10"}`}
              >
                Flip H
              </button>
              <button
                onClick={() => onUpdateElement(activeEl.id, { flipY: !activeEl.flipY })}
                className={`py-2 text-[10px] font-bold rounded-lg transition-all ${activeEl.flipY ? "bg-indigo-500/30 text-white" : "bg-white/6 text-slate-500 hover:text-white hover:bg-white/10"}`}
              >
                Flip V
              </button>
            </div>
          </Panel>

          {/* P3.5 — shape-specific fields. Lives inside the
              `activeEl && selectedCount === 1` block so TS narrows
              SlideElement → ShapeElement. */}
          {activeEl.kind === "shape" && (
            <Panel label="Shape">
              <div className="flex flex-wrap gap-1">
                {(["rect", "rounded", "circle", "line", "triangle"] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => onUpdateElement(activeEl.id, { shape: s })}
                    className={`flex-1 min-w-[60px] py-1.5 text-[10px] font-bold rounded-lg capitalize transition-all ${(activeEl.shape ?? "rect") === s ? "bg-indigo-500 text-white" : "bg-white/6 text-slate-400 hover:text-white hover:bg-white/10"}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              {activeEl.shape !== "line" && (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[9px] text-slate-500 w-8">Fill</span>
                  <input
                    type="color"
                    value={activeEl.fillColor ?? activeEl.color ?? "#6366f1"}
                    onChange={e => onUpdateElement(activeEl.id, { fillColor: e.target.value })}
                    className="w-7 h-7 rounded-lg cursor-pointer border border-white/20 bg-transparent"
                  />
                </div>
              )}
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[9px] text-slate-500 w-8">Stroke</span>
                <input
                  type="color"
                  value={activeEl.strokeColor ?? "#000000"}
                  onChange={e => onUpdateElement(activeEl.id, { strokeColor: e.target.value })}
                  className="w-7 h-7 rounded-lg cursor-pointer border border-white/20 bg-transparent"
                />
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={Math.round(activeEl.strokeWidth ?? 0)}
                  placeholder="0"
                  onChange={e => onUpdateElement(activeEl.id, { strokeWidth: Number(e.target.value) })}
                  onKeyDown={e => e.stopPropagation()}
                  className="w-14 bg-white/6 border border-white/10 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-indigo-500/50 transition-colors"
                />
                <span className="text-[9px] text-slate-600">px</span>
              </div>
              {(!activeEl.shape || activeEl.shape === "rect" || activeEl.shape === "rounded") && (
                <label className="flex items-center gap-2 mt-1 cursor-pointer">
                  <span className="text-[9px] text-slate-500 w-8">Radius</span>
                  <input
                    type="range"
                    min={0}
                    max={96}
                    value={activeEl.borderRadius ?? 0}
                    onChange={e => onUpdateElement(activeEl.id, { borderRadius: Number(e.target.value) })}
                    className="flex-1 accent-indigo-500"
                  />
                  <span className="text-[9px] text-slate-400 tabular-nums w-6 text-right">{Math.round(activeEl.borderRadius ?? 0)}</span>
                </label>
              )}
            </Panel>
          )}

          {/* P3.6 — image-specific fields. Lives inside the
              `activeEl && selectedCount === 1` block. */}
          {activeEl.kind === "image" && (
            <Panel label="Image">
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-[9px] text-slate-500 w-16">Opacity</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={activeEl.opacity ?? 1}
                  onChange={e => onUpdateElement(activeEl.id, { opacity: Number(e.target.value) })}
                  className="flex-1 accent-indigo-500"
                />
                <span className="text-[9px] text-slate-400 tabular-nums w-6 text-right">{Math.round((activeEl.opacity ?? 1) * 100)}%</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-[9px] text-slate-500 w-16">Fit</span>
                <select
                  value={activeEl.objectFit ?? "contain"}
                  onChange={e => onUpdateElement(activeEl.id, { objectFit: e.target.value as "contain" | "cover" | "fill" })}
                  onKeyDown={e => e.stopPropagation()}
                  className="flex-1 bg-white/6 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-white outline-none"
                  style={{ colorScheme: "dark" }}
                >
                  <option value="contain">Contain</option>
                  <option value="cover">Cover</option>
                  <option value="fill">Fill</option>
                </select>
              </label>
              <label className="flex items-center gap-2 cursor-pointer mt-1">
                <span className="text-[9px] text-slate-500 w-16">Position</span>
                <select
                  value={activeEl.objectPosition ?? "center"}
                  onChange={e => onUpdateElement(activeEl.id, { objectPosition: e.target.value })}
                  onKeyDown={e => e.stopPropagation()}
                  className="flex-1 bg-white/6 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-white outline-none"
                  style={{ colorScheme: "dark" }}
                >
                  {["top left","top center","top right","center left","center","center right","bottom left","bottom center","bottom right"].map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2 cursor-pointer mt-1">
                <span className="text-[9px] text-slate-500 w-16">Filter</span>
                <select
                  value={activeEl.filter ?? "none"}
                  onChange={e => onUpdateElement(activeEl.id, { filter: e.target.value as "none" | "grayscale" | "sepia" | "blur" | "brightness" })}
                  onKeyDown={e => e.stopPropagation()}
                  className="flex-1 bg-white/6 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-white outline-none"
                  style={{ colorScheme: "dark" }}
                >
                  <option value="none">None</option>
                  <option value="grayscale">Grayscale</option>
                  <option value="sepia">Sepia</option>
                  <option value="blur">Blur</option>
                  <option value="brightness">Brightness</option>
                </select>
              </label>
              {(activeEl.filter && activeEl.filter !== "none") && (
                <label className="flex items-center gap-2 cursor-pointer mt-1">
                  <span className="text-[9px] text-slate-500 w-16">Strength</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={activeEl.filterValue ?? 0}
                    onChange={e => onUpdateElement(activeEl.id, { filterValue: Number(e.target.value) })}
                    className="flex-1 accent-indigo-500"
                  />
                  <span className="text-[9px] text-slate-400 tabular-nums w-6 text-right">{Math.round(activeEl.filterValue ?? 0)}</span>
                </label>
              )}
              <label className="flex items-center gap-2 cursor-pointer mt-1">
                <span className="text-[9px] text-slate-500 w-16">Radius</span>
                <input
                  type="range"
                  min={0}
                  max={96}
                  value={activeEl.borderRadius ?? 0}
                  onChange={e => onUpdateElement(activeEl.id, { borderRadius: Number(e.target.value) })}
                  className="flex-1 accent-indigo-500"
                />
                <span className="text-[9px] text-slate-400 tabular-nums w-6 text-right">{Math.round(activeEl.borderRadius ?? 0)}</span>
              </label>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[9px] text-slate-500 w-16">Border</span>
                <input
                  type="color"
                  value={activeEl.border?.color ?? "#ffffff"}
                  onChange={e => onUpdateElement(activeEl.id, { border: { color: e.target.value, width: activeEl.border?.width ?? 1 } })}
                  className="w-7 h-7 rounded-lg cursor-pointer border border-white/20 bg-transparent"
                />
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={activeEl.border?.width ?? 0}
                  onChange={e => onUpdateElement(activeEl.id, { border: { color: activeEl.border?.color ?? "#ffffff", width: Number(e.target.value) } })}
                  onKeyDown={e => e.stopPropagation()}
                  className="w-14 bg-white/6 border border-white/10 rounded-lg px-2 py-1 text-xs text-white outline-none focus:border-indigo-500/50 transition-colors"
                />
                <span className="text-[9px] text-slate-600">px</span>
              </div>
            </Panel>
          )}

          {/* P4.7 — video-specific fields: fit + opacity. Loop/mute stay on
              the toolbar for quick access. */}
          {activeEl.kind === "video" && (
            <Panel label="Video">
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-[9px] text-slate-500 w-16">Opacity</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={activeEl.opacity ?? 1}
                  onChange={e => onUpdateElement(activeEl.id, { opacity: Number(e.target.value) })}
                  className="flex-1 accent-indigo-500"
                />
                <span className="text-[9px] text-slate-400 tabular-nums w-6 text-right">{Math.round((activeEl.opacity ?? 1) * 100)}%</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer mt-1">
                <span className="text-[9px] text-slate-500 w-16">Fit</span>
                <select
                  value={activeEl.objectFit ?? "contain"}
                  onChange={e => onUpdateElement(activeEl.id, { objectFit: e.target.value as "contain" | "cover" | "fill" })}
                  onKeyDown={e => e.stopPropagation()}
                  className="flex-1 bg-white/6 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-white outline-none"
                  style={{ colorScheme: "dark" }}
                >
                  <option value="contain">Contain</option>
                  <option value="cover">Cover</option>
                  <option value="fill">Fill</option>
                </select>
              </label>
            </Panel>
          )}
        </>}

        {selectedCount > 1 && (
          <div className="flex flex-col gap-2">
            <button onClick={onGroup} className="w-full flex items-center justify-center gap-1.5 py-2 bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 text-[10px] font-bold rounded-lg transition-all border border-indigo-500/20">
              <Layers size={12} /> Group ({selectedCount} elements)
            </button>
            {hasGroup && (
              <button onClick={onUngroup} className="w-full flex items-center justify-center gap-1.5 py-2 bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 text-[10px] font-bold rounded-lg transition-all border border-indigo-400/25">
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
        </>}
      </div>
    </aside>
  );
}