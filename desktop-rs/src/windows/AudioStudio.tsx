import React, { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { Mic } from "lucide-react";
import { AnimatePresence } from "framer-motion";
import { useAppStore } from "../store";
import { AudioHeader } from "../components/audio-studio/AudioHeader";
import { AudioSidebar } from "../components/audio-studio/AudioSidebar";
import { WaveformEditor } from "../components/audio-studio/WaveformEditor";
import { TranscriptPanel } from "../components/audio-studio/TranscriptPanel";
import { LiveRecordingView } from "../components/audio-studio/LiveRecordingView";
import { Toast } from "../components/Toast";

export function AudioStudio() {
  const { 
    selectedRecording, 
    fetchRecordings, 
    fetchDevices, 
    setMicLevel, 
    setIsImporting,
    setIsTranscribing,
    isRecording,
    error,
    setError
  } = useAppStore();


  useEffect(() => {
    fetchRecordings();
    fetchDevices();

    // Listen for level updates
    const unlistenLevel = listen("studio-audio-level", (ev: any) => {
      setMicLevel(ev.payload as number);
    });

    const unlistenImport = listen("studio-import-complete", (ev: any) => {
      setIsImporting(false);
      fetchRecordings(`${ev.payload as string}_imported`);
    });

    const unlistenImportErr = listen("studio-import-error", (ev: any) => {
      setIsImporting(false);
      alert("Import failed: " + ev.payload);
    });

    const unlistenSaved = listen("studio-recording-saved", (ev: any) => {
      fetchRecordings(ev.payload as string);
    });

    const unlistenTrans = listen("studio-transcription-status", (ev: any) => {
      const { id, status, text } = ev.payload;
      // We need to update the recording in the store if it's the one currently selected
      // Actually, just refetching recordings or updating the selected one works.
      if (status === "processing") setIsTranscribing(true);
      if (status === "complete") {
        setIsTranscribing(false);
        fetchRecordings();
        // Force update selected recording if it's the one transcribed
        // Note: the component handles fetching transcript via useEffect on selectedRecording
      }
    });

    const decayInterval = setInterval(() => {
      const currentLevel = useAppStore.getState().micLevel;
      if (currentLevel > 0) {
        setMicLevel(currentLevel > 0.01 ? currentLevel * 0.85 : 0);
      }
    }, 50);

    return () => {
      unlistenLevel.then(f => f());
      unlistenImport.then(f => f());
      unlistenImportErr.then(f => f());
      unlistenSaved.then(f => f());
      unlistenTrans.then(f => f());
      clearInterval(decayInterval);
    };
  }, []);

  return (
    <div className="h-screen bg-slate-950 text-slate-200 flex flex-col font-sans overflow-hidden select-none">
      <AnimatePresence>
        {error && <Toast message={error} onDone={() => setError(null)} />}
      </AnimatePresence>
      <AudioHeader />

      <main className="flex-1 flex overflow-hidden">
        <AudioSidebar />

        <section className="flex-1 flex flex-col bg-slate-950 relative overflow-hidden">
          {isRecording ? (
            <LiveRecordingView />
          ) : selectedRecording ? (
            <div className="h-full flex flex-col p-8 overflow-hidden">
              <WaveformEditor />
              <div className="flex-1 mt-6 overflow-hidden flex flex-col">
                <TranscriptPanel />
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-800">
              <div className="w-24 h-24 bg-slate-900 rounded-3xl flex items-center justify-center mb-6 border border-slate-800">
                <Mic size={48} strokeWidth={1} className="text-slate-700" />
              </div>
              <h3 className="text-xl font-black text-slate-700 uppercase tracking-widest mb-2">Recording Workspace</h3>
              <p className="text-slate-600 max-w-sm text-center text-sm leading-relaxed">
                Select a recording from the history to begin editing or start a new recording session.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
