import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { stableId } from "../utils";
import {
  MediaItem, Song, LowerThirdTemplate,
  PresentationSettings, PropItem, SceneData, ServiceMeta,
  DisplayItem
} from "../types";

export function useAppInitialization() {
  const {
    setLabel, setMedia, setStudioList, setStudioSlides,
    setScheduleEntries, setSongs, setHymnLibrary, setLtSavedTemplates,
    setLtTemplate, setSettings, setAvailableVersions, setBibleVersion,
    setPropItems, setSavedScenes, setServices, setLiveItem,
    setLtVisible, setCurrentLowerThird,
    setStagedItem, setStartupIssues, setIsInitialized,
    setAppDataDir,
  } = useAppStore();

  useEffect(() => {
    const windowLabel = getCurrentWindow().label;
    setLabel(windowLabel);
    if (windowLabel === "output") {
      setIsInitialized(true);
      return;
    }

    const loadAll = async () => {
      let ready = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        try {
          await invoke("get_startup_status");
          ready = true;
          break;
        } catch (e) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      if (!ready) return;

      const [
        versionsRes, mediaRes, studioRes, scheduleRes, songsRes, hymnLibraryRes,
        ltRes, settingsRes, propsRes,
        scenesRes, servicesRes, currentLtRes, appDirRes
      ] = await Promise.all([
        invoke<string[]>("get_bible_versions").catch(() => []),
        invoke<MediaItem[]>("list_media").catch(() => []),
        invoke<any[]>("list_studio_presentations").catch(() => []),
        invoke<any>("load_schedule").catch(() => ({ items: [] })),
        invoke<Song[]>("list_songs").catch(() => []),
        invoke<Song[]>("get_hymn_library").catch(() => []),
        invoke<LowerThirdTemplate[]>("load_lt_templates").catch(() => []),
        invoke<PresentationSettings>("get_settings").catch(() => null),
        invoke<PropItem[]>("get_props").catch(() => []),
        invoke<SceneData[]>("list_scenes").catch(() => []),
        invoke<ServiceMeta[]>("list_services").catch(() => []),
        invoke<any>("get_current_lower_third").catch(() => null),
        invoke<string>("get_app_data_dir").catch(() => null),
      ]);

      setMedia(mediaRes);
      setStudioList(studioRes);
      if (appDirRes) setAppDataDir(appDirRes);
      const scheduleItems = Array.isArray(scheduleRes?.items) ? scheduleRes.items : [];
      setScheduleEntries(scheduleItems.map((e: any) => ({ id: e.id || stableId(), item: e.item ?? e })));
      setSongs(songsRes);
      setHymnLibrary(hymnLibraryRes);

      const savedTpls = ltRes.length ? ltRes : [useAppStore.getState().ltTemplate];
      setLtSavedTemplates(savedTpls);
      const activeId = localStorage.getItem("activeLtTemplateId");
      const active = savedTpls.find(t => t.id === activeId) || savedTpls[0];
      setLtTemplate(active);

      if (currentLtRes) setCurrentLowerThird(currentLtRes);

      if (settingsRes) setSettings(settingsRes);

      setAvailableVersions(versionsRes);
      setBibleVersion(localStorage.getItem("pref_bibleVersion") || (versionsRes.length > 0 ? versionsRes[0] : ""));

      setPropItems(propsRes);
      setSavedScenes(scenesRes);
      setServices(servicesRes.length ? servicesRes : [{ id: "default", name: "Sunday Service", item_count: 0, updated_at: Date.now() }]);

      invoke("get_current_item").then((v: any) => { if (v) setLiveItem(v); }).catch(() => {});

      setIsInitialized(true);
    };

    loadAll();

    const unlistenStaged = listen("item-staged", (ev: any) => setStagedItem(ev.payload as DisplayItem));
    const unlistenSettings = listen("settings-changed", (ev: any) => setSettings(ev.payload as PresentationSettings));
    const unlistenLtUpdate = listen("lower-third-update", (ev: any) => {
      const payload = ev.payload;
      if (payload) {
        setCurrentLowerThird(payload);
        setLtVisible(true);
      } else {
        setCurrentLowerThird(null);
        setLtVisible(false);
      }
    });
    const unlistenLtSync = listen<LowerThirdTemplate[]>("lower-third-template-sync", (ev) => {
      const incoming = ev.payload;
      if (incoming.length === 1) {
        const t = incoming[0];
        setLtSavedTemplates(useAppStore.getState().ltSavedTemplates.map(old => old.id === t.id ? t : old));
        if (useAppStore.getState().ltTemplate.id === t.id) setLtTemplate(t);
      } else {
        setLtSavedTemplates(incoming);
        const activeId = useAppStore.getState().ltTemplate.id;
        const active = incoming.find(t => t.id === activeId);
        if (active) setLtTemplate(active);
      }
    });
    const unlistenScenesSync = listen<SceneData[]>("scenes-sync", (ev) => { setSavedScenes(ev.payload); });
    const unlistenSongsSync = listen<Song[]>("songs-sync", (ev) => { setSongs(ev.payload); });
    const unlistenStudioSync = listen<any[]>("studio-sync", (ev) => { setStudioList(ev.payload); });
    const unlistenStudioSlidesSync = listen<{ id: string; slides: any[] }>("studio-slides-sync", (ev) => {
      const { id, slides } = ev.payload;
      setStudioSlides({ ...useAppStore.getState().studioSlides, [id]: slides });
    });
    const unlistenLog = listen<any>("system-log", (ev) => {
      useAppStore.getState().addLog(ev.payload);
    });

    return () => {
      unlistenStaged.then(f => f());
      unlistenSettings.then(f => f());
      unlistenLtUpdate.then(f => f());
      unlistenLtSync.then(f => f());
      unlistenScenesSync.then(f => f());
      unlistenSongsSync.then(f => f());
      unlistenStudioSync.then(f => f());
      unlistenStudioSlidesSync.then(f => f());
      unlistenLog.then(f => f());
    };
  }, []);

  useEffect(() => {
    const label = getCurrentWindow().label;
    if (label === "main") {
      invoke("set_bible_version", { version: useAppStore.getState().bibleVersion }).catch(() => {});
    }
  }, [useAppStore.getState().bibleVersion]);
}
