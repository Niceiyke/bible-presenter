import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Monitor, Repeat, Keyboard, X } from "lucide-react";
import { useAppStore } from "../../store";

export function AppHeader() {
  const {
    isLogOpen, setIsLogOpen,
    showShortcuts, setShowShortcuts,
    outputVisible, setOutputVisible,
    backendError, setBackendError,
  } = useAppStore();

  return (
    <header className="h-11 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-3 shrink-0 z-30">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 bg-amber-500 rounded-md flex items-center justify-center text-black font-black text-xs shadow-lg shadow-amber-500/20 shrink-0">WL</div>
          <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-100 hidden sm:block">Wordlyte</span>
        </div>
        {backendError && (
          <button
            onClick={() => { setIsLogOpen(true); setBackendError(null); }}
            className="flex items-center gap-1.5 ml-2 px-2.5 py-1 rounded-full bg-red-950/80 border border-red-700/60 text-red-300 hover:bg-red-900/80 transition-all group shrink-0"
            title={backendError}
          >
            <AlertTriangle size={12} className="text-red-400 shrink-0" />
            <span className="text-[10px] font-bold uppercase tracking-wider truncate max-w-[280px]">Backend issue — click for logs</span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); setBackendError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setBackendError(null); } }}
              className="text-red-500/70 hover:text-red-300 shrink-0"
            >
              <X size={11} />
            </span>
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <button onClick={() => { invoke("toggle_output_window").catch((e: any) => setBackendError(`Output window: ${e?.message ?? e}`)); setOutputVisible((v: boolean) => !v); }}
          className={`p-1.5 rounded-md transition-all ${outputVisible ? "bg-green-500/20 text-green-400" : "text-slate-500 hover:text-green-400 hover:bg-slate-800"}`}
          title="Toggle Output Window (Ctrl+O)" aria-label="Toggle output window"><Monitor size={15} /></button>
        <div className="w-px h-4 bg-slate-800 mx-0.5" />
        <button onClick={() => setIsLogOpen(!isLogOpen)}
          className={`p-1.5 rounded-md transition-all ${isLogOpen ? "bg-slate-800 text-amber-500" : "text-slate-500 hover:text-white hover:bg-slate-800"}`} title="System Logs" aria-label="System logs"><Repeat size={15} className="rotate-90" /></button>
        <button onClick={() => setShowShortcuts(true)}
          className={`p-1.5 rounded-md transition-all ${showShortcuts ? "bg-slate-800 text-amber-500" : "text-slate-500 hover:text-white hover:bg-slate-800"}`} title="Keyboard Shortcuts (?)" aria-label="Keyboard shortcuts"><Keyboard size={15} /></button>
      </div>
    </header>
  );
}
