import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { AnimatePresence } from "framer-motion";
import { Layers, Monitor, Sliders, Wand2, Clapperboard, LayoutDashboard } from "lucide-react";
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
    toast, setToast,
    setAppDataDir,
    setStagedItem,
    setLiveItem,
    scheduleEntries, setScheduleEntries,
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

      // Handle LT templates loading with fallback to default
      const savedTpls = ltRes.length ? ltRes : [useAppStore.getState().ltTemplate];
      setLtSavedTemplates(savedTpls);
      const activeId = localStorage.getItem("activeLtTemplateId");
      const active = savedTpls.find(t => t.id === activeId) || savedTpls[0];
      setLtTemplate(active);

      setPropItems(propsRes);
      setSavedScenes(scenesRes);
      if (settingsRes) setSettings(settingsRes);
      if (appDirRes) setAppDataDir(appDirRes);

    };
    loadAll();
  }, []);

  const stageItem = useCallback(async (item: DisplayItem) => {
    setStagedItem(item);
    await invoke("stage_item", { item });
  }, [setStagedItem]);

  const sendLive = useCallback(async (item: DisplayItem) => {
    await stageItem(item);
    await invoke("go_live");
    setLiveItem(item);
  }, [stageItem, setLiveItem]);

  const addToSchedule = useCallback(async (item: DisplayItem) => {
    const entry = { id: stableId(), item };
    const next = [...scheduleEntries, entry];
    setScheduleEntries(next);
    emit("schedule-sync", next);
    setToast("Added to schedule");
  }, [scheduleEntries, setScheduleEntries, setToast]);

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

  const tabs = [
    { id: "studio" as const, label: "Studio", icon: <Clapperboard size={14} /> },
    { id: "lt-designer" as const, label: "LT Designer", icon: <Wand2 size={14} /> },
    { id: "scene" as const, label: "Scene Builder", icon: <LayoutDashboard size={14} /> },
    { id: "props" as const, label: "Props", icon: <Layers size={14} /> },
    { id: "settings" as const, label: "Preferences", icon: <Sliders size={14} /> },
  ];

  return (
    <div className="h-screen bg-slate-950 text-slate-200 flex flex-col font-sans overflow-hidden">
      <header className="flex items-center gap-0 px-0 border-b border-slate-800 bg-slate-900 shrink-0">
        {/* Branding */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-r border-slate-800 shrink-0">
          <div className="w-7 h-7 bg-gradient-to-br from-purple-600 to-purple-800 rounded-lg flex items-center justify-center shadow-lg">
            <Clapperboard size={14} className="text-white" />
          </div>
          <div>
            <p className="text-[11px] font-black uppercase tracking-widest text-white leading-tight">Design Hub</p>
            <p className="text-[8px] text-purple-500 font-semibold leading-tight">Presentation Tools</p>
          </div>
        </div>
        {/* Tabs */}
        <div className="flex flex-1 h-full">
          {tabs.map(({ id, label, icon }) => (
            <button
              key={id}
              onClick={() => setHubTab(id)}
              className={`flex items-center gap-2 px-4 py-3 text-[11px] font-semibold border-b-2 transition-all ${
                hubTab === id
                  ? "border-purple-500 text-purple-300 bg-purple-500/5"
                  : "border-transparent text-slate-500 hover:text-slate-300 hover:bg-slate-800/30"
              }`}
            >
              <span className={hubTab === id ? "text-purple-400" : "text-slate-600"}>{icon}</span>
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        {/* Full-height fill tabs — no padding wrapper */}
        {hubTab === "lt-designer" && <LtDesignerTab onSetToast={setToast} onLoadMedia={async () => {}} />}
        {hubTab === "scene" && (
          <SceneComposerTab
            onSetToast={setToast}
            onStage={stageItem}
            onLive={sendLive}
            onAddToSchedule={addToSchedule}
          />
        )}
        {/* Scrollable tabs — padded, overflow-y-auto */}
        {(hubTab === "studio" || hubTab === "props" || hubTab === "settings") && (
          <div className="h-full overflow-y-auto p-4 custom-scrollbar">
            {hubTab === "studio" && <StudioTab onOpenEditor={handleOpenEditor} onNewPresentation={handleNewPresentation} />}
            {hubTab === "props" && <PropsTab onUpdateProps={updateProps} />}
            {hubTab === "settings" && (
              <SettingsTab
                onUpdateSettings={updateSettings}
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
