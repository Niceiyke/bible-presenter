import React, { lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useAppStore } from "../../store";
import { stableId, newDefaultSlide } from "../../utils";
import { CameraTab } from "../CameraTab";
import { PropsTab } from "../PropsTab";
import { ScenesTab } from "../ScenesTab";
import { SceneBuilder } from "../SceneBuilder";
import type { DisplayItem, PresentationSettings, PropItem, CustomPresentation, Scene } from "../../types";

// P10: workspace tabs are loaded on demand so the initial bundle stays lean and
// tab switches are fast. Each tab is only mounted while it is active anyway.
const BibleTab = lazy(() => import("../BibleTab").then((m) => ({ default: m.BibleTab })));
const MediaTab = lazy(() => import("../MediaTab").then((m) => ({ default: m.MediaTab })));
const SongsTab = lazy(() => import("../SongsTab").then((m) => ({ default: m.SongsTab })));
const StudioTab = lazy(() => import("../StudioTab").then((m) => ({ default: m.StudioTab })));
const ScheduleTab = lazy(() => import("../ScheduleTab").then((m) => ({ default: m.ScheduleTab })));
const SettingsTab = lazy(() => import("../SettingsTab").then((m) => ({ default: m.SettingsTab })));
const RemoteTab = lazy(() => import("../RemoteTab").then((m) => ({ default: m.RemoteTab })));
const LtDesignerTab = lazy(() => import("../LtDesignerTab").then((m) => ({ default: m.LtDesignerTab })));
const RecordingsTab = lazy(() => import("../RecordingsTab").then((m) => ({ default: m.RecordingsTab })));
const StreamerTab = lazy(() => import("../StreamerTab").then((m) => ({ default: m.StreamerTab })));
const SystemTab = lazy(() => import("../SystemTab").then((m) => ({ default: m.SystemTab })));

/**
 * Full-page Scene Builder workspace (mirrors the LT Designer tab layout).
 * Owns the scene being edited in the store so ScenesTab can hand a specific
 * scene over (or seed a fresh one) before navigating here.
 */
function SceneBuilderPage({
  saveScene,
  applyScene,
}: {
  saveScene: (scene: Scene) => Promise<void>;
  applyScene: (id: string) => Promise<void>;
}) {
  const settings = useAppStore((s) => s.settings);
  const sceneBuilderScene = useAppStore((s) => s.sceneBuilderScene);
  const setSceneBuilderScene = useAppStore((s) => s.setSceneBuilderScene);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const scene = sceneBuilderScene ?? {
    id: stableId(),
    name: "",
    settings: { ...settings },
    props: [],
    layout: { zones: [] },
    created_at: Date.now(),
  };

  const close = () => {
    setSceneBuilderScene(null);
    setActiveTab("scenes");
  };

  return (
    <SceneBuilder
      scene={scene}
      onSceneChange={setSceneBuilderScene}
      onSave={async (sc) => {
        await saveScene(sc);
        setSceneBuilderScene(null);
        setActiveTab("scenes");
      }}
      onApply={async (id) => {
        if (!useAppStore.getState().scenes.some((s) => s.id === id)) {
          await saveScene(scene);
        }
        await applyScene(id);
      }}
      onClose={close}
    />
  );
}

interface ContentBrowserProps {
  stageItem: (item: DisplayItem) => Promise<boolean>;
  sendLive: (item: DisplayItem) => Promise<boolean>;
  addToSchedule: (item: DisplayItem) => Promise<void>;
  handleFileUpload: () => Promise<void>;
  handleDeleteMedia: (id: string) => Promise<void>;
  updateSettings: (s: PresentationSettings) => Promise<void>;
  updateProps: (items: PropItem[]) => Promise<void>;
  setEditingPres: (pres: CustomPresentation | null) => void;
  persistSchedule: () => Promise<void>;
  saveScene: (scene: Scene) => Promise<void>;
  deleteScene: (id: string) => Promise<void>;
  applyScene: (id: string) => Promise<void>;
  captureScene: (name: string) => Promise<void>;
}

export function ContentBrowser({
  stageItem,
  sendLive,
  addToSchedule,
  handleFileUpload,
  handleDeleteMedia,
  updateSettings,
  updateProps,
  setEditingPres,
  persistSchedule,
  saveScene,
  deleteScene,
  applyScene,
  captureScene,
}: ContentBrowserProps) {
  const {
    activeTab,
    media, setMedia,
    studioList, setStudioList,
    studioSlides, setStudioSlides,
    setToast,
    setBottomDeckOpen, setBottomDeckMode,
  } = useAppStore();

return (
    <div className={activeTab === "lt-designer" || activeTab === "scenes" || activeTab === "scene-builder"
      ? "flex-1 min-h-0 overflow-hidden"
      : "flex-1 min-h-0 overflow-y-auto p-4 custom-scrollbar"}>
      <Suspense fallback={null}>
        {activeTab === "bible" && <BibleTab onStage={stageItem} onLive={sendLive} onAddToSchedule={addToSchedule} />}
        {activeTab === "media" && (
          <MediaTab
            onStage={stageItem} onLive={sendLive} onAddToSchedule={addToSchedule}
            onLoadMedia={handleFileUpload} onDeleteMedia={handleDeleteMedia}
            onSetAsLogo={(path) => updateSettings({ ...useAppStore.getState().settings, logo_path: path })}
            onSetAsBackgroundLogo={(path) => {
              const fit = media.find(m => m.path === path)?.fit_mode ?? "cover";
              updateSettings({ ...useAppStore.getState().settings, background_logo_path: path, background_logo_fit: fit, show_background_logo: true });
              setToast("Background logo set & activated");
            }}
          />
        )}
        {activeTab === "studio" && (
          <StudioTab
            onStage={stageItem} onLive={sendLive} onAddToSchedule={addToSchedule}
            onOpenEditor={(id) => {
              invoke("load_studio_presentation", { id }).then((data: any) => {
                const pres = data as CustomPresentation;
                setStudioSlides({ ...studioSlides, [id]: pres.slides });
                setEditingPres(pres);
              }).catch(() => {});
            }}
            onNewPresentation={() => {
              const id = stableId();
              // P2.4: new presentations get a synthesized default theme so
              // text elements authored with `font_family: "inherit"` resolve
              // against the cascade from the very first save.
              const newPres: CustomPresentation = {
                id,
                name: "New Presentation",
                slides: [newDefaultSlide()],
                version: 2,
                theme: {
                  id: stableId(),
                  name: "Default",
                  defaultFontFamily: "Arial",
                  defaultFontSize: 32,
                  titleStyle: { font_family: "Arial", font_size: 60, color: "#ffffff", bold: true },
                  bodyStyle: { font_family: "Arial", font_size: 32, color: "#ffffff" },
                  textColor: "#ffffff",
                  accentColor: "#f59e0b",
                  background: { type: "color", value: "#1a1a2e" },
                },
              };
              invoke("save_studio_presentation", { presentation: newPres }).then(() => {
                const nextList = [...studioList, { id, name: newPres.name, slide_count: 1, version: 2, updated_at: Date.now() }];
                setStudioList(nextList);
                emit("studio-sync", nextList);
                setStudioSlides({ ...studioSlides, [id]: newPres.slides });
                setEditingPres(newPres);
              }).catch(() => {});
            }}
          />
        )}
        {activeTab === "lt-designer" && <LtDesignerTab onSetToast={setToast} onLoadMedia={async () => {}} />}
        {activeTab === "scene-builder" && <SceneBuilderPage saveScene={saveScene} applyScene={applyScene} />}
        {activeTab === "songs" && (
          <SongsTab
            onStage={stageItem} onLive={sendLive} onAddToSchedule={addToSchedule}
            onOpenLyricsMode={(id) => {
              setBottomDeckOpen(true);
              setBottomDeckMode("live-lt");
              useAppStore.getState().setLtSongId(id);
              useAppStore.getState().setLtMode("lyrics");
            }}
          />
        )}
        {activeTab === "schedule" && <ScheduleTab onSendItem={sendLive} onPersist={persistSchedule} stageItem={stageItem} />}
        {activeTab === "settings" && <SettingsTab onUpdateSettings={updateSettings} onUploadMedia={handleFileUpload} />}
        {activeTab === "remote" && <RemoteTab />}
        {activeTab === "recordings" && <RecordingsTab />}
        {activeTab === "streaming" && <StreamerTab />}
        {activeTab === "diagnostics" && <SystemTab />}
        {activeTab === "props" && <PropsTab onUpdateProps={updateProps} />}
        {activeTab === "scenes" && (
          <ScenesTab
            saveScene={saveScene}
            deleteScene={deleteScene}
            applyScene={applyScene}
            captureScene={captureScene}
          />
        )}
      </Suspense>
    </div>
  );
}
