import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import { ltBuildLyricsPayload } from "../utils";
import { resolveSongLtTemplate } from "../utils/song";
import { itemNav, type ItemLookup } from "../items/registry";
import { useKeyboardBinding } from "./keyboardRegistry";
import type { DisplayItem } from "../types";

interface Props {
  stageItem: (item: DisplayItem) => Promise<boolean>;
  goLive: () => Promise<boolean>;
  sendLive: (item: DisplayItem) => Promise<boolean>;
  clearAll: () => Promise<unknown>;
  ltFlatLines: { text: string; sectionLabel: string }[];
}

export function useKeyboardShortcuts(props: Props): void {
  const { stageItem, goLive, sendLive, clearAll, ltFlatLines } = props;

  const {
    label, stagedItem, liveItem, setLiveItem, studioSlides, nextVerse,
    ltVisible, setLtVisible, ltLineIndex, setLtLineIndex,
    ltLinesPerDisplay, ltMode, ltTemplate, ltSavedTemplates, ltSongId,
    settings, setSettings, setIsBlackout,
    setActiveTab, setBottomDeckOpen, bottomDeckOpen,
    showShortcuts, setShowShortcuts,
    songs, hymnLibrary, scheduleEntries, activeScheduleIdx, setActiveScheduleIdx,
    setBackendError,
  } = useAppStore();

  // A song with its own saved template wins over the operator's active one
  // for the lyrics-overlay keyboard path (Ctrl+Space, PageUp/PageDown).
  const resolvedLtTemplate = resolveSongLtTemplate(ltSongId, songs, ltSavedTemplates, ltTemplate);

  // Transactional shortcut helpers: every backend-driven shortcut only updates
  // local state when the backend accepts the command, and rolls back on
  // failure — a shortcut must never leave the console believing an action
  // succeeded on air when it did not (audit: shortcut transactionality).
  const shortcutClearLive = async () => {
    try {
      await invoke("clear_live");
      setLiveItem(null);
    } catch (err: any) {
      setBackendError(`Clear failed: ${err?.message ?? err}`);
    }
  };

  const shortcutToggleBlackout = async () => {
    const prev = useAppStore.getState().settings;
    const nb = !prev.is_blanked;
    setSettings({ ...prev, is_blanked: nb });
    setIsBlackout(nb);
    try {
      await invoke("save_settings", { settings: { ...prev, is_blanked: nb } });
    } catch (err: any) {
      setSettings(prev);
      setIsBlackout(prev.is_blanked);
      setBackendError(`Failed to save settings: ${err?.message ?? err}`);
    }
  };

  const shortcutToggleLt = async () => {
    if (ltVisible) {
      try {
        await invoke("hide_lower_third");
        setLtVisible(false);
      } catch (err: any) {
        setBackendError(`Lower-third failed: ${err?.message ?? err}`);
      }
    } else {
      const p = ltBuildLyricsPayload(ltFlatLines, ltLineIndex, ltLinesPerDisplay);
      if (!p) return;
      try {
        await invoke("show_lower_third", { data: p, template: resolvedLtTemplate });
        setLtVisible(true);
      } catch (err: any) {
        setBackendError(`Lower-third failed: ${err?.message ?? err}`);
      }
    }
  };

  const shortcutLtNavigate = async (next: number) => {
    const prev = ltLineIndex;
    setLtLineIndex(next);
    if (ltVisible) {
      const p = ltBuildLyricsPayload(ltFlatLines, next, ltLinesPerDisplay);
      if (!p) return;
      try {
        await invoke("show_lower_third", { data: p, template: resolvedLtTemplate });
      } catch (err: any) {
        // The backend rejected the advance — revert the line index so the
        // console does not drift ahead of what is actually on air.
        setLtLineIndex(prev);
        setBackendError(`Lower-third failed: ${err?.message ?? err}`);
      }
    }
  };

  useKeyboardBinding(
    "operator-default",
    0,
    () => {
      if (label && label !== "main") return false;
      const tgt = document.activeElement;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return false;
      return true;
    },
    (e) => {
      switch (e.key) {
        case "?": setShowShortcuts((v: boolean) => !v); break;
        case "Escape":
          if (showShortcuts) { setShowShortcuts(false); return; }
          shortcutClearLive();
          break;
        case "Enter": if (stagedItem) goLive(); break;
        case "o": if (e.ctrlKey) { e.preventDefault(); invoke("toggle_output_window").catch((err: any) => setBackendError(`Output window: ${err?.message ?? err}`)); } break;
        case "b": if (e.ctrlKey) { e.preventDefault(); shortcutToggleBlackout(); } break;
        case "t": if (e.ctrlKey) { e.preventDefault(); setBottomDeckOpen(!bottomDeckOpen); } break;
        case "F1": setActiveTab("bible"); break;
        case "F2": setActiveTab("songs"); break;
        case "F3": setActiveTab("media"); break;
        case "F4": setActiveTab("studio"); break;
        case "F5": setActiveTab("lt-designer"); break;
        case "F6": setActiveTab("schedule"); break;
        case "F7": setActiveTab("props"); break;
        case "F8": setActiveTab("media"); useAppStore.getState().setMediaFilter("camera"); break;
        case "F9": setActiveTab("settings"); break;
        case "n": if (nextVerse) { const it: DisplayItem = { type: "Verse", data: nextVerse }; if (e.ctrlKey) sendLive(it); else stageItem(it); } break;
        case "ArrowRight": {
          const lookup: ItemLookup = { studioSlides, songs, hymns: hymnLibrary, nextVerse, verseSplits: {}, verseSplitThreshold: settings.verse_split_threshold };
          const nav = liveItem ? itemNav(liveItem, lookup) : null;
          if (nav?.next) sendLive(nav.next);
          break;
        }
        case "ArrowLeft": {
          const lookup: ItemLookup = { studioSlides, songs, hymns: hymnLibrary, nextVerse, verseSplits: {}, verseSplitThreshold: settings.verse_split_threshold };
          const nav = liveItem ? itemNav(liveItem, lookup) : null;
          if (nav?.prev) sendLive(nav.prev);
          break;
        }
        case " ":
          if (e.ctrlKey) {
            e.preventDefault();
            shortcutToggleLt();
          }
          break;
        case "PageDown":
          if (ltMode === "lyrics") {
            const next = Math.min(ltLineIndex + ltLinesPerDisplay, ltFlatLines.length - 1);
            shortcutLtNavigate(next);
          }
          break;
        case "PageUp":
          if (ltMode === "lyrics") {
            const nextIdx = Math.max(0, ltLineIndex - ltLinesPerDisplay);
            shortcutLtNavigate(nextIdx);
          }
          break;
        case "k": emit("media-control", { action: "video-play-pause" }); break;
        case "r": emit("media-control", { action: "video-restart" }); break;
        case "m": emit("media-control", { action: "video-mute-toggle" }); break;
        case "g": if (e.ctrlKey) { e.preventDefault(); if (stagedItem) goLive(); } break;
        case "l": if (e.ctrlKey) { e.preventDefault(); shortcutClearLive(); } break;
        case "x": if (e.ctrlKey && e.shiftKey) { e.preventDefault(); clearAll(); } break;
        case "s": if (e.ctrlKey) { e.preventDefault(); setActiveTab("settings"); } break;
        case "ArrowDown": {
          e.preventDefault();
          const nextIdx = activeScheduleIdx !== null ? activeScheduleIdx + 1 : 0;
          if (nextIdx < scheduleEntries.length) {
            setActiveScheduleIdx(nextIdx);
            sendLive(scheduleEntries[nextIdx].item);
          }
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prevIdx = activeScheduleIdx !== null ? activeScheduleIdx - 1 : scheduleEntries.length - 1;
          if (prevIdx >= 0 && scheduleEntries.length > 0) {
            setActiveScheduleIdx(prevIdx);
            sendLive(scheduleEntries[prevIdx].item);
          }
          break;
        }
        case "Home": {
          const lookup: ItemLookup = { studioSlides, songs, hymns: hymnLibrary, nextVerse, verseSplits: {}, verseSplitThreshold: settings.verse_split_threshold };
          const nav = liveItem ? itemNav(liveItem, lookup) : null;
          if (nav?.first) { e.preventDefault(); sendLive(nav.first); }
          break;
        }
        case "End": {
          const lookup: ItemLookup = { studioSlides, songs, hymns: hymnLibrary, nextVerse, verseSplits: {}, verseSplitThreshold: settings.verse_split_threshold };
          const nav = liveItem ? itemNav(liveItem, lookup) : null;
          if (nav?.last) { e.preventDefault(); sendLive(nav.last); }
          break;
        }
      }
    },
  );
}

