import React, { useState, useEffect } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";

export function TranscriptPanel() {
  const { 
    selectedRecording, 
    isTranscribing, 
    transMode, 
    handleTranscribe,
    handleDeleteRecording
  } = useAppStore();

  const [transcript, setTranscript] = useState<string | null>(null);

  useEffect(() => {
    if (selectedRecording?.transcribed) {
      invoke<string>("get_studio_recording_transcript", { id: selectedRecording.id })
        .then(setTranscript)
        .catch(console.error);
    } else {
      setTranscript(null);
    }
  }, [selectedRecording]);

  if (!selectedRecording) return null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 bg-slate-900/30 border border-slate-800/50 rounded-3xl p-6 overflow-y-auto custom-scrollbar min-h-0">
        <div className="flex items-center justify-between mb-4 sticky top-0 bg-slate-950/80 backdrop-blur-sm -m-6 p-6 z-20">
          <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Transcript</h3>
          {isTranscribing && (
            <div className="flex items-center gap-2">
              <RefreshCw size={12} className="animate-spin text-indigo-400" />
              <span className="text-[9px] font-bold text-indigo-400 uppercase">AI Processing...</span>
            </div>
          )}
        </div>
        <div className="mt-4">
          {transcript ? (
            <p className="text-slate-300 leading-relaxed font-light text-lg">
              {transcript}
            </p>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-slate-700">
              <p className="text-xs italic">No transcript available. Click 'Transcribe Sermon' below.</p>
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 mt-4 flex items-center justify-end border-t border-slate-800 pt-6">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => handleTranscribe(selectedRecording.id, transMode)}
            disabled={isTranscribing}
            className={`px-6 py-2 ${transMode === 'cloud' ? 'bg-amber-600 hover:bg-amber-500 shadow-amber-600/20' : 'bg-indigo-600 hover:bg-indigo-500 shadow-indigo-600/20'} text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg transition-all disabled:opacity-50`}
          >
            {isTranscribing ? "Processing..." : "Transcribe Sermon"}
          </button>
          <button 
            onClick={() => handleDeleteRecording(selectedRecording.id)}
            className="p-2 text-slate-600 hover:text-red-500 transition-colors"
          >
            <Trash2 size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
