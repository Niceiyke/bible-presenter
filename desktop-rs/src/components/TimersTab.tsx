import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Square, RefreshCcw } from "lucide-react";
import { useAppStore } from "../store";
import type { DisplayItem, TimerData } from "../types";

interface TimersTabProps {
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
}

export function TimersTab({ onStage, onLive }: TimersTabProps) {
  const {
    timerType, setTimerType,
    timerHours, setTimerHours,
    timerMinutes, setTimerMinutes,
    timerSeconds, setTimerSeconds,
    timerLabel, setTimerLabel,
    timerRunning, setTimerRunning,
    liveItem
  } = useAppStore();

  const isTimerLive = liveItem?.type === "Timer";

  const makeTimerData = (running: boolean): TimerData => {
    const duration = timerHours * 3600 + timerMinutes * 60 + timerSeconds;
    return {
      timer_type: timerType,
      duration_secs: timerType === "countdown" ? duration : undefined,
      started_at: running ? Date.now() : undefined,
      label: timerLabel.trim() || undefined,
    };
  };

  const handleStartTimer = async () => {
    const data = makeTimerData(true);
    await onLive({ type: "Timer", data });
    setTimerRunning(true);
  };

  const handleStopTimer = async () => {
    await invoke("clear_live");
    setTimerRunning(false);
  };

  const handleReset = () => {
    setTimerRunning(false);
    if (isTimerLive) invoke("clear_live");
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[9px] font-black uppercase text-slate-500 mb-2">Timer Type</p>
        <div className="flex gap-2">
          {(["countdown", "countup", "clock"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTimerType(t)}
              className={`flex-1 py-1.5 text-[9px] font-black uppercase rounded-lg border transition-all ${timerType === t ? "bg-cyan-600 border-cyan-500 text-white" : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {timerType === "countdown" && (
        <div>
          <p className="text-[9px] font-black uppercase text-slate-500 mb-2">Duration</p>
          <div className="flex gap-2 items-center">
            {([
              ["Hours", timerHours, setTimerHours, 23],
              ["Mins", timerMinutes, setTimerMinutes, 59],
              ["Secs", timerSeconds, setTimerSeconds, 59],
            ] as const).map(([lbl, val, setter, max]) => (
              <div key={lbl} className="flex flex-col items-center gap-0.5 flex-1">
                <span className="text-[8px] text-slate-600 uppercase">{lbl}</span>
                <input
                  type="number" min={0} max={max} value={val}
                  onChange={(e) => (setter as any)((prev: number) => parseInt(e.target.value) || 0)}
                  className="w-full bg-slate-800 text-slate-200 text-center text-sm rounded border border-slate-700 py-1"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="text-[9px] font-black uppercase text-slate-500 mb-2">Label (Optional)</p>
        <input
          value={timerLabel}
          onChange={(e) => setTimerLabel(e.target.value)}
          placeholder="Service Countdown, etc."
          className="w-full bg-slate-800 text-slate-200 text-sm rounded border border-slate-700 px-3 py-2"
        />
      </div>

      <div className="flex flex-col gap-2 pt-2">
        <div className="flex gap-2">
          <button
            onClick={timerRunning ? handleStopTimer : handleStartTimer}
            className={`flex-1 py-3 rounded-xl flex items-center justify-center gap-2 font-black uppercase transition-all ${
              timerRunning ? "bg-red-600 hover:bg-red-500 text-white" : "bg-cyan-600 hover:bg-cyan-500 text-white"
            }`}
          >
            {timerRunning ? <Square size={16} /> : <Play size={16} />}
            {timerRunning ? "Stop Timer" : "Start Timer"}
          </button>
          <button
            onClick={handleReset}
            className="w-12 h-12 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-xl border border-slate-700 transition-all"
            title="Reset"
          >
            <RefreshCcw size={18} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 mt-2">
          <button
            onClick={() => onStage({ type: "Timer", data: makeTimerData(false) })}
            className="py-2 bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold rounded-lg transition-all"
          >
            STAGE PREVIEW
          </button>
          <button
            onClick={() => onLive({ type: "Timer", data: makeTimerData(true) })}
            className="py-2 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-bold rounded-lg transition-all"
          >
            DISPLAY LIVE
          </button>
        </div>
      </div>
    </div>
  );
}
