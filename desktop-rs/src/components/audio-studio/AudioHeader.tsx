import React from "react";
import { Mic, RefreshCw, FileUp } from "lucide-react";
import { useAppStore } from "../../store";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

export function AudioHeader() {
  const { 
    selectedDevice, 
    handleDeviceChange, 
    devices, 
    transMode, 
    setTransMode, 
    isRecording, 
    micLevel,
    isImporting,
    setIsImporting
  } = useAppStore();

  const handleImport = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Audio", extensions: ["mp3", "wav", "m4a", "flac", "aac"] }],
      });
      if (!selected || typeof selected !== "string") return;
      setIsImporting(true);
      await invoke("import_studio_audio", { path: selected });
    } catch (err) {
      console.error(err);
      setIsImporting(false);
      alert("Failed to import audio: " + err);
    }
  };

  return (
    <header className="h-16 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-6 shrink-0">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-600/20">
          <Mic size={24} />
        </div>
        <div>
          <h1 className="font-black text-sm uppercase tracking-widest text-slate-200">Audio Studio</h1>
          <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Archival & Editing Suite</p>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-800">
          <p className="text-[9px] font-black text-slate-500 uppercase">Input:</p>
          <select 
            value={selectedDevice}
            onChange={(e) => handleDeviceChange(e.target.value)}
            className="bg-transparent text-[10px] font-bold text-slate-300 outline-none cursor-pointer max-w-[150px]"
          >
            <option value="">Default Device</option>
            {devices.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </div>

        <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800">
          <button 
            onClick={() => setTransMode("local")}
            className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${transMode === "local" ? "bg-indigo-600 text-white shadow-lg shadow-indigo-600/20" : "text-slate-500 hover:text-slate-300"}`}
          >
            Local AI
          </button>
          <button 
            onClick={() => setTransMode("cloud")}
            className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${transMode === "cloud" ? "bg-amber-600 text-white shadow-lg shadow-amber-600/20" : "text-slate-500 hover:text-slate-300"}`}
          >
            Cloud AI
          </button>
        </div>

        <div className="w-px h-6 bg-slate-800 mx-2" />

        {isRecording && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border border-red-500/30 rounded-full animate-pulse">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            <span className="text-[10px] font-black text-red-500 uppercase tracking-widest">Recording</span>
          </div>
        )}
        <div className="flex items-center gap-2 bg-slate-950 px-3 py-2 rounded-xl border border-slate-800 shadow-inner">
          <div className="w-32 h-2 bg-slate-900 rounded-full overflow-hidden">
            <div 
              className={`h-full transition-all duration-75 ${isRecording ? 'bg-red-500' : 'bg-indigo-500'}`}
              style={{ width: `${micLevel * 100}%` }}
            />
          </div>
        </div>
        <button 
          onClick={handleImport}
          disabled={isImporting}
          className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition-all border border-slate-700 disabled:opacity-50"
        >
          {isImporting ? <RefreshCw size={16} className="animate-spin" /> : <FileUp size={16} />}
          {isImporting ? "Importing..." : "Import Audio"}
        </button>
      </div>
    </header>
  );
}
