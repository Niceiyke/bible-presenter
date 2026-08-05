import React, { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { AnimatePresence } from "framer-motion";
import { Layers, Monitor, Sliders, Wand2, Clapperboard, Loader2 } from "lucide-react";
import { useAppStore } from "../store";
import { SlideEditor } from "../components/editors/SlideEditor";
import { LtDesignerTab } from "../components/LtDesignerTab";
import { StudioTab } from "../components/StudioTab";
import { PropsTab } from "../components/PropsTab";
import { SettingsTab } from "../components/SettingsTab";
import { Toast } from "../components/Toast";
import { stableId, newDefaultSlide } from "../utils";
import type {
  PresentationSummary,
  CustomPresentation,
  MediaItem,
  LowerThirdTemplate,
  PropItem,
  PresentationSettings,
  DisplayItem,
  SlideTemplate,
} from "../types";

export function DesignHub() {
  const {
    studioList, setStudioList,
    setStudioSlides,
    media, setMedia,
    setLtTemplate,
    setLtSavedTemplates,
    setPropItems,
    settings, setSettings,
    toast, setToast,
    setAppDataDir,
    setStagedItem,
    setLiveItem,
    scheduleEntries, setScheduleEntries,
    editorPresId, setEditorPresId,
    editorPres, setEditorPres,
    setTemplates,
  } = useAppStore();

  const [hubTab, setHubTab] = useState<"studio" | "lt-designer" | "props" | "settings">("studio");
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const mediaImages = media.filter(i => i.media_type === "Image");

  useEffect(() => {
    const loadAll = async () => {
      setIsLoading(true);
      setLoadError(null);
      const errors: string[] = [];

      try {
        const [studioRes, mediaRes, ltRes, propsRes, settingsRes, appDirRes, templatesRes] = await Promise.all([
          invoke<PresentationSummary[]>("list_studio_presentations").catch((e) => { errors.push("Presentations: " + String(e)); return []; }),
          invoke<MediaItem[]>("list_media").catch((e) => { errors.push("Media: " + String(e)); return []; }),
          invoke<LowerThirdTemplate[]>("load_lt_templates").catch((e) => { errors.push("LT Templates: " + String(e)); return []; }),
          invoke<PropItem[]>("get_props").catch((e) => { errors.push("Props: " + String(e)); return []; }),
          invoke<PresentationSettings>("get_settings").catch((e) => { errors.push("Settings: " + String(e)); return null; }),
          invoke<string>("get_app_data_dir").catch((e) => { errors.push("App data dir: " + String(e)); return null; }),
          invoke<SlideTemplate[]>("list_slide_templates").catch((e) => { errors.push("Templates: " + String(e)); return []; }),
        ]);

        setStudioList(studioRes);
        setMedia(mediaRes);
        setTemplates(templatesRes);

        const savedTpls = ltRes.length ? ltRes : [useAppStore.getState().ltTemplate];
        setLtSavedTemplates(savedTpls);
        const activeId = localStorage.getItem("activeLtTemplateId");
        const active = savedTpls.find(t => t.id === activeId) || savedTpls[0];
        setLtTemplate(active);

        setPropItems(propsRes);
        if (settingsRes) setSettings(settingsRes);
        if (appDirRes) setAppDataDir(appDirRes);

        if (errors.length > 0) {
          setLoadError("Some data failed to load: " + errors.join("; "));
        }
      } catch (e) {
        setLoadError("Failed to initialize: " + String(e));
      } finally {
        setIsLoading(false);
      }
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
    const list = await invoke<PresentationSummary[]>("list_studio_presentations");
    setStudioList(list);
    emit("studio-sync", list);
    setEditorPresId(pres.id);
    setEditorPres(pres);
  };

  const handleOpenEditor = async (id: string) => {
    const data = await invoke<CustomPresentation>("load_studio_presentation", { id });
    setEditorPresId(id);
    setEditorPres(data);
  };

  const handleEditorClose = async (saved: boolean) => {
    setEditorPresId(null);
    setEditorPres(null);
    if (saved) {
      const list = await invoke<PresentationSummary[]>("list_studio_presentations");
      setStudioList(list);
      emit("studio-sync", list);
    }
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
        media={media}
        onClose={handleEditorClose}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="h-screen bg-slate-950 flex items-center justify-center font-sans">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={32} className="text-purple-500 animate-spin" />
          <p className="text-sm text-slate-400">Loading design tools…</p>
        </div>
      </div>
    );
  }

  const tabs = [
    { id: "studio" as const, label: "Studio", icon: <Clapperboard size={14} /> },
    { id: "lt-designer" as const, label: "LT Designer", icon: <Wand2 size={14} /> },
    { id: "props" as const, label: "Props", icon: <Layers size={14} /> },
    { id: "settings" as const, label: "Preferences", icon: <Sliders size={14} /> },
  ];

  return (
    <div className="h-screen bg-slate-950 text-slate-200 flex flex-col font-sans overflow-hidden">
      <header className="flex items-center gap-0 px-0 border-b border-slate-800 bg-slate-900 shrink-0">
        <div className="flex items-center gap-2.5 px-4 py-3 border-r border-slate-800 shrink-0">
          <div className="w-7 h-7 bg-gradient-to-br from-purple-600 to-purple-800 rounded-lg flex items-center justify-center shadow-lg">
            <Clapperboard size={14} className="text-white" />
          </div>
          <div>
            <p className="text-[11px] font-black uppercase tracking-widest text-white leading-tight">Design Hub</p>
            <p className="text-[8px] text-purple-500 font-semibold leading-tight">Presentation Tools</p>
          </div>
        </div>
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

      {loadError && (
        <div className="bg-red-900/40 border-b border-red-500/30 px-4 py-2 text-[11px] text-red-400 font-medium flex items-center gap-2 shrink-0">
          <span className="text-red-500">&#x26A0;</span> {loadError}
          <button onClick={() => setLoadError(null)} className="ml-auto text-red-500 hover:text-red-300 text-[11px] font-bold">Dismiss</button>
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        {hubTab === "lt-designer" && <LtDesignerTab onSetToast={setToast} onLoadMedia={async () => {}} />}
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
