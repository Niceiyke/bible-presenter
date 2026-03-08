import React, { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { message } from "@tauri-apps/plugin-dialog";
import { AnimatePresence } from "framer-motion";
import { Mic } from "lucide-react";
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
    setError,
  } = useAppStore();

  useEffect(() => {
    fetchRecordings();
    fetchDevices();

    const unlistenLevel = listen("studio-audio-level", (ev: any) => {
      setMicLevel(ev.payload as number);
    });

    const unlistenImport = listen("studio-import-complete", (ev: any) => {
      setIsImporting(false);
      fetchRecordings(`${ev.payload as string}_imported`);
    });

    const unlistenImportErr = listen("studio-import-error", (ev: any) => {
      setIsImporting(false);
      message("Import failed: " + ev.payload, { title: "Import Error", kind: "error" });
    });

    const unlistenSaved = listen("studio-recording-saved", (ev: any) => {
      fetchRecordings(ev.payload as string);
    });

    const unlistenTrans = listen("studio-transcription-status", (ev: any) => {
      const { status } = ev.payload;
      if (status === "processing") setIsTranscribing(true);
      if (status === "complete") {
        setIsTranscribing(false);
        fetchRecordings();
      }
    });

    const decayInterval = setInterval(() => {
      const level = useAppStore.getState().micLevel;
      if (level > 0) setMicLevel(level > 0.01 ? level * 0.85 : 0);
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

      <div className="flex-1 flex overflow-hidden">
        <AudioSidebar />

        <main className="flex-1 flex flex-col overflow-hidden bg-slate-950">
          {isRecording ? (
            <LiveRecordingView />
          ) : selectedRecording ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Top: waveform editor */}
              <div className="shrink-0 border-b border-slate-800">
                <WaveformEditor />
              </div>
              {/* Bottom: transcript */}
              <div className="flex-1 overflow-hidden flex flex-col">
                <TranscriptPanel />
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-700">
              <div className="w-16 h-16 bg-slate-900 border border-slate-800 rounded-xl flex items-center justify-center">
                <Mic size={28} strokeWidth={1.5} className="text-slate-600" />
              </div>
              <div className="text-center">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-600">Recording Workspace</p>
                <p className="text-[9px] text-slate-700 mt-1">Select a recording or start a new session</p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
