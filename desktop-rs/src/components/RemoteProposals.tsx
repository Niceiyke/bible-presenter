import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Check, Zap, Clock } from "lucide-react";
import { useAppStore } from "../store";
import { displayItemLabel } from "../utils";
import type { RemoteProposal } from "../types";

export function RemoteProposals() {
  const { remoteProposals, setStagedItem, setLiveItem, setPreviousItem, liveItem } = useAppStore();

  if (remoteProposals.length === 0) return null;

  const handleDismiss = async (key: string) => {
    try {
      await invoke("dismiss_remote_proposal", { operatorKey: key });
    } catch (err) {
      console.error("Failed to dismiss proposal:", err);
    }
  };

  const handleAccept = async (proposal: RemoteProposal, mode: "stage" | "live") => {
    if (mode === "stage") {
      await invoke("stage_item", { item: proposal.item });
      // Note: stage_item in backend emits "item-staged" which we listen to in useAppInitialization
    } else {
      if (liveItem) setPreviousItem(liveItem);
      await invoke("go_live", { item: proposal.item });
      // Note: go_live in backend broadcasts state update
    }
    
    // Auto-dismiss after accepting
    handleDismiss(proposal.operator_key);
  };

  return (
    <div className="flex flex-col gap-2 p-3 bg-amber-500/5 border-b border-amber-500/20">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-[10px] font-black uppercase tracking-widest text-amber-500 flex items-center gap-1.5">
          <Clock size={12} /> Remote Proposals
        </h3>
        <span className="text-[10px] bg-amber-500 text-black px-1.5 py-0.5 rounded-full font-bold">
          {remoteProposals.length}
        </span>
      </div>
      <div className="flex flex-col gap-2 max-h-[300px] overflow-y-auto custom-scrollbar pr-1">
        {remoteProposals.map((p) => (
          <div key={p.operator_key} className="bg-slate-900 border border-slate-800 rounded-lg p-2.5 flex flex-col gap-2 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-black text-slate-500 uppercase truncate pr-2 flex-1">From {p.operator_name}</span>
              <span className="text-[8px] text-slate-600 font-mono shrink-0">
                {new Date(p.staged_at_ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <p className="text-xs font-bold text-slate-200 line-clamp-2">{displayItemLabel(p.item)}</p>
            <div className="flex gap-1.5 mt-1">
              <button 
                onClick={() => handleAccept(p, "stage")}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold py-1.5 rounded flex items-center justify-center gap-1 transition-all"
              >
                <Check size={12} /> STAGE
              </button>
              <button 
                onClick={() => handleAccept(p, "live")}
                className="flex-1 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-black py-1.5 rounded flex items-center justify-center gap-1 transition-all"
              >
                <Zap size={12} fill="currentColor" /> LIVE
              </button>
              <button 
                onClick={() => handleDismiss(p.operator_key)}
                className="bg-slate-800 hover:bg-red-900/40 text-slate-500 hover:text-red-400 p-1.5 rounded transition-all"
                title="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
