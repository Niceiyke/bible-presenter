import React, { useState, useEffect } from "react";
import { RefreshCw, Trash2, Edit3, Check, X, FileDown } from "lucide-react";
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
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState("");

  useEffect(() => {
    if (selectedRecording?.transcribed) {
      invoke<string>("get_studio_recording_transcript", { id: selectedRecording.id })
        .then((text) => {
           setTranscript(text);
           setEditText(text);
        })
        .catch(console.error);
    } else {
      setTranscript(null);
      setEditText("");
    }
  }, [selectedRecording]);

  const handleSaveEdit = async () => {
    if (!selectedRecording) return;
    try {
      await invoke("save_studio_recording_transcript", { id: selectedRecording.id, text: editText });
      setTranscript(editText);
      setIsEditing(false);
    } catch (err) {
      alert("Failed to save transcript: " + err);
    }
  };

  const handleExport = async () => {
    if (!selectedRecording || !transcript) return;
    try {
      // Create a blob and download it
      const blob = new Blob([transcript], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${selectedRecording.name}_transcript.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
    }
  };

  if (!selectedRecording) return null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 bg-slate-900/30 border border-slate-800/50 rounded-3xl p-6 overflow-y-auto custom-scrollbar min-h-0 flex flex-col">
        <div className="flex items-center justify-between mb-4 sticky top-0 bg-slate-950/80 backdrop-blur-sm -m-6 p-6 z-20">
          <div className="flex items-center gap-3">
            <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Transcript</h3>
            {transcript && !isEditing && (
              <button 
                onClick={() => setIsEditing(true)}
                className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-500 hover:text-indigo-400 transition-all"
                title="Edit Transcript"
              >
                <Edit3 size={14} />
              </button>
            )}
          </div>
          
          <div className="flex items-center gap-4">
            {transcript && (
               <button 
                 onClick={handleExport}
                 className="flex items-center gap-2 text-[9px] font-black text-slate-500 hover:text-white uppercase tracking-widest transition-colors"
               >
                 <FileDown size={14} /> Export TXT
               </button>
            )}

            {isTranscribing && (
              <div className="flex items-center gap-2">
                <RefreshCw size={12} className="animate-spin text-indigo-400" />
                <span className="text-[9px] font-bold text-indigo-400 uppercase">AI Processing...</span>
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 flex-1 flex flex-col">
          {isEditing ? (
            <div className="flex-1 flex flex-col gap-4">
              <textarea 
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                className="flex-1 bg-slate-950/50 border border-indigo-500/30 rounded-2xl p-4 text-slate-300 leading-relaxed font-light text-lg outline-none focus:border-indigo-500 transition-colors resize-none custom-scrollbar"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <button 
                  onClick={() => { setIsEditing(false); setEditText(transcript || ""); }}
                  className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all"
                >
                  <X size={14} /> Cancel
                </button>
                <button 
                  onClick={handleSaveEdit}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-[10px] font-black uppercase tracking-widest transition-all shadow-lg shadow-indigo-600/20"
                >
                  <Check size={14} /> Save Changes
                </button>
              </div>
            </div>
          ) : transcript ? (
            <p className="text-slate-300 leading-relaxed font-light text-lg">
              {transcript}
            </p>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center py-12 text-slate-700">
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
        </div>
      </div>
    </div>
  );
}
