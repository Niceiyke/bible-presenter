import { useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { displayItemLabel, stableId } from "../utils";
import { itemNextLive, type ItemLookup } from "../items/registry";
import type { DisplayItem, PresentationSettings, PropItem, MediaItem, ScheduleEntry, Schedule, ServiceMeta, Scene } from "../types";

const getVerseKey = (v: any, threshold: number) => `${v.book}-${v.chapter}-${v.verse}-${v.version}-${threshold}`;
const MAX_VERSE_SPLITS = 64;

export interface ClearSnapshot {
  liveItem: DisplayItem | null;
  stagedItem: DisplayItem | null;
  propItems: PropItem[];
  currentLowerThird: { data: any; template: any } | null;
  ltVisible: boolean;
}

export function useItemActions() {
  const {
    liveItem, setLiveItem, stagedItem, setStagedItem,
    previousItem, setPreviousItem,
    nextVerse, recentItems, setRecentItems,
    settings, setSettings,
    ltVisible, setLtVisible, ltTemplate, ltMode, ltLineIndex, ltLinesPerDisplay,
    currentLowerThird, setCurrentLowerThird,
    scheduleEntries, setScheduleEntries,
    activeServiceId, setActiveServiceId,
    setActiveScheduleIdx,
    services, setServices,
    media, setMedia,
    songs, hymnLibrary, studioSlides,
    setToast, setPropItems, propItems,
    setBackendError, setBusyAction,
    scenes, setScenes,
    setPendingScheduleItem, setAddToServiceOpen,
  } = useAppStore();

  const verseSplitsRef = useRef<Record<string, any[]>>({});

  // Monotonic guard so a slow (e.g. verse-splitting) stage request can never
  // overwrite a newer staging request. Only the newest request may apply its
  // result to local or backend state.
  const stageReqRef = useRef(0);

  const buildLookup = useCallback((): ItemLookup => ({
    studioSlides,
    songs,
    hymns: hymnLibrary,
    nextVerse,
    verseSplits: verseSplitsRef.current as any,
    verseSplitThreshold: settings.verse_split_threshold,
  }), [studioSlides, songs, hymnLibrary, nextVerse, settings.verse_split_threshold]);

  const updateSettings = useCallback(async (next: PresentationSettings) => {
    const prev = useAppStore.getState().settings;
    setSettings(next);
    try {
      await invoke("save_settings", { settings: next });
    } catch (err: any) {
      setSettings(prev);
      setBackendError(`Failed to save settings: ${err?.message ?? err}`);
    }
  }, [setSettings, setBackendError]);

  const updateProps = useCallback(async (items: PropItem[]) => {
    const prev = useAppStore.getState().propItems;
    setPropItems(items);
    try {
      await invoke("set_props", { props: items });
    } catch (err: any) {
      setPropItems(prev);
      setBackendError(`Failed to update props: ${err?.message ?? err}`);
    }
  }, [setPropItems, setBackendError]);

  const nextLiveItem = useMemo((): DisplayItem | null => {
    if (!liveItem) return null;
    return itemNextLive(liveItem, buildLookup());
  }, [liveItem, buildLookup]);

  const stageItem = useCallback(async (item: DisplayItem): Promise<boolean> => {
    const reqId = ++stageReqRef.current;
    let finalItem = item;
    const prevStaged = useAppStore.getState().stagedItem;

    if (item.type === "Verse" && item.data.split_index === undefined && settings.auto_split_verses) {
      const key = getVerseKey(item.data, settings.verse_split_threshold);
      let splits = verseSplitsRef.current[key];
      if (!splits) {
        try {
          splits = await invoke("split_verse", {
            verse: item.data,
            threshold: settings.verse_split_threshold
          });
          // Cap the cache to avoid unbounded growth across a long service.
          const keys = Object.keys(verseSplitsRef.current);
          if (keys.length >= MAX_VERSE_SPLITS) {
            delete verseSplitsRef.current[keys[0]];
          }
          verseSplitsRef.current[key] = splits;
        } catch (err: any) {
          setBackendError(`Failed to split verse: ${err?.message ?? err}`);
          return false;
        }
      }
      if (splits.length > 1) {
        finalItem = { type: "Verse", data: splits[0] };
      }
    }

    // Abandon this request if a newer stage request began while we awaited
    // the verse split. Only the newest request may update staged state.
    if (reqId !== stageReqRef.current) return false;

    setBusyAction("stage", true);
    setStagedItem(finalItem);
    try {
      await invoke("stage_item", { item: finalItem });
    } catch (err: any) {
      if (reqId === stageReqRef.current) {
        setStagedItem(prevStaged);
        setBackendError(`Failed to stage item: ${err?.message ?? err}`);
      }
      return false;
    } finally {
      if (reqId === stageReqRef.current) setBusyAction("stage", false);
    }
    return true;
  }, [setStagedItem, settings, setBackendError, setBusyAction]);

  const getNextItem = useCallback((item: DisplayItem): DisplayItem | null => {
    return itemNextLive(item, buildLookup());
  }, [buildLookup]);

  const goLive = useCallback(async (): Promise<boolean> => {
    const current = useAppStore.getState().liveItem;
    const staged = useAppStore.getState().stagedItem;
    let committed: DisplayItem | null = null;
    setBusyAction("goLive", true);
    try {
      committed = (await invoke<DisplayItem | null>("commit_staged")) ?? null;
    } catch (err: any) {
      setBackendError(`Failed to go live: ${err?.message ?? err}`);
      return false;
    } finally {
      setBusyAction("goLive", false);
    }
    if (committed) setLiveItem(committed);
    if (current) setPreviousItem(current);

    if (staged?.type === "Song" && staged.data.style === "LowerThird") {
      const payload = {
        kind: "Lyrics",
        data: {
          line1: staged.data.lines[0] ?? "",
          line2: staged.data.lines[1],
          section_label: staged.data.section_label
        }
      };
      // Phase 6: only claim the overlay is visible when the backend accepts
      // the show command — a silent fire-and-forget would let the operator
      // believe an overlay is on air when it is not.
      invoke("show_lower_third", { data: payload, template: ltTemplate })
        .then(() => {
          setLtVisible(true);
          useAppStore.getState().setLtSongId(staged.data.song_id);
          useAppStore.getState().setLtLineIndex(staged.data.slide_index);
          useAppStore.getState().setLtMode("lyrics");
        })
        .catch((e: any) => setBackendError(`Lower-third failed: ${e?.message ?? e}`));
    }

    if (settings.auto_clear_background_logo && settings.show_background_logo) {
      updateSettings({ ...settings, show_background_logo: false });
    }

    if (nextLiveItem) {
      stageItem(nextLiveItem);
    }
    return true;
  }, [nextLiveItem, stageItem, settings, setPreviousItem, setLiveItem, ltTemplate, setLtVisible, updateSettings, setBackendError, setBusyAction]);

  const sendLive = useCallback(async (item: DisplayItem): Promise<boolean> => {
    const current = useAppStore.getState().liveItem;
    // Stage first; never commit when staging fails — commit would expose an
    // older or invalid item to the audience.
    const stagedOk = await stageItem(item);
    if (!stagedOk) return false;

    let committed: DisplayItem | null = null;
    setBusyAction("goLive", true);
    try {
      committed = (await invoke<DisplayItem | null>("commit_staged")) ?? null;
    } catch (err: any) {
      setBackendError(`Failed to send live: ${err?.message ?? err}`);
      return false;
    } finally {
      setBusyAction("goLive", false);
    }
    setLiveItem(committed);
    if (current) setPreviousItem(current);

    if (item.type === "Song" && item.data.style === "LowerThird") {
      const payload = {
        kind: "Lyrics",
        data: {
          line1: item.data.lines[0] ?? "",
          line2: item.data.lines[1],
          section_label: item.data.section_label
        }
      };
      // Phase 6: see goLive — only flip the visible state on a successful show.
      invoke("show_lower_third", { data: payload, template: ltTemplate })
        .then(() => {
          setLtVisible(true);
          useAppStore.getState().setLtSongId(item.data.song_id);
          useAppStore.getState().setLtLineIndex(item.data.slide_index);
          useAppStore.getState().setLtMode("lyrics");
        })
        .catch((e: any) => setBackendError(`Lower-third failed: ${e?.message ?? e}`));
    }

    if (settings.auto_clear_background_logo && settings.show_background_logo) {
      updateSettings({ ...settings, show_background_logo: false });
    }

    const lbl = displayItemLabel(item);

    setRecentItems((prev) => {
      const next = { ...prev };
      if (item.type === "Verse" || item.type === "Song") {
        next.bible = [item, ...prev.bible.filter(h => displayItemLabel(h) !== lbl)].slice(0, 100);
      } else if (item.type === "Media") {
        next.media = [item, ...prev.media.filter(h => displayItemLabel(h) !== lbl)].slice(0, 50);
      } else if (item.type === "CustomSlide") {
        next.presentation = [item, ...prev.presentation.filter(h => displayItemLabel(h) !== lbl)].slice(0, 50);
      }
      return next;
    });

    const next = getNextItem(item);
    if (next) {
      stageItem(next);
    }
    return true;
  }, [stageItem, setRecentItems, getNextItem, setPreviousItem, setLiveItem, settings, ltTemplate, setLtVisible, updateSettings, setBackendError, setBusyAction]);

  const clearAll = useCallback(async (): Promise<ClearSnapshot | null> => {
    const snapshot: ClearSnapshot = {
      liveItem: useAppStore.getState().liveItem,
      stagedItem: useAppStore.getState().stagedItem,
      propItems: useAppStore.getState().propItems,
      currentLowerThird: useAppStore.getState().currentLowerThird,
      ltVisible: useAppStore.getState().ltVisible,
    };
    setBusyAction("clear", true);
    try {
      await invoke("clear_all");
    } catch (err: any) {
      useAppStore.getState().setLiveItem(snapshot.liveItem);
      useAppStore.getState().setStagedItem(snapshot.stagedItem);
      useAppStore.getState().setPropItems(snapshot.propItems);
      setBackendError(`Clear All failed: ${err?.message ?? err}`);
      return null;
    } finally {
      setBusyAction("clear", false);
    }
    setLiveItem(null);
    setStagedItem(null);
    setPropItems([]);
    setLtVisible(false);
    setCurrentLowerThird(null);
    return snapshot;
  }, [setLiveItem, setStagedItem, setPropItems, setLtVisible, setCurrentLowerThird, setBackendError, setBusyAction]);

  const undoClearAll = useCallback(async (snapshot: ClearSnapshot): Promise<boolean> => {
    setBusyAction("clear", true);
    try {
      if (snapshot.stagedItem) {
        const ok = await stageItem(snapshot.stagedItem);
        if (!ok) throw new Error("restoring staged item failed");
      }
      if (snapshot.liveItem) {
        const current = useAppStore.getState().liveItem;
        await invoke("go_live_item", { item: snapshot.liveItem });
        setLiveItem(snapshot.liveItem);
        if (current) setPreviousItem(current);
      }
      if (snapshot.propItems.length > 0) {
        await invoke("set_props", { props: snapshot.propItems });
        setPropItems(snapshot.propItems);
      }
      if (snapshot.ltVisible && snapshot.currentLowerThird) {
        await invoke("show_lower_third", {
          data: snapshot.currentLowerThird.data,
          template: snapshot.currentLowerThird.template,
        });
        setCurrentLowerThird(snapshot.currentLowerThird);
        setLtVisible(true);
      }
      setToast("Clear undone");
      return true;
    } catch (err: any) {
      setBackendError(`Undo clear failed: ${err?.message ?? err}`);
      return false;
    } finally {
      setBusyAction("clear", false);
    }
  }, [setLiveItem, setStagedItem, setPropItems, setCurrentLowerThird, setLtVisible, setToast, setBackendError, setBusyAction, stageItem]);

  const addToSchedule = useCallback(async (item: DisplayItem) => {
    const svcs = useAppStore.getState().services;
    // With multiple services, ask which one to add to instead of silently
    // appending to the currently active service.
    if (svcs.length > 1) {
      setPendingScheduleItem(item);
      setAddToServiceOpen(true);
      return;
    }
    const entry: ScheduleEntry = { id: stableId(), item };
    setScheduleEntries([...scheduleEntries, entry]);
    setToast("Added to schedule");
  }, [scheduleEntries, setScheduleEntries, setToast, setPendingScheduleItem, setAddToServiceOpen]);

  const addToService = useCallback(async (item: DisplayItem, serviceId: string) => {
    try {
      const loaded: Schedule = await invoke<Schedule>("load_service", { id: serviceId })
        .catch(() => ({ id: serviceId, name: "Service", items: [] } as Schedule));
      const entry: ScheduleEntry = { id: stableId(), item };
      const next: Schedule = { ...loaded, items: [...(loaded.items ?? []), entry] };
      await invoke("save_service", { schedule: next });
      setActiveServiceId(serviceId);
      setScheduleEntries(next.items ?? []);
      setActiveScheduleIdx(null);
      localStorage.setItem("activeServiceId", serviceId);
      const list = (await invoke<ServiceMeta[]>("list_services")) as ServiceMeta[];
      setServices(list);
      setToast("Added to service");
      return true;
    } catch (err: any) {
      setBackendError(`Add to service failed: ${err?.message ?? err}`);
      return false;
    }
  }, [setActiveServiceId, setScheduleEntries, setActiveScheduleIdx, setServices, setToast, setBackendError]);

  const persistSchedule = useCallback(async () => {
    const s: Schedule = { id: activeServiceId, name: services.find(s => s.id === activeServiceId)?.name || "Service", items: scheduleEntries };
    setBusyAction("save", true);
    try {
      await invoke("save_service", { schedule: s });
      setToast("Service saved");
    } catch (err: any) {
      setBackendError(`Save service failed: ${err?.message ?? err}`);
    } finally {
      setBusyAction("save", false);
    }
  }, [activeServiceId, services, scheduleEntries, setToast, setBackendError, setBusyAction]);

  const handleFileUpload = useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [
          { name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] },
          { name: "Videos", extensions: ["mp4", "webm", "mov", "mkv", "avi"] },
          { name: "Audio", extensions: ["mp3", "wav", "ogg", "m4a", "aac", "flac"] },
        ],
      });
      if (!selected || typeof selected !== "string") return;
      setToast("Importing media…");
      await invoke("add_media_streaming", { path: selected });
      const result: MediaItem[] = await invoke("list_media");
      setMedia(result);
      setToast("Media added to library");
    } catch (err: any) {
      console.error("Upload failed:", err);
      setBackendError(`Upload failed: ${err?.message ?? err}`);
    }
  }, [media, setMedia, setToast, setBackendError]);

  const handleDeleteMedia = useCallback(async (id: string, removeFile = true) => {
    try {
      await invoke("delete_media", { id, removeFile });
      setMedia(media.filter((m) => m.id !== id));
    } catch (err: any) {
      console.error("Delete failed:", err);
      setBackendError(`Delete media failed: ${err?.message ?? err}`);
    }
  }, [media, setMedia, setBackendError]);

  // ---- Scenes ----

  const loadScenes = useCallback(async () => {
    try {
      const list = await invoke<Scene[]>("list_scenes");
      setScenes(list);
    } catch (err: any) {
      setBackendError(`Load scenes failed: ${err?.message ?? err}`);
    }
  }, [setScenes, setBackendError]);

  const saveScene = useCallback(async (scene: Scene) => {
    try {
      const saved = await invoke<Scene>("save_scene", { scene });
      const cur = useAppStore.getState().scenes;
      const next = cur.some(s => s.id === saved.id)
        ? cur.map(s => s.id === saved.id ? saved : s)
        : [...cur, saved];
      setScenes(next);
      setToast(`Scene "${saved.name}" saved`);
    } catch (err: any) {
      setBackendError(`Save scene failed: ${err?.message ?? err}`);
    }
  }, [setScenes, setToast, setBackendError]);

  const deleteScene = useCallback(async (id: string) => {
    try {
      await invoke("delete_scene", { id });
      setScenes(useAppStore.getState().scenes.filter(s => s.id !== id));
    } catch (err: any) {
      setBackendError(`Delete scene failed: ${err?.message ?? err}`);
    }
  }, [setScenes, setBackendError]);

  const applyScene = useCallback(async (id: string) => {
    try {
      const payload = await invoke<any>("apply_scene", { id });
      // Mirror the authoritative state the backend just broadcast.
      setSettings(payload.settings);
      setPropItems(payload.props ?? []);
      if (payload.lower_third_data) {
        setLtVisible(true);
        useAppStore.getState().setCurrentLowerThird({
          data: payload.lower_third_data,
          template: payload.lower_third_template ?? ltTemplate,
        });
      } else {
        setLtVisible(false);
        useAppStore.getState().setCurrentLowerThird(null);
      }
      setToast(`Scene "${payload.name}" applied`);
    } catch (err: any) {
      setBackendError(`Apply scene failed: ${err?.message ?? err}`);
    }
  }, [setSettings, setPropItems, setLtVisible, setToast, ltTemplate, setBackendError]);

  const captureScene = useCallback(async (name: string) => {
    try {
      const saved = await invoke<Scene>("capture_scene", { name });
      setScenes([...useAppStore.getState().scenes, saved]);
      setToast(`Captured scene "${saved.name}"`);
    } catch (err: any) {
      setBackendError(`Capture scene failed: ${err?.message ?? err}`);
    }
  }, [setScenes, setToast, setBackendError]);

  return {
    nextLiveItem,
    stageItem,
    goLive,
    sendLive,
    clearAll,
    undoClearAll,
    getNextItem,
    addToSchedule,
    addToService,
    persistSchedule,
    handleFileUpload,
    handleDeleteMedia,
    updateSettings,
    updateProps,
    verseSplitsRef,
    loadScenes,
    saveScene,
    deleteScene,
    applyScene,
    captureScene,
  };
}
