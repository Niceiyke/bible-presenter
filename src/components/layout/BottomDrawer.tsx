import React from "react";
import { X } from "lucide-react";
import { useAppStore } from "../../store";
import { LowerThirdTab } from "../LowerThirdTab";
import { TimersTab } from "../TimersTab";
import type { DisplayItem, PresentationSettings } from "../../types";

interface BottomDrawerProps {
  bottomDeckH: number;
  setBottomDeckH: (v: number) => void;
  stageItem: (item: DisplayItem) => Promise<void>;
  sendLive: (item: DisplayItem) => Promise<void>;
  handleFileUpload: () => Promise<void>;
  updateSettings: (s: PresentationSettings) => Promise<void>;
}

export function BottomDrawer({
  bottomDeckH,
  setBottomDeckH,
  stageItem,
  sendLive,
  handleFileUpload,
  updateSettings,
}: BottomDrawerProps) {
  const {
    bottomDeckOpen, setBottomDeckOpen,
    bottomDeckMode, setBottomDeckMode,
    ltTemplate,
  } = useAppStore();

  if (!bottomDeckOpen) return null;

  return (
    <section className="bg-slate-900/80 backdrop-blur-xl border-t border-white/[0.06] flex flex-col shrink-0 z-40 relative" style={{ height: bottomDeckH }}>
      <div className="h-1 bg-white/[0.04] hover:bg-indigo-400/60 cursor-row-resize transition-colors absolute top-0 left-0 right-0 z-10"
        onMouseDown={(e) => {
          const startY = e.clientY; const startH = bottomDeckH;
          const move = (em: MouseEvent) => {
            const next = Math.max(180, Math.min(window.innerHeight * 0.55, startH - (em.clientY - startY)));
            setBottomDeckH(next); localStorage.setItem("pref_bottomDeckH", String(Math.round(next)));
          };
          const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
          document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
        }}
      />
      <div className="flex items-center gap-3 justify-between px-4 py-2 border-b border-white/[0.06] bg-white/[0.02] shrink-0">
        <div className="flex gap-0.5 rounded-lg overflow-hidden border border-white/[0.08] bg-black/30 p-0.5">
          {([
            { id: "live-lt",    label: "Lower Third" },
            { id: "timer",      label: "Timers" },
          ] as const).map(({ id, label: lbl }) => (
            <button key={id} onClick={() => setBottomDeckMode(id)}
              className={`px-3 py-1 text-[9px] font-bold uppercase tracking-widest rounded-md transition-all active:scale-95 ${bottomDeckMode === id ? "bg-gradient-to-br from-amber-400 to-amber-600 text-black shadow-lg shadow-amber-500/20" : "text-slate-400 hover:text-slate-200"}`}>
              {lbl}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[8px] font-bold uppercase tracking-widest text-slate-500">
          <span className="hidden md:inline">Tools</span>
          <button onClick={() => setBottomDeckOpen(false)} className="text-slate-500 hover:text-white p-1 rounded-md hover:bg-white/5 transition-all active:scale-90"><X size={14} /></button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        {bottomDeckMode === "live-lt" && <LowerThirdTab onSetToast={useAppStore.getState().setToast} onLoadMedia={handleFileUpload} />}
        {bottomDeckMode === "timer" && <TimersTab onStage={stageItem} onLive={sendLive} />}
      </div>
    </section>
  );
}
