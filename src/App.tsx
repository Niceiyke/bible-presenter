import React, { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { AnimatePresence } from "framer-motion";

import { useAppStore } from "./store";
import { useAppInitialization } from "./hooks/useAppInitialization";
import { useFonts } from "./hooks/useFonts";
import { useBibleCascade } from "./hooks/useBibleCascade";
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
import { RecoveryModal } from "./components/RecoveryModal";
import { MusicPlayer } from "./components/MusicPlayer";

import { OutputWindow, StageWindow } from "./windows";
import { ErrorBoundary } from "./components/ErrorBoundary";

import type { CustomPresentation, ScheduleEntry } from "./types";

export default function App() {
  const {
    label,
    liveItem, setLiveItem,
    nextVerse, setNextVerse,
    bibleVersion,
    scheduleEntries, setScheduleEntries,
    activeServiceId, setActiveServiceId,
    songs, ltSongId,
    media, studioSlides,
    setStudioSlides,
    toast, setToast,
    showShortcuts,
    startupIssues, setStartupIssues,
    isLogOpen,
    recentItems, setRecentItems,
    pastScheduleStates, futureScheduleStates,
    isInitialized,
  } = useAppStore();

  const [editingPres, setEditingPres] = useState<CustomPresentation | null>(null);
  const [bottomDeckH, setBottomDeckH] = React.useState(() => Number(localStorage.getItem("pref_bottomDeckH") || 280));
  const [cockpitWidth, setCockpitWidth] = React.useState(() => Number(localStorage.getItem("pref_cockpitWidth") || 340));
  const [recovery, setRecovery] = useState<{ activeServiceId: string; scheduleEntries: ScheduleEntry[]; lastUpdate: number } | null>(null);

  useAppInitialization();
  useBibleCascade();
  useFonts(); // P2.5: inject @font-face for user-installed fonts.

  const {
    nextLiveItem, stageItem, goLive, sendLive, clearAll, getNextItem,
    addToSchedule, persistSchedule, handleFileUpload, handleDeleteMedia,
    updateSettings, updateProps,
    loadScenes, saveScene, deleteScene, applyScene, captureScene,
  } = useItemActions();

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

  useKeyboardShortcuts({ stageItem, goLive, sendLive, clearAll, ltFlatLines });

  useEffect(() => {
    if (liveItem?.type === "Verse") {
      const v = liveItem.data;
      invoke("get_next_verse", { book: v.book, chapter: v.chapter, verse: v.verse, version: v.version || bibleVersion })
        .then((res: any) => setNextVerse(res || null)).catch(() => setNextVerse(null));
    } else setNextVerse(null);
  }, [liveItem, bibleVersion, setNextVerse]);

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

  // P1.7 — Recovery prompt as an in-app modal (replaces window.confirm).
  useEffect(() => {
    const checkRecovery = async () => {
      const data = await invoke<any>("load_recovery").catch(() => null);
      if (data && data.scheduleEntries?.length > 0) {
        setRecovery({
          activeServiceId: data.activeServiceId,
          scheduleEntries: data.scheduleEntries,
          lastUpdate: data.lastUpdate,
        });
      }
    };
    const t = setTimeout(checkRecovery, 1500);
    return () => clearTimeout(t);
  }, []);

  // P1.5 — Persist recent items across restarts (debounced).
  useEffect(() => {
    if (!isInitialized) return;
    const t = setTimeout(() => {
      invoke("save_workspace", { key: "recents", value: recentItems }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [recentItems, isInitialized]);

  // P1.5 — Persist schedule undo/redo stacks across restarts (debounced).
  useEffect(() => {
    if (!isInitialized) return;
    const t = setTimeout(() => {
      invoke("save_workspace", {
        key: "schedule_history",
        value: { entries: scheduleEntries, past: pastScheduleStates, future: futureScheduleStates }
      }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [scheduleEntries, pastScheduleStates, futureScheduleStates, isInitialized]);

  // P1.6 — Load scenes once on init.
  useEffect(() => {
    if (isInitialized) loadScenes();
  }, [isInitialized, loadScenes]);

  if (label === "output") return <ErrorBoundary windowLabel="output"><OutputWindow /></ErrorBoundary>;
  if (label === "stage") return <ErrorBoundary windowLabel="stage"><StageWindow /></ErrorBoundary>;

  return (
    <div className="h-screen app-ambient text-slate-200 flex flex-col font-sans overflow-hidden select-none">

      <AppHeader />

      {startupIssues.length > 0 && (
        <div className="bg-amber-950/70 backdrop-blur-md border-b border-amber-500/30 px-4 py-2 flex items-start gap-2 text-sm text-amber-200 z-50 rise-in">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0 text-amber-400"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div className="flex-1"><span className="font-bold text-amber-300">Setup Issues: </span>{startupIssues.join(" | ")}</div>
          <button onClick={() => setStartupIssues([])} className="text-amber-400 hover:text-white shrink-0 transition-colors"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">

        <LeftNav />

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
            saveScene={saveScene}
            deleteScene={deleteScene}
            applyScene={applyScene}
            captureScene={captureScene}
          />

          <BottomDrawer
            bottomDeckH={bottomDeckH}
            setBottomDeckH={setBottomDeckH}
            stageItem={stageItem}
            sendLive={sendLive}
            handleFileUpload={handleFileUpload}
            updateSettings={updateSettings}
          />
        </div>

        <Cockpit
          nextLiveItem={nextLiveItem}
          stageItem={stageItem}
          goLive={goLive}
          sendLive={sendLive}
          clearAll={clearAll}
          persistSchedule={persistSchedule}
          updateSettings={updateSettings}
          cockpitWidth={cockpitWidth}
          setCockpitWidth={setCockpitWidth}
        />
      </div>

      <MusicPlayer />

      <AnimatePresence>
        {toast && <Toast key={toast} message={toast} onDone={() => setToast(null)} />}
      </AnimatePresence>

      {recovery && (
        <RecoveryModal
          recovery={recovery}
          onRestore={() => {
            setScheduleEntries(recovery.scheduleEntries);
            setActiveServiceId(recovery.activeServiceId);
            setToast("Session restored successfully");
            setRecovery(null);
            invoke("clear_recovery").catch(() => {});
          }}
          onDiscard={() => {
            setRecovery(null);
            invoke("clear_recovery").catch(() => {});
          }}
        />
      )}

      {editingPres && (
        <SlideEditor
          initialPres={editingPres}
          mediaImages={media.filter(m => m.media_type === "Image")}
          media={media}
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
