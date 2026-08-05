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
    <section className="bg-slate-900 border-t border-slate-800 flex flex-col shrink-0 z-40 relative" style={{ height: bottomDeckH }}>
      <div className="h-1 bg-slate-800 hover:bg-amber-500/40 cursor-row-resize transition-colors absolute top-0 left-0 right-0 z-10"
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
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-800/30 shrink-0">
        <div className="flex gap-0.5 rounded-md overflow-hidden border border-slate-700 bg-black/20 p-0.5">
          {([
            { id: "live-lt",    label: "Lower Third" },
            { id: "timer",      label: "Timers" },
          ] as const).map(({ id, label: lbl }) => (
            <button key={id} onClick={() => setBottomDeckMode(id)}
              className={`px-3 py-1 text-[9px] font-black uppercase tracking-widest rounded transition-all ${bottomDeckMode === id ? "bg-amber-500 text-black shadow" : "text-slate-500 hover:text-slate-300"}`}>
              {lbl}
            </button>
          ))}
        </div>
        <button onClick={() => setBottomDeckOpen(false)} className="text-slate-500 hover:text-white p-1"><X size={16} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        {bottomDeckMode === "live-lt" && <LowerThirdTab onSetToast={useAppStore.getState().setToast} onLoadMedia={handleFileUpload} />}
        {bottomDeckMode === "timer" && <TimersTab onStage={stageItem} onLive={sendLive} />}
      </div>
    </section>
  );
}
