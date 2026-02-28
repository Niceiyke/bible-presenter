import React, { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { 
  BookOpen, CalendarDays, ChevronRight, Clock, EyeOff, Image as ImageIcon, 
  Layers, Layout, Mic, Monitor, Presentation, Settings, X, Zap, AlertCircle
} from "lucide-react";

import { useAppStore } from "./store";
import { 
  displayItemLabel, 
  buildCustomSlideItem,
  ltBuildLyricsPayload
} from "./utils";
import { BibleTab } from "./components/BibleTab";
import { MediaTab } from "./components/MediaTab";
import { PresentationsTab } from "./components/PresentationsTab";
import { SongsTab } from "./components/SongsTab";
import { LowerThirdTab } from "./components/LowerThirdTab";
import { TimersTab } from "./components/TimersTab";
import { ScheduleTab } from "./components/ScheduleTab";
import { StudioTab } from "./components/StudioTab";
import { SceneComposerTab } from "./components/SceneComposerTab";
import { SettingsTab } from "./components/SettingsTab";
import { PropsTab } from "./components/PropsTab";
import { PreviewCard } from "./components/PreviewCard";
import { Toast } from "./components/Toast";
import { SlideEditor } from "./components/editors/SlideEditor";
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

export default function App() {
  const {
    label, liveItem, stagedItem, setStagedItem, suggestedItem, setSuggestedItem,
    suggestedConfidence, nextVerse, setNextVerse, verseHistory, setVerseHistory,
    sidebarWidth, setSidebarWidth, isTranscriptionCollapsed, setIsTranscriptionCollapsed,
    bottomDeckOpen, setBottomDeckOpen, bottomDeckMode, setBottomDeckMode,
    settings, setSettings, activeTab, setActiveTab, toast, setToast,
    ltVisible, setLtVisible, ltMode, ltLineIndex, setLtLineIndex, ltLinesPerDisplay, ltTemplate,
    ltSongId, scheduleEntries, setScheduleEntries, services,
    activeServiceId, media, setMedia, pauseWhisper, transcript, sessionState, micLevel,
    remoteUrl, remotePin, bibleVersion, topPanelPct, setTopPanelPct, stagePct, setStagePct, 
    studioList, setStudioList, studioSlides, setStudioSlides,
    setIsBlackout, songs, setPropItems, audioError, setAudioError, deviceError
  } = useAppStore();

  const [outputVisible, setOutputVisible] = React.useState(false);
  const [editingPres, setEditingPres] = useState<CustomPresentation | null>(null);
  const [bottomDeckH, setBottomDeckH] = React.useState(() => Number(localStorage.getItem("pref_bottomDeckH") || 280));
  const [scheduleWidth, setScheduleWidth] = React.useState(() => Number(localStorage.getItem("pref_scheduleWidth") || 240));

  // Initialization & Listeners
  useAppInitialization();

  // Bible selection logic (cascade loading)
  useBibleCascade();

  // LAN Camera WebRTC Hook
  const {
    cameraSources, enableCameraPreview, disableCameraPreview, 
    removeCameraSource, previewVideoMapRef, previewObserverMapRef, setLiveCamera
  } = useLanCamera(remotePin);

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
    if (liveItem.type === "Verse" && nextVerse) return { type: "Verse", data: nextVerse };
    if (liveItem.type === "PresentationSlide") {
      const next = liveItem.data.slide_index + 1;
      if (next < (liveItem.data.slide_count || 0))
        return { type: "PresentationSlide", data: { ...liveItem.data, slide_index: next } };
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
    setStagedItem(item);
    await invoke("stage_item", { item });
  }, [setStagedItem]);

  const goLive = useCallback(async () => {
    await invoke("go_live");
    // After going live, if there's a next item, stage it automatically
    if (nextLiveItem) {
      stageItem(nextLiveItem);
    }
  }, [nextLiveItem, stageItem]);

  const getNextItem = useCallback((item: DisplayItem): DisplayItem | null => {
    if (item.type === "Verse" && nextVerse) return { type: "Verse", data: nextVerse };
    if (item.type === "PresentationSlide") {
      const idx = item.data.slide_index + 1;
      if (idx < (item.data.slide_count || 0))
        return { type: "PresentationSlide", data: { ...item.data, slide_index: idx } };
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
    await stageItem(item);
    await invoke("go_live");
    
    const lbl = displayItemLabel(item);
    setVerseHistory([item, ...verseHistory.filter(h => displayItemLabel(h) !== lbl)].slice(0, 10));
    
    // Calculate next item
    const next = getNextItem(item);
    if (next) {
      stageItem(next);
    }
  }, [stageItem, verseHistory, setVerseHistory, getNextItem]);

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

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const handleKD = (e: KeyboardEvent) => {
      if (label && label !== "main") return;
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") {
        if (e.key === "Escape") invoke("clear_live");
        return;
      }
      switch (e.key) {
        case "Escape": invoke("clear_live"); break;
        case "Enter": if (stagedItem) goLive(); break;
        case "o": if (e.ctrlKey) { invoke("toggle_output_window"); setOutputVisible(v => !v); } break;
        case "b": if (e.ctrlKey) { e.preventDefault(); const nb = !settings.is_blanked; setSettings({ ...settings, is_blanked: nb }); setIsBlackout(nb); invoke("save_settings", { settings: { ...settings, is_blanked: nb } }); } break;
        case "t": if (e.ctrlKey) { e.preventDefault(); setBottomDeckOpen(!bottomDeckOpen); } break;
        case "F1": setActiveTab("bible"); break;
        case "F2": setActiveTab("songs"); break;
        case "F3": setActiveTab("media"); break;
        case "F4": setActiveTab("presentations"); break;
        case "F5": invoke("toggle_design_window"); break;
        case "n": if (nextVerse) { const it: DisplayItem = { type: "Verse", data: nextVerse }; if (e.ctrlKey) sendLive(it); else stageItem(it); } break;
        case "ArrowRight": 
          if (liveItem?.type === "PresentationSlide") { 
            if (liveItem.data.slide_index < (liveItem.data.slide_count || 0) - 1) 
              sendLive({ ...liveItem, data: { ...liveItem.data, slide_index: liveItem.data.slide_index + 1 } }); 
          }
          else if (liveItem?.type === "CustomSlide") { 
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
          break;
        case "ArrowLeft":
          if (liveItem?.type === "PresentationSlide") { 
            if (liveItem.data.slide_index > 0) 
              sendLive({ ...liveItem, data: { ...liveItem.data, slide_index: liveItem.data.slide_index - 1 } }); 
          }
          else if (liveItem?.type === "CustomSlide") { 
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
  }, [label, stagedItem, goLive, liveItem, studioSlides, nextVerse, ltVisible, ltFlatLines, ltLineIndex, ltTemplate, settings, bottomDeckOpen, setSettings, setIsBlackout, setActiveTab, setBottomDeckOpen, setBottomDeckMode, sendLive, stageItem, setLtVisible, ltLinesPerDisplay, ltMode, setLtLineIndex]);

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

  const updateTranscriptionWindow = (sec: number) => {
    invoke("set_transcription_window", { samples: Math.round(sec * 16000) }).catch(() => {});
  };

  const updateVadThreshold = (val: number) => {
    invoke("set_vad_threshold", { threshold: val }).catch(() => {});
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="h-screen bg-slate-950 text-slate-200 flex flex-col font-sans overflow-hidden select-none">
      <header className="h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 shrink-0 z-30">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-amber-500 rounded-lg flex items-center justify-center text-black font-black text-xl shadow-lg shadow-amber-500/20">BP</div>
            <span className="font-black text-xs uppercase tracking-widest text-slate-400">Presenter <span className="text-amber-500/60">RS</span></span>
          </div>
          <nav className="flex gap-1 overflow-x-auto">
            {([
              { id: "bible", label: "Bible", icon: BookOpen },
              { id: "media", label: "Media", icon: ImageIcon },
              { id: "presentations", label: "PPTX", icon: Presentation },
              { id: "songs", label: "Songs", icon: Mic },
              { id: "studio", label: "Studio", icon: Layers },
              { id: "scenes", label: "Scenes", icon: Layout },
              { id: "schedule", label: "Service", icon: CalendarDays },
            ] as const).map(({ id, label: lbl, icon: Icon }) => (
              <button key={id} onClick={() => setActiveTab(id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${activeTab === id ? "bg-amber-500 text-black shadow-lg" : "text-slate-500 hover:text-slate-300 hover:bg-slate-800"}`}>
                <Icon size={14} /> {lbl}
              </button>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <div className="h-8 w-px bg-slate-800 mx-2" />
          <div className="flex flex-col items-end gap-0.5">
            <div className="flex items-center gap-2 px-3 py-1 bg-slate-950 rounded-full border border-slate-800">
              <div className="w-24 h-1.5 bg-slate-800 rounded-full overflow-hidden flex">
                <motion.div className="h-full bg-gradient-to-r from-green-500 via-yellow-500 to-red-500" animate={{ width: `${micLevel * 100}%` }} transition={{ type: "spring", bounce: 0, duration: 0.1 }} />
              </div>
              <span className={`text-[8px] font-black uppercase ${sessionState === "running" ? "text-green-500" : "text-slate-600"}`}>{sessionState}</span>
            </div>
          </div>
          <button
            onClick={() => { invoke("toggle_output_window"); setOutputVisible(v => !v); }}
            className={`p-2 rounded-lg transition-all ${outputVisible ? "bg-green-500/20 text-green-400 ring-1 ring-green-500/40" : "text-slate-400 hover:text-green-400 hover:bg-green-500/10"}`}
            title="Toggle Output Window (Ctrl+O)"
          ><Monitor size={18} /></button>
          <button onClick={() => invoke("toggle_design_window")} className="p-2 text-slate-400 hover:text-purple-400 hover:bg-purple-500/10 rounded-lg transition-all" title="Design Hub"><Layout size={18} /></button>
          <button onClick={() => setActiveTab("settings")} className={`p-2 rounded-lg transition-all ${activeTab === "settings" ? "bg-slate-800 text-amber-500" : "text-slate-400 hover:text-white hover:bg-slate-800"}`}><Settings size={18} /></button>
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
                  updateSettings({ ...settings, background_logo_path: path, show_background_logo: true });
                  setToast("Background logo set & activated");
                }}
                remoteUrl={remoteUrl} remotePin={remotePin}
                cameraSources={cameraSources} onEnableCameraPreview={enableCameraPreview} onDisableCameraPreview={disableCameraPreview}
                onRemoveCameraSource={removeCameraSource} previewVideoMapRef={previewVideoMapRef} previewObserverMapRef={previewObserverMapRef}
              />
            )}
            {activeTab === "presentations" && <PresentationsTab onStage={stageItem} onLive={sendLive} onAddToSchedule={addToSchedule} />}
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
                    setStudioList([...studioList, { id, name: newPres.name, slide_count: 1, updated_at: Date.now() }]);
                    setStudioSlides({ ...studioSlides, [id]: newPres.slides });
                    setEditingPres(newPres);
                  });
                }}
              />
            )}
            {activeTab === "scenes" && (
              <SceneComposerTab
                onStage={stageItem}
                onLive={sendLive}
                onSetToast={setToast}
              />
            )}
            {activeTab === "songs" && <SongsTab 
              onStage={stageItem} 
              onLive={sendLive} 
              onAddToSchedule={addToSchedule}
              onOpenLyricsMode={(id) => { setActiveTab("lower-third"); useAppStore.getState().setLtSongId(id); useAppStore.getState().setLtMode("lyrics"); }} 
            />}
            {activeTab === "schedule" && <ScheduleTab onSendItem={sendLive} onPersist={persistSchedule} />}
            {activeTab === "settings" && <SettingsTab onUpdateSettings={updateSettings} onUpdateTranscriptionWindow={updateTranscriptionWindow} onUpdateVadThreshold={updateVadThreshold} onUploadMedia={handleFileUpload} />}
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
              <button onClick={goLive} disabled={!stagedItem} className="px-6 py-1.5 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-black uppercase rounded-lg shadow-lg shadow-amber-500/20 disabled:opacity-30">GO LIVE</button>
            </div>
          </div>

          {!isTranscriptionCollapsed && (
            <section className="bg-slate-950 p-5 flex flex-col overflow-hidden border-b border-slate-900 relative" style={{ height: `${topPanelPct}%` }}>
              <div className="flex-1 overflow-y-auto text-xl font-light text-slate-400 custom-scrollbar">{transcript || <span className="text-slate-800 italic">Listening for sermon audio...</span>}</div>
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
                    ) : nextLiveItem.type === "PresentationSlide" ? (
                      <div>
                        <p className="text-orange-400 text-sm font-black">Slide {nextLiveItem.data.slide_index + 1}</p>
                        <p className="text-slate-500 text-[10px] truncate max-w-full">{nextLiveItem.data.presentation_name}</p>
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
          <div className="p-4 border-b border-slate-900 flex items-center justify-between shrink-0">
            <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center gap-2"><CalendarDays size={14} className="text-amber-500" /> Service Setlist</h2>
            <button onClick={persistSchedule} className="text-[9px] font-black bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded transition-colors">SAVE</button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
            {scheduleEntries.map((e, i) => (
              <div key={e.id} onClick={() => stageItem(e.item)}
                className={`group p-2.5 rounded-xl border cursor-pointer transition-all ${stagedItem && displayItemLabel(stagedItem) === displayItemLabel(e.item) ? "bg-amber-500/10 border-amber-500/40" : liveItem && displayItemLabel(liveItem) === displayItemLabel(e.item) ? "bg-red-900/20 border-red-900/40" : "bg-slate-950 border-slate-800 hover:border-slate-700"}`}>
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
              invoke("list_studio_presentations").then((list: any) => setStudioList(list));
              // Refresh slides if the edited one is currently being presented in the studio tab
              invoke("load_studio_presentation", { id: editingPres.id }).then((data: any) => {
                setStudioSlides({ ...studioSlides, [editingPres.id]: data.slides });
              });
            }
            setEditingPres(null);
          }}
        />
      )}
    </div>
  );
}
