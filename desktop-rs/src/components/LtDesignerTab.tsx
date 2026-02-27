import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { LowerThirdOverlay } from "./shared/Renderers";
import { stableId } from "../utils";
import { FONTS } from "../types";
import { Monitor, Plus } from "lucide-react";
import { MediaPickerModal } from "./MediaPickerModal";
import type { LowerThirdTemplate } from "../types";

interface LtDesignerTabProps {
  onSetToast: (msg: string) => void;
  onLoadMedia: () => Promise<void>;
}

export function LtDesignerTab({ onSetToast, onLoadMedia }: LtDesignerTabProps) {
  const {
    ltTemplate, setLtTemplate,
    ltSavedTemplates, setLtSavedTemplates,
    ltMode, ltName, ltTitle, ltFreeText, ltLineIndex, ltLinesPerDisplay,
    showLtImgPicker, setShowLtImgPicker,
    media, songs, ltSongId
  } = useAppStore();

  const ltFlatLines = React.useMemo(() => {
    const song = songs.find(s => s.id === ltSongId);
    if (!song) return [];
    const flat: { text: string; sectionLabel: string }[] = [];
    const arr = song.arrangement;
    if (arr && arr.length > 0) {
      for (const lbl of arr) {
        const sec = song.sections.find((s) => s.label === lbl);
        if (sec) for (const line of sec.lines) flat.push({ text: line, sectionLabel: sec.label });
      }
    } else {
      for (const section of song.sections) for (const line of section.lines) flat.push({ text: line, sectionLabel: section.label });
    }
    return flat;
  }, [songs, ltSongId]);

  const saveTemplates = async (ts: LowerThirdTemplate[]) => {
    await invoke("save_lt_templates", { templates: ts });
    onSetToast("Templates saved");
  };

  const updateTpl = (patch: Partial<LowerThirdTemplate>) => {
    setLtTemplate(t => ({ ...t, ...patch }));
  };

  return (
    <div className="h-full flex overflow-hidden -m-4">
      <div className="w-80 border-r border-slate-800 p-4 overflow-y-auto space-y-4 bg-slate-900/50 shrink-0 custom-scrollbar">
        <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Template Management</p>
        <div className="flex gap-1.5">
          <select className="flex-1 bg-slate-950 text-slate-200 text-[10px] rounded p-1.5 border border-slate-800" value={ltTemplate.id} onChange={(e) => { const t = ltSavedTemplates.find(t => t.id === e.target.value); if (t) { setLtTemplate(t); localStorage.setItem("activeLtTemplateId", t.id); } }}>
            {ltSavedTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button onClick={() => { const n: LowerThirdTemplate = { ...ltTemplate, id: stableId(), name: "New Template" }; setLtTemplate(n); setLtSavedTemplates([...ltSavedTemplates, n]); }} className="p-1.5 bg-slate-800 rounded text-white"><Plus size={14} /></button>
          <button onClick={() => saveTemplates(ltSavedTemplates.map(t => t.id === ltTemplate.id ? ltTemplate : t))} className="px-3 bg-amber-600 rounded text-white text-[9px] font-bold">SAVE</button>
        </div>

        <div className="border-t border-slate-800 my-4" />
        <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Global Styles</p>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-[8px] text-slate-600 uppercase font-bold">Variant</span>
            <select value={ltTemplate.variant} onChange={(e) => updateTpl({ variant: e.target.value as any })} className="bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800">
              <option value="classic">Classic</option><option value="modern">Modern</option><option value="banner">Banner</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[8px] text-slate-600 uppercase font-bold">Anim</span>
            <select value={ltTemplate.animation} onChange={(e) => updateTpl({ animation: e.target.value as any })} className="bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800">
              <option value="slide-up">Slide Up</option><option value="slide-left">Slide Left</option><option value="fade">Fade</option><option value="none">None</option>
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[8px] text-slate-600 uppercase font-bold">Background</span>
          <div className="grid grid-cols-4 gap-1">
            {(["solid", "gradient", "image", "transparent"] as const).map(bt => (
              <button key={bt} onClick={() => updateTpl({ bgType: bt })} className={`text-[8px] font-bold py-1 rounded border transition-all ${ltTemplate.bgType === bt ? "bg-slate-700 border-slate-500 text-white" : "bg-slate-950 border-slate-800 text-slate-600"}`}>{bt.toUpperCase()}</button>
            ))}
          </div>
          {ltTemplate.bgType === "solid" && <div className="flex items-center gap-2 mt-2"><span className="text-[8px] text-slate-600 uppercase font-bold w-12">Color</span><input type="color" value={ltTemplate.bgColor} onChange={(e) => updateTpl({ bgColor: e.target.value })} className="flex-1 h-6 bg-transparent cursor-pointer" /></div>}
          {ltTemplate.bgType === "gradient" && (
            <div className="space-y-1 mt-2">
              <div className="flex items-center gap-2"><span className="text-[8px] text-slate-600 uppercase font-bold w-12">Start</span><input type="color" value={ltTemplate.bgColor} onChange={(e) => updateTpl({ bgColor: e.target.value })} className="flex-1 h-6 bg-transparent cursor-pointer" /></div>
              <div className="flex items-center gap-2"><span className="text-[8px] text-slate-600 uppercase font-bold w-12">End</span><input type="color" value={ltTemplate.bgGradientEnd} onChange={(e) => updateTpl({ bgGradientEnd: e.target.value })} className="flex-1 h-6 bg-transparent cursor-pointer" /></div>
            </div>
          )}
          {ltTemplate.bgType === "image" && <button onClick={() => setShowLtImgPicker(true)} className="mt-2 w-full py-1.5 px-2 bg-slate-950 border border-slate-800 rounded text-[9px] text-slate-400 truncate">{ltTemplate.bgImagePath ? ltTemplate.bgImagePath.split(/[/\\]/).pop() : "CHOOSE IMAGE..."}</button>}
          <div className="flex items-center gap-2 mt-2"><span className="text-[8px] text-slate-600 uppercase font-bold w-12">Opacity</span><input type="range" min={0} max={100} value={ltTemplate.bgOpacity} onChange={(e) => updateTpl({ bgOpacity: parseInt(e.target.value) })} className="flex-1 accent-amber-500" /></div>
          <div className="flex items-center justify-between"><span className="text-[8px] text-slate-600 uppercase font-bold">Blur</span><input type="checkbox" checked={ltTemplate.bgBlur} onChange={(e) => updateTpl({ bgBlur: e.target.checked })} /></div>
        </div>

        <div className="border-t border-slate-800 my-4" />
        <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Accent Bar</p>
        <div className="space-y-2">
          <div className="flex items-center justify-between"><span className="text-[8px] text-slate-600 uppercase font-bold">Enabled</span><input type="checkbox" checked={ltTemplate.accentEnabled} onChange={(e) => updateTpl({ accentEnabled: e.target.checked })} /></div>
          {ltTemplate.accentEnabled && (
            <>
              <div className="flex items-center gap-2"><span className="text-[8px] text-slate-600 uppercase font-bold w-12">Color</span><input type="color" value={ltTemplate.accentColor} onChange={(e) => updateTpl({ accentColor: e.target.value })} className="flex-1 h-6 bg-transparent cursor-pointer" /></div>
              <div className="flex items-center gap-2"><span className="text-[8px] text-slate-600 uppercase font-bold w-12">Width</span><input type="range" min={1} max={20} value={ltTemplate.accentWidth} onChange={(e) => updateTpl({ accentWidth: parseInt(e.target.value) })} className="flex-1 accent-amber-500" /></div>
            </>
          )}
        </div>

        <div className="border-t border-slate-800 my-4" />
        <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Typography</p>
        <div className="space-y-4">
          <div className="space-y-2">
            <span className="text-[8px] text-slate-600 uppercase font-bold">Primary (Name / Line 1)</span>
            <div className="flex gap-2 items-center">
              <select value={ltTemplate.primaryFont} onChange={(e) => updateTpl({ primaryFont: e.target.value })} className="flex-1 bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800">{FONTS.map(f => <option key={f} value={f}>{f}</option>)}</select>
              <input type="number" value={ltTemplate.primarySize} onChange={(e) => updateTpl({ primarySize: parseInt(e.target.value) })} className="w-12 bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800" />
              <input type="color" value={ltTemplate.primaryColor} onChange={(e) => updateTpl({ primaryColor: e.target.value })} className="w-8 h-8 cursor-pointer" />
            </div>
            <div className="flex gap-1">
              <button onClick={() => updateTpl({ primaryBold: !ltTemplate.primaryBold })} className={`flex-1 py-1 text-[9px] font-black rounded border ${ltTemplate.primaryBold ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-600"}`}>B</button>
              <button onClick={() => updateTpl({ primaryItalic: !ltTemplate.primaryItalic })} className={`flex-1 py-1 text-[9px] italic rounded border ${ltTemplate.primaryItalic ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-600"}`}>I</button>
              <button onClick={() => updateTpl({ primaryUppercase: !ltTemplate.primaryUppercase })} className={`flex-1 py-1 text-[9px] font-bold rounded border ${ltTemplate.primaryUppercase ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-600"}`}>AA</button>
            </div>
          </div>
          <div className="space-y-2">
            <span className="text-[8px] text-slate-600 uppercase font-bold">Secondary (Title / Line 2)</span>
            <div className="flex gap-2 items-center">
              <select value={ltTemplate.secondaryFont} onChange={(e) => updateTpl({ secondaryFont: e.target.value })} className="flex-1 bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800">{FONTS.map(f => <option key={f} value={f}>{f}</option>)}</select>
              <input type="number" value={ltTemplate.secondarySize} onChange={(e) => updateTpl({ secondarySize: parseInt(e.target.value) })} className="w-12 bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800" />
              <input type="color" value={ltTemplate.secondaryColor} onChange={(e) => updateTpl({ secondaryColor: e.target.value })} className="w-8 h-8 cursor-pointer" />
            </div>
          </div>
        </div>

        <div className="border-t border-slate-800 my-4" />
        <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Layout</p>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1"><span className="text-[8px] text-slate-600 uppercase font-bold">Width %</span><input type="range" min={10} max={100} value={ltTemplate.widthPct} onChange={(e) => updateTpl({ widthPct: parseInt(e.target.value) })} className="accent-amber-500" /></div>
          <div className="flex flex-col gap-1"><span className="text-[8px] text-slate-600 uppercase font-bold">Radius</span><input type="range" min={0} max={50} value={ltTemplate.borderRadius} onChange={(e) => updateTpl({ borderRadius: parseInt(e.target.value) })} className="accent-amber-500" /></div>
          <div className="flex flex-col gap-1"><span className="text-[8px] text-slate-600 uppercase font-bold">Offset X</span><input type="number" value={ltTemplate.offsetX} onChange={(e) => updateTpl({ offsetX: parseInt(e.target.value) })} className="bg-slate-950 text-slate-300 text-[10px] p-1 border border-slate-800" /></div>
          <div className="flex flex-col gap-1"><span className="text-[8px] text-slate-600 uppercase font-bold">Offset Y</span><input type="number" value={ltTemplate.offsetY} onChange={(e) => updateTpl({ offsetY: parseInt(e.target.value) })} className="bg-slate-950 text-slate-300 text-[10px] p-1 border border-slate-800" /></div>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center bg-black/40 p-8 overflow-hidden">
        <div className="relative aspect-video w-full bg-slate-900 rounded-lg overflow-hidden ring-1 ring-slate-800 shadow-2xl">
          <div className="absolute inset-0 flex items-center justify-center opacity-10"><Monitor size={64} /></div>
          <div style={{ position: "absolute", inset: 0, transform: "scale(0.5)", transformOrigin: "top left" }}>
            <div style={{ width: 1920, height: 1080 }}>
              <LowerThirdOverlay template={ltTemplate} data={ltMode === "nameplate" ? { kind: "Nameplate", data: { name: ltName || "Full Name", title: ltTitle || "Title" } } : ltMode === "freetext" ? { kind: "FreeText", data: { text: ltFreeText || "Message" } } : { kind: "Lyrics", data: { line1: ltFlatLines[ltLineIndex]?.text || "Lyric Line", line2: ltLinesPerDisplay === 2 ? ltFlatLines[ltLineIndex+1]?.text : undefined } }} />
            </div>
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
