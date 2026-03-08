import React, { useState, useEffect } from "react";
import { Mic, Square, Circle } from "lucide-react";
import { useAppStore } from "../../store";

export function LiveRecordingView() {
  const { micLevel, handleStopRecording } = useAppStore();
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds(s => s + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (totalSeconds: number) => {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Generate a simple "heartbeat" or rolling bars visualizer
  const bars = Array.from({ length: 40 }).map((_, i) => {
    // Random jitter + base level for a "live" feel
    const height = Math.max(10, (micLevel * 100) * (0.5 + Math.random() * 0.5));
    return height;
  });

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-slate-950 p-12">
      <div className="relative mb-12">
        <div className="absolute inset-0 bg-red-500/20 blur-3xl rounded-full animate-pulse" />
        <div className="relative w-32 h-32 bg-slate-900 rounded-[2.5rem] border border-red-500/30 flex items-center justify-center shadow-2xl shadow-red-500/10">
          <Mic size={48} className="text-red-500 animate-pulse" />
        </div>
        <div className="absolute -top-2 -right-2 flex items-center gap-1.5 bg-red-600 px-3 py-1 rounded-full shadow-lg">
          <Circle size={8} fill="currentColor" className="text-white animate-pulse" />
          <span className="text-[10px] font-black text-white uppercase tracking-widest">Live</span>
        </div>
      </div>

      <div className="text-center mb-12">
        <h3 className="text-6xl font-black text-white tabular-nums tracking-tighter mb-2">
          {formatTime(seconds)}
        </h3>
        <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.3em]">Recording in Progress</p>
      </div>

      <div className="w-full max-w-2xl h-32 flex items-center justify-center gap-1 mb-16">
        {bars.map((h, i) => (
          <div 
            key={i}
            className="w-1.5 bg-red-500 rounded-full transition-all duration-75 opacity-80"
            style={{ 
              height: `${h}%`,
              opacity: 0.3 + (h / 100) * 0.7 
            }}
          />
        ))}
      </div>

      <button 
        onClick={handleStopRecording}
        className="group flex flex-col items-center gap-4 transition-transform hover:scale-105 active:scale-95"
      >
        <div className="w-20 h-20 bg-white text-black rounded-full flex items-center justify-center shadow-xl shadow-white/5 group-hover:bg-red-500 group-hover:text-white transition-colors">
          <Square size={32} fill="currentColor" />
        </div>
        <span className="text-[11px] font-black text-slate-400 uppercase tracking-widest group-hover:text-red-500 transition-colors">Stop Session</span>
      </button>
      
      <div className="mt-12 p-4 bg-slate-900/50 border border-slate-800 rounded-2xl flex items-center gap-3">
        <div className="w-2 h-2 rounded-full bg-indigo-500" />
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
          Audio is being captured at 16kHz Mono (Broadcaster Standard)
        </p>
      </div>
    </div>
  );
}
