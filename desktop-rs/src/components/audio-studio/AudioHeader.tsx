import React from "react";
import { FileUp, RefreshCw, Mic } from "lucide-react";
import { useAppStore } from "../../store";
import { open as openDialog, message } from "@tauri-apps/plugin-dialog";
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
    setIsImporting,
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
      await message("Failed to import audio: " + err, { title: "Import Error", kind: "error" });
    }
  };

  return (
    <header className="h-11 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-3 shrink-0 z-30">
      {/* Left — logo + title */}
      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-amber-500 rounded-md flex items-center justify-center text-black font-black text-xs shadow-lg shadow-amber-500/20 shrink-0">
            WL
          </div>
          <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-100">Audio Studio</span>
        </div>

        <div className="h-4 w-px bg-slate-800 mx-1" />

        {/* Recording status pill */}
        {isRecording && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-red-600/20 border border-red-600/30 rounded-md">
            <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-[9px] font-black uppercase tracking-widest text-red-400">Recording</span>
          </div>
        )}
      </div>

      {/* Right — controls */}
      <div className="flex items-center gap-2">
        {/* Mic level meter */}
        <div className="flex items-center gap-1.5">
          <Mic size={10} className="text-slate-600" />
          <div className="w-20 h-1 bg-slate-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-75 ${isRecording ? "bg-red-500" : "bg-amber-500"}`}
              style={{ width: `${micLevel * 100}%` }}
            />
          </div>
        </div>

        <div className="h-4 w-px bg-slate-800" />

        {/* Device selector */}
        <select
          value={selectedDevice}
          onChange={(e) => handleDeviceChange(e.target.value)}
          className="bg-slate-800 border border-slate-700 text-slate-300 text-[9px] font-bold rounded-md px-2 py-1 cursor-pointer focus:outline-none focus:border-amber-500 max-w-[140px]"
        >
          <option value="">Default Input</option>
          {devices.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>

        {/* Local / Cloud toggle */}
        <div className="flex bg-black/30 p-0.5 rounded-md border border-slate-700">
          <button
            onClick={() => setTransMode("local")}
            className={`px-2.5 py-1 rounded text-[9px] font-black uppercase tracking-widest transition-all ${
              transMode === "local"
                ? "bg-amber-500 text-black shadow"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            Local
          </button>
          <button
            onClick={() => setTransMode("cloud")}
            className={`px-2.5 py-1 rounded text-[9px] font-black uppercase tracking-widest transition-all ${
              transMode === "cloud"
                ? "bg-amber-500 text-black shadow"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            Cloud
          </button>
        </div>

        {/* Import button */}
        <button
          onClick={handleImport}
          disabled={isImporting}
          className="flex items-center gap-1.5 px-3 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white rounded-md text-[9px] font-black uppercase tracking-widest transition-all disabled:opacity-40"
        >
          {isImporting
            ? <RefreshCw size={11} className="animate-spin" />
            : <FileUp size={11} />
          }
          {isImporting ? "Importing…" : "Import"}
        </button>
      </div>
    </header>
  );
}
