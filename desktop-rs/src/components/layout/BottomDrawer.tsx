import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import { X, Image as ImageIcon } from "lucide-react";
import { useAppStore } from "../../store";
import { displayItemLabel } from "../../utils";
import { TranscriptLog } from "../TranscriptLog";
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
  isPttActive: boolean;
  handlePttDown: () => void;
  handlePttUp: () => void;
  handleToggleOperatorMute: () => void;
  handleTogglePreacherMute: () => void;
}

export function BottomDrawer({
  bottomDeckH,
  setBottomDeckH,
  stageItem,
  sendLive,
  handleFileUpload,
  updateSettings,
  isPttActive,
  handlePttDown,
  handlePttUp,
  handleToggleOperatorMute,
  handleTogglePreacherMute,
}: BottomDrawerProps) {
  const {
    bottomDeckOpen, setBottomDeckOpen,
    bottomDeckMode, setBottomDeckMode,
    sessionTranscript, suggestedItem, setSuggestedItem, suggestedConfidence,
    operatorMicLevel, preacherMicLevel,
    operatorMuted, preacherMuted,
    operatorRecordingActive, setOperatorRecordingActive,
    preacherRecordingActive, setPreacherRecordingActive,
    sessionState,
    settings,
    setAudioError,
    ltTemplate,
  } = useAppStore();

  if (!bottomDeckOpen) {
    return (
      <>
        {/* AI suggestion banner — floats above bottom drawer when transcript is not open */}
        <AnimatePresence>
          {suggestedItem && bottomDeckMode !== "transcript" && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
              className="border-t border-slate-800 bg-slate-900/95 backdrop-blur-sm px-4 py-2.5 flex items-center justify-between shrink-0 z-30">
              <div className="flex-1 min-w-0 flex items-center gap-3">
                <span className="text-[9px] text-slate-500 uppercase font-black shrink-0">AI Detected</span>
                <span className="text-blue-400 text-[9px] font-black shrink-0">{Math.round(suggestedConfidence * 100)}%</span>
                <p className="text-slate-200 text-xs truncate font-medium">{displayItemLabel(suggestedItem)}</p>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button onClick={() => { stageItem(suggestedItem); setSuggestedItem(null); }} className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-white text-[9px] font-bold rounded-lg">STAGE</button>
                <button onClick={() => { sendLive(suggestedItem); setSuggestedItem(null); }} className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-black text-[9px] font-black rounded-lg">DISPLAY</button>
                <button onClick={() => setSuggestedItem(null)} className="p-1 text-slate-600 hover:text-white"><X size={13} /></button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }

  return (
    <>
      {/* AI suggestion banner — floats above bottom drawer when transcript is not open */}
      <AnimatePresence>
        {suggestedItem && bottomDeckMode !== "transcript" && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            className="border-t border-slate-800 bg-slate-900/95 backdrop-blur-sm px-4 py-2.5 flex items-center justify-between shrink-0 z-30">
            <div className="flex-1 min-w-0 flex items-center gap-3">
              <span className="text-[9px] text-slate-500 uppercase font-black shrink-0">AI Detected</span>
              <span className="text-blue-400 text-[9px] font-black shrink-0">{Math.round(suggestedConfidence * 100)}%</span>
              <p className="text-slate-200 text-xs truncate font-medium">{displayItemLabel(suggestedItem)}</p>
            </div>
            <div className="flex gap-1.5 shrink-0">
              <button onClick={() => { stageItem(suggestedItem); setSuggestedItem(null); }} className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-white text-[9px] font-bold rounded-lg">STAGE</button>
              <button onClick={() => { sendLive(suggestedItem); setSuggestedItem(null); }} className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-black text-[9px] font-black rounded-lg">DISPLAY</button>
              <button onClick={() => setSuggestedItem(null)} className="p-1 text-slate-600 hover:text-white"><X size={13} /></button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <section className="bg-slate-900 border-t border-slate-800 flex flex-col shrink-0 z-40 relative" style={{ height: bottomDeckH }}>
        {/* Resize handle */}
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
        {/* Drawer tab bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-800/30 shrink-0">
          <div className="flex gap-0.5 rounded-md overflow-hidden border border-slate-700 bg-black/20 p-0.5">
            {([
              { id: "transcript", label: "AI Transcript" },
              { id: "live-lt",    label: "Lower Third" },
              { id: "timer",      label: "Timers" },
              { id: "audio",      label: "Audio" },
            ] as const).map(({ id, label: lbl }) => (
              <button key={id} onClick={() => setBottomDeckMode(id)}
                className={`px-3 py-1 text-[9px] font-black uppercase tracking-widest rounded transition-all ${bottomDeckMode === id ? "bg-amber-500 text-black shadow" : "text-slate-500 hover:text-slate-300"}`}>
                {lbl}
              </button>
            ))}
          </div>
          <button onClick={() => setBottomDeckOpen(false)} className="text-slate-500 hover:text-white p-1"><X size={16} /></button>
        </div>

        {/* Drawer content */}
        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
          {bottomDeckMode === "transcript" && (
            <div className="h-full flex flex-col">
              <TranscriptLog segments={sessionTranscript} />
              <AnimatePresence>
                {suggestedItem && (
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
                    className="mt-3 bg-slate-800 border border-slate-700 rounded-xl p-3 flex items-center justify-between shrink-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-[9px] text-slate-500 uppercase font-black mb-1">AI Detected <span className="ml-2 text-blue-400">{Math.round(suggestedConfidence * 100)}% Match</span></p>
                      <p className="text-slate-200 text-sm truncate font-medium">{displayItemLabel(suggestedItem)}</p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => { stageItem(suggestedItem); setSuggestedItem(null); }} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold rounded-lg">STAGE</button>
                      <button onClick={() => { sendLive(suggestedItem); setSuggestedItem(null); }} className="px-4 py-1.5 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-black rounded-lg">DISPLAY</button>
                      <button onClick={() => setSuggestedItem(null)} className="p-1.5 text-slate-600 hover:text-white"><X size={14} /></button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
          {bottomDeckMode === "live-lt" && <LowerThirdTab onSetToast={useAppStore.getState().setToast} onLoadMedia={handleFileUpload} />}
          {bottomDeckMode === "timer" && <TimersTab onStage={stageItem} onLive={sendLive} />}
          {bottomDeckMode === "audio" && (
            <div className="flex items-start gap-10 h-full">
              {/* Operator track */}
              <div className="flex flex-col gap-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-amber-500">Operator</p>
                <div className="flex items-center gap-2">
                  <button onClick={handleToggleOperatorMute}
                    className={`px-2 py-0.5 text-[9px] font-black uppercase rounded transition-all ${operatorMuted ? "bg-red-600/30 text-red-400" : "bg-slate-800 text-amber-400 hover:bg-slate-700"}`}>
                    {operatorMuted ? "Muted" : "Live"}
                  </button>
                  <div className={`w-32 h-2 rounded-full overflow-hidden ${operatorMuted ? "bg-red-900/40" : "bg-slate-800"}`}>
                    <motion.div className={`h-full ${operatorMuted ? "bg-red-700/50" : "bg-amber-500"}`}
                      animate={{ width: operatorMuted ? "100%" : `${operatorMicLevel * 100}%` }}
                      transition={{ type: "spring", bounce: 0, duration: 0.1 }} />
                  </div>
                </div>
                {sessionState === "running" && (
                  <div className="flex items-center gap-2">
                    {operatorRecordingActive && (
                      <button onMouseDown={handlePttDown} onMouseUp={handlePttUp} onMouseLeave={handlePttUp}
                        className={`px-3 py-1.5 rounded text-[10px] font-black uppercase transition-all ${isPttActive ? "bg-amber-500 text-black scale-95" : "bg-slate-800 text-slate-400 hover:bg-slate-700"}`}
                        title="Push-to-Talk (hold Space)">PTT</button>
                    )}
                    <button onClick={async () => {
                      if (operatorRecordingActive) { await invoke("stop_operator_recording").catch((e: any) => setAudioError(String(e))); setOperatorRecordingActive(false); }
                      else { await invoke("start_operator_recording").catch((e: any) => setAudioError(String(e))); }
                    }} className={`px-3 py-1.5 text-[9px] font-black uppercase rounded transition-all ${operatorRecordingActive ? "bg-amber-600/30 text-amber-400 animate-pulse" : "bg-slate-800 text-slate-400 hover:text-amber-300"}`}>
                      {operatorRecordingActive ? "■ Stop" : "REC"}
                    </button>
                  </div>
                )}
              </div>

              {/* Preacher track */}
              <div className="flex flex-col gap-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-blue-400">Preacher / Pastor</p>
                <div className="flex items-center gap-2">
                  <button onClick={handleTogglePreacherMute}
                    className={`px-2 py-0.5 text-[9px] font-black uppercase rounded transition-all ${preacherMuted ? "bg-red-600/30 text-red-400" : "bg-slate-800 text-blue-400 hover:bg-slate-700"}`}>
                    {preacherMuted ? "Muted" : "Live"}
                  </button>
                  <div className={`w-32 h-2 rounded-full overflow-hidden ${preacherMuted ? "bg-red-900/40" : "bg-slate-800"}`}>
                    <motion.div className={`h-full ${preacherMuted ? "bg-red-700/50" : "bg-blue-400"}`}
                      animate={{ width: preacherMuted ? "100%" : `${preacherMicLevel * 100}%` }}
                      transition={{ type: "spring", bounce: 0, duration: 0.1 }} />
                  </div>
                </div>
                {sessionState === "running" && (
                  <button onClick={async () => {
                    if (preacherRecordingActive) { await invoke("stop_preacher_recording").catch((e: any) => setAudioError(String(e))); setPreacherRecordingActive(false); }
                    else { await invoke("start_preacher_recording").catch((e: any) => setAudioError(String(e))); }
                  }} className={`px-3 py-1.5 text-[9px] font-black uppercase rounded transition-all w-fit ${preacherRecordingActive ? "bg-red-600/30 text-red-400 animate-pulse" : "bg-slate-800 text-slate-400 hover:text-blue-300"}`}>
                    {preacherRecordingActive ? "■ Stop" : "REC"}
                  </button>
                )}
              </div>

              {/* BG → LOGO utility */}
              <div className="flex flex-col gap-3 ml-auto">
                <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Utility</p>
                <button
                  onClick={() => { const bg = settings.background; if (bg.type === "Image" && bg.value) updateSettings({ ...settings, logo_path: bg.value }); }}
                  disabled={settings.background.type !== "Image" || !(settings.background as { type: "Image"; value: string }).value}
                  className={`px-3 py-1.5 rounded text-[9px] font-black uppercase transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
                    settings.background.type === "Image" && (settings.background as { type: "Image"; value: string }).value && settings.logo_path === (settings.background as { type: "Image"; value: string }).value
                      ? "bg-teal-600/30 border border-teal-600/40 text-teal-400"
                      : "bg-slate-800 text-slate-500 hover:text-teal-400"
                  }`}>
                  <ImageIcon size={11} className="inline mr-1" /> BG→LOGO
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
