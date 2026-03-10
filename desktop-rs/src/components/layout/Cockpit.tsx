import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { CalendarDays, ChevronRight, Clock, EyeOff, Layers, X, Zap } from "lucide-react";
import { useAppStore } from "../../store";
import { displayItemLabel, getItemUid } from "../../utils";
import { PreviewCard } from "../PreviewCard";
import type { DisplayItem, PresentationSettings } from "../../types";

interface CockpitProps {
  nextLiveItem: DisplayItem | null;
  stageItem: (item: DisplayItem) => Promise<void>;
  goLive: () => Promise<void>;
  sendLive: (item: DisplayItem) => Promise<void>;
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
      <div className="w-1 bg-slate-800 hover:bg-amber-500/40 cursor-col-resize transition-colors shrink-0"
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
      <aside className="bg-slate-900 border-l border-slate-800 flex flex-col shrink-0 overflow-hidden" style={{ width: cockpitWidth }}>

        {/* STAGE preview */}
        <div className="p-3 border-b border-slate-800 flex flex-col gap-2 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500/50" />
              <span className="text-[9px] font-black uppercase tracking-widest text-amber-500/70">Stage</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setStagedItem(null)}
                className="px-2 py-0.5 text-[8px] font-black uppercase text-slate-600 hover:text-red-400 hover:bg-red-500/10 rounded transition-all">
                CLEAR
              </button>
              <button onClick={goLive} disabled={!stagedItem}
                className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-black text-[9px] font-black uppercase rounded-md shadow-lg shadow-amber-500/20 disabled:opacity-30 transition-all">
                GO LIVE ↑
              </button>
            </div>
          </div>
          <div className="w-full rounded-lg overflow-hidden ring-1 ring-amber-500/20 bg-black" style={{ aspectRatio: "16/9" }}>
            <PreviewCard item={stagedItem} label="" accent="" badge={null} empty="Stage is empty" isLocalPreview={true} hideHeader />
          </div>
          {/* Up Next strip */}
          {nextLiveItem && (
            <div className="flex items-center gap-2 px-2 py-1 bg-slate-950/60 rounded-md border border-slate-800">
              <span className="text-[7px] text-slate-600 uppercase font-black shrink-0">Up Next</span>
              <span className="text-[9px] text-slate-400 truncate flex-1">{displayItemLabel(nextLiveItem)}</span>
              <button onClick={() => sendLive(nextLiveItem)}
                className="text-[8px] font-black bg-slate-800 hover:bg-amber-500 hover:text-black text-slate-400 px-1.5 py-0.5 rounded transition-all flex items-center gap-0.5 shrink-0">
                SEND <ChevronRight size={9} />
              </button>
            </div>
          )}
        </div>

        {/* LIVE preview */}
        <div className="p-3 border-b border-slate-800 flex flex-col gap-2 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-[9px] font-black uppercase tracking-widest text-red-500">On Air</span>
            </div>
            <div className="flex items-center gap-1.5">
              {previousItem && (
                <button onClick={() => sendLive(previousItem)}
                  className="px-2 py-0.5 text-[8px] font-black uppercase rounded bg-slate-800 hover:bg-slate-700 text-slate-400 flex items-center gap-1"
                  title={`Return to: ${displayItemLabel(previousItem)}`}>
                  <Clock size={9} /> Prev
                </button>
              )}
              <button onClick={() => invoke("clear_live")}
                className="px-2 py-0.5 bg-red-900/40 hover:bg-red-600 text-red-300 text-[8px] font-black uppercase rounded border border-red-900/50 transition-all">
                CLEAR
              </button>
            </div>
          </div>
          <div className="w-full rounded-lg overflow-hidden ring-2 ring-red-500/25 bg-black" style={{ aspectRatio: "16/9" }}>
            <PreviewCard item={liveItem} label="" accent="" badge={null} empty="Output is empty" hideHeader />
          </div>
        </div>

        {/* Quick Actions */}
        <div className="px-3 py-2 border-b border-slate-800 grid grid-cols-3 gap-1.5 shrink-0">
          <button onClick={() => { const nb = !settings.is_blanked; setSettings({ ...settings, is_blanked: nb }); setIsBlackout(nb); invoke("save_settings", { settings: { ...settings, is_blanked: nb } }); }}
            className={`py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1 ${settings.is_blanked ? "bg-red-600 text-white" : "bg-slate-800 text-slate-500 hover:text-slate-300"}`}>
            <EyeOff size={11} />{settings.is_blanked ? "UNBLK" : "BLKOUT"}
          </button>
          <button onClick={() => { const nl = !settings.show_background_logo; updateSettings({ ...settings, show_background_logo: nl }); }}
            className={`py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider transition-all flex items-center justify-center gap-1 ${settings.show_background_logo ? "bg-purple-600 text-white" : "bg-slate-800 text-slate-500 hover:text-slate-300"}`}>
            <Layers size={11} />BG LOGO
          </button>
          <button onClick={() => { invoke("clear_live").catch(console.error); invoke("hide_lower_third").catch(console.error); setLiveItem(null); setLtVisible(false); }}
            className="py-1.5 rounded-md text-[9px] font-black uppercase tracking-wider bg-slate-800 text-slate-500 hover:text-red-400 hover:bg-red-900/20 transition-all flex items-center justify-center gap-1">
            <X size={11} />CLEAR ALL
          </button>
        </div>

        {/* Service Setlist */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between shrink-0">
            <h2 className="text-[9px] font-black uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
              <CalendarDays size={12} className="text-amber-500" /> Setlist
            </h2>
            <button onClick={persistSchedule} className="text-[8px] font-black bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded transition-colors">SAVE</button>
          </div>
          <div className="flex-1 overflow-y-auto py-1 px-2 space-y-0.5 custom-scrollbar">
            {scheduleEntries.map((e, i) => (
              <div key={e.id} onClick={() => stageItem(e.item)}
                className={`group px-2 py-2 rounded-lg border cursor-pointer transition-all ${
                  stagedItem && getItemUid(stagedItem) === getItemUid(e.item) ? "bg-amber-500/10 border-amber-500/30"
                  : liveItem && getItemUid(liveItem) === getItemUid(e.item) ? "bg-red-900/15 border-red-900/30"
                  : "bg-slate-950/60 border-slate-800/60 hover:border-slate-700"
                }`}>
                <div className="flex items-center gap-2">
                  <span className="text-[8px] font-black text-slate-700 w-3.5 text-right shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-bold text-slate-200 truncate">{displayItemLabel(e.item)}</p>
                    <p className="text-[7px] text-slate-600 uppercase font-black">{e.item.type}</p>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button onClick={(em) => { em.stopPropagation(); sendLive(e.item); }} className="bg-amber-500 hover:bg-amber-400 text-black p-1 rounded"><Zap size={9} fill="currentColor" /></button>
                    <button onClick={(em) => { em.stopPropagation(); setScheduleEntries(scheduleEntries.filter(se => se.id !== e.id)); }} className="bg-red-900/40 hover:bg-red-600 text-red-200 p-1 rounded"><X size={9} /></button>
                  </div>
                </div>
              </div>
            ))}
            {scheduleEntries.length === 0 && (
              <p className="text-center text-slate-700 text-[10px] italic py-6">No items in setlist</p>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
