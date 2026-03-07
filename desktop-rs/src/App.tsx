import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { 
  BookOpen, CalendarDays, ChevronRight, Clock, EyeOff, Image as ImageIcon, 
  Layers, Layout, Mic, Monitor, Settings, X, Zap, AlertCircle, Keyboard, Repeat
} from "lucide-react";

import { useAppStore } from "./store";
import { 
  displayItemLabel, 
  buildCustomSlideItem,
  ltBuildLyricsPayload,
  getItemUid
} from "./utils";
import { BibleTab } from "./components/BibleTab";
import { MediaTab } from "./components/MediaTab";
import { SongsTab } from "./components/SongsTab";
import { LowerThirdTab } from "./components/LowerThirdTab";
import { TimersTab } from "./components/TimersTab";
import { ScheduleTab } from "./components/ScheduleTab";
import { StudioTab } from "./components/StudioTab";
import { SceneComposerTab } from "./components/SceneComposerTab";
import { ScenesTab } from "./components/ScenesTab";
import { SettingsTab } from "./components/SettingsTab";
import { PropsTab } from "./components/PropsTab";
import { PreviewCard } from "./components/PreviewCard";
import { Toast } from "./components/Toast";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { SlideEditor } from "./components/editors/SlideEditor";
import { LogViewer } from "./components/LogViewer";
import { RemoteProposals } from "./components/RemoteProposals";
import { MusicPlayer } from "./components/MusicPlayer";
import { OutputWindow, StageWindow, DesignHub } from "./windows";
import { stableId, newDefaultSlide } from "./utils";
import { useLanCamera } from "./hooks/useLanCamera";
import { useAppInitialization } from "./hooks/useAppInitialization";
import { useBibleCascade } from "./hooks/useBibleCascade";
import type {
  DisplayItem,
  PresentationSettings,
  Schedule, ScheduleEntry, PropItem, MediaItem, CustomPresentation
} from "./types";

const getVerseKey = (v: any) => `${v.book}-${v.chapter}-${v.verse}-${v.version}`;

function TranscriptLog({ segments }: { segments: { text: string; timestamp_ms: number; source: string }[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [segments.length]);
  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="flex items-center justify-between mb-2 shrink-0">
        <span className="text-[9px] font-black uppercase tracking-widest text-slate-600">Transcript Log</span>
        <span className="text-[9px] text-slate-700">{segments.length} segments</span>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar space-y-1 text-sm font-light">
        {segments.length === 0 && (
          <span className="text-slate-700 italic text-xs">No transcription yet — start a session to begin.</span>
        )}
        {segments.map((seg, i) => {
          const isPreacher = seg.source === "preacher";
          return (
            <div key={i} className="flex gap-2 items-start">
              <span className={`shrink-0 text-[9px] font-black uppercase tracking-wider mt-0.5 ${isPreacher ? "text-amber-500" : "text-blue-400"}`}>
                {isPreacher ? "PST" : "OPR"}
              </span>
              <span className="text-slate-300 leading-snug">{seg.text}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

export default function App() {
  const {
    label, liveItem, setLiveItem, stagedItem, setStagedItem, suggestedItem, setSuggestedItem,
    previousItem, setPreviousItem, setManualOverrideUntil,
    suggestedConfidence, nextVerse, setNextVerse, recentItems, setRecentItems,
    sidebarWidth, setSidebarWidth, isTranscriptionCollapsed, setIsTranscriptionCollapsed,
    bottomDeckOpen, setBottomDeckOpen, bottomDeckMode, setBottomDeckMode,
    settings, setSettings, activeTab, setActiveTab, toast, setToast,
    ltVisible, setLtVisible, ltMode, ltLineIndex, setLtLineIndex, ltLinesPerDisplay, ltTemplate,
    ltSongId, scheduleEntries, setScheduleEntries, services,
    activeServiceId, setActiveServiceId, media, setMedia, pauseWhisper, transcript, sessionTranscript, sessionState, setSessionState,
    operatorMicLevel, preacherMicLevel, operatorMuted, setOperatorMuted, preacherMuted, setPreacherMuted,
    operatorRecordingActive, setOperatorRecordingActive,
    preacherRecordingActive, setPreacherRecordingActive,
    remoteUrl, remotePin, bibleVersion, topPanelPct, setTopPanelPct, stagePct, setStagePct, 
    studioList, setStudioList, studioSlides, setStudioSlides,
    setIsBlackout, songs, setPropItems, audioError, setAudioError, deviceError,
    startupIssues, setStartupIssues, isLogOpen, setIsLogOpen
  } = useAppStore();

  const [isPttActive, setIsPttActive] = useState(false);

  // Handle Spacebar for Push-to-Talk
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isPttActive && (e.target as HTMLElement).tagName !== "INPUT" && (e.target as HTMLElement).tagName !== "TEXTAREA") {
        e.preventDefault();
        setIsPttActive(true);
        invoke("set_operator_ptt", { active: true }).catch(console.error);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && isPttActive) {
        setIsPttActive(false);
        invoke("set_operator_ptt", { active: false }).catch(console.error);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [isPttActive]);

  const handlePttDown = () => {
    setIsPttActive(true);
    invoke("set_operator_ptt", { active: true }).catch(console.error);
  };
  const handlePttUp = () => {
    setIsPttActive(false);
    invoke("set_operator_ptt", { active: false }).catch(console.error);
  };

  const handleToggleOperatorMute = () => {
    const next = !operatorMuted;
    setOperatorMuted(next);
    invoke("set_operator_muted", { muted: next }).catch(console.error);
  };
  const handleTogglePreacherMute = () => {
    const next = !preacherMuted;
    setPreacherMuted(next);
    invoke("set_preacher_muted", { muted: next }).catch(console.error);
  };

  // Session elapsed timer
  const [sessionSecs, setSessionSecs] = React.useState(0);
  useEffect(() => {
    if (sessionState !== "running") { setSessionSecs(0); return; }
    const t = setInterval(() => setSessionSecs(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [sessionState]);
  const fmtTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  const [outputVisible, setOutputVisible] = React.useState(false);
  const [showShortcuts, setShowShortcuts] = React.useState(false);
  const [editingPres, setEditingPres] = useState<CustomPresentation | null>(null);
  const [bottomDeckH, setBottomDeckH] = React.useState(() => Number(localStorage.getItem("pref_bottomDeckH") || 280));
  const [scheduleWidth, setScheduleWidth] = React.useState(() => Number(localStorage.getItem("pref_scheduleWidth") || 240));

  // Memory of split verses so we don't have to re-split as often
  const verseSplitsRef = useRef<Record<string, any[]>>({});

  // Initialization & Listeners
  useAppInitialization();

  // Recovery Save effect
  useEffect(() => {
    if (activeServiceId && scheduleEntries.length > 0) {
      const timer = setTimeout(() => {
        invoke("save_recovery", { 
          data: { 
            activeServiceId, 
            scheduleEntries, 
            lastUpdate: Date.now() 
          } 
        }).catch(console.error);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [scheduleEntries, activeServiceId]);

  // Recovery Check on Mount
  useEffect(() => {
    const checkRecovery = async () => {
      const data = await invoke<any>("load_recovery").catch(() => null);
      if (data && data.scheduleEntries?.length > 0) {
        const timeStr = new Date(data.lastUpdate).toLocaleTimeString();
        if (window.confirm(`An unsaved session from ${timeStr} was found. Would you like to restore it?`)) {
          setScheduleEntries(data.scheduleEntries);
          setActiveServiceId(data.activeServiceId);
          setToast("Session restored successfully");
        }
        await invoke("clear_recovery").catch(() => {});
      }
    };
    // Wait a bit for initialization to settle
    setTimeout(checkRecovery, 1500);
  }, []);

  // Bible selection logic (cascade loading)
  useBibleCascade();

  // LAN Camera WebRTC Hook
  const {
    cameraSources, enableCameraPreview, disableCameraPreview, 
    removeCameraSource, previewVideoMapRef, previewObserverMapRef, setLiveCamera
  } = useLanCamera(remotePin, label);

  React.useEffect(() => {
    let activeDeviceIdA: string | null = null;
    let activeDeviceIdB: string | null = null;

    if (liveItem?.type === "CameraFeed" && liveItem.data.lan) {
      activeDeviceIdA = liveItem.data.device_id;
    } else if (liveItem?.type === "Scene") {
      const lanSources = liveItem.data.layers
        .map(l => l.content)
        .filter((c): c is any => c.kind === "source" && c.source.type === "camera-lan")
        .map(c => c.source);
      if (lanSources[0]) activeDeviceIdA = lanSources[0].device_id;
      if (lanSources[1]) activeDeviceIdB = lanSources[1].device_id;
    }
    
    setLiveCamera(activeDeviceIdA, 'A');
    setLiveCamera(activeDeviceIdB, 'B');
  }, [liveItem, setLiveCamera]);

  // ── Compute ltFlatLines for shortcuts ──────────────────────────────────────

  const ltFlatLines = useMemo((): { text: string; sectionLabel: string }[] => {
    const song = songs.find(s => s.id === ltSongId);
    if (!song) return [];
    const flat: { text: string; sectionLabel: string }[] = [];
    const arr = song.arrangement;
    const sections = song.sections;
    if (arr && arr.length > 0) {
      for (const lbl of arr) {
        const sec = sections.find((s) => s.label === lbl);
        if (sec) for (const line of sec.lines) flat.push({ text: line, sectionLabel: sec.label });
      }
    } else {
      for (const section of sections) for (const line of section.lines) flat.push({ text: line, sectionLabel: section.label });
    }
    return flat;
  }, [songs, ltSongId]);

  // ── Next item after what's currently live ──────────────────────────────────
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

  // ── Operators Handlers ─────────────────────────────────────────────────────

  const stageItem = useCallback(async (item: DisplayItem) => {
    let finalItem = item;
    
    // Auto-split long verses
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
  }, [setStagedItem]);

  const goLive = useCallback(async () => {
    const current = liveItem;
    const staged = stagedItem;
    await invoke("go_live");
    if (current) setPreviousItem(current);
    // Operator explicitly chose this item — suppress auto-detection for 30 s
    setManualOverrideUntil(Date.now() + 30_000);

    // Auto-trigger lower third if staged song is set to LowerThird style
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
      // Update store for shortcut sync
      useAppStore.getState().setLtSongId(staged.data.song_id);
      useAppStore.getState().setLtLineIndex(staged.data.slide_index);
      useAppStore.getState().setLtMode("lyrics");
    }

    // If bg logo is on, clear it
    if (settings.show_background_logo) {
      updateSettings({ ...settings, show_background_logo: false });
    }

    // After going live, if there's a next item, stage it automatically
    if (nextLiveItem) {
      stageItem(nextLiveItem);
    }
  }, [nextLiveItem, stageItem, liveItem, stagedItem, settings, setPreviousItem, ltTemplate, setLtVisible]);

  const getNextItem = useCallback((item: DisplayItem): DisplayItem | null => {
    if (item.type === "Verse") {
      const splitIdx = item.data.split_index;
      const totalSplits = item.data.total_splits;

      if (splitIdx !== undefined && totalSplits !== undefined && splitIdx + 1 < totalSplits) {
        // Find split parts in cache
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

  const sendLive = useCallback(async (item: DisplayItem) => {
    // We want to send THIS item live, then stage its successor
    const current = liveItem;
    await stageItem(item);
    await invoke("go_live");
    if (current) setPreviousItem(current);
    // Operator explicitly chose this item — suppress auto-detection for 30 s
    setManualOverrideUntil(Date.now() + 30_000);

    // Auto-trigger lower third if song is set to LowerThird style
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
      // Update store for shortcut sync
      useAppStore.getState().setLtSongId(item.data.song_id);
      useAppStore.getState().setLtLineIndex(item.data.slide_index);
      useAppStore.getState().setLtMode("lyrics");
    } else if (ltVisible && item.type !== "Song") {
      // If we move away from songs, maybe hide LT? 
      // Actually, usually users want manual control over hiding LTs.
    }

    // If bg logo is on, clear it
    if (settings.show_background_logo) {
      updateSettings({ ...settings, show_background_logo: false });
    }
    
    const lbl = displayItemLabel(item);
    
    // Categorical History
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
    
    // Calculate next item
    const next = getNextItem(item);
    if (next) {
      stageItem(next);
    }
  }, [stageItem, recentItems, setRecentItems, getNextItem, liveItem, setPreviousItem, settings]);

  const addToSchedule = useCallback(async (item: DisplayItem) => {
    const entry: ScheduleEntry = { id: stableId(), item };
    setScheduleEntries([...scheduleEntries, entry]);
    setToast("Added to schedule");
  }, [scheduleEntries, setScheduleEntries, setToast]);

  const persistSchedule = useCallback(async () => {
    const s: Schedule = { id: activeServiceId, name: services.find(s => s.id === activeServiceId)?.name || "Service", items: scheduleEntries };
    await invoke("save_service", { schedule: s });
  }, [activeServiceId, services, scheduleEntries]);

  // ── Media Handlers ──────────────────────────────────────────────────────────

  const handleFileUpload = async () => {
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
  };

  const handleDeleteMedia = async (id: string) => {
    try {
      await invoke("delete_media", { id });
      setMedia(media.filter((m) => m.id !== id));
    } catch (err: any) {
      console.error("Delete failed:", err);
    }
  };

  // ── Sync effects ───────────────────────────────────────────────────────────

  useEffect(() => {
    invoke("set_transcription_paused", { paused: pauseWhisper && cameraSources.size > 0 }).catch(() => {});
  }, [pauseWhisper, cameraSources.size]);

  useEffect(() => {
    if (liveItem?.type === "Verse") {
      const v = liveItem.data;
      invoke("get_next_verse", { book: v.book, chapter: v.chapter, verse: v.verse, version: v.version || bibleVersion })
        .then((res: any) => setNextVerse(res || null)).catch(() => setNextVerse(null));
    } else setNextVerse(null);
  }, [liveItem, bibleVersion, setNextVerse]);

  // Auto-dismiss suggested item (AI peel) after 5 seconds
  useEffect(() => {
    if (suggestedItem) {
      const t = setTimeout(() => {
        setSuggestedItem(null);
      }, 5000);
      return () => clearTimeout(t);
    }
  }, [suggestedItem, setSuggestedItem]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const handleKD = (e: KeyboardEvent) => {
      if (label && label !== "main") return;
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") {
        if (e.key === "Escape") invoke("clear_live");
        return;
      }
      switch (e.key) {
        case "?": setShowShortcuts(v => !v); break;
        case "Escape": 
          if (showShortcuts) { setShowShortcuts(false); return; }
          invoke("clear_live"); 
          break;
        case "Enter": if (stagedItem) goLive(); break;
        case "o": if (e.ctrlKey) { invoke("toggle_output_window"); setOutputVisible(v => !v); } break;
        case "b": if (e.ctrlKey) { e.preventDefault(); const nb = !settings.is_blanked; setSettings({ ...settings, is_blanked: nb }); setIsBlackout(nb); invoke("save_settings", { settings: { ...settings, is_blanked: nb } }); } break;
        case "t": if (e.ctrlKey) { e.preventDefault(); setBottomDeckOpen(!bottomDeckOpen); } break;
        case "F1": setActiveTab("bible"); break;
        case "F2": setActiveTab("songs"); break;
        case "F3": setActiveTab("media"); break;
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
                  for (const label of song.arrangement) {
                    const sec = song.sections.find((s) => s.label === label);
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
              const key = getVerseKey(liveItem.data);
              const splits = verseSplitsRef.current[key];
              if (splits && splits[liveItem.data.split_index - 1]) {
                sendLive({ type: "Verse", data: splits[liveItem.data.split_index - 1] });
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
      }
    };
    window.addEventListener("keydown", handleKD); return () => window.removeEventListener("keydown", handleKD);
  }, [label, stagedItem, goLive, liveItem, studioSlides, nextVerse, ltVisible, ltFlatLines, ltLineIndex, ltTemplate, settings, bottomDeckOpen, setSettings, setIsBlackout, setActiveTab, setBottomDeckOpen, setBottomDeckMode, sendLive, stageItem, setLtVisible, ltLinesPerDisplay, ltMode, setLtLineIndex, showShortcuts, setShowShortcuts]);

  // ── Window Routing (after all hooks to satisfy React rules) ───────────────
  if (label === "output") return <OutputWindow />;
  if (label === "stage") return <StageWindow />;
  if (label === "design") return <DesignHub />;

  const updateSettings = async (next: PresentationSettings) => {
    setSettings(next);
    await invoke("save_settings", { settings: next });
  };

  const updateProps = async (items: PropItem[]) => {
    setPropItems(items);
    await invoke("set_props", { props: items });
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="h-screen bg-slate-950 text-slate-200 flex flex-col font-sans overflow-hidden select-none">
      <header className="h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 shrink-0 z-30">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-amber-500 rounded-lg flex items-center justify-center text-black font-black text-xl shadow-lg shadow-amber-500/20">BP</div>
            <span className="font-black text-xs uppercase tracking-widest text-slate-400 hidden xl:inline">Presenter <span className="text-amber-500/60">RS</span></span>
          </div>
          <nav className="flex gap-1 overflow-x-auto">
            {([
              { id: "bible", label: "Bible", icon: BookOpen },
              { id: "media", label: "Media", icon: ImageIcon },
              { id: "songs", label: "Songs", icon: Mic },
              { id: "studio", label: "Studio", icon: Layers },
              { id: "scenes", label: "Scenes", icon: Layout },
              { id: "scene-builder", label: "Scene Builder", icon: Layout },
              { id: "schedule", label: "Service", icon: CalendarDays },
            ] as const).map(({ id, label: lbl, icon: Icon }) => (
              <button key={id} onClick={() => setActiveTab(id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${activeTab === id ? "bg-amber-500 text-black shadow-lg" : "text-slate-500 hover:text-slate-300 hover:bg-slate-800"}`}>
                <Icon size={14} /> {lbl}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {/* Audio Control Panel — always visible */}
          <div className="flex items-center gap-2 bg-slate-950 px-2 py-1.5 rounded-xl border border-slate-800/60 shadow-inner">
            {/* Clear output */}
            <button
              onClick={() => {
                invoke("clear_live").catch(console.error);
                invoke("hide_lower_third").catch(console.error);
                setLiveItem(null);
                setLtVisible(false);
              }}
              className="px-2 py-1 hover:bg-red-900/30 text-slate-500 hover:text-red-400 rounded transition-all flex items-center gap-1"
              title="Clear Output (Shift+C)"
            >
              <X size={13} />
            </button>

            <div className="w-px h-5 bg-slate-800" />

            {/* START / STOP button */}
            <button
              onClick={async () => {
                if (sessionState === "idle") {
                  setSessionState("loading");
                  await invoke("start_session").catch((e: any) => {
                    setAudioError(typeof e === "string" ? e : "Failed to start session");
                    setSessionState("idle");
                  });
                } else if (sessionState === "running") {
                  setSessionState("stopping");
                  await invoke("stop_session").catch(() => { setSessionState("idle"); });
                }
              }}
              disabled={sessionState === "loading" || sessionState === "stopping"}
              title={sessionState === "running" ? "Stop live transcription" : "Start live transcription"}
              className={`px-3 py-1 rounded-lg transition-all flex items-center gap-1.5 font-black text-[10px] uppercase tracking-wider ${
                sessionState === "running"
                  ? "bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/30"
                  : sessionState === "loading"
                  ? "bg-amber-600/40 text-amber-300 cursor-wait"
                  : sessionState === "stopping"
                  ? "bg-slate-700 text-slate-400 cursor-wait"
                  : "bg-green-700/30 hover:bg-green-600/40 text-green-400 border border-green-700/40"
              }`}
            >
              <Mic size={13} className={sessionState === "running" ? "animate-pulse" : ""} />
              {sessionState === "running"
                ? <><span>Stop</span><span className="font-mono font-normal text-red-200/80">{fmtTime(sessionSecs)}</span></>
                : <span>{sessionState === "loading" ? "Starting…" : sessionState === "stopping" ? "Stopping…" : "Go Live"}</span>
              }
            </button>

            {/* PTT — only while operator is recording */}
            {sessionState === "running" && operatorRecordingActive && (
              <button
                onMouseDown={handlePttDown}
                onMouseUp={handlePttUp}
                onMouseLeave={handlePttUp}
                className={`px-2.5 py-1 rounded text-[10px] font-black uppercase transition-all ${
                  isPttActive
                    ? "bg-amber-500 text-black scale-95"
                    : "bg-slate-800 text-slate-400 hover:bg-slate-700"
                }`}
                title="Push-to-Talk (hold Space)"
              >
                PTT
              </button>
            )}

            <div className="w-px h-5 bg-slate-800" />

            {/* VU meters with inline mute toggles */}
            <div className="flex flex-col gap-1">
              {/* Operator row */}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleToggleOperatorMute}
                  title={operatorMuted ? "Unmute operator mic" : "Mute operator mic"}
                  className={`text-[8px] font-black uppercase w-5 text-center rounded transition-all ${
                    operatorMuted ? "text-red-400" : "text-amber-500 hover:text-amber-300"
                  }`}
                >
                  {operatorMuted ? "✕" : "Op"}
                </button>
                <div className={`w-16 h-1.5 rounded-full overflow-hidden ${operatorMuted ? "bg-red-900/40" : "bg-slate-900"}`}>
                  <motion.div
                    className={`h-full ${operatorMuted ? "bg-red-700/50" : "bg-amber-500"}`}
                    animate={{ width: operatorMuted ? "100%" : `${operatorMicLevel * 100}%` }}
                    transition={{ type: "spring", bounce: 0, duration: 0.1 }}
                  />
                </div>
                {sessionState === "running" && (
                  <button
                    onClick={async () => {
                      if (operatorRecordingActive) {
                        await invoke("stop_operator_recording").catch((e: any) => setAudioError(String(e)));
                        setOperatorRecordingActive(false);
                      } else {
                        await invoke("start_operator_recording").catch((e: any) => setAudioError(String(e)));
                      }
                    }}
                    title={operatorRecordingActive ? "Stop operator recording" : "Start operator recording"}
                    className={`text-[8px] font-black uppercase px-1 py-0.5 rounded transition-all ${
                      operatorRecordingActive
                        ? "bg-amber-600/30 text-amber-400 animate-pulse"
                        : "bg-slate-800 text-slate-400 hover:text-amber-300 hover:bg-slate-700"
                    }`}
                  >
                    {operatorRecordingActive ? "■" : "REC"}
                  </button>
                )}
              </div>
              {/* Preacher row */}
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleTogglePreacherMute}
                  title={preacherMuted ? "Unmute preacher mic" : "Mute preacher mic"}
                  className={`text-[8px] font-black uppercase w-5 text-center rounded transition-all ${
                    preacherMuted ? "text-red-400" : "text-blue-400 hover:text-blue-300"
                  }`}
                >
                  {preacherMuted ? "✕" : "Pr"}
                </button>
                <div className={`w-16 h-1.5 rounded-full overflow-hidden ${preacherMuted ? "bg-red-900/40" : "bg-slate-900"}`}>
                  <motion.div
                    className={`h-full ${preacherMuted ? "bg-red-700/50" : "bg-blue-400"}`}
                    animate={{ width: preacherMuted ? "100%" : `${preacherMicLevel * 100}%` }}
                    transition={{ type: "spring", bounce: 0, duration: 0.1 }}
                  />
                </div>
                {sessionState === "running" && (
                  <button
                    onClick={async () => {
                      if (preacherRecordingActive) {
                        await invoke("stop_preacher_recording").catch((e: any) => setAudioError(String(e)));
                        setPreacherRecordingActive(false);
                      } else {
                        await invoke("start_preacher_recording").catch((e: any) => setAudioError(String(e)));
                      }
                    }}
                    title={preacherRecordingActive ? "Stop pastor recording" : "Start pastor recording"}
                    className={`text-[8px] font-black uppercase px-1 py-0.5 rounded transition-all ${
                      preacherRecordingActive
                        ? "bg-red-600/30 text-red-400 animate-pulse"
                        : "bg-slate-800 text-slate-400 hover:text-blue-300 hover:bg-slate-700"
                    }`}
                  >
                    {preacherRecordingActive ? "■" : "REC"}
                  </button>
                )}
              </div>
            </div>
          </div>

          {settings.ndi_enabled && (
            <div className="px-2 py-0.5 bg-teal-500/10 border border-teal-500/30 rounded flex items-center gap-1.5 animate-pulse hidden xl:flex">
              <span className="w-1.5 h-1.5 rounded-full bg-teal-500" />
              <span className="text-[9px] font-black text-teal-500 uppercase tracking-widest">NDI</span>
            </div>
          )}

          {/* System Icons Block */}
          <div className="flex items-center gap-1 bg-slate-950 px-1.5 py-1.5 rounded-xl border border-slate-800/60 shadow-inner">
            <button
              onClick={() => { invoke("toggle_output_window"); setOutputVisible(v => !v); }}
              className={`p-1.5 rounded-lg transition-all ${outputVisible ? "bg-green-500/20 text-green-400" : "text-slate-400 hover:text-green-400 hover:bg-slate-800"}`}
              title="Toggle Output Window (Ctrl+O)"
            ><Monitor size={16} /></button>
            <button onClick={() => invoke("toggle_design_window")} className="p-1.5 text-slate-400 hover:text-purple-400 hover:bg-slate-800 rounded-lg transition-all" title="Design Hub"><Layout size={16} /></button>
            <div className="w-px h-4 bg-slate-800 mx-1 hidden sm:block" />
            <button onClick={() => setIsLogOpen(!isLogOpen)} className={`p-1.5 rounded-lg transition-all hidden sm:block ${isLogOpen ? "bg-slate-800 text-amber-500" : "text-slate-400 hover:text-white hover:bg-slate-800"}`} title="System Logs"><Repeat size={16} className="rotate-90" /></button>
            <button onClick={() => setShowShortcuts(true)} className={`p-1.5 rounded-lg transition-all hidden sm:block ${showShortcuts ? "bg-slate-800 text-amber-500" : "text-slate-400 hover:text-white hover:bg-slate-800"}`} title="Keyboard Shortcuts (?)"><Keyboard size={16} /></button>
            <button onClick={() => setActiveTab("settings")} className={`p-1.5 rounded-lg transition-all ${activeTab === "settings" ? "bg-slate-800 text-amber-500" : "text-slate-400 hover:text-white hover:bg-slate-800"}`} title="Settings"><Settings size={16} /></button>
          </div>
        </div>
      </header>

      {/* Error Banner */}
      {(audioError || deviceError) && (
        <div className="bg-red-600/90 text-white px-4 py-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider z-50">
          <div className="flex items-center gap-2">
            <AlertCircle size={14} />
            <span>{audioError || deviceError}</span>
          </div>
          <button onClick={() => setAudioError(null)}><X size={14} /></button>
        </div>
      )}

      {/* Startup Issues Banner */}
      {startupIssues.length > 0 && (
        <div className="bg-amber-900/90 border-b border-amber-600 px-4 py-2 flex items-start gap-2 text-sm text-amber-200 z-50">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="flex-1">
            <span className="font-bold text-amber-300">Setup Issues: </span>
            {startupIssues.join(" | ")}
          </div>
          <button onClick={() => setStartupIssues([])} className="text-amber-400 hover:text-white shrink-0"><X size={14} /></button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        <aside className="bg-slate-900/40 border-r border-slate-900 flex flex-col overflow-hidden" style={{ width: sidebarWidth }}>
          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            {activeTab === "bible" && <BibleTab onStage={stageItem} onLive={sendLive} onAddToSchedule={addToSchedule} />}
            {activeTab === "media" && (
              <MediaTab
                onStage={stageItem} onLive={sendLive} onAddToSchedule={addToSchedule}
                onLoadMedia={handleFileUpload} onDeleteMedia={handleDeleteMedia}
                onSetAsLogo={(path) => updateSettings({ ...settings, logo_path: path })}
                onSetAsBackgroundLogo={(path) => {
                  const fit = media.find(m => m.path === path)?.fit_mode ?? "cover";
                  updateSettings({ ...settings, background_logo_path: path, background_logo_fit: fit, show_background_logo: true });
                  setToast("Background logo set & activated");
                }}
                remoteUrl={remoteUrl} remotePin={remotePin}
                cameraSources={cameraSources} onEnableCameraPreview={enableCameraPreview} onDisableCameraPreview={disableCameraPreview}
                onRemoveCameraSource={removeCameraSource} previewVideoMapRef={previewVideoMapRef} previewObserverMapRef={previewObserverMapRef}
              />
            )}
            {activeTab === "studio" && (
              <StudioTab
                onStage={stageItem}
                onLive={sendLive}
                onOpenEditor={(id) => {
                  invoke("load_studio_presentation", { id }).then((data: any) => {
                    const pres = data as CustomPresentation;
                    setStudioSlides({ ...studioSlides, [id]: pres.slides });
                    setEditingPres(pres);
                  });
                }}
                onNewPresentation={() => {
                  const id = stableId();
                  const newPres: CustomPresentation = { id, name: "New Presentation", slides: [newDefaultSlide()], version: 1 };
                  invoke("save_studio_presentation", { presentation: newPres }).then(() => {
                    const nextList = [...studioList, { id, name: newPres.name, slide_count: 1, updated_at: Date.now() }];
                    setStudioList(nextList);
                    emit("studio-sync", nextList);
                    setStudioSlides({ ...studioSlides, [id]: newPres.slides });
                    setEditingPres(newPres);
                  });
                }}
              />
            )}
            {activeTab === "scenes" && (
              <ScenesTab
                onStage={stageItem}
                onLive={sendLive}
                onAddToSchedule={addToSchedule}
              />
            )}
            {activeTab === "scene-builder" && (
              <SceneComposerTab
                onSetToast={setToast}
                onStage={stageItem}
                onLive={sendLive}
                onAddToSchedule={addToSchedule}
              />
            )}
            {activeTab === "songs" && <SongsTab 
              onStage={stageItem} 
              onLive={sendLive} 
              onAddToSchedule={addToSchedule}
              onOpenLyricsMode={(id) => { setActiveTab("lower-third"); useAppStore.getState().setLtSongId(id); useAppStore.getState().setLtMode("lyrics"); }} 
            />}
            {activeTab === "schedule" && <ScheduleTab onSendItem={sendLive} onPersist={persistSchedule} stageItem={stageItem} />}
            {activeTab === "settings" && <SettingsTab onUpdateSettings={updateSettings} onUploadMedia={handleFileUpload} />}
            {activeTab === "lower-third" && <LowerThirdTab onSetToast={setToast} onLoadMedia={handleFileUpload} />}
            {activeTab === "props" && <PropsTab onUpdateProps={updateProps} />}
          </div>
        </aside>

        <div className="w-1 bg-slate-900 hover:bg-amber-500/40 cursor-col-resize transition-colors"
          onMouseDown={(e) => {
            const startX = e.clientX; const startW = sidebarWidth;
            const move = (em: MouseEvent) => setSidebarWidth(Math.max(240, Math.min(500, startW + em.clientX - startX)));
            const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
            document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
          }}
        />

        <main className="flex-1 flex flex-col overflow-hidden relative">
          <div className="h-12 bg-slate-950 border-b border-slate-900 px-4 flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <button onClick={() => { const nb = !settings.is_blanked; setSettings({ ...settings, is_blanked: nb }); setIsBlackout(nb); invoke("save_settings", { settings: { ...settings, is_blanked: nb } }); }}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${settings.is_blanked ? "bg-red-600 text-white" : "bg-slate-800 text-slate-500 hover:text-slate-300"}`}>
                <EyeOff size={12} className="inline mr-1.5" /> {settings.is_blanked ? "BLACKOUT ON" : "BLACKOUT"}
              </button>
              <button onClick={() => { const nl = !settings.show_background_logo; updateSettings({ ...settings, show_background_logo: nl }); }}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${settings.show_background_logo ? "bg-purple-600 text-white" : "bg-slate-800 text-slate-500 hover:text-slate-300"}`}>
                <Layers size={12} className="inline mr-1.5" /> {settings.show_background_logo ? "BG LOGO ON" : "BG LOGO"}
              </button>
              <button onClick={() => setIsTranscriptionCollapsed(!isTranscriptionCollapsed)} className="px-3 py-1.5 bg-slate-800 rounded-lg text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-300">
                <Mic size={12} className="inline mr-1.5" /> {isTranscriptionCollapsed ? "SHOW AI" : "HIDE AI"}
              </button>
              <button
                onClick={() => {
                  const bg = settings.background;
                  if (bg.type === "Image" && bg.value) updateSettings({ ...settings, logo_path: bg.value });
                }}
                disabled={settings.background.type !== "Image" || !(settings.background as { type: "Image"; value: string }).value}
                title="Set current background image as corner logo"
                className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                  settings.background.type === "Image" && (settings.background as { type: "Image"; value: string }).value && settings.logo_path === (settings.background as { type: "Image"; value: string }).value
                    ? "bg-teal-600/30 border border-teal-600/40 text-teal-400"
                    : "bg-slate-800 text-slate-500 hover:text-teal-400"
                }`}
              >
                <ImageIcon size={12} className="inline mr-1.5" /> BG→LOGO
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setBottomDeckOpen(!bottomDeckOpen)} className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${bottomDeckOpen ? "bg-purple-600 text-white" : "bg-slate-800 text-slate-500"}`}>TOOLS</button>
              <div className="h-4 w-px bg-slate-800 mx-1" />
              <button onClick={() => invoke("clear_live")} className="px-4 py-1.5 bg-red-900/40 hover:bg-red-600 text-red-200 text-[10px] font-black uppercase rounded-lg border border-red-900/50">CLEAR</button>
              {previousItem && (
                <button
                  onClick={() => sendLive(previousItem)}
                  className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 text-[10px] font-black uppercase rounded-lg border border-slate-700 flex items-center gap-1.5"
                  title={`Go back to: ${displayItemLabel(previousItem)}`}
                >
                  <Clock size={12} /> Previous
                </button>
              )}
              <button onClick={goLive} disabled={!stagedItem} className="px-6 py-1.5 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-black uppercase rounded-lg shadow-lg shadow-amber-500/20 disabled:opacity-30">GO LIVE</button>
            </div>
          </div>

          {!isTranscriptionCollapsed && (
            <section className="bg-slate-950 p-5 flex flex-col overflow-hidden border-b border-slate-900 relative" style={{ height: `${topPanelPct}%` }}>
              <TranscriptLog segments={sessionTranscript} />
              <AnimatePresence>
                {suggestedItem && (
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} className="mt-4 bg-slate-900 border border-slate-800 rounded-xl p-3 flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-[9px] text-slate-500 uppercase font-black mb-1">AI Detected Reference <span className="ml-2 text-blue-400">{Math.round(suggestedConfidence * 100)}% Match</span></p>
                      <p className="text-slate-200 text-sm truncate font-medium">{displayItemLabel(suggestedItem)}</p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => { stageItem(suggestedItem); setSuggestedItem(null); }} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-[10px] font-bold rounded-lg">STAGE</button>
                      <button onClick={() => { sendLive(suggestedItem); setSuggestedItem(null); }} className="px-4 py-1.5 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-black rounded-lg">DISPLAY</button>
                      <button onClick={() => setSuggestedItem(null)} className="p-1.5 text-slate-600 hover:text-white"><X size={16} /></button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              <div className="h-1 bg-slate-900 hover:bg-amber-500/40 cursor-row-resize transition-colors absolute bottom-0 left-0 right-0 z-10" onMouseDown={(e) => {
                const startY = e.clientY; const startH = topPanelPct;
                const move = (em: MouseEvent) => {
                  const nextH = Math.max(15, Math.min(60, startH + (em.clientY - startY) / window.innerHeight * 100));
                  setTopPanelPct(nextH); localStorage.setItem("pref_topPanelPct", String(Math.round(nextH)));
                };
                const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
                document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
              }} />
            </section>
          )}

          <section className="flex-1 flex overflow-hidden bg-slate-950 relative min-h-[180px]">
            <div className="p-5 flex flex-col overflow-hidden shrink-0 border-r border-slate-900 gap-3" style={{ width: `${stagePct}%` }}>
              {/* Staged item — uses PreviewCard with action buttons injected into badge slot */}
              <div className="flex flex-col min-h-0" style={{ flex: "1 1 65%" }}>
                <PreviewCard
                  item={stagedItem}
                  label="Stage Preview"
                  accent="text-amber-500/60"
                  isLocalPreview={true}
                  badge={
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setStagedItem(null)}
                        className="px-2 py-0.5 text-[9px] font-black uppercase text-slate-600 hover:text-red-400 hover:bg-red-500/10 rounded transition-all"
                        title="Clear stage"
                      >✕</button>
                      <button
                        onClick={goLive}
                        disabled={!stagedItem}
                        className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-black text-[9px] font-black uppercase rounded-lg shadow-lg shadow-amber-500/20 disabled:opacity-30 transition-all"
                      >GO LIVE</button>
                      <span className="text-[9px] bg-amber-500/10 text-amber-500 px-2 py-0.5 rounded border border-amber-500/20 font-black">NEXT</span>
                    </div>
                  }
                  empty="Stage is empty"
                />
              </div>
              {/* Up Next — compact info card, no full render */}
              <div className="flex flex-col shrink-0" style={{ flex: "0 0 30%" }}>
                <div className="flex items-center justify-between mb-2 shrink-0">
                  <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Up Next from Live</h2>
                  {nextLiveItem && (
                    <button onClick={() => sendLive(nextLiveItem)} className="px-2 py-0.5 bg-slate-800 hover:bg-amber-500 hover:text-black text-slate-400 text-[9px] font-black uppercase rounded-lg transition-all flex items-center gap-1">SEND <ChevronRight size={11} /></button>
                  )}
                </div>
                <div className="flex-1 bg-black/20 rounded-xl border border-slate-900 flex flex-col items-center justify-center p-4 min-h-0 text-center">
                  {nextLiveItem ? (
                    nextLiveItem.type === "Verse" ? (
                      <div>
                        <p className="text-slate-400 text-xs leading-snug line-clamp-3 font-serif mb-1">{nextLiveItem.data.text}</p>
                        <p className="text-amber-500/60 text-[10px] font-bold uppercase tracking-wider">{nextLiveItem.data.book} {nextLiveItem.data.chapter}:{nextLiveItem.data.verse}</p>
                      </div>
                    ) : nextLiveItem.type === "CustomSlide" ? (
                      <div>
                        <p className="text-purple-400 text-sm font-black">Slide {nextLiveItem.data.slide_index + 1}</p>
                        <p className="text-slate-500 text-[10px] truncate max-w-full">{nextLiveItem.data.presentation_name}</p>
                      </div>
                    ) : (
                      <p className="text-slate-400 text-xs font-bold">{displayItemLabel(nextLiveItem)}</p>
                    )
                  ) : (
                    <p className="text-slate-800 italic text-xs">Nothing after current live</p>
                  )}
                </div>
              </div>
            </div>
            <div className="w-1 bg-slate-900 hover:bg-amber-500/40 cursor-col-resize transition-colors absolute top-0 bottom-0 z-10" style={{ left: `${stagePct}%` }} onMouseDown={(e) => {
              const startX = e.clientX; const startP = stagePct;
              const move = (em: MouseEvent) => {
                const nextP = Math.max(20, Math.min(80, startP + (em.clientX - startX) / window.innerWidth * 100));
                setStagePct(nextP); localStorage.setItem("pref_stagePct", String(Math.round(nextP)));
              };
              const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
              document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
            }} />
            <div className="flex-1 p-5 flex flex-col overflow-hidden">
              <PreviewCard item={liveItem} label="Live Output" accent="text-red-500/60" badge={<div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /><span className="text-[9px] text-red-500 font-black uppercase">On Air</span></div>} empty="Output is empty" />
            </div>
          </section>

          {bottomDeckOpen && (
            <section className="bg-slate-900 border-t border-slate-800 flex flex-col shrink-0 z-40 relative" style={{ height: bottomDeckH }}>
              <div className="h-1 bg-slate-900 hover:bg-amber-500/40 cursor-row-resize transition-colors absolute top-0 left-0 right-0 z-10"
                onMouseDown={(e) => {
                  const startY = e.clientY; const startH = bottomDeckH;
                  const move = (em: MouseEvent) => {
                    const next = Math.max(180, Math.min(window.innerHeight * 0.55, startH - (em.clientY - startY)));
                    setBottomDeckH(next); localStorage.setItem("pref_bottomDeckH", String(Math.round(next)));
                  };
                  const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
                  document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
                }}
              />
              <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-800/50">
                <div className="flex rounded-lg overflow-hidden border border-slate-700 bg-black/20 p-0.5">
                  {([
                    { id: "live-lt", label: "Lower Third" },
                    { id: "timer", label: "Timers" },
                  ] as const).map(({ id, label: lbl }) => (
                    <button key={id} onClick={() => setBottomDeckMode(id)} className={`px-4 py-1.5 text-[9px] font-black uppercase tracking-widest rounded-md transition-all ${bottomDeckMode === id ? "bg-amber-500 text-black shadow-lg" : "text-slate-500 hover:text-slate-300"}`}>{lbl}</button>
                  ))}
                </div>
                <button onClick={() => setBottomDeckOpen(false)} className="text-slate-500 hover:text-white p-1"><X size={20} /></button>
              </div>
              <div className="flex-1 overflow-hidden p-4">
                {bottomDeckMode === "live-lt" && <LowerThirdTab onSetToast={setToast} onLoadMedia={handleFileUpload} />}
                {bottomDeckMode === "timer" && <TimersTab onStage={stageItem} onLive={sendLive} />}
              </div>
            </section>
          )}
        </main>

        {/* 5. Schedule / Setlist */}
        <div className="w-1 bg-slate-900 hover:bg-amber-500/40 cursor-col-resize transition-colors shrink-0"
          onMouseDown={(e) => {
            const startX = e.clientX; const startW = scheduleWidth;
            const move = (em: MouseEvent) => {
              const next = Math.max(160, Math.min(400, startW - (em.clientX - startX)));
              setScheduleWidth(next); localStorage.setItem("pref_scheduleWidth", String(Math.round(next)));
            };
            const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
            document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
          }}
        />
        <aside className="bg-slate-900/20 border-l border-slate-900 flex flex-col overflow-hidden shrink-0" style={{ width: scheduleWidth }}>
          <RemoteProposals />
          <div className="p-4 border-b border-slate-900 flex items-center justify-between shrink-0">
            <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center gap-2"><CalendarDays size={14} className="text-amber-500" /> Service Setlist</h2>
            <button onClick={persistSchedule} className="text-[9px] font-black bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded transition-colors">SAVE</button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
            {scheduleEntries.map((e, i) => (
              <div key={e.id} onClick={() => stageItem(e.item)}
                className={`group p-2.5 rounded-xl border cursor-pointer transition-all ${stagedItem && getItemUid(stagedItem) === getItemUid(e.item) ? "bg-amber-500/10 border-amber-500/40" : liveItem && getItemUid(liveItem) === getItemUid(e.item) ? "bg-red-900/20 border-red-900/40" : "bg-slate-950 border-slate-800 hover:border-slate-700"}`}>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-black text-slate-700 w-4">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-bold text-slate-200 truncate">{displayItemLabel(e.item)}</p>
                    <p className="text-[8px] text-slate-600 uppercase font-black">{e.item.type}</p>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button onClick={(em) => { em.stopPropagation(); sendLive(e.item); }} className="bg-amber-500 hover:bg-amber-400 text-black p-1 rounded-lg"><Zap size={10} fill="currentColor" /></button>
                    <button onClick={(em) => { em.stopPropagation(); setScheduleEntries(scheduleEntries.filter(se => se.id !== e.id)); }} className="bg-red-900/40 hover:bg-red-600 text-red-200 p-1 rounded-lg"><X size={10} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      <AnimatePresence>
        {toast && <Toast key={toast} message={toast} onDone={() => setToast(null)} />}
      </AnimatePresence>

      {editingPres && (
        <SlideEditor
          initialPres={editingPres}
          mediaImages={media.filter(m => m.media_type === "Image")}
          onClose={(saved) => {
            if (saved) {
              invoke("list_studio_presentations").then((list: any) => {
                setStudioList(list);
                emit("studio-sync", list);
              });
              // Refresh slides if the edited one is currently being presented in the studio tab
              invoke("load_studio_presentation", { id: editingPres.id }).then((data: any) => {
                const slides = data.slides;
                setStudioSlides({ ...studioSlides, [editingPres.id]: slides });
                emit("studio-slides-sync", { id: editingPres.id, slides });
              });
            }
            setEditingPres(null);
          }}
        />
      )}

      <ShortcutsModal isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <LogViewer />
    </div>
  );
}
