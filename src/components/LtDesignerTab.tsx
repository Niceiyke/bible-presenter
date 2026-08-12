import React, { useRef, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeFile, readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "../store";
import { LowerThirdOverlay } from "./shared/Renderers";
import { stableId } from "../utils";
import { flattenSongForLowerThird } from "../utils/song";
import { FONTS } from "../types";
import {
  Monitor, Plus, Type, Palette, Move, Zap, Square,
  Image as ImageIcon, Download, Upload, Save, Copy,
  ChevronDown, ChevronRight, User, Music, MessageSquare,
} from "lucide-react";
import { MediaPickerModal } from "./MediaPickerModal";
import type { LowerThirdTemplate } from "../types";

interface LtDesignerTabProps {
  onSetToast: (msg: string) => void;
  onLoadMedia: () => Promise<void>;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function AccordionSection({
  title, icon: Icon, defaultOpen = true, children,
}: {
  title: string; icon: React.ElementType; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-slate-800/60 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full min-h-11 flex items-center justify-between px-4 py-3 hover:bg-slate-800/30 transition-colors group"
      >
        <div className="flex items-center gap-2">
          <Icon size={12} className="text-slate-500 group-hover:text-slate-400 transition-colors" />
          <span className="text-[11px] font-black uppercase tracking-widest text-console-text-muted group-hover:text-console-text transition-colors">
            {title}
          </span>
        </div>
        {open
          ? <ChevronDown size={10} className="text-slate-600" />
          : <ChevronRight size={10} className="text-slate-600" />}
      </button>
      {open && <div className="px-4 pb-4 space-y-3">{children}</div>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 min-h-8">
      <span className="text-[10px] text-console-text-muted uppercase font-bold tracking-wide shrink-0">{label}</span>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

function SliderRow({ label, min, max, step = 1, value, onChange, unit = "" }: {
  label: string; min: number; max: number; step?: number; value: number;
  onChange: (v: number) => void; unit?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-console-text-muted uppercase font-bold tracking-wide">{label}</span>
        <span className="text-[11px] text-action-primary font-mono tabular-nums">{value}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(step < 1 ? parseFloat(e.target.value) : parseInt(e.target.value))}
        aria-label={label}
        className="w-full h-1.5 accent-amber-500 cursor-pointer"
      />
    </div>
  );
}

function ColorSwatch({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const id = `cs-${label.replace(/\s/g, "")}`;
  return (
    <label htmlFor={id} className="flex items-center gap-1.5 cursor-pointer group">
      <div
        className="w-6 h-6 rounded border-2 border-slate-700 group-hover:border-amber-500/50 transition-colors shadow-inner shrink-0"
        style={{ background: value }}
      />
      <span className="text-[9px] font-mono text-slate-500 group-hover:text-slate-400 transition-colors">{value.toUpperCase()}</span>
      <input type="color" id={id} value={value} onChange={e => onChange(e.target.value)} className="sr-only" />
    </label>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      aria-label="Toggle setting"
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${checked ? "bg-action-primary" : "bg-slate-700 hover:bg-slate-600"}`}
    >
      <div
        className="absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all duration-150"
        style={{ left: checked ? "20px" : "4px" }}
      />
    </button>
  );
}

function StyleBtns({
  bold, italic, uppercase, onBold, onItalic, onUppercase,
}: {
  bold: boolean; italic: boolean; uppercase: boolean;
  onBold: () => void; onItalic: () => void; onUppercase: () => void;
}) {
  const cls = (active: boolean) =>
    `w-8 h-7 rounded border transition-all text-[11px] ${
      active
        ? "bg-amber-500/15 border-amber-500/40 text-amber-400"
        : "bg-slate-900 border-slate-700 text-slate-500 hover:text-white hover:border-slate-500"
    }`;
  return (
    <div className="flex gap-1">
      <button onClick={onBold} className={cls(bold)} style={{ fontWeight: "bold" }}>B</button>
      <button onClick={onItalic} className={cls(italic)} style={{ fontStyle: "italic" }}>I</button>
      <button onClick={onUppercase} className={`${cls(uppercase)} text-[9px] font-bold`}>Aa</button>
    </div>
  );
}

/** Visual 9-point alignment picker that looks like a screen grid */
function AlignmentGrid({
  vAlign, hAlign, onChange,
}: {
  vAlign: string;
  hAlign: string;
  onChange: (v: "top" | "middle" | "bottom", h: "left" | "center" | "right") => void;
}) {
  const cells = [
    ["top", "left"], ["top", "center"], ["top", "right"],
    ["middle", "left"], ["middle", "center"], ["middle", "right"],
    ["bottom", "left"], ["bottom", "center"], ["bottom", "right"],
  ] as const;

  const labels: Record<string, string> = {
    "top-left": "↖", "top-center": "↑", "top-right": "↗",
    "middle-left": "←", "middle-center": "·", "middle-right": "→",
    "bottom-left": "↙", "bottom-center": "↓", "bottom-right": "↘",
  };

  return (
    <div className="space-y-1.5">
      <span className="text-[9px] text-slate-500 uppercase font-bold tracking-wide">Position</span>
      <div className="relative w-32 h-24 rounded-lg bg-slate-950 border border-slate-700 overflow-hidden">
        {/* Grid lines */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute inset-x-0 top-1/3 h-px bg-slate-800" />
          <div className="absolute inset-x-0 top-2/3 h-px bg-slate-800" />
          <div className="absolute inset-y-0 left-1/3 w-px bg-slate-800" />
          <div className="absolute inset-y-0 left-2/3 w-px bg-slate-800" />
        </div>
        <div className="grid grid-cols-3 h-full">
          {cells.map(([v, h]) => {
            const active = vAlign === v && hAlign === h;
            const key = `${v}-${h}`;
            return (
              <button
                key={key}
                onClick={() => onChange(v, h)}
                title={`${v} ${h}`}
                className={`flex items-center justify-center text-[14px] transition-all hover:bg-amber-500/10 ${
                  active ? "bg-amber-500/20" : ""
                }`}
              >
                <span className={`transition-all ${active ? "text-amber-400 scale-125" : "text-slate-700 hover:text-slate-500"}`}>
                  {labels[key]}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="text-[10px] leading-relaxed text-console-text-subtle">
        Active: <span className="text-amber-400 font-bold">{vAlign} {hAlign}</span>
      </p>
      <p className="text-[10px] leading-relaxed text-console-text-subtle">Offsets use the nearest canvas edge, or the canvas center for middle/center.</p>
    </div>
  );
}

function PillGroup<T extends string>({
  options, value, onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex bg-slate-950 rounded-lg border border-slate-800 p-0.5 gap-0.5">
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`flex-1 py-1 px-2 rounded text-[9px] font-bold uppercase tracking-wide transition-all ${
            value === opt.value
              ? "bg-slate-700 text-amber-400 shadow-inner"
              : "text-slate-600 hover:text-slate-300"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function LtDesignerTab({ onSetToast, onLoadMedia }: LtDesignerTabProps) {
  const {
    ltTemplate, setLtTemplate,
    ltSavedTemplates, setLtSavedTemplates,
    ltMode, ltName, ltTitle, ltFreeText, ltLineIndex, ltLinesPerDisplay,
    showLtImgPicker, setShowLtImgPicker,
    media, songs, ltSongId,
    ltPreviewBg, setLtPreviewBg,
  } = useAppStore();

  const ltFlatLines = React.useMemo(() => {
    const song = songs.find(s => s.id === ltSongId);
    return flattenSongForLowerThird(song);
  }, [songs, ltSongId]);

  // Dynamic preview scaling
  const previewRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);

  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      const availableWidth = Math.max(0, width - 64);
      const availableHeight = Math.max(0, height - 64);
      if (availableWidth > 0 && availableHeight > 0) {
        setScale(Math.min(availableWidth / 1920, availableHeight / 1080));
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Preview mode (what content to show in preview)
  const [previewMode, setPreviewMode] = useState<"nameplate" | "lyrics" | "freetext">("nameplate");

  const saveTemplates = async (ts: LowerThirdTemplate[], msg = "Template saved") => {
    try {
      await invoke("save_lt_templates", { templates: ts });
      setLtSavedTemplates(ts);
      emit("lower-third-template-sync", ts);
      onSetToast(msg);
    } catch {
      onSetToast("Save failed");
    }
  };

  const updateTpl = (patch: Partial<LowerThirdTemplate>) => {
    const next = { ...ltTemplate, ...patch };
    setLtTemplate(next);
    emit("lower-third-template-sync", [next]);
  };

  const handleSave = () => {
    const exists = ltSavedTemplates.some(t => t.id === ltTemplate.id);
    const newList = exists
      ? ltSavedTemplates.map(t => t.id === ltTemplate.id ? ltTemplate : t)
      : [...ltSavedTemplates, ltTemplate];
    saveTemplates(newList);
    localStorage.setItem("activeLtTemplateId", ltTemplate.id);
  };

  const handleDuplicate = () => {
    const n: LowerThirdTemplate = { ...ltTemplate, id: stableId(), name: `${ltTemplate.name} Copy` };
    saveTemplates([...ltSavedTemplates, n], "Template duplicated");
    setLtTemplate(n);
    localStorage.setItem("activeLtTemplateId", n.id);
  };

  const exportTemplate = async () => {
    try {
      const path = await save({
        filters: [{ name: "Lower Third Template", extensions: ["lttemplate"] }],
        defaultPath: `${ltTemplate.name.replace(/\s+/g, "_").toLowerCase()}.lttemplate`,
      });
      if (path) {
        await writeFile(path, new TextEncoder().encode(JSON.stringify(ltTemplate, null, 2)));
        onSetToast("Exported");
      }
    } catch { onSetToast("Export failed"); }
  };

  const importTemplate = async () => {
    try {
      const path = await open({ multiple: false, filters: [{ name: "Lower Third Template", extensions: ["lttemplate"] }] });
      if (path && typeof path === "string") {
        const imported = JSON.parse(await readTextFile(path)) as LowerThirdTemplate;
        imported.id = stableId();
        setLtTemplate(imported);
        setLtSavedTemplates([...ltSavedTemplates, imported]);
        onSetToast("Imported");
      }
    } catch { onSetToast("Invalid template file"); }
  };

  // Preview data
  const previewData =
    previewMode === "nameplate"
      ? { kind: "Nameplate" as const, data: { name: ltName || "Full Name", title: ltTitle || "Title / Role" } }
      : previewMode === "freetext"
      ? { kind: "FreeText" as const, data: { text: ltFreeText || "Custom broadcast message text goes here" } }
      : {
          kind: "Lyrics" as const,
          data: {
            line1: ltFlatLines[ltLineIndex]?.text || "Amazing grace, how sweet the sound",
            line2: ltLinesPerDisplay === 2 ? (ltFlatLines[ltLineIndex + 1]?.text || "That saved a wretch like me") : undefined,
            section_label: ltFlatLines[ltLineIndex]?.sectionLabel || "Verse 1",
          },
        };

  const bgClass =
    ltPreviewBg === "green"
      ? "bg-[#00b140]"
      : ltPreviewBg === "checkered"
      ? "bg-[length:20px_20px] [background-image:linear-gradient(45deg,#333_25%,transparent_25%),linear-gradient(-45deg,#333_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#333_75%),linear-gradient(-45deg,transparent_75%,#333_75%)] [background-position:0_0,0_10px,10px_-10px,-10px_0px] bg-[#1e1e1e]"
      : "bg-slate-900";

  return (
    <div className="h-full min-h-0 flex overflow-hidden bg-console-canvas">
      {/* ── LEFT PANEL ───────────────────────────────────────────────────── */}
      <div className="w-[18rem] max-w-[34vw] shrink-0 border-r border-console-border flex flex-col overflow-hidden bg-console-surface">

        {/* Template Manager */}
        <div className="px-4 py-3 border-b border-console-border space-y-2 bg-console-surface-raised/40 shrink-0">
          <p className="text-[10px] font-black uppercase tracking-widest text-console-text-muted">Template</p>
          <div className="flex items-center gap-1.5">
            <select
              className="flex-1 min-w-0 bg-slate-950 text-slate-200 text-[11px] rounded-lg px-2 py-1.5 border border-slate-800 outline-none focus:border-amber-500/50 transition-colors"
              value={ltTemplate.id}
              onChange={e => {
                const t = ltSavedTemplates.find(t => t.id === e.target.value);
                if (t) { setLtTemplate(t); localStorage.setItem("activeLtTemplateId", t.id); }
              }}
            >
              {ltSavedTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button onClick={handleDuplicate} className="min-w-9 min-h-9 p-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-all" title="Duplicate">
              <Copy size={12} />
            </button>
            <button onClick={handleSave} className="min-w-9 min-h-9 p-1.5 bg-action-primary hover:bg-action-primary-hover rounded-lg text-black transition-all" title="Save">
              <Save size={12} />
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              value={ltTemplate.name}
              onChange={e => updateTpl({ name: e.target.value })}
              placeholder="Template name"
              className="flex-1 min-w-0 bg-slate-950 text-slate-300 text-[10px] px-2 py-1 rounded-lg border border-slate-800 outline-none focus:border-amber-500/40"
            />
            <button onClick={exportTemplate} title="Export" className="min-w-9 min-h-9 p-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-500 hover:text-slate-300 transition-all">
              <Download size={12} />
            </button>
            <button onClick={importTemplate} title="Import" className="min-w-9 min-h-9 p-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-slate-500 hover:text-slate-300 transition-all">
              <Upload size={12} />
            </button>
          </div>
        </div>

        {/* Settings Sections */}
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">

          {/* Position & Layout */}
          <AccordionSection title="Position & Layout" icon={Move}>
            <AlignmentGrid
              vAlign={ltTemplate.vAlign}
              hAlign={ltTemplate.hAlign}
              onChange={(v, h) => updateTpl({ vAlign: v, hAlign: h })}
            />

            <div className="pt-1 space-y-3">
              <SliderRow label="Width" min={10} max={100} value={ltTemplate.widthPct} onChange={v => updateTpl({ widthPct: v })} unit="%" />
              <SliderRow label="Offset X" min={-960} max={960} value={ltTemplate.offsetX} onChange={v => updateTpl({ offsetX: v })} unit="px" />
              <SliderRow label="Offset Y" min={-540} max={540} value={ltTemplate.offsetY} onChange={v => updateTpl({ offsetY: v })} unit="px" />
              <SliderRow label="Pad X" min={0} max={120} value={ltTemplate.paddingX} onChange={v => updateTpl({ paddingX: v })} unit="px" />
              <SliderRow label="Pad Y" min={0} max={80} value={ltTemplate.paddingY} onChange={v => updateTpl({ paddingY: v })} unit="px" />
              <SliderRow label="Radius" min={0} max={100} value={ltTemplate.borderRadius} onChange={v => updateTpl({ borderRadius: v })} unit="px" />
            </div>

            <Row label="Full Width">
              <button
                onClick={() => updateTpl({ widthPct: 100, borderRadius: 0, hAlign: "center", offsetX: 0 })}
                className={`px-2.5 py-1 rounded text-[9px] font-bold border transition-all ${
                  ltTemplate.widthPct >= 100
                    ? "bg-amber-500/15 border-amber-500/40 text-amber-400"
                    : "bg-slate-900 border-slate-700 text-slate-500 hover:text-white hover:border-slate-500"
                }`}
              >
                Apply
              </button>
            </Row>
          </AccordionSection>

          {/* Background */}
          <AccordionSection title="Background" icon={Palette}>
            <PillGroup
              options={[
                { value: "solid", label: "Solid" },
                { value: "gradient", label: "Grad" },
                { value: "image", label: "Image" },
                { value: "transparent", label: "None" },
              ]}
              value={ltTemplate.bgType as any}
              onChange={v => updateTpl({ bgType: v })}
            />

            {ltTemplate.bgType === "solid" && (
              <Row label="Color">
                <ColorSwatch value={ltTemplate.bgColor} onChange={v => updateTpl({ bgColor: v })} label="bg-solid" />
              </Row>
            )}
            {ltTemplate.bgType === "gradient" && (
              <div className="space-y-2">
                <Row label="From"><ColorSwatch value={ltTemplate.bgColor} onChange={v => updateTpl({ bgColor: v })} label="grad-start" /></Row>
                <Row label="To"><ColorSwatch value={ltTemplate.bgGradientEnd} onChange={v => updateTpl({ bgGradientEnd: v })} label="grad-end" /></Row>
              </div>
            )}
            {ltTemplate.bgType === "image" && (
              <button
                onClick={() => setShowLtImgPicker(true)}
                className="w-full py-2 px-3 bg-slate-950 border border-slate-800 rounded-lg text-[10px] text-slate-400 flex items-center gap-2 hover:border-slate-600 transition-colors"
              >
                <ImageIcon size={11} />
                <span className="truncate">{ltTemplate.bgImagePath ? ltTemplate.bgImagePath.split(/[/\\]/).pop() : "Choose image…"}</span>
              </button>
            )}

            <SliderRow label="Opacity" min={0} max={100} value={ltTemplate.bgOpacity} onChange={v => updateTpl({ bgOpacity: v })} unit="%" />

            <Row label="Glass Blur"><Toggle checked={ltTemplate.bgBlur} onChange={v => updateTpl({ bgBlur: v })} /></Row>
            {ltTemplate.bgBlur && (
              <SliderRow label="Blur Amt" min={0} max={40} value={ltTemplate.bgBlurAmount} onChange={v => updateTpl({ bgBlurAmount: v })} unit="px" />
            )}

            <div className="pt-2 border-t border-slate-800/40 space-y-2">
              <Row label="Box Shadow"><Toggle checked={ltTemplate.boxShadow} onChange={v => updateTpl({ boxShadow: v })} /></Row>
              {ltTemplate.boxShadow && (
                <div className="space-y-2 pl-2 border-l-2 border-slate-800">
                  <Row label="Shadow Color">
                    <ColorSwatch value={ltTemplate.boxShadowColor} onChange={v => updateTpl({ boxShadowColor: v })} label="shadow-col" />
                  </Row>
                  <SliderRow label="Shadow Blur" min={0} max={100} value={ltTemplate.boxShadowBlur} onChange={v => updateTpl({ boxShadowBlur: v })} unit="px" />
                </div>
              )}
            </div>
          </AccordionSection>

          {/* Borders & Accents */}
          <AccordionSection title="Borders & Accents" icon={Square}>
            <Row label="Accent Bar"><Toggle checked={ltTemplate.accentEnabled} onChange={v => updateTpl({ accentEnabled: v })} /></Row>
            {ltTemplate.accentEnabled && (
              <div className="space-y-2 pl-2 border-l-2 border-slate-800">
                <PillGroup
                  options={[
                    { value: "left", label: "L" },
                    { value: "right", label: "R" },
                    { value: "top", label: "T" },
                    { value: "bottom", label: "B" },
                  ]}
                  value={ltTemplate.accentSide as any}
                  onChange={v => updateTpl({ accentSide: v })}
                />
                <Row label="Color">
                  <ColorSwatch value={ltTemplate.accentColor} onChange={v => updateTpl({ accentColor: v })} label="accent-col" />
                </Row>
                <SliderRow label="Width" min={1} max={40} value={ltTemplate.accentWidth} onChange={v => updateTpl({ accentWidth: v })} unit="px" />
              </div>
            )}

            <div className="pt-2 border-t border-slate-800/40 space-y-2">
              <Row label="Full Border"><Toggle checked={ltTemplate.borderEnabled} onChange={v => updateTpl({ borderEnabled: v })} /></Row>
              {ltTemplate.borderEnabled && (
                <div className="space-y-2 pl-2 border-l-2 border-slate-800">
                  <Row label="Color">
                    <ColorSwatch value={ltTemplate.borderColor} onChange={v => updateTpl({ borderColor: v })} label="border-col" />
                  </Row>
                  <SliderRow label="Width" min={1} max={20} value={ltTemplate.borderWidth} onChange={v => updateTpl({ borderWidth: v })} unit="px" />
                </div>
              )}
            </div>
          </AccordionSection>

          {/* Typography */}
          <AccordionSection title="Typography" icon={Type}>
            {/* Primary */}
            <div className="space-y-2">
              <p className="text-[9px] font-black uppercase tracking-widest text-amber-500/70">Primary — Name / Line 1</p>
              <select
                value={ltTemplate.primaryFont}
                onChange={e => updateTpl({ primaryFont: e.target.value })}
                className="w-full bg-slate-950 text-slate-300 text-[11px] p-1.5 rounded-lg border border-slate-800 outline-none"
              >
                {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <SliderRow label="Size" min={12} max={120} value={ltTemplate.primarySize} onChange={v => updateTpl({ primarySize: v })} unit="px" />
                </div>
                <ColorSwatch value={ltTemplate.primaryColor} onChange={v => updateTpl({ primaryColor: v })} label="p-col" />
              </div>
              <StyleBtns
                bold={ltTemplate.primaryBold} italic={ltTemplate.primaryItalic} uppercase={ltTemplate.primaryUppercase}
                onBold={() => updateTpl({ primaryBold: !ltTemplate.primaryBold })}
                onItalic={() => updateTpl({ primaryItalic: !ltTemplate.primaryItalic })}
                onUppercase={() => updateTpl({ primaryUppercase: !ltTemplate.primaryUppercase })}
              />
            </div>

            {/* Secondary */}
            <div className="space-y-2 pt-3 border-t border-slate-800/40">
              <p className="text-[9px] font-black uppercase tracking-widest text-amber-500/70">Secondary — Title / Line 2</p>
              <select
                value={ltTemplate.secondaryFont}
                onChange={e => updateTpl({ secondaryFont: e.target.value })}
                className="w-full bg-slate-950 text-slate-300 text-[11px] p-1.5 rounded-lg border border-slate-800 outline-none"
              >
                {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <SliderRow label="Size" min={10} max={80} value={ltTemplate.secondarySize} onChange={v => updateTpl({ secondarySize: v })} unit="px" />
                </div>
                <ColorSwatch value={ltTemplate.secondaryColor} onChange={v => updateTpl({ secondaryColor: v })} label="s-col" />
              </div>
              <StyleBtns
                bold={ltTemplate.secondaryBold} italic={ltTemplate.secondaryItalic} uppercase={ltTemplate.secondaryUppercase}
                onBold={() => updateTpl({ secondaryBold: !ltTemplate.secondaryBold })}
                onItalic={() => updateTpl({ secondaryItalic: !ltTemplate.secondaryItalic })}
                onUppercase={() => updateTpl({ secondaryUppercase: !ltTemplate.secondaryUppercase })}
              />
            </div>

            {/* Text Effects */}
            <div className="pt-3 border-t border-slate-800/40 space-y-3">
              <Row label="Text Shadow"><Toggle checked={ltTemplate.textShadow} onChange={v => updateTpl({ textShadow: v })} /></Row>
              {ltTemplate.textShadow && (
                <div className="space-y-2 pl-2 border-l-2 border-slate-800">
                  <Row label="Color"><ColorSwatch value={ltTemplate.textShadowColor} onChange={v => updateTpl({ textShadowColor: v })} label="tshadow-col" /></Row>
                  <SliderRow label="Blur" min={0} max={20} value={ltTemplate.textShadowBlur} onChange={v => updateTpl({ textShadowBlur: v })} unit="px" />
                </div>
              )}

              <Row label="Text Outline"><Toggle checked={ltTemplate.textOutline} onChange={v => updateTpl({ textOutline: v })} /></Row>
              {ltTemplate.textOutline && (
                <div className="space-y-2 pl-2 border-l-2 border-slate-800">
                  <Row label="Color"><ColorSwatch value={ltTemplate.textOutlineColor} onChange={v => updateTpl({ textOutlineColor: v })} label="tout-col" /></Row>
                  <SliderRow label="Width" min={0.1} max={5} step={0.1} value={ltTemplate.textOutlineWidth} onChange={v => updateTpl({ textOutlineWidth: v })} unit="px" />
                </div>
              )}

              <Row label="Max Lines">
                <input
                  type="number" min={0} max={10} value={ltTemplate.maxLines}
                  onChange={e => updateTpl({ maxLines: parseInt(e.target.value) })}
                  className="w-14 bg-slate-950 text-slate-300 text-[10px] px-2 py-1 rounded border border-slate-800 outline-none text-center"
                />
              </Row>
            </div>
          </AccordionSection>

          {/* Motion */}
          <AccordionSection title="Motion & Variants" icon={Zap} defaultOpen={false}>
            <div className="space-y-3">
              <div className="space-y-1">
                <span className="text-[9px] text-slate-500 uppercase font-bold tracking-wide">Variant</span>
                <PillGroup
                  options={[
                    { value: "classic", label: "Classic" },
                    { value: "modern", label: "Modern" },
                    { value: "banner", label: "Banner" },
                  ]}
                  value={ltTemplate.variant as any}
                  onChange={v => updateTpl({ variant: v })}
                />
              </div>

              <div className="space-y-1">
                <span className="text-[9px] text-slate-500 uppercase font-bold tracking-wide">Animation</span>
                <PillGroup
                  options={[
                    { value: "slide-up", label: "Up" },
                    { value: "slide-left", label: "Left" },
                    { value: "fade", label: "Fade" },
                    { value: "none", label: "None" },
                  ]}
                  value={ltTemplate.animation as any}
                  onChange={v => updateTpl({ animation: v })}
                />
              </div>

              <SliderRow label="Enter" min={0.1} max={3} step={0.1} value={ltTemplate.animationDuration} onChange={v => updateTpl({ animationDuration: v })} unit="s" />
              <SliderRow label="Exit" min={0.1} max={3} step={0.1} value={ltTemplate.exitDuration} onChange={v => updateTpl({ exitDuration: v })} unit="s" />

              {!ltTemplate.scrollEnabled && (
                <SliderRow label="Auto Hide" min={0} max={60} value={ltTemplate.autoHideSeconds} onChange={v => updateTpl({ autoHideSeconds: v })} unit="s" />
              )}

              {ltTemplate.variant === "banner" && (
                <Row label="Badge Text">
                  <input
                    type="text" value={ltTemplate.bannerBadgeText}
                    onChange={e => updateTpl({ bannerBadgeText: e.target.value })}
                    placeholder="LIVE"
                    className="w-20 bg-slate-950 text-slate-300 text-[10px] px-2 py-1 rounded border border-slate-800 outline-none"
                  />
                </Row>
              )}

              <div className="pt-2 border-t border-slate-800/40 space-y-2">
                <Row label="Ticker Scroll"><Toggle checked={ltTemplate.scrollEnabled} onChange={v => updateTpl({ scrollEnabled: v })} /></Row>
                {ltTemplate.scrollEnabled && (
                  <div className="space-y-2 pl-2 border-l-2 border-slate-800">
                    <Row label="Direction">
                      <PillGroup
                        options={[{ value: "rtl", label: "RTL" }, { value: "ltr", label: "LTR" }]}
                        value={ltTemplate.scrollDirection as any}
                        onChange={v => updateTpl({ scrollDirection: v })}
                      />
                    </Row>
                    <SliderRow label="Speed" min={1} max={10} value={ltTemplate.scrollSpeed} onChange={v => updateTpl({ scrollSpeed: v })} />
                    <Row label="Separator">
                      <input
                        type="text" value={ltTemplate.scrollSeparator}
                        onChange={e => updateTpl({ scrollSeparator: e.target.value })}
                        className="w-20 bg-slate-950 text-slate-300 text-[10px] px-2 py-1 rounded border border-slate-800 outline-none"
                      />
                    </Row>
                    <Row label="Cycles (0=∞)">
                      <input
                        type="number" min={0} max={100} value={ltTemplate.scrollCount}
                        onChange={e => updateTpl({ scrollCount: parseInt(e.target.value) })}
                        className="w-14 bg-slate-950 text-slate-300 text-[10px] px-2 py-1 rounded border border-slate-800 outline-none text-center"
                      />
                    </Row>
                    <SliderRow label="Auto Hide" min={0} max={120} value={ltTemplate.autoHideSeconds} onChange={v => updateTpl({ autoHideSeconds: v })} unit="s" />
                  </div>
                )}
              </div>
            </div>
          </AccordionSection>
        </div>
      </div>

      {/* ── RIGHT: PREVIEW ───────────────────────────────────────────────── */}
      <div className="min-w-0 flex-1 flex flex-col overflow-hidden bg-console-canvas">

        {/* Preview toolbar */}
        <div className="min-h-12 border-b border-console-border flex flex-wrap items-center justify-between gap-3 px-4 py-2 shrink-0 bg-console-surface/70">
          <div className="flex items-center gap-2">
            <Monitor size={13} className="text-slate-600" />
            <div>
              <span className="text-[11px] font-black uppercase tracking-widest text-console-text">Output Preview</span>
              <span className="block text-[10px] text-console-text-subtle">1920 × 1080 safe canvas</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Preview mode */}
            <div className="flex items-center gap-1 bg-slate-900 rounded-lg border border-slate-800 p-0.5">
              {([
                { mode: "nameplate" as const, icon: User, label: "Nameplate" },
                { mode: "lyrics" as const, icon: Music, label: "Lyrics" },
                { mode: "freetext" as const, icon: MessageSquare, label: "Free Text" },
              ]).map(({ mode, icon: Icon, label }) => (
                <button
                  key={mode}
                  onClick={() => setPreviewMode(mode)}
                  title={label}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[9px] font-bold transition-all ${
                    previewMode === mode
                      ? "bg-slate-700 text-amber-400"
                      : "text-slate-600 hover:text-slate-400"
                  }`}
                >
                  <Icon size={11} />
                  <span>{label}</span>
                </button>
              ))}
            </div>

            {/* Background */}
            <div className="flex items-center gap-1 bg-slate-900 rounded-lg border border-slate-800 p-0.5">
              {(["dark", "green", "checkered"] as const).map(bg => (
                <button
                  key={bg}
                  onClick={() => setLtPreviewBg(bg)}
                  className={`px-2.5 py-1 rounded text-[9px] font-bold uppercase transition-all ${
                    ltPreviewBg === bg ? "bg-slate-700 text-amber-400" : "text-slate-600 hover:text-slate-400"
                  }`}
                >
                  {bg}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Canvas — dynamically scaled */}
        <div ref={previewRef} className="relative min-h-0 flex-1 flex items-center justify-center overflow-hidden p-8">
          <div
            className={`relative rounded-xl overflow-hidden shadow-[0_0_60px_rgba(0,0,0,0.6)] ring-1 ring-white/8 ${bgClass}`}
            style={{ width: Math.round(1920 * scale), height: Math.round(1080 * scale) }}
          >
            {/* Subtle screen label */}
            {ltPreviewBg === "dark" && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-[0.03]">
                <Monitor size={200} />
              </div>
            )}

            {/* The actual 1920×1080 canvas, scaled to fit */}
            <div
              style={{
                width: 1920,
                height: 1080,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
                position: "absolute",
                top: 0,
                left: 0,
              }}
            >
              <LowerThirdOverlay template={ltTemplate} data={previewData} />
            </div>
          </div>

          {/* Scale indicator */}
          <div className="absolute bottom-3 right-4 text-[9px] text-slate-700 font-mono">
            {Math.round(scale * 100)}% scale
          </div>
        </div>
      </div>

      {showLtImgPicker && (
        <MediaPickerModal
          images={media.filter(m => m.media_type === "Image")}
          onSelect={path => updateTpl({ bgImagePath: path })}
          onClose={() => setShowLtImgPicker(false)}
          onUpload={onLoadMedia}
        />
      )}
    </div>
  );
}
