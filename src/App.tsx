import React, { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { AnimatePresence } from "framer-motion";
import { AlertCircle, X } from "lucide-react";

import { useAppStore } from "./store";
import { useAppInitialization } from "./hooks/useAppInitialization";
import { useBibleCascade } from "./hooks/useBibleCascade";
import { useSessionTimer } from "./hooks/useSessionTimer";
import { useItemActions } from "./hooks/useItemActions";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";

import { AppHeader } from "./components/layout/AppHeader";
import { LeftNav } from "./components/layout/LeftNav";
import { BottomDrawer } from "./components/layout/BottomDrawer";
import { Cockpit } from "./components/layout/Cockpit";
import { ContentBrowser } from "./components/layout/ContentBrowser";

import { Toast } from "./components/Toast";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { SlideEditor } from "./components/editors/SlideEditor";
import { LogViewer } from "./components/LogViewer";

import { OutputWindow, StageWindow, DesignHub, AudioStudio } from "./windows";

import type { CustomPresentation } from "./types";

export default function App() {
  const {
    label,
    liveItem, setLiveItem,
    nextVerse, setNextVerse,
    bibleVersion,
    suggestedItem, setSuggestedItem,
    scheduleEntries, setScheduleEntries,
    activeServiceId, setActiveServiceId,
    songs, ltSongId,
    operatorMuted, setOperatorMuted,
    preacherMuted, setPreacherMuted,
    media, studioSlides,
    setStudioSlides,
    toast, setToast,
    showShortcuts,
    audioError, setAudioError,
    deviceError,
    startupIssues, setStartupIssues,
    isLogOpen,
  } = useAppStore();

  const [isPttActive, setIsPttActive] = useState(false);
  const [editingPres, setEditingPres] = useState<CustomPresentation | null>(null);
  const [bottomDeckH, setBottomDeckH] = React.useState(() => Number(localStorage.getItem("pref_bottomDeckH") || 280));
  const [cockpitWidth, setCockpitWidth] = React.useState(() => Number(localStorage.getItem("pref_cockpitWidth") || 340));

  // Initialization & listeners
  useAppInitialization();
  useBibleCascade();

  // Session timer
  const { sessionSecs, fmtTime } = useSessionTimer();

  // Item action handlers (stage, go live, send live, etc.)
  const {
    nextLiveItem, stageItem, goLive, sendLive, getNextItem,
    addToSchedule, persistSchedule, handleFileUpload, handleDeleteMedia,
    updateSettings, updateProps,
  } = useItemActions();

  // ltFlatLines for keyboard shortcuts
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

  // Keyboard shortcuts
  useKeyboardShortcuts({ stageItem, goLive, sendLive, getNextItem, ltFlatLines });

  // ── PTT Spacebar ──────────────────────────────────────────────────────────
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

  // ── Next verse sync ────────────────────────────────────────────────────────
  useEffect(() => {
    if (liveItem?.type === "Verse") {
      const v = liveItem.data;
      invoke("get_next_verse", { book: v.book, chapter: v.chapter, verse: v.verse, version: v.version || bibleVersion })
        .then((res: any) => setNextVerse(res || null)).catch(() => setNextVerse(null));
    } else setNextVerse(null);
  }, [liveItem, bibleVersion, setNextVerse]);

  // ── Auto-dismiss suggested item (AI peel) after 5 seconds ─────────────────
  useEffect(() => {
    if (suggestedItem) {
      const t = setTimeout(() => { setSuggestedItem(null); }, 5000);
      return () => clearTimeout(t);
    }
  }, [suggestedItem, setSuggestedItem]);

  // ── Recovery Save ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (activeServiceId && scheduleEntries.length > 0) {
      const timer = setTimeout(() => {
        invoke("save_recovery", {
          data: { activeServiceId, scheduleEntries, lastUpdate: Date.now() }
        }).catch(console.error);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [scheduleEntries, activeServiceId]);

  // ── Recovery Check on Mount ────────────────────────────────────────────────
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
    setTimeout(checkRecovery, 1500);
  }, []);

  // ── Window Routing (after all hooks) ──────────────────────────────────────
  if (label === "output") return <OutputWindow />;
  if (label === "stage") return <StageWindow />;
  if (label === "design") return <DesignHub />;
  if (label === "studio") return <AudioStudio />;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen bg-slate-950 text-slate-200 flex flex-col font-sans overflow-hidden select-none">

      <AppHeader
        sessionSecs={sessionSecs}
        fmtTime={fmtTime}
        handleToggleOperatorMute={handleToggleOperatorMute}
        handleTogglePreacherMute={handleTogglePreacherMute}
        isPttActive={isPttActive}
        handlePttDown={handlePttDown}
        handlePttUp={handlePttUp}
      />

      {/* Error / Startup banners */}
      {(audioError || deviceError) && (
        <div className="bg-red-600/90 text-white px-4 py-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider z-50">
          <div className="flex items-center gap-2"><AlertCircle size={14} /><span>{audioError || deviceError}</span></div>
          <button onClick={() => setAudioError(null)}><X size={14} /></button>
        </div>
      )}
      {startupIssues.length > 0 && (
        <div className="bg-amber-900/90 border-b border-amber-600 px-4 py-2 flex items-start gap-2 text-sm text-amber-200 z-50">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="flex-1"><span className="font-bold text-amber-300">Setup Issues: </span>{startupIssues.join(" | ")}</div>
          <button onClick={() => setStartupIssues([])} className="text-amber-400 hover:text-white shrink-0"><X size={14} /></button>
        </div>
      )}

      {/* ── BODY ─────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">

        <LeftNav />

        {/* ── CENTER — Content Browser + Bottom Drawer ───────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden bg-slate-950">
          <ContentBrowser
            stageItem={stageItem}
            sendLive={sendLive}
            addToSchedule={addToSchedule}
            handleFileUpload={handleFileUpload}
            handleDeleteMedia={handleDeleteMedia}
            updateSettings={updateSettings}
            updateProps={updateProps}
            setEditingPres={setEditingPres}
            persistSchedule={persistSchedule}
          />

          <BottomDrawer
            bottomDeckH={bottomDeckH}
            setBottomDeckH={setBottomDeckH}
            stageItem={stageItem}
            sendLive={sendLive}
            handleFileUpload={handleFileUpload}
            updateSettings={updateSettings}
            isPttActive={isPttActive}
            handlePttDown={handlePttDown}
            handlePttUp={handlePttUp}
            handleToggleOperatorMute={handleToggleOperatorMute}
            handleTogglePreacherMute={handleTogglePreacherMute}
          />
        </div>

        <Cockpit
          nextLiveItem={nextLiveItem}
          stageItem={stageItem}
          goLive={goLive}
          sendLive={sendLive}
          persistSchedule={persistSchedule}
          updateSettings={updateSettings}
          cockpitWidth={cockpitWidth}
          setCockpitWidth={setCockpitWidth}
        />
      </div>

      {/* ── OVERLAYS ──────────────────────────────────────────────────────── */}
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
                useAppStore.getState().setStudioList(list);
                emit("studio-sync", list);
              });
              invoke("load_studio_presentation", { id: editingPres.id }).then((data: any) => {
                const slides = data.slides;
                useAppStore.getState().setStudioSlides({ ...studioSlides, [editingPres.id]: slides });
                emit("studio-slides-sync", { id: editingPres.id, slides });
              });
            }
            setEditingPres(null);
          }}
        />
      )}

      <ShortcutsModal isOpen={showShortcuts} onClose={() => useAppStore.getState().setShowShortcuts(false)} />
      <LogViewer />
    </div>
  );
}
