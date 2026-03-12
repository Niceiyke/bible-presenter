import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import { Mic, Monitor, Layout, Repeat, Keyboard } from "lucide-react";
import { useAppStore } from "../../store";

interface AppHeaderProps {
  sessionSecs: number;
  fmtTime: (s: number) => string;
  handleToggleOperatorMute: () => void;
  handleTogglePreacherMute: () => void;
  isPttActive: boolean;
  handlePttDown: () => void;
  handlePttUp: () => void;
}

export function AppHeader({
  sessionSecs,
  fmtTime,
  handleToggleOperatorMute,
  handleTogglePreacherMute,
  isPttActive,
  handlePttDown,
  handlePttUp,
}: AppHeaderProps) {
  const {
    sessionState, setSessionState, setAudioError,
    operatorMicLevel, preacherMicLevel,
    operatorMuted, preacherMuted,
    settings,
    isLogOpen, setIsLogOpen,
    showShortcuts, setShowShortcuts,
    outputVisible, setOutputVisible,
  } = useAppStore();

  return (
    <header className="h-11 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-3 shrink-0 z-30">
      <div className="flex items-center gap-2.5">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-amber-500 rounded-md flex items-center justify-center text-black font-black text-xs shadow-lg shadow-amber-500/20 shrink-0">WL</div>
          <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-100 hidden sm:block">Wordlyte</span>
        </div>

        <div className="h-4 w-px bg-slate-800 mx-1" />

        {/* Session START / STOP */}
        <button
          onClick={async () => {
            if (sessionState === "idle") {
              setSessionState("loading");
              await invoke("start_session").catch((e: any) => {
                setAudioError(typeof e === "string" ? e : "Failed to start session");
                setSessionState("idle");
              });
            } else if (sessionState === "running") {
              setSessionState("stopping");
              await invoke("stop_session").catch(() => { setSessionState("idle"); });
            }
          }}
          disabled={sessionState === "loading" || sessionState === "stopping"}
          className={`px-3 py-1 rounded-md transition-all flex items-center gap-1.5 font-black text-[10px] uppercase tracking-wider ${
            sessionState === "running"
              ? "bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/30"
              : sessionState === "loading" ? "bg-amber-600/40 text-amber-300 cursor-wait"
              : sessionState === "stopping" ? "bg-slate-700 text-slate-400 cursor-wait"
              : "bg-green-700/30 hover:bg-green-600/40 text-green-400 border border-green-700/40"
          }`}
        >
          <Mic size={12} className={sessionState === "running" ? "animate-pulse" : ""} />
          {sessionState === "running"
            ? <><span>Live</span><span className="font-mono font-normal text-red-200/80">{fmtTime(sessionSecs)}</span></>
            : <span>{sessionState === "loading" ? "Starting…" : sessionState === "stopping" ? "Stopping…" : "AI Start"}</span>
          }
        </button>

        {/* Inline VU meters — visible while session runs */}
        {sessionState === "running" && (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <button onClick={handleToggleOperatorMute} title={operatorMuted ? "Unmute operator" : "Mute operator"}
                className={`text-[7px] font-black uppercase w-4 text-center rounded transition-all ${operatorMuted ? "text-red-400" : "text-amber-500 hover:text-amber-300"}`}>
                {operatorMuted ? "✕" : "Op"}
              </button>
              <div className={`w-16 h-1 rounded-full overflow-hidden ${operatorMuted ? "bg-red-900/40" : "bg-slate-800"}`}>
                <motion.div className={`h-full ${operatorMuted ? "bg-red-700/50" : "bg-amber-500"}`}
                  animate={{ width: operatorMuted ? "100%" : `${operatorMicLevel * 100}%` }}
                  transition={{ type: "spring", bounce: 0, duration: 0.1 }} />
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={handleTogglePreacherMute} title={preacherMuted ? "Unmute preacher" : "Mute preacher"}
                className={`text-[7px] font-black uppercase w-4 text-center rounded transition-all ${preacherMuted ? "text-red-400" : "text-blue-400 hover:text-blue-300"}`}>
                {preacherMuted ? "✕" : "Pr"}
              </button>
              <div className={`w-16 h-1 rounded-full overflow-hidden ${preacherMuted ? "bg-red-900/40" : "bg-slate-800"}`}>
                <motion.div className={`h-full ${preacherMuted ? "bg-red-700/50" : "bg-blue-400"}`}
                  animate={{ width: preacherMuted ? "100%" : `${preacherMicLevel * 100}%` }}
                  transition={{ type: "spring", bounce: 0, duration: 0.1 }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Right system controls */}
      <div className="flex items-center gap-1.5">
        <button onClick={() => { invoke("toggle_output_window"); setOutputVisible((v: boolean) => !v); }}
          className={`p-1.5 rounded-md transition-all ${outputVisible ? "bg-green-500/20 text-green-400" : "text-slate-500 hover:text-green-400 hover:bg-slate-800"}`}
          title="Toggle Output Window (Ctrl+O)"><Monitor size={15} /></button>
        <button onClick={() => invoke("toggle_design_window")}
          className="p-1.5 text-slate-500 hover:text-purple-400 hover:bg-slate-800 rounded-md transition-all" title="Design Hub"><Layout size={15} /></button>
        <button onClick={() => invoke("toggle_studio_window")}
          className="p-1.5 text-slate-500 hover:text-indigo-400 hover:bg-slate-800 rounded-md transition-all" title="Audio Studio"><Mic size={15} /></button>
        <div className="w-px h-4 bg-slate-800 mx-0.5" />
        <button onClick={() => setIsLogOpen(!isLogOpen)}
          className={`p-1.5 rounded-md transition-all ${isLogOpen ? "bg-slate-800 text-amber-500" : "text-slate-500 hover:text-white hover:bg-slate-800"}`} title="System Logs"><Repeat size={15} className="rotate-90" /></button>
        <button onClick={() => setShowShortcuts(true)}
          className={`p-1.5 rounded-md transition-all ${showShortcuts ? "bg-slate-800 text-amber-500" : "text-slate-500 hover:text-white hover:bg-slate-800"}`} title="Keyboard Shortcuts (?)"><Keyboard size={15} /></button>
      </div>
    </header>
  );
}
