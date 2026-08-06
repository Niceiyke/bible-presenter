import { useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { displayItemLabel, stableId } from "../utils";
import { itemNextLive, type ItemLookup } from "../items/registry";
import type { DisplayItem, PresentationSettings, PropItem, MediaItem, ScheduleEntry, Schedule, Scene } from "../types";

const getVerseKey = (v: any, threshold: number) => `${v.book}-${v.chapter}-${v.verse}-${v.version}-${threshold}`;
const MAX_VERSE_SPLITS = 64;

export function useItemActions() {
  const {
    liveItem, setLiveItem, stagedItem, setStagedItem,
    previousItem, setPreviousItem,
    nextVerse, recentItems, setRecentItems,
    settings, setSettings,
    ltVisible, setLtVisible, ltTemplate, ltMode, ltLineIndex, ltLinesPerDisplay,
    scheduleEntries, setScheduleEntries,
    activeServiceId, services,
    media, setMedia,
    songs, studioSlides,
    setToast, setPropItems,
    setBackendError,
    scenes, setScenes,
  } = useAppStore();

  const verseSplitsRef = useRef<Record<string, any[]>>({});

  const buildLookup = useCallback((): ItemLookup => ({
    studioSlides,
    songs,
    nextVerse,
    verseSplits: verseSplitsRef.current as any,
    verseSplitThreshold: settings.verse_split_threshold,
  }), [studioSlides, songs, nextVerse, settings.verse_split_threshold]);

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

  const stageItem = useCallback(async (item: DisplayItem) => {
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
          return;
        }
      }
      if (splits.length > 1) {
        finalItem = { type: "Verse", data: splits[0] };
      }
    }

    setStagedItem(finalItem);
    try {
      await invoke("stage_item", { item: finalItem });
    } catch (err: any) {
      setStagedItem(prevStaged);
      setBackendError(`Failed to stage item: ${err?.message ?? err}`);
    }
  }, [setStagedItem, settings, setBackendError]);

  const getNextItem = useCallback((item: DisplayItem): DisplayItem | null => {
    return itemNextLive(item, buildLookup());
  }, [buildLookup]);

  const goLive = useCallback(async () => {
    const current = liveItem;
    const staged = stagedItem;
    let committed: DisplayItem | null = null;
    try {
      committed = (await invoke<DisplayItem | null>("commit_staged")) ?? null;
    } catch (err: any) {
      setBackendError(`Failed to go live: ${err?.message ?? err}`);
      return;
    }
    setLiveItem(committed);
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
      invoke("show_lower_third", { data: payload, template: ltTemplate }).catch((e: any) =>
        setBackendError(`Lower-third failed: ${e?.message ?? e}`));
      setLtVisible(true);
      useAppStore.getState().setLtSongId(staged.data.song_id);
      useAppStore.getState().setLtLineIndex(staged.data.slide_index);
      useAppStore.getState().setLtMode("lyrics");
    }

    if (settings.auto_clear_background_logo && settings.show_background_logo) {
      updateSettings({ ...settings, show_background_logo: false });
    }

    if (nextLiveItem) {
      stageItem(nextLiveItem);
    }
  }, [nextLiveItem, stageItem, liveItem, stagedItem, settings, setPreviousItem, setLiveItem, ltTemplate, setLtVisible, updateSettings, setBackendError]);

  const sendLive = useCallback(async (item: DisplayItem) => {
    const current = liveItem;
    await stageItem(item);
    let committed: DisplayItem | null = null;
    try {
      committed = (await invoke<DisplayItem | null>("commit_staged")) ?? null;
    } catch (err: any) {
      setBackendError(`Failed to send live: ${err?.message ?? err}`);
      return;
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
      invoke("show_lower_third", { data: payload, template: ltTemplate }).catch((e: any) =>
        setBackendError(`Lower-third failed: ${e?.message ?? e}`));
      setLtVisible(true);
      useAppStore.getState().setLtSongId(item.data.song_id);
      useAppStore.getState().setLtLineIndex(item.data.slide_index);
      useAppStore.getState().setLtMode("lyrics");
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
  }, [stageItem, setRecentItems, getNextItem, liveItem, setPreviousItem, setLiveItem, settings, ltTemplate, setLtVisible, updateSettings, setBackendError]);

  const clearAll = useCallback(async () => {
    const prevLive = useAppStore.getState().liveItem;
    const prevStaged = useAppStore.getState().stagedItem;
    const prevProps = useAppStore.getState().propItems;
    setLiveItem(null);
    setStagedItem(null);
    setPropItems([]);
    setLtVisible(false);
    try {
      await invoke("clear_all");
    } catch (err: any) {
      setLiveItem(prevLive);
      setStagedItem(prevStaged);
      setPropItems(prevProps);
      setBackendError(`Clear All failed: ${err?.message ?? err}`);
    }
  }, [setLiveItem, setStagedItem, setPropItems, setLtVisible, setBackendError]);

  const addToSchedule = useCallback(async (item: DisplayItem) => {
    const entry: ScheduleEntry = { id: stableId(), item };
    setScheduleEntries([...scheduleEntries, entry]);
    setToast("Added to schedule");
  }, [scheduleEntries, setScheduleEntries, setToast]);

  const persistSchedule = useCallback(async () => {
    const s: Schedule = { id: activeServiceId, name: services.find(s => s.id === activeServiceId)?.name || "Service", items: scheduleEntries };
    try {
      await invoke("save_service", { schedule: s });
      setToast("Service saved");
    } catch (err: any) {
      setBackendError(`Save service failed: ${err?.message ?? err}`);
    }
  }, [activeServiceId, services, scheduleEntries, setToast, setBackendError]);

  const handleFileUpload = useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [
          { name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] },
          { name: "Videos", extensions: ["mp4", "webm", "mov", "mkv", "avi"] },
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

  const handleDeleteMedia = useCallback(async (id: string) => {
    try {
      await invoke("delete_media", { id });
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
    getNextItem,
    addToSchedule,
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
