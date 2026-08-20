import React, { useState, useEffect, lazy, Suspense } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { AnimatePresence } from "framer-motion";
import { AlertTriangle } from "lucide-react";

import { useAppStore } from "./store";
import { useAppInitialization } from "./hooks/useAppInitialization";
import { useFonts } from "./hooks/useFonts";
import { useBibleCascade } from "./hooks/useBibleCascade";
import { useItemActions } from "./hooks/useItemActions";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useLtFlatLines } from "./hooks/useLtFlatLines";
import { PhoneCameraProvider } from "./hooks/usePhoneCameraHost";
import { SystemDiagnosticsProvider } from "./system/SystemDiagnosticsContext";
import { RecordingProvider } from "./hooks/useRecordingProvider";
import { StreamingProvider } from "./hooks/useStreamingProvider";
import { AudioGraphProvider } from "./hooks/useAudioGraphProvider";
import { LicenseGate, OfflineLicenseBanner } from "./components/LicenseGate";
import { isLicenseBlocked } from "./types/license";

import { AppHeader } from "./components/layout/AppHeader";
import { LeftNav } from "./components/layout/LeftNav";
import { BottomDrawer } from "./components/layout/BottomDrawer";
import { Cockpit } from "./components/layout/Cockpit";
import { ContentBrowser } from "./components/layout/ContentBrowser";
import { AddToServiceModal } from "./components/AddToServiceModal";

import { Toast } from "./components/Toast";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { LogViewer } from "./components/LogViewer";
import { RecoveryModal } from "./components/RecoveryModal";
import { FirstRunWizard, FIRST_RUN_KEY } from "./components/FirstRunWizard";
import { MusicPlayer } from "./components/MusicPlayer";

import { ErrorBoundary } from "./components/ErrorBoundary";

import type { CustomPresentation, ScheduleEntry } from "./types";

// P10: the Tiptap-based slide editor is the heaviest module in the app and only
// needed while a presentation is open. Load it on demand.
const SlideEditor = lazy(() =>
  import("./components/editors/SlideEditor").then((m) => ({ default: m.SlideEditor }))
);

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
    backendAvailable,
    services,
    addToServiceOpen, setAddToServiceOpen,
    pendingScheduleItem, setPendingScheduleItem,
    license,
  } = useAppStore();

  const [editingPres, setEditingPres] = useState<CustomPresentation | null>(null);
  const [bottomDeckH, setBottomDeckH] = React.useState(() => Number(localStorage.getItem("pref_bottomDeckH") || 280));
  const [cockpitWidth, setCockpitWidth] = React.useState(() => Number(localStorage.getItem("pref_cockpitWidth") || 340));
  const [recovery, setRecovery] = useState<{ activeServiceId: string; scheduleEntries: ScheduleEntry[]; lastUpdate: number } | null>(null);
  const [showFirstRun, setShowFirstRun] = useState(false);

  useAppInitialization();
  useBibleCascade();
  useFonts(); // P2.5: inject @font-face for user-installed fonts.

  // Phase 8: show the first-run service setup wizard once, after the app is
  // ready and the license is not blocking, until the operator dismisses it.
  useEffect(() => {
    if (!isInitialized) return;
    if (isLicenseBlocked(license?.status)) return;
    if (label !== "main") return;
    if (localStorage.getItem(FIRST_RUN_KEY) === "1") return;
    setShowFirstRun(true);
  }, [isInitialized, license?.status, label]);

  const {
    nextLiveItem, stageItem, goLive, sendLive, clearStaged, clearAll, undoClearAll, getNextItem,
    addToSchedule, addToService, persistSchedule, handleFileUpload, handleDeleteMedia,
    updateSettings, updateProps,
    loadScenes, saveScene, deleteScene, applyScene, captureScene,
  } = useItemActions();

  const ltFlatLines = useLtFlatLines();

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

  // Neutral startup surface until the window role is known AND while the
  // backend is booting — never render operator controls into a window whose
  // role is unresolved. The main window also stays on this surface until
  // initialization finishes so the license gate never flashes the console.
  if (!label || (label === "main" && !isInitialized)) {
    return (
      <div className="h-screen bg-slate-950 flex items-center justify-center flex-col gap-4 select-none">
        <div className="w-8 h-8 bg-amber-500 rounded-md flex items-center justify-center text-black font-black text-xs">WL</div>
        <p className="text-xs font-black uppercase tracking-[0.2em] text-slate-500">Preparing Wordlyte…</p>
      </div>
    );
  }

  // Configured but not-yet-implemented auxiliary windows get an explicit
  // neutral role surface instead of silently rendering the operator console.
  if (label === "design" || label === "studio") {
    return (
      <div className="h-screen bg-slate-950 flex items-center justify-center flex-col gap-4 select-none">
        <div className="w-8 h-8 bg-purple-500/80 rounded-md flex items-center justify-center text-black font-black text-xs">
          {label === "design" ? "D" : "A"}
        </div>
        <p className="text-xs font-black uppercase tracking-widest text-slate-400">
          {label === "design" ? "Design Hub" : "Audio Studio"}
        </p>
        <p className="text-[11px] text-slate-600">This window is not implemented yet.</p>
      </div>
    );
  }

  // Main window: if the backend never became available, offer retry and
  // remediation instead of an empty, non-functional console.
  if (label === "main" && !backendAvailable) {
    return (
      <div className="h-screen bg-slate-950 flex items-center justify-center flex-col gap-4 select-none px-8">
        <div className="w-12 h-12 rounded-full bg-red-500/15 flex items-center justify-center">
          <AlertTriangle size={22} className="text-red-400" />
        </div>
        <h1 className="text-base font-black text-slate-200">Backend unavailable</h1>
        <p className="text-xs text-slate-500 max-w-md text-center leading-relaxed">
          Wordlyte could not reach its local service to load your Bibles, media, and service plans.
          Check that the app is not blocked by security software and try again.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-1 px-4 py-2 text-xs font-black uppercase bg-amber-500 hover:bg-amber-400 text-black rounded-md transition-all"
        >
          Retry
        </button>
      </div>
    );
  }

  // License gate: block the operator console until the license is active
  // (or backend hydration failed to report one). This is the primary UI
  // control; the Rust commands additionally enforce it on the broadcast path.
  if (label === "main" && isLicenseBlocked(license?.status)) {
    return <LicenseGate />;
  }

  return (
    <PhoneCameraProvider>
      <SystemDiagnosticsProvider>
      <AudioGraphProvider>
      <RecordingProvider>
      <StreamingProvider>
      <div className="h-screen bg-slate-950 text-slate-200 flex flex-col font-sans overflow-hidden select-none">

      <AppHeader />

      {startupIssues.length > 0 && (
        <div className="bg-amber-900/90 border-b border-amber-600 px-4 py-2 flex items-start gap-2 text-sm text-amber-200 z-50">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0 text-amber-400"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div className="flex-1"><span className="font-bold text-amber-300">Setup Issues: </span>{startupIssues.join(" | ")}</div>
          <button onClick={() => setStartupIssues([])} className="text-amber-400 hover:text-white shrink-0"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
      )}

      <OfflineLicenseBanner />

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
            updateProps={updateProps}
            saveScene={saveScene}
            deleteScene={deleteScene}
            applyScene={applyScene}
            captureScene={captureScene}
          />
        </div>

        <Cockpit
          nextLiveItem={nextLiveItem}
          stageItem={stageItem}
          goLive={goLive}
          sendLive={sendLive}
          clearStaged={clearStaged}
          clearAll={clearAll}
          undoClearAll={undoClearAll}
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

      {showFirstRun && <FirstRunWizard onClose={() => setShowFirstRun(false)} />}

      {editingPres && (
        <Suspense fallback={null}>
          <SlideEditor
            initialPres={editingPres}
            mediaImages={media.filter(m => m.media_type === "Image")}
            media={media}
            onStageSlide={stageItem}
            onAddToService={addToSchedule}
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
        </Suspense>
      )}

      <ShortcutsModal isOpen={showShortcuts} onClose={() => useAppStore.getState().setShowShortcuts(false)} />
      <LogViewer />

      <AddToServiceModal
        open={addToServiceOpen}
        services={services}
        activeServiceId={activeServiceId}
        onClose={() => {
          setAddToServiceOpen(false);
          setPendingScheduleItem(null);
        }}
        onSelect={async (id) => {
          const item = pendingScheduleItem;
          if (!item) return;
          await addToService(item, id);
          setAddToServiceOpen(false);
          setPendingScheduleItem(null);
        }}
      />
      </div>
      </StreamingProvider>
      </RecordingProvider>
      </AudioGraphProvider>
      </SystemDiagnosticsProvider>
    </PhoneCameraProvider>
  );
}
