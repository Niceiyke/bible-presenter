import React from "react";
import { Mic, Square, RefreshCw, FileAudio, Clock, HardDrive } from "lucide-react";
import { useAppStore } from "../../store";

export function AudioSidebar() {
  const {
    recordings,
    selectedRecording,
    setSelectedRecording,
    fetchRecordings,
    isRecording,
    handleStartRecording,
    handleStopRecording,
  } = useAppStore();

  return (
    <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0">
      {/* Sidebar header */}
      <div className="px-3 py-2.5 border-b border-slate-800 flex items-center justify-between">
        <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Recordings</span>
        <button
          onClick={() => fetchRecordings()}
          className="p-1 rounded text-slate-600 hover:text-slate-300 hover:bg-slate-800 transition-all"
          title="Refresh"
        >
          <RefreshCw size={11} />
        </button>
      </div>

      {/* Record button */}
      <div className="px-3 py-2.5 border-b border-slate-800">
        <button
          onClick={isRecording ? handleStopRecording : handleStartRecording}
          className={`w-full flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[9px] font-black uppercase tracking-widest transition-all ${
            isRecording
              ? "bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/20"
              : "bg-amber-500 hover:bg-amber-400 text-black shadow-lg shadow-amber-500/20"
          }`}
        >
          {isRecording
            ? <><Square size={11} fill="currentColor" /> Stop Session</>
            : <><Mic size={11} /> New Recording</>
          }
        </button>
      </div>

      {/* Recording list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5 custom-scrollbar">
        {recordings.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-slate-700">
            <FileAudio size={24} strokeWidth={1.5} />
            <p className="text-[9px] font-black uppercase tracking-widest">No Recordings</p>
          </div>
        ) : (
          recordings.map((rec) => {
            const isActive = selectedRecording?.id === rec.id;
            return (
              <button
                key={rec.id}
                onClick={() => setSelectedRecording(rec)}
                className={`w-full px-2.5 py-2 rounded-lg text-left transition-all border ${
                  isActive
                    ? "bg-amber-500/10 border-amber-500/30 ring-1 ring-amber-500/20"
                    : "bg-slate-950/60 border-slate-800/60 hover:border-slate-700 hover:bg-slate-800/40"
                }`}
              >
                <div className="flex items-start justify-between gap-1">
                  <p className={`text-[10px] font-bold truncate leading-tight ${isActive ? "text-amber-300" : "text-slate-200"}`}>
                    {rec.name}
                  </p>
                  {rec.transcribed && (
                    <div className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0 mt-0.5" title="Transcribed" />
                  )}
                </div>
                <div className="flex items-center gap-2.5 mt-1">
                  <span className="flex items-center gap-1 text-[8px] text-slate-500 font-bold uppercase tracking-wider">
                    <Clock size={8} />{rec.duration}
                  </span>
                  <span className="flex items-center gap-1 text-[8px] text-slate-600 font-bold">
                    <HardDrive size={8} />{rec.size_mb.toFixed(1)}MB
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
