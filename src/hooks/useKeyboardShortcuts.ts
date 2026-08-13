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
    label, stagedItem, liveItem, studioSlides, nextVerse,
    ltVisible, setLtVisible, ltLineIndex, setLtLineIndex,
    ltLinesPerDisplay, ltMode, ltTemplate, ltSavedTemplates, ltSongId,
    settings, setSettings, setIsBlackout,
    setActiveTab, setBottomDeckOpen, bottomDeckOpen,
    showShortcuts, setShowShortcuts,
    outputVisible, setOutputVisible,
    songs, hymnLibrary, scheduleEntries, activeScheduleIdx, setActiveScheduleIdx,
    setBackendError,
  } = useAppStore();

  // A song with its own saved template wins over the operator's active one
  // for the lyrics-overlay keyboard path (Ctrl+Space, PageUp/PageDown).
  const resolvedLtTemplate = resolveSongLtTemplate(ltSongId, songs, ltSavedTemplates, ltTemplate);

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
          invoke("clear_live").catch((err: any) => setBackendError(`Clear failed: ${err?.message ?? err}`));
          break;
        case "Enter": if (stagedItem) goLive(); break;
        case "o": if (e.ctrlKey) { e.preventDefault(); invoke("toggle_output_window").then(() => setOutputVisible((v: boolean) => !v)).catch((err: any) => setBackendError(`Output window: ${err?.message ?? err}`)); } break;
        case "b": if (e.ctrlKey) { e.preventDefault(); const nb = !settings.is_blanked; setSettings({ ...settings, is_blanked: nb }); setIsBlackout(nb); invoke("save_settings", { settings: { ...settings, is_blanked: nb } }); } break;
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
            if (ltVisible) { invoke("hide_lower_third"); setLtVisible(false); }
            else {
              let p = ltBuildLyricsPayload(ltFlatLines, ltLineIndex, ltLinesPerDisplay);
              if (p) { invoke("show_lower_third", { data: p, template: resolvedLtTemplate }); setLtVisible(true); }
            }
          }
          break;
        case "PageDown":
          if (ltMode === "lyrics") {
            const next = Math.min(ltLineIndex + ltLinesPerDisplay, ltFlatLines.length - 1);
            setLtLineIndex(next);
            if (ltVisible) {
              const p = ltBuildLyricsPayload(ltFlatLines, next, ltLinesPerDisplay);
              if (p) invoke("show_lower_third", { data: p, template: resolvedLtTemplate });
            }
          }
          break;
        case "PageUp":
          if (ltMode === "lyrics") {
            const nextIdx = Math.max(0, ltLineIndex - ltLinesPerDisplay);
            setLtLineIndex(nextIdx);
            if (ltVisible) {
              const p = ltBuildLyricsPayload(ltFlatLines, nextIdx, ltLinesPerDisplay);
              if (p) invoke("show_lower_third", { data: p, template: resolvedLtTemplate });
            }
          }
          break;
        case "k": emit("media-control", { action: "video-play-pause" }); break;
        case "r": emit("media-control", { action: "video-restart" }); break;
        case "m": emit("media-control", { action: "video-mute-toggle" }); break;
        case "g": if (e.ctrlKey) { e.preventDefault(); if (stagedItem) goLive(); } break;
        case "l": if (e.ctrlKey) { e.preventDefault(); invoke("clear_live").catch((err: any) => setBackendError(`Clear failed: ${err?.message ?? err}`)); } break;
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

