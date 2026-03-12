import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import { Edit3, Check, X, FileDown, RefreshCw } from "lucide-react";
import { useAppStore } from "../../store";

export function TranscriptPanel() {
  const { selectedRecording, isTranscribing, transMode, handleTranscribe } = useAppStore();

  const [transcript, setTranscript] = useState<string | null>(null);
  const [isEditing, setIsEditing]   = useState(false);
  const [editText, setEditText]     = useState("");

  useEffect(() => {
    if (selectedRecording?.transcribed) {
      invoke<string>("get_studio_recording_transcript", { id: selectedRecording.id })
        .then((t) => { setTranscript(t); setEditText(t); })
        .catch(console.error);
    } else {
      setTranscript(null);
      setEditText("");
    }
    setIsEditing(false);
  }, [selectedRecording?.id, selectedRecording?.transcribed]);

  const handleSave = async () => {
    if (!selectedRecording) return;
    try {
      await invoke("save_studio_recording_transcript", { id: selectedRecording.id, text: editText });
      setTranscript(editText);
      setIsEditing(false);
    } catch (err) {
      await message("Failed to save: " + err, { title: "Error", kind: "error" });
    }
  };

  const handleExport = () => {
    if (!selectedRecording || !transcript) return;
    const blob = new Blob([transcript], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), { href: url, download: `${selectedRecording.name}_transcript.txt` });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!selectedRecording) return null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Transcript header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Transcript</span>
          {isTranscribing && (
            <div className="flex items-center gap-1 text-amber-400">
              <RefreshCw size={9} className="animate-spin" />
              <span className="text-[8px] font-bold uppercase tracking-widest">Processing…</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {transcript && !isEditing && (
            <>
              <button
                onClick={handleExport}
                className="flex items-center gap-1 px-2 py-1 text-slate-500 hover:text-slate-200 hover:bg-slate-800 rounded text-[9px] font-black uppercase tracking-widest transition-all"
              ><FileDown size={10} /> Export</button>
              <button
                onClick={() => setIsEditing(true)}
                className="flex items-center gap-1 px-2 py-1 text-slate-500 hover:text-slate-200 hover:bg-slate-800 rounded text-[9px] font-black uppercase tracking-widest transition-all"
              ><Edit3 size={10} /> Edit</button>
            </>
          )}
          {isEditing && (
            <>
              <button
                onClick={() => { setIsEditing(false); setEditText(transcript || ""); }}
                className="flex items-center gap-1 px-2 py-1 text-slate-500 hover:text-slate-300 rounded text-[9px] font-black uppercase tracking-widest transition-all"
              ><X size={10} /> Cancel</button>
              <button
                onClick={handleSave}
                className="flex items-center gap-1 px-2 py-1 bg-amber-500 hover:bg-amber-400 text-black rounded-md text-[9px] font-black uppercase tracking-widest transition-all shadow-lg shadow-amber-500/20"
              ><Check size={10} /> Save</button>
            </>
          )}
        </div>
      </div>

      {/* Transcript body */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {isEditing ? (
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            autoFocus
            className="flex-1 w-full bg-transparent text-slate-300 text-xs leading-relaxed px-4 py-3 outline-none resize-none custom-scrollbar border-none"
          />
        ) : transcript ? (
          <div className="flex-1 overflow-y-auto px-4 py-3 custom-scrollbar">
            <p className="text-slate-300 text-xs leading-relaxed whitespace-pre-wrap">{transcript}</p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-slate-700">
            <p className="text-[9px] font-bold uppercase tracking-widest">No transcript available</p>
            <p className="text-[8px] text-slate-800">Click Transcribe below to process this recording</p>
          </div>
        )}
      </div>

      {/* Footer — transcribe button */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-t border-slate-800 bg-slate-900/60">
        <span className="text-[8px] text-slate-700 uppercase tracking-widest">
          {transMode === "cloud" ? "Cloud AI" : "Local AI"} · {selectedRecording.date}
        </span>
        <button
          onClick={() => handleTranscribe(selectedRecording.id, transMode)}
          disabled={isTranscribing}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[9px] font-black uppercase tracking-widest transition-all shadow-lg disabled:opacity-40 ${
            transMode === "cloud"
              ? "bg-amber-600 hover:bg-amber-500 text-white shadow-amber-600/20"
              : "bg-amber-500 hover:bg-amber-400 text-black shadow-amber-500/20"
          }`}
        >
          {isTranscribing && <RefreshCw size={10} className="animate-spin" />}
          {isTranscribing ? "Processing…" : "Transcribe"}
        </button>
      </div>
    </div>
  );
}
