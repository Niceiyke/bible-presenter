import React, { useState, useEffect } from "react";
import { Mic, Square } from "lucide-react";
import { useAppStore } from "../../store";

export function LiveRecordingView() {
  const { micLevel, handleStopRecording, recordingSampleRate } = useAppStore();
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const fmtTime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-slate-950 gap-8">
      {/* Mic icon with live badge */}
      <div className="relative">
        <div className="absolute inset-0 bg-red-500/15 blur-2xl rounded-full" />
        <div className="relative w-20 h-20 bg-slate-900 border border-red-500/20 rounded-2xl flex items-center justify-center shadow-xl">
          <Mic size={32} className="text-red-500" />
        </div>
        <div className="absolute -top-2 -right-2 flex items-center gap-1 bg-red-600 px-2 py-0.5 rounded-full">
          <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
          <span className="text-[8px] font-black uppercase tracking-widest text-white">Live</span>
        </div>
      </div>

      {/* Timer */}
      <div className="text-center">
        <p className="text-4xl font-black text-white tabular-nums tracking-tighter">
          {fmtTime(seconds)}
        </p>
        <p className="text-[9px] font-black uppercase tracking-widest text-slate-600 mt-1">Recording in progress</p>
      </div>

      {/* VU bars */}
      <div className="flex items-center justify-center gap-0.5 h-16 w-48">
        {Array.from({ length: 32 }).map((_, i) => {
          const h = Math.max(8, micLevel * 100 * (0.4 + Math.random() * 0.6));
          return (
            <div
              key={i}
              className="w-1 bg-red-500 rounded-full transition-all duration-75"
              style={{ height: `${h}%`, opacity: 0.3 + (h / 100) * 0.7 }}
            />
          );
        })}
      </div>

      {/* Stop button */}
      <button
        onClick={handleStopRecording}
        className="group flex items-center gap-2.5 px-5 py-2.5 bg-slate-800 hover:bg-red-600 border border-slate-700 hover:border-red-500 text-slate-300 hover:text-white rounded-lg text-[9px] font-black uppercase tracking-widest transition-all shadow-lg active:scale-95"
      >
        <Square size={12} fill="currentColor" />
        Stop Session
      </button>

      {/* Info badge */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg">
        <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        <p className="text-[8px] font-bold uppercase tracking-widest text-slate-500">
          Capturing · {recordingSampleRate >= 1000 ? `${(recordingSampleRate / 1000).toFixed(recordingSampleRate % 1000 === 0 ? 0 : 1)} kHz` : `${recordingSampleRate} Hz`} · Mono
        </p>
      </div>
    </div>
  );
}
