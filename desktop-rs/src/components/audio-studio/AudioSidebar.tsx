import React from "react";
import { 
  Mic, StopCircle, RefreshCw, FileAudio, Clock 
} from "lucide-react";
import { useAppStore } from "../../store";

export function AudioSidebar() {
  const { 
    recordings, 
    selectedRecording, 
    setSelectedRecording, 
    fetchRecordings,
    isRecording,
    handleStartRecording,
    handleStopRecording
  } = useAppStore();

  return (
    <aside className="w-80 bg-slate-900/50 border-r border-slate-800 flex flex-col">
      <div className="p-4 border-b border-slate-800 space-y-4">
        <button 
          onClick={isRecording ? handleStopRecording : handleStartRecording}
          className={`w-full py-3 rounded-xl font-black text-xs uppercase tracking-widest transition-all flex items-center justify-center gap-2 shadow-lg ${
            isRecording 
              ? "bg-red-600 hover:bg-red-500 text-white shadow-red-600/20" 
              : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-600/20"
          }`}
        >
          {isRecording ? <StopCircle size={18} /> : <Mic size={18} />}
          {isRecording ? "Stop Recording" : "New Recording"}
        </button>

        <div className="flex items-center justify-between">
          <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-500">History</h2>
          <button onClick={() => fetchRecordings()} className="text-slate-500 hover:text-white transition-colors">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
        {recordings.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-slate-600 opacity-50">
            <FileAudio size={32} strokeWidth={1} />
            <p className="text-[10px] font-bold uppercase mt-2 tracking-widest">No Recordings Yet</p>
          </div>
        ) : (
          recordings.map((rec) => (
            <button 
              key={rec.id}
              onClick={() => setSelectedRecording(rec)}
              className={`w-full p-3 rounded-xl border text-left transition-all ${
                selectedRecording?.id === rec.id 
                  ? "bg-indigo-600/10 border-indigo-500/40" 
                  : "bg-slate-950 border-slate-800 hover:border-slate-700"
              }`}
            >
              <p className="text-xs font-bold text-slate-200 truncate">{rec.name}</p>
              <div className="flex items-center gap-3 mt-1 text-[9px] text-slate-500 font-bold uppercase tracking-wider">
                <span className="flex items-center gap-1"><Clock size={10} /> {rec.duration}</span>
                <span>{rec.date}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
