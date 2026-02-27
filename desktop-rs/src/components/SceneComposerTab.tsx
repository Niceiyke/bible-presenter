import React, { useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { stableId, ltBuildLyricsPayload, describeLayerContent } from "../utils";
import { SceneRenderer } from "./shared/Renderers";
import { Eye, EyeOff, Layers, X } from "lucide-react";
import type { DisplayItem, LayerContent, LowerThirdData, SceneData, SceneLayer } from "../types";

interface SceneComposerTabProps {
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onSetToast: (msg: string) => void;
}

export function SceneComposerTab({ onStage, onLive, onSetToast }: SceneComposerTabProps) {
  const {
    workingScene, setWorkingScene,
    activeLayerId, setActiveLayerId,
    savedScenes, setSavedScenes,
    stagedItem,
    ltMode, ltName, ltTitle, ltFreeText, ltLineIndex, ltLinesPerDisplay, ltTemplate,
    songs, ltSongId
  } = useAppStore();

  const ltFlatLines = useMemo(() => {
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

  const updateLayer = (patch: Partial<SceneLayer>) => {
    if (!activeLayerId) return;
    setWorkingScene(s => ({
      ...s,
      layers: s.layers.map(l => l.id === activeLayerId ? { ...l, ...patch } : l)
    }));
  };

  const getCurrentLtData = (): LowerThirdData => {
    if (ltMode === "nameplate") return { kind: "Nameplate", data: { name: ltName, title: ltTitle || undefined } };
    if (ltMode === "freetext") return { kind: "FreeText", data: { text: ltFreeText } };
    return ltBuildLyricsPayload(ltFlatLines, ltLineIndex, ltLinesPerDisplay) || { kind: "Lyrics", data: { line1: "No Lyrics" } };
  };

  return (
    <div className="h-full flex overflow-hidden -m-4">
      <div className="w-72 border-r border-slate-800 flex flex-col overflow-hidden bg-slate-900/50 shrink-0">
        <div className="flex-1 overflow-y-auto p-3 space-y-4">
          {savedScenes.length > 0 && (
            <>
              <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Saved Scenes</p>
              <div className="space-y-1">
                {savedScenes.map(sc => (
                  <div key={sc.id} className="flex items-center gap-1 bg-slate-800/50 rounded px-2 py-1">
                    <span className="flex-1 text-[10px] text-slate-300 truncate">{sc.name}</span>
                    <button onClick={() => { setWorkingScene(sc); setActiveLayerId(null); }} className="text-[8px] font-black uppercase px-1.5 py-0.5 bg-blue-700 hover:bg-blue-600 text-white rounded">LOAD</button>
                    <button onClick={async () => { await invoke("delete_scene", { id: sc.id }); const list = await invoke<SceneData[]>("list_scenes"); setSavedScenes(list); }} className="text-[8px] font-black uppercase px-1.5 py-0.5 bg-red-900/50 hover:bg-red-600 text-red-300 hover:text-white rounded">DEL</button>
                  </div>
                ))}
              </div>
              <div className="border-t border-slate-800" />
            </>
          )}

          <div className="flex items-center justify-between">
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Layer Stack</p>
            <span className="text-[8px] text-slate-600">top ↑ bottom</span>
          </div>
          <div className="space-y-1">
            {[...workingScene.layers].reverse().map((layer) => {
              const isLt = layer.content.kind === "lower-third";
              const isItem = layer.content.kind === "item";
              return (
                <div key={layer.id} onClick={() => setActiveLayerId(layer.id)} className={`flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer transition-all ${activeLayerId === layer.id ? "bg-blue-600/20 border border-blue-500/50" : "bg-slate-800/40 border border-slate-700/30 hover:border-slate-600/50"}`}>
                  <button onClick={(e) => { e.stopPropagation(); setWorkingScene(s => ({ ...s, layers: s.layers.map(l => l.id === layer.id ? { ...l, visible: !l.visible } : l) })); }} className="text-slate-500 hover:text-white shrink-0">{layer.visible ? <Eye size={12} /> : <EyeOff size={12} />}</button>
                  <span className={`text-[7px] font-black uppercase px-1 rounded shrink-0 ${isLt ? "bg-amber-600/40 text-amber-300" : layer.content.kind === "empty" ? "bg-slate-700/60 text-slate-400" : "bg-blue-700/40 text-blue-300"}`}>
                    {isLt ? "LT" : layer.content.kind === "empty" ? "—" : isItem ? (layer.content as any).item.type.slice(0,3).toUpperCase() : "?"}
                  </span>
                  <span className="flex-1 text-[10px] text-slate-300 truncate">{layer.name}</span>
                  <button onClick={(e) => { e.stopPropagation(); setWorkingScene(s => ({ ...s, layers: s.layers.filter(l => l.id !== layer.id) })); if (activeLayerId === layer.id) setActiveLayerId(null); }} className="text-slate-600 hover:text-red-400 text-[10px]">×</button>
                </div>
              );
            })}
          </div>

          <div className="space-y-1.5 pt-1">
            <button onClick={() => { const id = stableId(); setWorkingScene(s => ({ ...s, layers: [...s.layers, { id, name: `Layer ${s.layers.length + 1}`, content: { kind: "empty" }, x: 0, y: 0, w: 100, h: 100, opacity: 1, visible: true }] })); setActiveLayerId(id); }} className="w-full py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-[9px] font-black uppercase rounded border border-slate-600">+ Add Empty Layer</button>
            <button onClick={() => { const id = stableId(); setWorkingScene(s => ({ ...s, layers: [...s.layers, { id, name: "Lower Third", content: { kind: "lower-third", ltData: getCurrentLtData(), template: ltTemplate }, x: 0, y: 0, w: 100, h: 100, opacity: 1, visible: true }] })); setActiveLayerId(id); }} className="w-full py-1.5 bg-amber-700/50 hover:bg-amber-600/60 text-amber-200 text-[9px] font-black uppercase rounded border border-amber-700/40">+ Add LT Layer</button>
          </div>
        </div>
      </div>

      <div className="flex-1 p-4 flex flex-col gap-3 overflow-hidden min-w-0">
        <div className="flex-1 min-h-0 bg-black rounded-xl border border-slate-800 shadow-2xl relative overflow-hidden">
          <SceneRenderer scene={workingScene} activeLayerId={activeLayerId} onLayerClick={setActiveLayerId} />
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <input value={workingScene.name} onChange={(e) => setWorkingScene(s => ({ ...s, name: e.target.value }))} className="flex-1 min-w-0 bg-slate-950 text-slate-200 text-xs px-3 py-2 rounded-lg border border-slate-800" placeholder="Scene Name..." />
          <button onClick={async () => { await invoke("save_scene", { scene: workingScene }); const list = await invoke<SceneData[]>("list_scenes"); setSavedScenes(list); onSetToast("Scene saved"); }} className="px-3 py-2 bg-green-700 hover:bg-green-600 text-white text-[10px] font-black uppercase rounded-lg">SAVE</button>
          <button onClick={() => onStage({ type: "Scene", data: workingScene })} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-black uppercase rounded-lg">STAGE</button>
          <button onClick={() => onLive({ type: "Scene", data: workingScene })} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-black uppercase rounded-lg shadow-lg">GO LIVE</button>
        </div>
      </div>

      <div className="w-80 border-l border-slate-800 p-3 overflow-y-auto bg-slate-950/50 shrink-0">
        {activeLayerId && workingScene.layers.find(l => l.id === activeLayerId) ? (() => {
          const layer = workingScene.layers.find(l => l.id === activeLayerId)!;
          const isLt = layer.content.kind === "lower-third";
          
          return (
            <div className="space-y-4">
              <p className="text-[9px] font-black text-blue-400 uppercase tracking-widest">Layer Config</p>
              <div className="flex flex-col gap-1">
                <span className="text-[8px] text-slate-500 uppercase font-bold">Name</span>
                <input value={layer.name} onChange={(e) => updateLayer({ name: e.target.value })} className="bg-slate-900 text-slate-200 text-xs px-2 py-1.5 rounded border border-slate-700" />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[8px] text-slate-500 uppercase font-bold">Content</span>
                <div className="bg-slate-900 rounded p-2 text-[10px] flex items-center border border-slate-700"><span className={layer.content.kind === "empty" ? "text-slate-600 italic" : "text-amber-400 font-bold"}>{describeLayerContent(layer.content)}</span></div>
                {stagedItem && !isLt && <button onClick={() => updateLayer({ content: { kind: "item", item: stagedItem } })} className="w-full py-1.5 bg-blue-700 hover:bg-blue-600 text-white text-[9px] font-black uppercase rounded">Assign Staged</button>}
                {isLt && <button onClick={() => updateLayer({ content: { kind: "lower-third", ltData: getCurrentLtData(), template: ltTemplate } })} className="w-full py-1.5 bg-amber-700/60 hover:bg-amber-600 text-amber-100 text-[9px] font-black uppercase rounded border border-amber-700/50">Assign Current LT</button>}
                <button onClick={() => updateLayer({ content: { kind: "empty" } })} className="w-full py-1 bg-red-900/30 hover:bg-red-700/40 text-red-300 text-[9px] font-black uppercase rounded border border-red-900/40">Clear</button>
              </div>
              {!isLt && (
                <>
                  <div className="border-t border-slate-800" />
                  <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Pos & Size</p>
                  {(["x", "y", "w", "h"] as const).map(key => (
                    <div key={key} className="flex items-center gap-2"><span className="text-[9px] text-slate-500 uppercase w-4">{key}</span><input type="range" min={0} max={100} step={1} value={layer[key]} onChange={(e) => updateLayer({ [key]: parseFloat(e.target.value) })} className="flex-1 accent-blue-500" /><span className="text-[9px] text-slate-400 w-8 text-right">{Math.round(layer[key])}%</span></div>
                  ))}
                </>
              )}
              <div className="border-t border-slate-800" />
              <div className="flex items-center gap-2"><span className="text-[8px] text-slate-500 uppercase">Opacity</span><input type="range" min={0} max={1} step={0.05} value={layer.opacity} onChange={(e) => updateLayer({ opacity: parseFloat(e.target.value) })} className="flex-1 accent-blue-500" /><span className="text-[9px] text-slate-400 w-8 text-right">{Math.round(layer.opacity * 100)}%</span></div>
            </div>
          );
        })() : <div className="flex flex-col items-center justify-center h-full text-slate-600"><Layers size={24} className="mb-2" /><p className="text-[10px]">Select a layer</p></div>}
      </div>
    </div>
  );
}
