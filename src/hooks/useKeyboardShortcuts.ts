import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import { buildCustomSlideItem, ltBuildLyricsPayload } from "../utils";
import type { DisplayItem } from "../types";

interface Props {
  stageItem: (item: DisplayItem) => Promise<void>;
  goLive: () => Promise<void>;
  sendLive: (item: DisplayItem) => Promise<void>;
  getNextItem: (item: DisplayItem) => DisplayItem | null;
  ltFlatLines: { text: string; sectionLabel: string }[];
}

export function useKeyboardShortcuts(props: Props): void {
  const { stageItem, goLive, sendLive, getNextItem, ltFlatLines } = props;

  const {
    label, stagedItem, liveItem, studioSlides, nextVerse,
    ltVisible, setLtVisible, ltLineIndex, setLtLineIndex,
    ltLinesPerDisplay, ltMode, ltTemplate,
    settings, setSettings, setIsBlackout,
    setActiveTab, setBottomDeckOpen, bottomDeckOpen,
    showShortcuts, setShowShortcuts,
    outputVisible, setOutputVisible,
    songs, scheduleEntries, activeScheduleIdx, setActiveScheduleIdx,
  } = useAppStore();

  useEffect(() => {
    const handleKD = (e: KeyboardEvent) => {
      if (label && label !== "main") return;
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") {
        if (e.key === "Escape") invoke("clear_live");
        return;
      }
      switch (e.key) {
        case "?": setShowShortcuts((v: boolean) => !v); break;
        case "Escape":
          if (showShortcuts) { setShowShortcuts(false); return; }
          invoke("clear_live");
          break;
        case "Enter": if (stagedItem) goLive(); break;
        case "o": if (e.ctrlKey) { invoke("toggle_output_window"); setOutputVisible((v: boolean) => !v); } break;
        case "b": if (e.ctrlKey) { e.preventDefault(); const nb = !settings.is_blanked; setSettings({ ...settings, is_blanked: nb }); setIsBlackout(nb); invoke("save_settings", { settings: { ...settings, is_blanked: nb } }); } break;
        case "t": if (e.ctrlKey) { e.preventDefault(); setBottomDeckOpen(!bottomDeckOpen); } break;
        case "F1": setActiveTab("bible"); break;
        case "F2": setActiveTab("songs"); break;
        case "F3": setActiveTab("media"); break;
        case "F4": invoke("toggle_design_window"); break;
        case "F5": setActiveTab("media"); useAppStore.getState().setMediaFilter("camera"); break;
        case "F6": setActiveTab("scenes"); break;
        case "F7": setActiveTab("scene-builder"); break;
        case "F8": setActiveTab("props"); break;
        case "F9": invoke("toggle_design_window"); break;
        case "n": if (nextVerse) { const it: DisplayItem = { type: "Verse", data: nextVerse }; if (e.ctrlKey) sendLive(it); else stageItem(it); } break;
        case "ArrowRight":
          if (liveItem?.type === "CustomSlide") {
            const slides = studioSlides[liveItem.data.presentation_id];
            if (slides && liveItem.data.slide_index < slides.length - 1) {
              const ni = liveItem.data.slide_index + 1;
              sendLive(buildCustomSlideItem({ id: liveItem.data.presentation_id, name: liveItem.data.presentation_name, slide_count: slides.length }, slides, ni));
            }
          }
          else if (liveItem?.type === "Song") {
            const next = getNextItem(liveItem);
            if (next) sendLive(next);
          }
          else if (liveItem?.type === "Verse") {
            const next = getNextItem(liveItem);
            if (next) sendLive(next);
          }
          break;
        case "ArrowLeft":
          if (liveItem?.type === "CustomSlide") {
            const slides = studioSlides[liveItem.data.presentation_id];
            if (slides && liveItem.data.slide_index > 0) {
              const ni = liveItem.data.slide_index - 1;
              sendLive(buildCustomSlideItem({ id: liveItem.data.presentation_id, name: liveItem.data.presentation_name, slide_count: slides.length }, slides, ni));
            }
          }
          else if (liveItem?.type === "Song") {
            if (liveItem.data.slide_index > 0) {
              const song = songs.find(s => s.id === liveItem.data.song_id);
              if (song) {
                const flat: { label: string; lines: string[] }[] = [];
                if (song.arrangement && song.arrangement.length > 0) {
                  for (const lbl of song.arrangement) {
                    const sec = song.sections.find((s) => s.label === lbl);
                    if (sec) flat.push(sec);
                  }
                } else {
                  flat.push(...song.sections);
                }
                const prevIdx = liveItem.data.slide_index - 1;
                const prev = flat[prevIdx];
                if (prev) {
                  sendLive({
                    type: "Song",
                    data: {
                      ...liveItem.data,
                      section_label: prev.label,
                      lines: prev.lines,
                      slide_index: prevIdx
                    }
                  });
                }
              }
            }
          }
          break;
        case " ":
          if (e.ctrlKey) {
            e.preventDefault();
            if (ltVisible) { invoke("hide_lower_third"); setLtVisible(false); }
            else {
              let p = ltBuildLyricsPayload(ltFlatLines, ltLineIndex, ltLinesPerDisplay);
              if (p) { invoke("show_lower_third", { data: p, template: ltTemplate }); setLtVisible(true); }
            }
          }
          break;
        case "PageDown":
          if (ltMode === "lyrics") {
            const next = Math.min(ltLineIndex + ltLinesPerDisplay, ltFlatLines.length - 1);
            setLtLineIndex(next);
            if (ltVisible) {
              const p = ltBuildLyricsPayload(ltFlatLines, next, ltLinesPerDisplay);
              if (p) invoke("show_lower_third", { data: p, template: ltTemplate });
            }
          }
          break;
        case "PageUp":
          if (ltMode === "lyrics") {
            const nextIdx = Math.max(0, ltLineIndex - ltLinesPerDisplay);
            setLtLineIndex(nextIdx);
            if (ltVisible) {
              const p = ltBuildLyricsPayload(ltFlatLines, nextIdx, ltLinesPerDisplay);
              if (p) invoke("show_lower_third", { data: p, template: ltTemplate });
            }
          }
          break;
        case "k": emit("media-control", { action: "video-play-pause" }); break;
        case "r": emit("media-control", { action: "video-restart" }); break;
        case "m": emit("media-control", { action: "video-mute-toggle" }); break;
        case "g": if (e.ctrlKey) { e.preventDefault(); if (stagedItem) goLive(); } break;
        case "l": if (e.ctrlKey) { e.preventDefault(); invoke("clear_live"); } break;
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
          e.preventDefault();
          if (liveItem?.type === "CustomSlide") {
            const slides = studioSlides[liveItem.data.presentation_id];
            if (slides && slides.length > 0) {
              sendLive(buildCustomSlideItem({ id: liveItem.data.presentation_id, name: liveItem.data.presentation_name, slide_count: slides.length }, slides, 0));
            }
          } else if (liveItem?.type === "Song") {
            const song = songs.find(s => s.id === liveItem.data.song_id);
            if (song) {
              const flat = song.arrangement && song.arrangement.length > 0
                ? song.arrangement.map(lbl => song.sections.find(s => s.label === lbl)).filter(Boolean) as { label: string; lines: string[] }[]
                : song.sections;
              if (flat.length > 0) sendLive({ type: "Song", data: { ...liveItem.data, section_label: flat[0].label, lines: flat[0].lines, slide_index: 0 } });
            }
          }
          break;
        }
        case "End": {
          e.preventDefault();
          if (liveItem?.type === "CustomSlide") {
            const slides = studioSlides[liveItem.data.presentation_id];
            if (slides && slides.length > 0) {
              const last = slides.length - 1;
              sendLive(buildCustomSlideItem({ id: liveItem.data.presentation_id, name: liveItem.data.presentation_name, slide_count: slides.length }, slides, last));
            }
          } else if (liveItem?.type === "Song") {
            const song = songs.find(s => s.id === liveItem.data.song_id);
            if (song) {
              const flat = song.arrangement && song.arrangement.length > 0
                ? song.arrangement.map(lbl => song.sections.find(s => s.label === lbl)).filter(Boolean) as { label: string; lines: string[] }[]
                : song.sections;
              if (flat.length > 0) {
                const last = flat.length - 1;
                sendLive({ type: "Song", data: { ...liveItem.data, section_label: flat[last].label, lines: flat[last].lines, slide_index: last } });
              }
            }
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", handleKD);
    return () => window.removeEventListener("keydown", handleKD);
  }, [label, stagedItem, goLive, liveItem, studioSlides, nextVerse, ltVisible, ltFlatLines, ltLineIndex, ltTemplate, settings, bottomDeckOpen, setSettings, setIsBlackout, setActiveTab, setBottomDeckOpen, sendLive, stageItem, setLtVisible, ltLinesPerDisplay, ltMode, setLtLineIndex, showShortcuts, setShowShortcuts, outputVisible, setOutputVisible, songs, getNextItem, scheduleEntries, activeScheduleIdx, setActiveScheduleIdx]);
}
