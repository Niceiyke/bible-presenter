import { useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import {
  displayItemLabel,
  buildCustomSlideItem,
  ltBuildLyricsPayload,
  getItemUid,
  stableId,
} from "../utils";
import type { DisplayItem, PresentationSettings, PropItem, MediaItem, ScheduleEntry, Schedule } from "../types";

const getVerseKey = (v: any) => `${v.book}-${v.chapter}-${v.verse}-${v.version}`;

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
  } = useAppStore();

  const verseSplitsRef = useRef<Record<string, any[]>>({});

  const updateSettings = useCallback(async (next: PresentationSettings) => {
    setSettings(next);
    await invoke("save_settings", { settings: next });
  }, [setSettings]);

  const updateProps = useCallback(async (items: PropItem[]) => {
    setPropItems(items);
    await invoke("set_props", { props: items });
  }, [setPropItems]);

  const nextLiveItem = useMemo((): DisplayItem | null => {
    if (!liveItem) return null;
    if (liveItem.type === "Verse") {
      const data = liveItem.data;
      if (data.split_index !== undefined && data.total_splits !== undefined && data.split_index + 1 < data.total_splits) {
        const key = getVerseKey(data);
        const splits = verseSplitsRef.current[key];
        if (splits && splits[data.split_index + 1]) {
          return { type: "Verse", data: splits[data.split_index + 1] };
        }
      }
      if (nextVerse) return { type: "Verse", data: nextVerse };
    }
    if (liveItem.type === "CustomSlide") {
      const slides = studioSlides[liveItem.data.presentation_id];
      const next = liveItem.data.slide_index + 1;
      if (slides && next < slides.length)
        return buildCustomSlideItem({ id: liveItem.data.presentation_id, name: liveItem.data.presentation_name, slide_count: slides.length }, slides, next);
    }
    if (liveItem.type === "Song") {
      const nextIdx = liveItem.data.slide_index + 1;
      if (nextIdx < liveItem.data.total_slides) {
        const song = songs.find(s => s.id === liveItem.data.song_id);
        if (song) {
          const flat: { label: string; lines: string[] }[] = [];
          if (song.arrangement && song.arrangement.length > 0) {
            for (const label of song.arrangement) {
              const sec = song.sections.find((s) => s.label === label);
              if (sec) flat.push(sec);
            }
          } else {
            flat.push(...song.sections);
          }
          const next = flat[nextIdx];
          if (next) {
            return {
              type: "Song",
              data: {
                ...liveItem.data,
                section_label: next.label,
                lines: next.lines,
                slide_index: nextIdx
              }
            };
          }
        }
      }
    }
    return null;
  }, [liveItem, nextVerse, studioSlides, songs]);

  const stageItem = useCallback(async (item: DisplayItem) => {
    let finalItem = item;

    if (item.type === "Verse" && item.data.split_index === undefined && settings.auto_split_verses) {
      const key = getVerseKey(item.data);
      let splits = verseSplitsRef.current[key];
      if (!splits) {
        splits = await invoke("split_verse", {
          verse: item.data,
          threshold: settings.verse_split_threshold
        });
        verseSplitsRef.current[key] = splits;
      }
      if (splits.length > 1) {
        finalItem = { type: "Verse", data: splits[0] };
      }
    }

    setStagedItem(finalItem);
    await invoke("stage_item", { item: finalItem });
  }, [setStagedItem, settings]);

  const getNextItem = useCallback((item: DisplayItem): DisplayItem | null => {
    if (item.type === "Verse") {
      const splitIdx = item.data.split_index;
      const totalSplits = item.data.total_splits;

      if (splitIdx !== undefined && totalSplits !== undefined && splitIdx + 1 < totalSplits) {
        const key = getVerseKey(item.data);
        const splits = verseSplitsRef.current[key];
        if (splits && splits[splitIdx + 1]) {
          return { type: "Verse", data: splits[splitIdx + 1] };
        }
      }
      if (nextVerse) return { type: "Verse", data: nextVerse };
    }
    if (item.type === "CustomSlide") {
      const slides = studioSlides[item.data.presentation_id];
      const idx = item.data.slide_index + 1;
      if (slides && idx < slides.length)
        return buildCustomSlideItem({ id: item.data.presentation_id, name: item.data.presentation_name, slide_count: slides.length }, slides, idx);
    }
    if (item.type === "Song") {
      const idx = item.data.slide_index + 1;
      if (idx < item.data.total_slides) {
        const song = songs.find(s => s.id === item.data.song_id);
        if (song) {
          const flat: { label: string; lines: string[] }[] = [];
          if (song.arrangement && song.arrangement.length > 0) {
            for (const label of song.arrangement) {
              const sec = song.sections.find((s) => s.label === label);
              if (sec) flat.push(sec);
            }
          } else {
            flat.push(...song.sections);
          }
          const next = flat[idx];
          if (next) {
            return {
              type: "Song",
              data: {
                ...item.data,
                section_label: next.label,
                lines: next.lines,
                slide_index: idx
              }
            };
          }
        }
      }
    }
    return null;
  }, [nextVerse, studioSlides, songs]);

  const goLive = useCallback(async () => {
    const current = liveItem;
    const staged = stagedItem;
    await invoke("go_live");
    if (current) setPreviousItem(current);

    if (staged?.type === "Song" && staged.data.style === "LowerThird") {
      const payload = {
        kind: "Lyrics",
        data: {
          line1: staged.data.lines[0],
          line2: staged.data.lines[1],
          section_label: staged.data.section_label
        }
      };
      invoke("show_lower_third", { data: payload, template: ltTemplate });
      setLtVisible(true);
      useAppStore.getState().setLtSongId(staged.data.song_id);
      useAppStore.getState().setLtLineIndex(staged.data.slide_index);
      useAppStore.getState().setLtMode("lyrics");
    }

    if (settings.show_background_logo) {
      updateSettings({ ...settings, show_background_logo: false });
    }

    if (nextLiveItem) {
      stageItem(nextLiveItem);
    }
  }, [nextLiveItem, stageItem, liveItem, stagedItem, settings, setPreviousItem, ltTemplate, setLtVisible, updateSettings]);

  const sendLive = useCallback(async (item: DisplayItem) => {
    const current = liveItem;
    await stageItem(item);
    await invoke("go_live");
    if (current) setPreviousItem(current);

    if (item.type === "Song" && item.data.style === "LowerThird") {
      const payload = {
        kind: "Lyrics",
        data: {
          line1: item.data.lines[0],
          line2: item.data.lines[1],
          section_label: item.data.section_label
        }
      };
      invoke("show_lower_third", { data: payload, template: ltTemplate });
      setLtVisible(true);
      useAppStore.getState().setLtSongId(item.data.song_id);
      useAppStore.getState().setLtLineIndex(item.data.slide_index);
      useAppStore.getState().setLtMode("lyrics");
    }

    if (settings.show_background_logo) {
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
  }, [stageItem, recentItems, setRecentItems, getNextItem, liveItem, setPreviousItem, settings, ltTemplate, setLtVisible, updateSettings]);

  const addToSchedule = useCallback(async (item: DisplayItem) => {
    const entry: ScheduleEntry = { id: stableId(), item };
    setScheduleEntries([...scheduleEntries, entry]);
    setToast("Added to schedule");
  }, [scheduleEntries, setScheduleEntries, setToast]);

  const persistSchedule = useCallback(async () => {
    const s: Schedule = { id: activeServiceId, name: services.find(s => s.id === activeServiceId)?.name || "Service", items: scheduleEntries };
    await invoke("save_service", { schedule: s });
  }, [activeServiceId, services, scheduleEntries]);

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
      await invoke("add_media", { path: selected });
      const result: MediaItem[] = await invoke("list_media");
      setMedia(result);
      setToast("Media added to library");
    } catch (err: any) {
      console.error("Upload failed:", err);
    }
  }, [media, setMedia, setToast]);

  const handleDeleteMedia = useCallback(async (id: string) => {
    try {
      await invoke("delete_media", { id });
      setMedia(media.filter((m) => m.id !== id));
    } catch (err: any) {
      console.error("Delete failed:", err);
    }
  }, [media, setMedia]);

  return {
    nextLiveItem,
    stageItem,
    goLive,
    sendLive,
    getNextItem,
    addToSchedule,
    persistSchedule,
    handleFileUpload,
    handleDeleteMedia,
    updateSettings,
    updateProps,
    verseSplitsRef,
  };
}
