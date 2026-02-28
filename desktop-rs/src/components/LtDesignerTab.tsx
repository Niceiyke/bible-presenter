import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeFile, readTextFile } from "@tauri-apps/plugin-fs";
import { useAppStore } from "../store";
import { LowerThirdOverlay } from "./shared/Renderers";
import { stableId, hexToRgba } from "../utils";
import { FONTS } from "../types";
import { Monitor, Plus, AlignLeft, AlignCenter, AlignRight, Type, Palette, Move, Zap, Layout, Scissors, Square, Image as ImageIcon, Download, Upload } from "lucide-react";
import { MediaPickerModal } from "./MediaPickerModal";
import type { LowerThirdTemplate } from "../types";

interface LtDesignerTabProps {
  onSetToast: (msg: string) => void;
  onLoadMedia: () => Promise<void>;
}

function Section({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <div className="space-y-3 pb-4 border-b border-slate-800/50">
      <div className="flex items-center gap-2 text-slate-500">
        <Icon size={12} />
        <span className="text-[10px] font-black uppercase tracking-widest">{title}</span>
      </div>
      <div className="space-y-3 px-1">{children}</div>
    </div>
  );
}

function ControlGroup({ label, children, vertical = false }: { label: string; children: React.ReactNode; vertical?: boolean }) {
  return (
    <div className={`flex ${vertical ? 'flex-col gap-1.5' : 'items-center justify-between gap-4'}`}>
      <span className="text-[9px] text-slate-500 uppercase font-bold shrink-0">{label}</span>
      <div className={vertical ? 'w-full' : 'flex-1 flex justify-end'}>{children}</div>
    </div>
  );
}

export function LtDesignerTab({ onSetToast, onLoadMedia }: LtDesignerTabProps) {
  const {
    ltTemplate, setLtTemplate,
    ltSavedTemplates, setLtSavedTemplates,
    ltMode, ltName, ltTitle, ltFreeText, ltLineIndex, ltLinesPerDisplay,
    showLtImgPicker, setShowLtImgPicker,
    media, songs, ltSongId,
    ltPreviewBg, setLtPreviewBg
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
    try {
      await invoke("save_lt_templates", { templates: ts });
      setLtSavedTemplates(ts);
      emit("lower-third-template-sync", ts);
      onSetToast("Templates saved");
    } catch (err) {
      console.error("Save failed:", err);
      onSetToast("Save failed");
    }
  };

  const updateTpl = (patch: Partial<LowerThirdTemplate>) => {
    const next = { ...ltTemplate, ...patch };
    setLtTemplate(next);
    // Also sync to other windows immediately
    emit("lower-third-template-sync", [next]);
  };

  const exportTemplate = async () => {
    try {
      const path = await save({
        filters: [{ name: "Lower Third Template", extensions: ["lttemplate"] }],
        defaultPath: `${ltTemplate.name.replace(/\s+/g, '_').toLowerCase()}.lttemplate`
      });
      if (path) {
        const content = JSON.stringify(ltTemplate, null, 2);
        await writeFile(path, new TextEncoder().encode(content));
        onSetToast("Template exported");
      }
    } catch (err) {
      console.error("Export failed:", err);
      onSetToast("Export failed");
    }
  };

  const importTemplate = async () => {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Lower Third Template", extensions: ["lttemplate"] }]
      });
      if (path && typeof path === 'string') {
        const content = await readTextFile(path);
        const imported = JSON.parse(content) as LowerThirdTemplate;
        // Generate new ID to avoid conflicts
        imported.id = stableId();
        setLtTemplate(imported);
        setLtSavedTemplates([...ltSavedTemplates, imported]);
        onSetToast("Template imported");
      }
    } catch (err) {
      console.error("Import failed:", err);
      onSetToast("Invalid template file");
    }
  };

  return (
    <div className="h-full flex overflow-hidden">
      {/* Sidebar */}
      <div className="w-80 border-r border-slate-800 p-4 overflow-y-auto space-y-6 bg-slate-900/50 shrink-0 custom-scrollbar">
        {/* Template Manager */}
        <div className="space-y-2">
          <p className="text-[9px] font-black text-amber-500/80 uppercase tracking-widest">Template Management</p>
          <div className="flex gap-1.5">
            <select className="flex-1 bg-slate-950 text-slate-200 text-[11px] rounded p-2 border border-slate-800 focus:border-amber-500/50 outline-none" value={ltTemplate.id} onChange={(e) => { const t = ltSavedTemplates.find(t => t.id === e.target.value); if (t) { setLtTemplate(t); localStorage.setItem("activeLtTemplateId", t.id); } }}>
              {ltSavedTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button onClick={async () => { 
              const n: LowerThirdTemplate = { ...ltTemplate, id: stableId(), name: `${ltTemplate.name} (Copy)` }; 
              const newList = [...ltSavedTemplates, n];
              setLtSavedTemplates(newList);
              setLtTemplate(n); 
              await invoke("save_lt_templates", { templates: newList });
              onSetToast("New template created");
            }} className="p-2 bg-slate-800 hover:bg-slate-700 rounded text-white transition-colors" title="Duplicate"><Plus size={14} /></button>
            <button onClick={() => saveTemplates(ltSavedTemplates.map(t => t.id === ltTemplate.id ? ltTemplate : t))} className="px-4 bg-amber-600 hover:bg-amber-500 rounded text-white text-[10px] font-bold transition-colors">SAVE</button>
          </div>
          <div className="flex gap-1.5">
            <input 
              type="text" 
              value={ltTemplate.name} 
              onChange={(e) => updateTpl({ name: e.target.value })}
              placeholder="Template Name"
              className="flex-1 bg-slate-950/50 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800/50"
            />
            <button onClick={exportTemplate} className="p-1.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-400" title="Export File"><Download size={14} /></button>
            <button onClick={importTemplate} className="p-1.5 bg-slate-800 hover:bg-slate-700 rounded text-slate-400" title="Import File"><Upload size={14} /></button>
          </div>
        </div>

        {/* Layout */}
        <Section title="Layout & Positioning" icon={Move}>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-slate-500 uppercase font-bold">Alignment</span>
                <button 
                  onClick={() => updateTpl({ widthPct: 100, borderRadius: 0, hAlign: "center", offsetX: 0 })}
                  className={`text-[8px] font-black px-2 py-0.5 rounded border transition-all ${ltTemplate.widthPct === 100 && ltTemplate.borderRadius === 0 ? 'bg-amber-500 text-white border-amber-400' : 'bg-slate-950 text-slate-500 border-slate-800'}`}
                >FULL WIDTH</button>
              </div>
              <div className="grid grid-cols-3 gap-1 w-24 mx-auto">
                {(['top', 'middle', 'bottom'] as const).map(v => 
                  (['left', 'center', 'right'] as const).map(h => (
                    <button 
                      key={`${v}-${h}`}
                      onClick={() => updateTpl({ vAlign: v, hAlign: h })}
                      className={`h-5 rounded border transition-all ${ltTemplate.vAlign === v && ltTemplate.hAlign === h ? 'bg-amber-500 border-amber-400' : 'bg-slate-950 border-slate-800 hover:border-slate-600'}`}
                    />
                  ))
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <ControlGroup label="Width %" vertical>
                <input type="range" min={10} max={100} value={ltTemplate.widthPct} onChange={(e) => updateTpl({ widthPct: parseInt(e.target.value) })} className="w-full accent-amber-500" />
              </ControlGroup>
              <ControlGroup label="Radius" vertical>
                <input type="range" min={0} max={100} value={ltTemplate.borderRadius} onChange={(e) => updateTpl({ borderRadius: parseInt(e.target.value) })} className="w-full accent-amber-500" />
              </ControlGroup>
              <ControlGroup label="Offset X" vertical>
                <input type="number" value={ltTemplate.offsetX} onChange={(e) => updateTpl({ offsetX: parseInt(e.target.value) })} className="w-full bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800" />
              </ControlGroup>
              <ControlGroup label="Offset Y" vertical>
                <input type="number" value={ltTemplate.offsetY} onChange={(e) => updateTpl({ offsetY: parseInt(e.target.value) })} className="w-full bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800" />
              </ControlGroup>
              <ControlGroup label="Pad X" vertical>
                <input type="range" min={0} max={100} value={ltTemplate.paddingX} onChange={(e) => updateTpl({ paddingX: parseInt(e.target.value) })} className="w-full accent-amber-500" />
              </ControlGroup>
              <ControlGroup label="Pad Y" vertical>
                <input type="range" min={0} max={100} value={ltTemplate.paddingY} onChange={(e) => updateTpl({ paddingY: parseInt(e.target.value) })} className="w-full accent-amber-500" />
              </ControlGroup>
            </div>
        </Section>

        {/* Background */}
        <Section title="Background & Style" icon={Palette}>
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-1">
              {(["solid", "gradient", "image", "transparent"] as const).map(bt => (
                <button key={bt} onClick={() => updateTpl({ bgType: bt })} className={`text-[8px] font-bold py-1.5 rounded border transition-all ${ltTemplate.bgType === bt ? "bg-slate-700 border-slate-500 text-white" : "bg-slate-950 border-slate-800 text-slate-600"}`}>{bt.toUpperCase()}</button>
              ))}
            </div>

            {ltTemplate.bgType === "solid" && <ControlGroup label="Color"><input type="color" value={ltTemplate.bgColor} onChange={(e) => updateTpl({ bgColor: e.target.value })} className="w-12 h-6 bg-transparent cursor-pointer" /></ControlGroup>}
            {ltTemplate.bgType === "gradient" && (
              <div className="grid grid-cols-2 gap-2">
                <ControlGroup label="Start" vertical><input type="color" value={ltTemplate.bgColor} onChange={(e) => updateTpl({ bgColor: e.target.value })} className="w-full h-6 bg-transparent cursor-pointer" /></ControlGroup>
                <ControlGroup label="End" vertical><input type="color" value={ltTemplate.bgGradientEnd} onChange={(e) => updateTpl({ bgGradientEnd: e.target.value })} className="w-full h-6 bg-transparent cursor-pointer" /></ControlGroup>
              </div>
            )}
            {ltTemplate.bgType === "image" && (
              <button onClick={() => setShowLtImgPicker(true)} className="w-full py-2 px-3 bg-slate-950 border border-slate-800 rounded text-[10px] text-slate-400 flex items-center gap-2 hover:border-slate-600 transition-colors">
                <ImageIcon size={12} />
                <span className="truncate">{ltTemplate.bgImagePath ? ltTemplate.bgImagePath.split(/[/\\]/).pop() : "CHOOSE IMAGE..."}</span>
              </button>
            )}

            <ControlGroup label="Opacity" vertical>
              <input type="range" min={0} max={100} value={ltTemplate.bgOpacity} onChange={(e) => updateTpl({ bgOpacity: parseInt(e.target.value) })} className="w-full accent-amber-500" />
            </ControlGroup>

            <div className="flex items-center justify-between">
              <span className="text-[9px] text-slate-500 uppercase font-bold">Glass Blur</span>
              <input type="checkbox" checked={ltTemplate.bgBlur} onChange={(e) => updateTpl({ bgBlur: e.target.checked })} className="accent-amber-500" />
            </div>
            {ltTemplate.bgBlur && (
              <ControlGroup label="Blur Amount" vertical>
                <div className="flex items-center gap-2">
                  <input type="range" min={0} max={40} value={ltTemplate.bgBlurAmount} onChange={(e) => updateTpl({ bgBlurAmount: parseInt(e.target.value) })} className="flex-1 accent-amber-500" />
                  <span className="text-[10px] text-slate-400 w-8 text-right">{ltTemplate.bgBlurAmount}px</span>
                </div>
              </ControlGroup>
            )}

            <div className="space-y-2 pt-2 border-t border-slate-800/30">
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-slate-500 uppercase font-bold">Box Shadow</span>
                <input type="checkbox" checked={ltTemplate.boxShadow} onChange={(e) => updateTpl({ boxShadow: e.target.checked })} className="accent-amber-500" />
              </div>
              {ltTemplate.boxShadow && (
                <div className="grid grid-cols-2 gap-2">
                  <ControlGroup label="Color" vertical><input type="color" value={ltTemplate.boxShadowColor} onChange={(e) => updateTpl({ boxShadowColor: e.target.value })} className="w-full h-6 bg-transparent cursor-pointer" /></ControlGroup>
                  <ControlGroup label="Blur" vertical><input type="range" min={0} max={100} value={ltTemplate.boxShadowBlur} onChange={(e) => updateTpl({ boxShadowBlur: parseInt(e.target.value) })} className="w-full accent-amber-500" /></ControlGroup>
                </div>
              )}
            </div>
          </div>
        </Section>

        {/* Borders & Accents */}
        <Section title="Borders & Accents" icon={Square}>
          <div className="space-y-4">
            {/* Accent Bar */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-slate-500 uppercase font-bold">Accent Bar</span>
                <input type="checkbox" checked={ltTemplate.accentEnabled} onChange={(e) => updateTpl({ accentEnabled: e.target.checked })} className="accent-amber-500" />
              </div>
              {ltTemplate.accentEnabled && (
                <div className="space-y-3 bg-slate-950/30 p-2 rounded border border-slate-800/50">
                  <div className="grid grid-cols-4 gap-1">
                    {(['left', 'right', 'top', 'bottom'] as const).map(side => (
                      <button key={side} onClick={() => updateTpl({ accentSide: side })} className={`text-[8px] font-bold py-1 rounded border capitalize ${ltTemplate.accentSide === side ? 'bg-slate-700 text-white border-slate-500' : 'bg-slate-950 text-slate-600 border-slate-800'}`}>{side}</button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <ControlGroup label="Color" vertical><input type="color" value={ltTemplate.accentColor} onChange={(e) => updateTpl({ accentColor: e.target.value })} className="w-full h-6 bg-transparent cursor-pointer" /></ControlGroup>
                    <ControlGroup label="Width" vertical><input type="range" min={1} max={40} value={ltTemplate.accentWidth} onChange={(e) => updateTpl({ accentWidth: parseInt(e.target.value) })} className="w-full accent-amber-500" /></ControlGroup>
                  </div>
                </div>
              )}
            </div>

            {/* Full Border */}
            <div className="space-y-3 pt-2 border-t border-slate-800/30">
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-slate-500 uppercase font-bold">Full Border</span>
                <input type="checkbox" checked={ltTemplate.borderEnabled} onChange={(e) => updateTpl({ borderEnabled: e.target.checked })} className="accent-amber-500" />
              </div>
              {ltTemplate.borderEnabled && (
                <div className="grid grid-cols-2 gap-2 bg-slate-950/30 p-2 rounded border border-slate-800/50">
                  <ControlGroup label="Color" vertical><input type="color" value={ltTemplate.borderColor} onChange={(e) => updateTpl({ borderColor: e.target.value })} className="w-full h-6 bg-transparent cursor-pointer" /></ControlGroup>
                  <ControlGroup label="Width" vertical><input type="range" min={1} max={20} value={ltTemplate.borderWidth} onChange={(e) => updateTpl({ borderWidth: parseInt(e.target.value) })} className="w-full accent-amber-500" /></ControlGroup>
                </div>
              )}
            </div>
          </div>
        </Section>

        {/* Typography */}
        <Section title="Typography" icon={Type}>
          <div className="space-y-6">
            {/* Primary Text */}
            <div className="space-y-3">
              <span className="text-[9px] text-amber-500 uppercase font-black tracking-widest">Primary (Name / Line 1)</span>
              <div className="grid grid-cols-2 gap-2">
                <select value={ltTemplate.primaryFont} onChange={(e) => updateTpl({ primaryFont: e.target.value })} className="col-span-2 bg-slate-950 text-slate-300 text-[11px] p-2 rounded border border-slate-800">{FONTS.map(f => <option key={f} value={f}>{f}</option>)}</select>
                <ControlGroup label="Size" vertical><input type="number" value={ltTemplate.primarySize} onChange={(e) => updateTpl({ primarySize: parseInt(e.target.value) })} className="w-full bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800" /></ControlGroup>
                <ControlGroup label="Color" vertical><input type="color" value={ltTemplate.primaryColor} onChange={(e) => updateTpl({ primaryColor: e.target.value })} className="w-full h-7 bg-transparent cursor-pointer" /></ControlGroup>
              </div>
              <div className="flex gap-1">
                <button onClick={() => updateTpl({ primaryBold: !ltTemplate.primaryBold })} className={`flex-1 py-1.5 text-[10px] font-black rounded border transition-colors ${ltTemplate.primaryBold ? "bg-slate-700 text-white border-slate-500" : "bg-slate-950 text-slate-600 border-slate-800"}`}>B</button>
                <button onClick={() => updateTpl({ primaryItalic: !ltTemplate.primaryItalic })} className={`flex-1 py-1.5 text-[10px] italic rounded border transition-colors ${ltTemplate.primaryItalic ? "bg-slate-700 text-white border-slate-500" : "bg-slate-950 text-slate-600 border-slate-800"}`}>I</button>
                <button onClick={() => updateTpl({ primaryUppercase: !ltTemplate.primaryUppercase })} className={`flex-1 py-1.5 text-[10px] font-bold rounded border transition-colors ${ltTemplate.primaryUppercase ? "bg-slate-700 text-white border-slate-500" : "bg-slate-950 text-slate-600 border-slate-800"}`}>AA</button>
              </div>
            </div>

            {/* Secondary Text */}
            <div className="space-y-3 pt-4 border-t border-slate-800/30">
              <span className="text-[9px] text-amber-500 uppercase font-black tracking-widest">Secondary (Title / Line 2)</span>
              <div className="grid grid-cols-2 gap-2">
                <select value={ltTemplate.secondaryFont} onChange={(e) => updateTpl({ secondaryFont: e.target.value })} className="col-span-2 bg-slate-950 text-slate-300 text-[11px] p-2 rounded border border-slate-800">{FONTS.map(f => <option key={f} value={f}>{f}</option>)}</select>
                <ControlGroup label="Size" vertical><input type="number" value={ltTemplate.secondarySize} onChange={(e) => updateTpl({ secondarySize: parseInt(e.target.value) })} className="w-full bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800" /></ControlGroup>
                <ControlGroup label="Color" vertical><input type="color" value={ltTemplate.secondaryColor} onChange={(e) => updateTpl({ secondaryColor: e.target.value })} className="w-full h-7 bg-transparent cursor-pointer" /></ControlGroup>
              </div>
              <div className="flex gap-1">
                <button onClick={() => updateTpl({ secondaryBold: !ltTemplate.secondaryBold })} className={`flex-1 py-1.5 text-[10px] font-black rounded border transition-colors ${ltTemplate.secondaryBold ? "bg-slate-700 text-white border-slate-500" : "bg-slate-950 text-slate-600 border-slate-800"}`}>B</button>
                <button onClick={() => updateTpl({ secondaryItalic: !ltTemplate.secondaryItalic })} className={`flex-1 py-1.5 text-[10px] italic rounded border transition-colors ${ltTemplate.secondaryItalic ? "bg-slate-700 text-white border-slate-500" : "bg-slate-950 text-slate-600 border-slate-800"}`}>I</button>
                <button onClick={() => updateTpl({ secondaryUppercase: !ltTemplate.secondaryUppercase })} className={`flex-1 py-1.5 text-[10px] font-bold rounded border transition-colors ${ltTemplate.secondaryUppercase ? "bg-slate-700 text-white border-slate-500" : "bg-slate-950 text-slate-600 border-slate-800"}`}>AA</button>
              </div>
            </div>

            {/* Text Shadow */}
            <div className="space-y-3 pt-4 border-t border-slate-800/30">
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-slate-500 uppercase font-bold">Text Shadow</span>
                <input type="checkbox" checked={ltTemplate.textShadow} onChange={(e) => updateTpl({ textShadow: e.target.checked })} className="accent-amber-500" />
              </div>
              {ltTemplate.textShadow && (
                <div className="grid grid-cols-2 gap-2 bg-slate-950/30 p-2 rounded border border-slate-800/50">
                  <ControlGroup label="Color" vertical><input type="color" value={ltTemplate.textShadowColor} onChange={(e) => updateTpl({ textShadowColor: e.target.value })} className="w-full h-6 bg-transparent cursor-pointer" /></ControlGroup>
                  <ControlGroup label="Blur" vertical><input type="range" min={0} max={20} value={ltTemplate.textShadowBlur} onChange={(e) => updateTpl({ textShadowBlur: parseInt(e.target.value) })} className="w-full accent-amber-500" /></ControlGroup>
                </div>
              )}
            </div>

            {/* Text Outline */}
            <div className="space-y-3 pt-4 border-t border-slate-800/30">
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-slate-500 uppercase font-bold">Text Outline (Stroke)</span>
                <input type="checkbox" checked={ltTemplate.textOutline} onChange={(e) => updateTpl({ textOutline: e.target.checked })} className="accent-amber-500" />
              </div>
              {ltTemplate.textOutline && (
                <div className="grid grid-cols-2 gap-2 bg-slate-950/30 p-2 rounded border border-slate-800/50">
                  <ControlGroup label="Color" vertical><input type="color" value={ltTemplate.textOutlineColor} onChange={(e) => updateTpl({ textOutlineColor: e.target.value })} className="w-full h-6 bg-transparent cursor-pointer" /></ControlGroup>
                  <ControlGroup label="Width" vertical><input type="range" min={0.1} max={5} step={0.1} value={ltTemplate.textOutlineWidth} onChange={(e) => updateTpl({ textOutlineWidth: parseFloat(e.target.value) })} className="w-full accent-amber-500" /></ControlGroup>
                </div>
              )}
            </div>

            {/* Layout Extras */}
            <div className="space-y-3 pt-4 border-t border-slate-800/30">
              <ControlGroup label="Max Lines (0=auto)">
                <input type="number" min={0} max={10} value={ltTemplate.maxLines} onChange={(e) => updateTpl({ maxLines: parseInt(e.target.value) })} className="w-16 bg-slate-950 text-slate-300 text-[10px] p-1 rounded border border-slate-800" />
              </ControlGroup>
            </div>
          </div>
        </Section>

        {/* Animation */}
        <Section title="Motion & Variants" icon={Zap}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <ControlGroup label="Variant" vertical>
                <select value={ltTemplate.variant} onChange={(e) => updateTpl({ variant: e.target.value as any })} className="w-full bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800">
                  <option value="classic">Classic</option><option value="modern">Modern</option><option value="banner">Banner</option>
                </select>
              </ControlGroup>
              <ControlGroup label="Animation" vertical>
                <select value={ltTemplate.animation} onChange={(e) => updateTpl({ animation: e.target.value as any })} className="w-full bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800">
                  <option value="slide-up">Slide Up</option><option value="slide-left">Slide Left</option><option value="fade">Fade</option><option value="none">None</option>
                </select>
              </ControlGroup>
            </div>
            
            <div className="grid grid-cols-2 gap-2">
              <ControlGroup label="Enter (s)" vertical>
                <div className="flex items-center gap-1.5">
                  <input type="range" min={0.1} max={3} step={0.1} value={ltTemplate.animationDuration} onChange={(e) => updateTpl({ animationDuration: parseFloat(e.target.value) })} className="flex-1 accent-amber-500" />
                  <span className="text-[10px] text-slate-400 w-6">{ltTemplate.animationDuration}s</span>
                </div>
              </ControlGroup>
              <ControlGroup label="Exit (s)" vertical>
                <div className="flex items-center gap-1.5">
                  <input type="range" min={0.1} max={3} step={0.1} value={ltTemplate.exitDuration} onChange={(e) => updateTpl({ exitDuration: parseFloat(e.target.value) })} className="flex-1 accent-amber-500" />
                  <span className="text-[10px] text-slate-400 w-6">{ltTemplate.exitDuration}s</span>
                </div>
              </ControlGroup>
            </div>

            {!ltTemplate.scrollEnabled && (
              <ControlGroup label="Auto Hide (s)" vertical>
                <div className="flex items-center gap-2">
                  <input type="range" min={0} max={60} step={1} value={ltTemplate.autoHideSeconds} onChange={(e) => updateTpl({ autoHideSeconds: parseInt(e.target.value) })} className="flex-1 accent-amber-500" />
                  <span className="text-[10px] text-slate-400 w-8 text-right">{ltTemplate.autoHideSeconds}s</span>
                </div>
              </ControlGroup>
            )}

            {ltTemplate.variant === "banner" && (
              <ControlGroup label="Badge Text" vertical>
                <input type="text" value={ltTemplate.bannerBadgeText} onChange={(e) => updateTpl({ bannerBadgeText: e.target.value })} className="w-full bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800" placeholder="LIVE" />
              </ControlGroup>
            )}

            <div className="space-y-3 pt-2 border-t border-slate-800/30">
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-slate-500 uppercase font-bold">Ticker (FreeText Only)</span>
                <input type="checkbox" checked={ltTemplate.scrollEnabled} onChange={(e) => updateTpl({ scrollEnabled: e.target.checked })} className="accent-amber-500" />
              </div>
              {ltTemplate.scrollEnabled && (
                <div className="space-y-3 bg-slate-950/30 p-2 rounded border border-slate-800/50">
                  <div className="grid grid-cols-2 gap-2">
                    <ControlGroup label="Dir" vertical>
                      <select value={ltTemplate.scrollDirection} onChange={(e) => updateTpl({ scrollDirection: e.target.value as any })} className="w-full bg-slate-950 text-slate-300 text-[10px] p-1 rounded border border-slate-800">
                        <option value="rtl">RTL</option><option value="ltr">LTR</option>
                      </select>
                    </ControlGroup>
                    <ControlGroup label="Speed" vertical>
                      <div className="flex items-center gap-2">
                        <input type="range" min={1} max={10} value={ltTemplate.scrollSpeed} onChange={(e) => updateTpl({ scrollSpeed: parseInt(e.target.value) })} className="flex-1 accent-amber-500" />
                        <span className="text-[9px] text-slate-400 w-6 text-right">{(11 - ltTemplate.scrollSpeed) * 4}s</span>
                      </div>
                    </ControlGroup>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <ControlGroup label="Separator" vertical>
                      <input type="text" value={ltTemplate.scrollSeparator} onChange={(e) => updateTpl({ scrollSeparator: e.target.value })} className="w-full bg-slate-950 text-slate-300 text-[10px] p-1 rounded border border-slate-800" />
                    </ControlGroup>
                    <ControlGroup label="Gap (px)" vertical>
                      <input type="number" min={0} max={500} value={ltTemplate.scrollGap} onChange={(e) => updateTpl({ scrollGap: parseInt(e.target.value) })} className="w-full bg-slate-950 text-slate-300 text-[10px] p-1 rounded border border-slate-800" />
                    </ControlGroup>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <ControlGroup label="Cycles (0=∞)" vertical>
                      <input type="number" min={0} max={100} value={ltTemplate.scrollCount} onChange={(e) => updateTpl({ scrollCount: parseInt(e.target.value) })} className="w-full bg-slate-950 text-slate-300 text-[10px] p-1 rounded border border-slate-800" />
                    </ControlGroup>
                    <ControlGroup label="Auto Hide (s)" vertical>
                      <input type="number" min={0} max={120} value={ltTemplate.autoHideSeconds} onChange={(e) => updateTpl({ autoHideSeconds: parseInt(e.target.value) })} className="w-full bg-slate-950 text-slate-300 text-[10px] p-1 rounded border border-slate-800" />
                    </ControlGroup>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Section>
      </div>

      {/* Main Preview Area */}
      <div className="flex-1 flex flex-col bg-slate-950/20 overflow-hidden">
        {/* Preview Toolbar */}
        <div className="h-12 border-b border-slate-800 flex items-center justify-between px-6 bg-slate-900/30">
          <div className="flex items-center gap-3">
            <Monitor size={14} className="text-slate-500" />
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">Canvas Preview (1080p Scale)</span>
          </div>
          <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-lg border border-slate-800">
            {(['dark', 'green', 'checkered'] as const).map(bg => (
              <button
                key={bg}
                onClick={() => setLtPreviewBg(bg)}
                className={`px-3 py-1 rounded text-[9px] font-black uppercase transition-all ${ltPreviewBg === bg ? 'bg-slate-800 text-amber-500 shadow-inner' : 'text-slate-500 hover:text-slate-300'}`}
              >
                {bg}
              </button>
            ))}
          </div>
        </div>

        {/* Canvas Container */}
        <div className="flex-1 flex items-center justify-center p-12 overflow-hidden bg-slate-900/10">
          <div className={`relative aspect-video w-full max-w-5xl rounded-xl overflow-hidden ring-1 ring-white/10 shadow-[0_0_50px_rgba(0,0,0,0.5)] ${
            ltPreviewBg === 'green' ? 'bg-[#00b140]' : 
            ltPreviewBg === 'checkered' ? 'bg-checkered' : 
            'bg-slate-900'
          }`}>
            {ltPreviewBg === 'dark' && (
              <div className="absolute inset-0 flex items-center justify-center opacity-5 pointer-events-none">
                <Monitor size={120} />
              </div>
            )}
            
            {/* The actual 1080p internal canvas, scaled down to fit */}
            <div className="absolute inset-0" style={{ transform: 'scale(var(--preview-scale, 0.5))', transformOrigin: 'top left' }}>
              <div style={{ width: 1920, height: 1080 }} className="relative">
                <LowerThirdOverlay 
                  template={ltTemplate} 
                  data={
                    ltMode === "nameplate" ? { kind: "Nameplate", data: { name: ltName || "Full Name", title: ltTitle || "Title or Variable {time}" } } : 
                    ltMode === "freetext" ? { kind: "FreeText", data: { text: ltFreeText || "Custom Message Example with {date}" } } : 
                    { kind: "Lyrics", data: { line1: ltFlatLines[ltLineIndex]?.text || "Example Lyric Line One", line2: ltLinesPerDisplay === 2 ? (ltFlatLines[ltLineIndex+1]?.text || "Example Lyric Line Two") : undefined, section_label: ltFlatLines[ltLineIndex]?.sectionLabel || "Chorus" } }
                  } 
                />
              </div>
            </div>
          </div>
        </div>

        {/* Scaling helper script */}
        <style dangerouslySetInnerHTML={{ __html: `
          .bg-checkered {
            background-color: #1a1a1a;
            background-image: linear-gradient(45deg, #222 25%, transparent 25%), linear-gradient(-45deg, #222 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #222 75%), linear-gradient(-45deg, transparent 75%, #222 75%);
            background-size: 20px 20px;
            background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
          }
          :root { --preview-scale: 0.5; }
          @media (max-width: 1200px) { :root { --preview-scale: 0.4; } }
          @media (max-width: 1000px) { :root { --preview-scale: 0.3; } }
        `}} />
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
