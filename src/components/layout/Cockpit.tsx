import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { CalendarDays, ChevronRight, Clock, EyeOff, Layers, X, Zap, Radio } from "lucide-react";
import { useAppStore } from "../../store";
import { displayItemLabel, getItemUid } from "../../utils";
import { PreviewCard } from "../PreviewCard";
import type { DisplayItem, PresentationSettings } from "../../types";

interface CockpitProps {
  nextLiveItem: DisplayItem | null;
  stageItem: (item: DisplayItem) => Promise<void>;
  goLive: () => Promise<void>;
  sendLive: (item: DisplayItem) => Promise<void>;
  clearAll: () => Promise<void>;
  persistSchedule: () => Promise<void>;
  updateSettings: (s: PresentationSettings) => Promise<void>;
  cockpitWidth: number;
  setCockpitWidth: (v: number) => void;
}

export function Cockpit({
  nextLiveItem,
  stageItem,
  goLive,
  sendLive,
  clearAll,
  persistSchedule,
  updateSettings,
  cockpitWidth,
  setCockpitWidth,
}: CockpitProps) {
  const {
    stagedItem, setStagedItem,
    liveItem, setLiveItem,
    previousItem,
    scheduleEntries, setScheduleEntries,
    settings, setSettings, setIsBlackout,
    setLtVisible,
  } = useAppStore();

  return (
    <>
      {/* Drag handle */}
      <div
        className="w-1 bg-white/[0.04] hover:bg-indigo-400/60 cursor-col-resize transition-colors shrink-0 focus:outline-none focus:bg-indigo-500/80"
        role="slider"
        tabIndex={0}
        aria-label="Cockpit width"
        aria-valuemin={280}
        aria-valuemax={480}
        aria-valuenow={cockpitWidth}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); const n = Math.min(480, cockpitWidth + 16); setCockpitWidth(n); localStorage.setItem("pref_cockpitWidth", String(Math.round(n))); }
          else if (e.key === "ArrowRight") { e.preventDefault(); const n = Math.max(280, cockpitWidth - 16); setCockpitWidth(n); localStorage.setItem("pref_cockpitWidth", String(Math.round(n))); }
        }}
        onMouseDown={(e) => {
          const startX = e.clientX; const startW = cockpitWidth;
          const move = (em: MouseEvent) => {
            const next = Math.max(280, Math.min(480, startW - (em.clientX - startX)));
            setCockpitWidth(next); localStorage.setItem("pref_cockpitWidth", String(Math.round(next)));
          };
          const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
          document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
        }}
      />
      <aside className="bg-slate-900/70 backdrop-blur-xl border-l border-white/[0.06] flex flex-col shrink-0 overflow-hidden" style={{ width: cockpitWidth }}>

        {/* STAGE preview */}
        <div className="p-3 border-b border-white/[0.06] flex flex-col gap-2 shrink-0 surface-card">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400/80 shadow-[0_0_8px_rgba(245,158,11,0.7)]" />
              <span className="text-[9px] font-black uppercase tracking-widest text-amber-400/90">Stage</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setStagedItem(null)}
                className="px-2 py-1 text-[8px] font-bold uppercase text-slate-400 hover:text-red-300 hover:bg-red-500/10 rounded-md transition-all active:scale-90">
                Clear
              </button>
              <button onClick={goLive} disabled={!stagedItem}
                className="group px-3 py-1.5 bg-gradient-to-br from-amber-400 to-amber-600 hover:from-amber-300 hover:to-amber-500 text-black text-[9px] font-black uppercase rounded-md shadow-lg shadow-amber-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-95 flex items-center gap-1">
                <Radio size={10} className={stagedItem ? "dot-flash" : ""} /> GO LIVE
              </button>
            </div>
          </div>
          <div className={`w-full rounded-lg overflow-hidden ring-1 bg-black preview-frame ${stagedItem ? "preview-frame--staged ring-amber-500/20" : "ring-white/[0.06]"} rise-in`} style={{ aspectRatio: "16/9" }}>
            <PreviewCard item={stagedItem} label="" accent="" badge={null} empty="Nothing staged" isLocalPreview={true} hideHeader />
          </div>
          {/* Up Next strip */}
          {nextLiveItem ? (
            <div className="flex items-center gap-2 px-2 py-1.5 bg-black/30 rounded-md border border-white/10 rise-in">
              <span className="text-[7px] text-slate-500 uppercase font-black shrink-0 tracking-wider">Up Next</span>
              <span className="text-[9px] text-slate-300 truncate flex-1">{displayItemLabel(nextLiveItem)}</span>
              <button onClick={() => sendLive(nextLiveItem)}
                className="text-[8px] font-bold bg-white/10 hover:bg-amber-400 hover:text-black text-slate-300 px-2 py-1 rounded transition-all flex items-center gap-0.5 shrink-0 active:scale-90">
                SEND <ChevronRight size={9} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-2 py-1.5 bg-black/20 rounded-md border border-white/5">
              <span className="text-[7px] text-slate-600 uppercase font-bold shrink-0 tracking-wider">Up Next</span>
              <span className="text-[9px] text-slate-600 italic truncate flex-1">Nothing queued</span>
            </div>
          )}
        </div>

        {/* LIVE preview */}
        <div className="p-3 border-b border-white/[0.06] flex flex-col gap-2 shrink-0 surface-card">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-live-400 dot-flash shadow-[0_0_10px_rgba(34,211,238,0.8)]" />
              <span className="text-[9px] font-black uppercase tracking-widest text-live-400">On Air</span>
            </div>
            <div className="flex items-center gap-1.5">
              {previousItem && (
                <button onClick={() => sendLive(previousItem)}
                  className="px-2 py-1 text-[8px] font-bold uppercase rounded-md bg-white/5 border border-white/10 text-slate-300 hover:text-white flex items-center gap-1 transition-all active:scale-90"
                  title={`Return to: ${displayItemLabel(previousItem)}`}>
                  <Clock size={9} /> Prev
                </button>
              )}
              <button onClick={() => { invoke("clear_live").catch((e: any) => useAppStore.getState().setBackendError(`Clear failed: ${e?.message ?? e}`)); setLiveItem(null); }}
                className="px-2 py-0.5 bg-red-500/15 hover:bg-red-600 text-red-300 text-[8px] font-bold uppercase rounded-md border border-red-500/30 transition-all active:scale-90">
                Clear
              </button>
            </div>
          </div>
          <div className={`relative w-full rounded-lg overflow-hidden ring-1 bg-black preview-frame ${liveItem ? "preview-frame--live ring-live-500/30 shadow-glow-live" : "ring-white/[0.06]"} rise-in`} style={{ aspectRatio: "16/9" }}>
            <PreviewCard item={liveItem} label="" accent="" badge={null} empty="Output is idle" isLocalPreview={false} hideHeader />
            {liveItem && (
              <span className="absolute top-2 right-2 z-20 px-1.5 py-0.5 rounded-md bg-live-500/20 ring-1 ring-live-500/40 text-live-400 text-[7px] font-black uppercase tracking-widest backdrop-blur-sm">
                <Radio size={8} className="inline -mt-0.5 dot-flash" /> LIVE
              </span>
            )}
          </div>
        </div>

        {/* Quick Actions */}
        <div className="px-3 py-2.5 border-b border-white/[0.06] grid grid-cols-3 gap-1.5 shrink-0">
          <button onClick={() => { const nb = !settings.is_blanked; updateSettings({ ...settings, is_blanked: nb }); setIsBlackout(nb); }}
            className={`py-2 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-all active:scale-95 flex items-center justify-center gap-1 ${settings.is_blanked ? "bg-red-500 text-white shadow-lg shadow-red-500/30" : "bg-white/[0.04] text-slate-400 hover:text-slate-200 hover:bg-white/[0.08] border border-white/[0.06]"}`}>
            <EyeOff size={11} />{settings.is_blanked ? "Unblank" : "Blank"}
          </button>
          <button onClick={() => { const nl = !settings.show_background_logo; updateSettings({ ...settings, show_background_logo: nl }); }}
            className={`py-2 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-all active:scale-95 flex items-center justify-center gap-1 ${settings.show_background_logo ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/30" : "bg-white/[0.04] text-slate-400 hover:text-slate-200 hover:bg-white/[0.08] border border-white/[0.06]"}`}>
            <Layers size={11} />Logo
          </button>
          <button onClick={clearAll}
            className="py-2 rounded-lg text-[9px] font-bold uppercase tracking-wider bg-white/[0.04] text-slate-400 hover:text-red-300 hover:bg-red-500/10 border border-white/[0.06] transition-all active:scale-95 flex items-center justify-center gap-1">
            <X size={11} />Reset
          </button>
        </div>

        {/* Service Setlist */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between shrink-0">
            <h2 className="text-[9px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
              <CalendarDays size={12} className="text-indigo-400" /> Setlist
            </h2>
            <button onClick={persistSchedule} className="text-[8px] font-bold bg-white/[0.06] hover:bg-indigo-500 text-slate-300 px-2 py-1 rounded-md transition-colors active:scale-95">Save</button>
          </div>
          <div className="flex-1 overflow-y-auto py-1 px-2 space-y-0.5 custom-scrollbar">
            {scheduleEntries.map((e, i) => (
              <div key={e.id} onClick={() => stageItem(e.item)}
                className={`group px-2 py-2 rounded-lg border cursor-pointer transition-all duration-150 active:scale-[0.99] ${
                  stagedItem && getItemUid(stagedItem) === getItemUid(e.item) ? "bg-amber-500/10 border-amber-500/30 shadow-amber-500/10"
                  : liveItem && getItemUid(liveItem) === getItemUid(e.item) ? "bg-live-500/10 border-live-500/30"
                  : "bg-white/[0.03] border-white/[0.06] hover:border-white/[0.14]"
                }`}>
                <div className="flex items-center gap-2">
                  <span className={`text-[8px] font-bold w-3.5 text-right shrink-0 ${stagedItem && getItemUid(stagedItem) === getItemUid(e.item) ? "text-amber-400" : liveItem && getItemUid(liveItem) === getItemUid(e.item) ? "text-live-500" : "text-slate-600"}`}>{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-semibold text-slate-200 truncate">{displayItemLabel(e.item)}</p>
                    <p className="text-[7px] text-slate-500 uppercase font-bold">{e.item.type}</p>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button onClick={(em) => { em.stopPropagation(); sendLive(e.item); }} className="bg-amber-400 hover:bg-amber-500 text-black p-1 rounded-md shadow-lg shadow-amber-500/20 active:scale-90"><Zap size={9} fill="currentColor" /></button>
                    <button onClick={(em) => { em.stopPropagation(); setScheduleEntries(scheduleEntries.filter(se => se.id !== e.id)); }} className="bg-red-500/15 hover:bg-red-600 text-red-200 p-1 rounded-md active:scale-90"><X size={9} /></button>
                  </div>
                </div>
              </div>
            ))}
            {scheduleEntries.length === 0 && (
              <p className="text-center text-slate-600 text-[10px] italic py-6">No items in setlist</p>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}