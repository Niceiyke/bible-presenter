import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useAppStore } from "../../store";
import { stableId, newDefaultSlide } from "../../utils";
import { BibleTab } from "../BibleTab";
import { MediaTab } from "../MediaTab";
import { SongsTab } from "../SongsTab";
import { CameraTab } from "../CameraTab";
import { LtDesignerTab } from "../LtDesignerTab";
import { StudioTab } from "../StudioTab";
import { ScheduleTab } from "../ScheduleTab";
import { SettingsTab } from "../SettingsTab";
import { PropsTab } from "../PropsTab";
import { ScenesTab } from "../ScenesTab";
import type { DisplayItem, PresentationSettings, PropItem, CustomPresentation, Scene } from "../../types";

interface ContentBrowserProps {
  stageItem: (item: DisplayItem) => Promise<void>;
  sendLive: (item: DisplayItem) => Promise<void>;
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
    <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
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
            const newPres: CustomPresentation = { id, name: "New Presentation", slides: [newDefaultSlide()], version: 1 };
            invoke("save_studio_presentation", { presentation: newPres }).then(() => {
              const nextList = [...studioList, { id, name: newPres.name, slide_count: 1, version: 1, updated_at: Date.now() }];
              setStudioList(nextList);
              emit("studio-sync", nextList);
              setStudioSlides({ ...studioSlides, [id]: newPres.slides });
              setEditingPres(newPres);
            }).catch(() => {});
          }}
        />
      )}
      {activeTab === "lt-designer" && <LtDesignerTab onSetToast={setToast} onLoadMedia={async () => {}} />}
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
      {activeTab === "props" && <PropsTab onUpdateProps={updateProps} />}
      {activeTab === "scenes" && (
        <ScenesTab
          saveScene={saveScene}
          deleteScene={deleteScene}
          applyScene={applyScene}
          captureScene={captureScene}
        />
      )}
    </div>
  );
}
