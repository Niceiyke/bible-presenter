import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Monitor, Repeat, Keyboard, X, Zap } from "lucide-react";
import { useAppStore } from "../../store";

export function AppHeader() {
  const {
    isLogOpen, setIsLogOpen,
    showShortcuts, setShowShortcuts,
    outputVisible, setOutputVisible,
    backendError, setBackendError,
  } = useAppStore();

  return (
    <header className="h-12 bg-slate-900/70 backdrop-blur-xl border-b border-white/[0.06] flex items-center justify-between px-3 shrink-0 z-30 relative hairline-top">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="relative w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 via-violet-500 to-cyan-400 flex items-center justify-center text-white font-black text-xs shadow-lg shadow-indigo-500/30 shrink-0">
            <Zap size={13} fill="currentColor" />
          </div>
          <span className="text-[11px] font-display font-black uppercase tracking-[0.22em] text-slate-100 hidden sm:block">
            Word<span className="text-grad-brand">lyte</span>
          </span>
          <span className="hidden lg:inline-flex text-[9px] font-bold uppercase tracking-[0.18em] px-1.5 py-0.5 rounded-full bg-white/5 border border-white/10 text-slate-400">
            Broadcast
          </span>
        </div>
        {backendError && (
          <button
            onClick={() => { setIsLogOpen(true); setBackendError(null); }}
            className="flex items-center gap-1.5 ml-2 px-2.5 py-1 rounded-full bg-red-950/70 border border-red-500/40 text-red-300 hover:bg-red-900/80 transition-all group shrink-0 shadow-lg shadow-red-950/40"
            title={backendError}
          >
            <AlertTriangle size={12} className="text-red-400 shrink-0 dot-flash" />
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
          className={`relative p-1.5 rounded-lg transition-all active:scale-90 ${outputVisible ? "bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/40 shadow-lg shadow-emerald-500/10" : "text-slate-500 hover:text-emerald-300 hover:bg-white/5"}`}
          title="Toggle Output Window (Ctrl+O)" aria-label="Toggle output window">
          <Monitor size={15} />
          {outputVisible && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 dot-flash" />}
        </button>
        <div className="w-px h-4 bg-white/10 mx-0.5" />
        <button onClick={() => setIsLogOpen(!isLogOpen)}
          className={`relative p-1.5 rounded-lg transition-all ${isLogOpen ? "bg-white/10 text-indigo-300 ring-1 ring-indigo-400/30" : "text-slate-500 hover:text-white hover:bg-white/5"}`} title="System Logs" aria-label="System logs"><Repeat size={15} className="rotate-90" /></button>
        <button onClick={() => setShowShortcuts(true)}
          className={`p-1.5 rounded-lg transition-all ${showShortcuts ? "bg-white/10 text-indigo-300 ring-1 ring-indigo-400/30" : "text-slate-500 hover:text-white hover:bg-white/5"}`} title="Keyboard Shortcuts (?)" aria-label="Keyboard shortcuts"><Keyboard size={15} /></button>
      </div>
    </header>
  );
}