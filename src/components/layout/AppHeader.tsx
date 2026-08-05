import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Monitor, Layout, Repeat, Keyboard } from "lucide-react";
import { useAppStore } from "../../store";

export function AppHeader() {
  const {
    isLogOpen, setIsLogOpen,
    showShortcuts, setShowShortcuts,
    outputVisible, setOutputVisible,
  } = useAppStore();

  return (
    <header className="h-11 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-3 shrink-0 z-30">
      <div className="flex items-center gap-2.5">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-amber-500 rounded-md flex items-center justify-center text-black font-black text-xs shadow-lg shadow-amber-500/20 shrink-0">WL</div>
          <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-100 hidden sm:block">Wordlyte</span>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <button onClick={() => { invoke("toggle_output_window").catch(() => {}); setOutputVisible((v: boolean) => !v); }}
          className={`p-1.5 rounded-md transition-all ${outputVisible ? "bg-green-500/20 text-green-400" : "text-slate-500 hover:text-green-400 hover:bg-slate-800"}`}
          title="Toggle Output Window (Ctrl+O)"><Monitor size={15} /></button>
        <button onClick={() => invoke("toggle_design_window").catch(() => {})}
          className="p-1.5 text-slate-500 hover:text-purple-400 hover:bg-slate-800 rounded-md transition-all" title="Design Hub"><Layout size={15} /></button>
        <div className="w-px h-4 bg-slate-800 mx-0.5" />
        <button onClick={() => setIsLogOpen(!isLogOpen)}
          className={`p-1.5 rounded-md transition-all ${isLogOpen ? "bg-slate-800 text-amber-500" : "text-slate-500 hover:text-white hover:bg-slate-800"}`} title="System Logs"><Repeat size={15} className="rotate-90" /></button>
        <button onClick={() => setShowShortcuts(true)}
          className={`p-1.5 rounded-md transition-all ${showShortcuts ? "bg-slate-800 text-amber-500" : "text-slate-500 hover:text-white hover:bg-slate-800"}`} title="Keyboard Shortcuts (?)"><Keyboard size={15} /></button>
      </div>
    </header>
  );
}
