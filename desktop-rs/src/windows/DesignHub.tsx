import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { AnimatePresence } from "framer-motion";
import { Layers, Plus, X, Monitor } from "lucide-react";
import { useAppStore } from "../store";
import { SlideEditor } from "../components/editors/SlideEditor";
import { SceneComposerTab } from "../components/SceneComposerTab";
import { LtDesignerTab } from "../components/LtDesignerTab";
import { StudioTab } from "../components/StudioTab";
import { PropsTab } from "../components/PropsTab";
import { SettingsTab } from "../components/SettingsTab";
import { Toast } from "../components/Toast";
import { stableId, newDefaultSlide } from "../utils";
import type { 
  CustomPresentation, 
  MediaItem, 
  LowerThirdTemplate, 
  SceneData, 
  PropItem, 
  PresentationSettings,
  DisplayItem
} from "../types";

export function DesignHub() {
  const {
    studioList, setStudioList,
    setStudioSlides,
    media, setMedia,
    setLtTemplate,
    setLtSavedTemplates,
    setSavedScenes,
    setPropItems,
    settings, setSettings,
    setCameras,
    toast, setToast,
    setAppDataDir,
  } = useAppStore();

  const [hubTab, setHubTab] = useState<"studio" | "lt-designer" | "scene" | "props" | "settings">("studio");
  const [editorPresId, setEditorPresId] = useState<string | null>(null);
  const [editorPres, setEditorPres] = useState<CustomPresentation | null>(null);

  const mediaImages = media.filter(i => i.media_type === "Image");

  useEffect(() => {
    const loadAll = async () => {
      const [studioRes, mediaRes, ltRes, propsRes, scenesRes, settingsRes, appDirRes] = await Promise.all([
        invoke<{ id: string; name: string; slide_count: number }[]>("list_studio_presentations").catch(() => []),
        invoke<MediaItem[]>("list_media").catch(() => []),
        invoke<LowerThirdTemplate[]>("load_lt_templates").catch(() => []),
        invoke<PropItem[]>("get_props").catch(() => []),
        invoke<SceneData[]>("list_scenes").catch(() => []),
        invoke<PresentationSettings>("get_settings").catch(() => null),
        invoke<string>("get_app_data_dir").catch(() => null),
      ]);

      setStudioList(studioRes);
      setMedia(mediaRes);
      if (ltRes.length) { 
        setLtSavedTemplates(ltRes); 
        setLtTemplate(ltRes.find(t => t.id === localStorage.getItem("activeLtTemplateId")) || ltRes[0]); 
      }
      setPropItems(propsRes);
      setSavedScenes(scenesRes);
      if (settingsRes) setSettings(settingsRes);
      if (appDirRes) setAppDataDir(appDirRes);

      navigator.mediaDevices?.enumerateDevices()
        .then((devs) => setCameras(devs.filter((d) => d.kind === "videoinput")))
        .catch(() => {});
    };
    loadAll();
  }, []);

  const handleNewPresentation = async () => {
    const pres: CustomPresentation = { id: stableId(), name: "Untitled Presentation", slides: [newDefaultSlide()] };
    await invoke("save_studio_presentation", { presentation: pres });
    const list: any[] = await invoke("list_studio_presentations");
    setStudioList(list);
    emit("studio-sync", list);
    setEditorPres(pres);
    setEditorPresId(pres.id);
  };

  const handleOpenEditor = async (id: string) => {
    const data = await invoke<any>("load_studio_presentation", { id });
    setEditorPres(data);
    setEditorPresId(id);
  };

  const updateSettings = async (next: PresentationSettings) => {
    setSettings(next);
    await invoke("save_settings", { settings: next });
  };

  const updateProps = async (items: PropItem[]) => {
    setPropItems(items);
    await invoke("set_props", { props: items });
  };

  if (editorPresId && editorPres) {
    return (
      <SlideEditor
        initialPres={editorPres}
        mediaImages={mediaImages}
        onClose={async (saved) => {
          setEditorPresId(null);
          setEditorPres(null);
          if (saved) {
            const list: any[] = await invoke("list_studio_presentations");
            setStudioList(list);
            emit("studio-sync", list);
            
            // Sync slides too
            const data: any = await invoke("load_studio_presentation", { id: editorPresId });
            const slides = data.slides;
            setStudioSlides((prev) => {
               const n = { ...prev };
               n[editorPresId] = slides;
               return n;
            });
            emit("studio-slides-sync", { id: editorPresId, slides });
          }
        }}
      />
    );
  }

  return (
    <div className="h-screen bg-slate-950 text-slate-200 flex flex-col font-sans overflow-hidden">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/60 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-purple-600 rounded flex items-center justify-center text-white font-black text-xs">DH</div>
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-400">Design Hub</span>
        </div>
        <div className="h-4 w-px bg-slate-700 mx-2" />
        <div className="flex gap-1 flex-wrap">
          {([
            { id: "studio", label: "Studio" },
            { id: "lt-designer", label: "LT Designer" },
            { id: "scene", label: "Scene Builder" },
            { id: "props", label: "Props" },
            { id: "settings", label: "Preferences" },
          ] as const).map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setHubTab(id)}
              className={`px-3 py-1 rounded text-xs font-bold transition-all ${
                hubTab === id ? "bg-purple-600 text-white shadow-lg" : "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        {/* Full-height fill tabs — no padding wrapper */}
        {hubTab === "lt-designer" && <LtDesignerTab onSetToast={setToast} onLoadMedia={async () => {}} />}
        {hubTab === "scene" && <SceneComposerTab onSetToast={setToast} />}
        {/* Scrollable tabs — padded, overflow-y-auto */}
        {(hubTab === "studio" || hubTab === "props" || hubTab === "settings") && (
          <div className="h-full overflow-y-auto p-4 custom-scrollbar">
            {hubTab === "studio" && <StudioTab onOpenEditor={handleOpenEditor} onNewPresentation={handleNewPresentation} />}
            {hubTab === "props" && <PropsTab onUpdateProps={updateProps} />}
            {hubTab === "settings" && (
              <SettingsTab
                onUpdateSettings={updateSettings}
                onUpdateTranscriptionWindow={(sec) => invoke("set_transcription_window", { samples: Math.round(sec * 16000) })}
                onUpdateVadThreshold={(val) => invoke("set_vad_threshold", { threshold: val })}
                onUploadMedia={async () => {}}
              />
            )}
          </div>
        )}
      </div>

      <AnimatePresence>
        {toast && <Toast key={toast} message={toast} onDone={() => setToast(null)} />}
      </AnimatePresence>
    </div>
  );
}
