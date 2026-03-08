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
    songs,
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
        case "F4": invoke("toggle_studio_window"); break;
        case "F5": invoke("toggle_design_window"); break;
        case "F6": setActiveTab("scenes"); break;
        case "F7": setActiveTab("scene-builder"); break;
        case "F8": setActiveTab("props"); break;
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
          else if (liveItem?.type === "Verse") {
            if (liveItem.data.split_index !== undefined && liveItem.data.split_index > 0) {
              // Navigate via sendLive with split index - 1 (verseSplitsRef not available here, skip)
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
      }
    };
    window.addEventListener("keydown", handleKD);
    return () => window.removeEventListener("keydown", handleKD);
  }, [label, stagedItem, goLive, liveItem, studioSlides, nextVerse, ltVisible, ltFlatLines, ltLineIndex, ltTemplate, settings, bottomDeckOpen, setSettings, setIsBlackout, setActiveTab, setBottomDeckOpen, sendLive, stageItem, setLtVisible, ltLinesPerDisplay, ltMode, setLtLineIndex, showShortcuts, setShowShortcuts, outputVisible, setOutputVisible, songs, getNextItem]);
}
