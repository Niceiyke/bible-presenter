import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import { stableId, ltBuildLyricsPayload, describeLayerContent, relativizePath } from "../utils";
import { SceneRenderer } from "./shared/Renderers";
import { Eye, EyeOff, Layers, RefreshCw } from "lucide-react";
import type { DisplayItem, LayerContent, LowerThirdData, SceneData, SceneLayer } from "../types";

interface SceneComposerTabProps {
  onSetToast: (msg: string) => void;
}

export function SceneComposerTab({ onSetToast }: SceneComposerTabProps) {
  const {
    workingScene, setWorkingScene,
    activeLayerId, setActiveLayerId,
    savedScenes, setSavedScenes,
    stagedItem,
    ltMode, ltName, ltTitle, ltFreeText, ltLineIndex, ltLinesPerDisplay, ltTemplate,
    ltSavedTemplates,
    songs, ltSongId,
    media: mediaItems,
    cameras: storeCameras,
    appDataDir,
    settings,
  } = useAppStore();

  const [availableLanCams, setAvailableLanCams] = useState<{ device_id: string; device_name: string }[]>([]);
  const [staticColor, setStaticColor] = useState("#1a1a2e");

  // Use the cameras already enumerated by the main app (with labels).
  // Fall back to a fresh enumerate if the store list is empty.
  const [fallbackCams, setFallbackCams] = useState<MediaDeviceInfo[]>([]);
  const didFallback = useRef(false);

  useEffect(() => {
    if (storeCameras.length === 0 && !didFallback.current) {
      didFallback.current = true;
      navigator.mediaDevices.enumerateDevices()
        .then((devs) => setFallbackCams(devs.filter((d) => d.kind === "videoinput")))
        .catch(() => {});
    }
  }, [storeCameras.length]);

  const availableLocalCams = (storeCameras.length > 0 ? storeCameras : fallbackCams)
    .map((d) => ({ deviceId: d.deviceId, label: d.label || d.deviceId }));

  const fetchLanCams = useCallback(async () => {
    try {
      const cams = await invoke<{ device_id: string; device_name: string }[]>("list_connected_cameras");
      setAvailableLanCams(cams);
    } catch {
      setAvailableLanCams([]);
    }
  }, []);

  useEffect(() => {
    fetchLanCams();
  }, [fetchLanCams]);

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

  const addLayer = (content: LayerContent, name: string) => {
    const id = stableId();
    setWorkingScene(s => ({
      ...s,
      layers: [...s.layers, { id, name, content, x: 0, y: 0, w: 100, h: 100, opacity: 1, visible: true }]
    }));
    setActiveLayerId(id);
  };

  const getLayerBadge = (layer: SceneLayer) => {
    const k = layer.content.kind;
    if (k === "lower-third") return { label: "LT", cls: "bg-amber-600/40 text-amber-300" };
    if (k === "empty") return { label: "—", cls: "bg-slate-700/60 text-slate-400" };
    if (k === "static-color") return { label: "CLR", cls: "bg-pink-700/40 text-pink-300" };
    if (k === "static-image") return { label: "IMG", cls: "bg-emerald-700/40 text-emerald-300" };
    if (k === "source") return { label: "SRC", cls: "bg-teal-700/40 text-teal-300" };
    if (k === "item") return { label: (layer.content as any).item.type.slice(0, 3).toUpperCase(), cls: "bg-blue-700/40 text-blue-300" };
    return { label: "?", cls: "bg-slate-700/60 text-slate-400" };
  };

  // Image media items for static-image picker
  const imageMedia = mediaItems.filter(m => m.media_type === "Image");

  return (
    <div className="h-full flex overflow-hidden">
      {/* ── Left: Layer stack + Add Layer ── */}
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
                    <button onClick={async () => { await invoke("delete_scene", { id: sc.id }); const list = await invoke<SceneData[]>("list_scenes"); setSavedScenes(list); emit("scenes-sync", list); }} className="text-[8px] font-black uppercase px-1.5 py-0.5 bg-red-900/50 hover:bg-red-600 text-red-300 hover:text-white rounded">DEL</button>
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
              const badge = getLayerBadge(layer);
              return (
                <div key={layer.id} onClick={() => setActiveLayerId(layer.id)} className={`flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer transition-all ${activeLayerId === layer.id ? "bg-blue-600/20 border border-blue-500/50" : "bg-slate-800/40 border border-slate-700/30 hover:border-slate-600/50"}`}>
                  <button onClick={(e) => { e.stopPropagation(); setWorkingScene(s => ({ ...s, layers: s.layers.map(l => l.id === layer.id ? { ...l, visible: !l.visible } : l) })); }} className="text-slate-500 hover:text-white shrink-0">{layer.visible ? <Eye size={12} /> : <EyeOff size={12} />}</button>
                  <span className={`text-[7px] font-black uppercase px-1 rounded shrink-0 ${badge.cls}`}>{badge.label}</span>
                  <span className="flex-1 text-[10px] text-slate-300 truncate">{layer.name}</span>
                  <button onClick={(e) => { e.stopPropagation(); setWorkingScene(s => ({ ...s, layers: s.layers.filter(l => l.id !== layer.id) })); if (activeLayerId === layer.id) setActiveLayerId(null); }} className="text-slate-600 hover:text-red-400 text-[10px]">×</button>
                </div>
              );
            })}
          </div>

          {/* ── Add Layer grouped menu ── */}
          <div className="space-y-2 pt-1">
            {/* Source layers */}
            <p className="text-[8px] font-black text-teal-500 uppercase tracking-widest border-t border-slate-800 pt-2">Add Source Layer</p>
            <div className="flex gap-1 flex-wrap items-center">
              <button
                onClick={() => addLayer({ kind: "source", source: { type: "live-output" } }, "Live Output")}
                className="px-2 py-1 bg-teal-800/50 hover:bg-teal-700/60 text-teal-200 text-[8px] font-black uppercase rounded border border-teal-700/40"
              >Live Output</button>
              
              <div className="flex items-center bg-amber-800/30 rounded border border-amber-700/40 overflow-hidden">
                <button
                  onClick={() => addLayer({ kind: "source", source: { type: "lower-third" } }, "Lower Third")}
                  className="px-2 py-1 bg-amber-800/50 hover:bg-amber-700/60 text-amber-200 text-[8px] font-black uppercase"
                >Lower Third</button>
                <select 
                  className="bg-transparent text-amber-400 text-[8px] border-l border-amber-700/40 px-1 py-1 focus:outline-none"
                  defaultValue=""
                  onChange={(e) => {
                    const t = ltSavedTemplates.find(tpl => tpl.id === e.target.value);
                    if (t) {
                       // Custom implementation for when a specific template is chosen for the source
                       // But the standard LayerContent for source doesn't store template.
                       // It uses the global one. If we want a specific one, we should use kind: 'lower-third' (static)
                       addLayer({ kind: "lower-third", ltData: getCurrentLtData(), template: t }, `LT: ${t.name}`);
                    }
                    e.target.value = "";
                  }}
                >
                  <option value="" disabled>Template...</option>
                  {ltSavedTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            </div>
            {/* LAN cameras */}
            <div className="flex items-center gap-1">
              <select
                className="flex-1 bg-slate-900 text-slate-300 text-[8px] px-1.5 py-1 rounded border border-slate-700"
                defaultValue=""
                onChange={(e) => {
                  const cam = availableLanCams.find(c => c.device_id === e.target.value);
                  if (cam) addLayer({ kind: "source", source: { type: "camera-lan", device_id: cam.device_id, device_name: cam.device_name } }, cam.device_name);
                  e.target.value = "";
                }}
              >
                <option value="" disabled>+ LAN Camera…</option>
                {availableLanCams.map(c => (
                  <option key={c.device_id} value={c.device_id}>{c.device_name}</option>
                ))}
              </select>
              <button onClick={fetchLanCams} title="Refresh" className="p-1 text-slate-500 hover:text-teal-400"><RefreshCw size={10} /></button>
            </div>
            {/* Local cameras */}
            {availableLocalCams.length > 0 && (
              <select
                className="w-full bg-slate-900 text-slate-300 text-[8px] px-1.5 py-1 rounded border border-slate-700"
                defaultValue=""
                onChange={(e) => {
                  const cam = availableLocalCams.find(c => c.deviceId === e.target.value);
                  if (cam) addLayer({ kind: "source", source: { type: "camera-local", device_id: cam.deviceId, label: cam.label } }, cam.label);
                  e.target.value = "";
                }}
              >
                <option value="" disabled>+ Local Camera…</option>
                {availableLocalCams.map(c => (
                  <option key={c.deviceId} value={c.deviceId}>{c.label}</option>
                ))}
              </select>
            )}

            {/* Static layers */}
            <p className="text-[8px] font-black text-pink-500 uppercase tracking-widest border-t border-slate-800 pt-2">Add Static Layer</p>
            <div className="flex items-center gap-1">
              <input
                type="color"
                value={staticColor}
                onChange={(e) => setStaticColor(e.target.value)}
                className="w-8 h-7 rounded border border-slate-700 bg-transparent cursor-pointer"
              />
              <button
                onClick={() => addLayer({ kind: "static-color", color: staticColor }, `Color ${staticColor}`)}
                className="flex-1 py-1 bg-pink-900/40 hover:bg-pink-700/50 text-pink-200 text-[8px] font-black uppercase rounded border border-pink-800/40"
              >Add Color</button>
            </div>
            {imageMedia.length > 0 && (
              <select
                className="w-full bg-slate-900 text-slate-300 text-[8px] px-1.5 py-1 rounded border border-slate-700"
                defaultValue=""
                onChange={(e) => {
                  const m = imageMedia.find(img => img.id === e.target.value);
                  if (m) addLayer({ kind: "static-image", path: relativizePath(m.path, appDataDir) }, m.name);
                  e.target.value = "";
                }}
              >
                <option value="" disabled>+ Image from Media…</option>
                {imageMedia.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            )}

            {/* Other */}
            <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest border-t border-slate-800 pt-2">Other</p>
            <div className="flex gap-1 items-center">
              <button onClick={() => { const id = stableId(); setWorkingScene(s => ({ ...s, layers: [...s.layers, { id, name: `Layer ${s.layers.length + 1}`, content: { kind: "empty" }, x: 0, y: 0, w: 100, h: 100, opacity: 1, visible: true }] })); setActiveLayerId(id); }} className="flex-1 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-[8px] font-black uppercase rounded border border-slate-600">+ Empty</button>
              
              <div className="flex-1 flex items-center bg-amber-700/30 rounded border border-amber-700/40 overflow-hidden">
                <button 
                  onClick={() => { const id = stableId(); setWorkingScene(s => ({ ...s, layers: [...s.layers, { id, name: "Lower Third", content: { kind: "lower-third", ltData: getCurrentLtData(), template: ltTemplate }, x: 0, y: 0, w: 100, h: 100, opacity: 1, visible: true }] })); setActiveLayerId(id); }} 
                  className="flex-1 py-1.5 bg-amber-700/50 hover:bg-amber-600/60 text-amber-200 text-[8px] font-black uppercase"
                >+ LT</button>
                <select 
                  className="bg-transparent text-amber-400 text-[8px] border-l border-amber-700/40 px-1 py-1 focus:outline-none"
                  defaultValue=""
                  onChange={(e) => {
                    const t = ltSavedTemplates.find(tpl => tpl.id === e.target.value);
                    if (t) {
                       const id = stableId();
                       setWorkingScene(s => ({ ...s, layers: [...s.layers, { id, name: `LT: ${t.name}`, content: { kind: "lower-third", ltData: getCurrentLtData(), template: t }, x: 0, y: 0, w: 100, h: 100, opacity: 1, visible: true }] }));
                       setActiveLayerId(id);
                    }
                    e.target.value = "";
                  }}
                >
                  <option value="" disabled>...</option>
                  {ltSavedTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Center: Preview canvas ── */}
      <div className="flex-1 p-4 flex flex-col gap-3 overflow-hidden min-w-0">
        <div className="flex-1 min-h-0 bg-black rounded-xl border border-slate-800 shadow-2xl relative overflow-hidden">
          <SceneRenderer scene={workingScene} activeLayerId={activeLayerId} onLayerClick={setActiveLayerId} appDataDir={appDataDir} settings={settings} />
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <input value={workingScene.name} onChange={(e) => setWorkingScene(s => ({ ...s, name: e.target.value }))} className="flex-1 min-w-0 bg-slate-950 text-slate-200 text-xs px-3 py-2 rounded-lg border border-slate-800" placeholder="Scene Name..." />
          <button onClick={async () => { await invoke("save_scene", { scene: workingScene }); const list = await invoke<SceneData[]>("list_scenes"); setSavedScenes(list); emit("scenes-sync", list); onSetToast("Scene saved"); }} className="px-3 py-2 bg-green-700 hover:bg-green-600 text-white text-[10px] font-black uppercase rounded-lg">SAVE</button>
        </div>
      </div>

      {/* ── Right: Layer config ── */}
      <div className="w-80 border-l border-slate-800 p-3 overflow-y-auto bg-slate-950/50 shrink-0">
        {activeLayerId && workingScene.layers.find(l => l.id === activeLayerId) ? (() => {
          const layer = workingScene.layers.find(l => l.id === activeLayerId)!;
          const isLt = layer.content.kind === "lower-third";
          const isSource = layer.content.kind === "source";
          const isStaticColor = layer.content.kind === "static-color";
          const isStaticImage = layer.content.kind === "static-image";

          return (
            <div className="space-y-4">
              <p className="text-[9px] font-black text-blue-400 uppercase tracking-widest">Layer Config</p>
              <div className="flex flex-col gap-1">
                <span className="text-[8px] text-slate-500 uppercase font-bold">Name</span>
                <input value={layer.name} onChange={(e) => updateLayer({ name: e.target.value })} className="bg-slate-900 text-slate-200 text-xs px-2 py-1.5 rounded border border-slate-700" />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[8px] text-slate-500 uppercase font-bold">Content</span>
                <div className="bg-slate-900 rounded p-2 text-[10px] flex items-center border border-slate-700">
                  <span className={layer.content.kind === "empty" ? "text-slate-600 italic" : "text-amber-400 font-bold"}>{describeLayerContent(layer.content)}</span>
                </div>
                {/* Source layers: read-only badge */}
                {isSource && (
                  <div className="px-2 py-1 bg-teal-900/30 rounded border border-teal-700/30 text-[8px] font-bold text-teal-400 uppercase">
                    Live Source — updates automatically
                  </div>
                )}
                {/* Static color: inline color editor */}
                {isStaticColor && (
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={(layer.content as any).color}
                      onChange={(e) => updateLayer({ content: { kind: "static-color", color: e.target.value } })}
                      className="w-10 h-8 rounded border border-slate-700 bg-transparent cursor-pointer"
                    />
                    <span className="text-[9px] text-slate-400">{(layer.content as any).color}</span>
                  </div>
                )}
                {/* Static image: filename + change button */}
                {isStaticImage && (
                  <div className="space-y-1">
                    <p className="text-[8px] text-slate-500 truncate">{(layer.content as any).path.split(/[\\/]/).pop()}</p>
                    {imageMedia.length > 0 && (
                      <select
                        className="w-full bg-slate-900 text-slate-300 text-[8px] px-1.5 py-1 rounded border border-slate-700"
                        defaultValue=""
                        onChange={(e) => {
                          const m = imageMedia.find(img => img.id === e.target.value);
                          if (m) updateLayer({ content: { kind: "static-image", path: relativizePath(m.path, appDataDir) }, name: m.name });
                          e.target.value = "";
                        }}
                      >
                        <option value="" disabled>Change image…</option>
                        {imageMedia.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    )}
                  </div>
                )}
                {/* Assign staged (non-LT, non-source, non-static layers) */}
                {!isSource && !isStaticColor && !isStaticImage && stagedItem && !isLt && (
                  <button onClick={() => updateLayer({ content: { kind: "item", item: stagedItem } })} className="w-full py-1.5 bg-blue-700 hover:bg-blue-600 text-white text-[9px] font-black uppercase rounded">Assign Staged</button>
                )}
                {isLt && (
                  <div className="space-y-2">
                    <button onClick={() => updateLayer({ content: { kind: "lower-third", ltData: getCurrentLtData(), template: ltTemplate } })} className="w-full py-1.5 bg-amber-700/60 hover:bg-amber-600 text-amber-100 text-[9px] font-black uppercase rounded border border-amber-700/50">Assign Current LT Data</button>
                    <div className="flex flex-col gap-1">
                      <span className="text-[8px] text-slate-500 uppercase font-bold">Template</span>
                      <select 
                        className="bg-slate-900 text-slate-200 text-[10px] px-2 py-1.5 rounded border border-slate-700"
                        value={(layer.content as any).template.id}
                        onChange={(e) => {
                          const t = ltSavedTemplates.find(tpl => tpl.id === e.target.value);
                          if (t) {
                            updateLayer({ content: { ...layer.content, template: t } as any });
                          }
                        }}
                      >
                        {ltSavedTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </div>
                  </div>
                )}
                <button onClick={() => updateLayer({ content: { kind: "empty" } })} className="w-full py-1 bg-red-900/30 hover:bg-red-700/40 text-red-300 text-[9px] font-black uppercase rounded border border-red-900/40">Clear</button>
              </div>
              {/* Pos & Size (all kinds) */}
              <div className="border-t border-slate-800" />
              <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Pos & Size</p>
              {(["x", "y", "w", "h"] as const).map(key => (
                <div key={key} className="flex items-center gap-2">
                  <span className="text-[9px] text-slate-500 uppercase w-4">{key}</span>
                  <input type="range" min={0} max={100} step={1} value={layer[key]} onChange={(e) => updateLayer({ [key]: parseFloat(e.target.value) })} className="flex-1 accent-blue-500" />
                  <span className="text-[9px] text-slate-400 w-8 text-right">{Math.round(layer[key])}%</span>
                </div>
              ))}
              <div className="border-t border-slate-800" />
              <div className="flex items-center gap-2">
                <span className="text-[8px] text-slate-500 uppercase">Opacity</span>
                <input type="range" min={0} max={1} step={0.05} value={layer.opacity} onChange={(e) => updateLayer({ opacity: parseFloat(e.target.value) })} className="flex-1 accent-blue-500" />
                <span className="text-[9px] text-slate-400 w-8 text-right">{Math.round(layer.opacity * 100)}%</span>
              </div>
            </div>
          );
        })() : (
          <div className="flex flex-col items-center justify-center h-full text-slate-600">
            <Layers size={24} className="mb-2" />
            <p className="text-[10px]">Select a layer</p>
          </div>
        )}
      </div>
    </div>
  );
}
