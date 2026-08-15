import React, { useState } from "react";
import { Clock, Pause, Play, Square } from "lucide-react";
import { Btn, Card, Label, cx } from "../ui";
import type { PanelProps } from "../panelTypes";
import type { RemoteTimerPayload } from "../../types/remote";

type TimerType = "countdown" | "countup" | "clock";

const TIMER_TYPES: { value: TimerType; label: string }[] = [
  { value: "countdown", label: "Countdown" },
  { value: "countup", label: "Count Up" },
  { value: "clock", label: "Clock" },
];

export function TimersPanel({ client, pushToast }: PanelProps) {
  const { command, isHeldBySelf, snapshot } = client;
  const [timerType, setTimerType] = useState<TimerType>("countdown");
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(5);
  const [seconds, setSeconds] = useState(0);
  const [label, setLabel] = useState("");

  const canTimer = snapshot?.permissions?.presentation ?? false;
  const live = snapshot?.live_item;
  const liveTimer = live?.type === "Timer" ? live.data : null;
  const timerRunning = liveTimer?.started_at != null;

  const guard = () => {
    if (isHeldBySelf) return true;
    pushToast("You need control to start a timer — take control in the header");
    return false;
  };

  const payload = (): RemoteTimerPayload => {
    const duration = hours * 3600 + minutes * 60 + seconds;
    return {
      timer_type: timerType,
      duration_secs: timerType === "countdown" ? duration : undefined,
      label: label.trim() || undefined,
    };
  };

  const start = () => {
    if (!guard()) return;
    command("timer.go_live", payload()).catch((e) => pushToast(String((e as Error).message ?? e)));
  };

  const stage = () => {
    if (!guard()) return;
    command("timer.stage", payload()).catch((e) => pushToast(String((e as Error).message ?? e)));
  };

  const toggle = () => {
    if (!guard()) return;
    command("timer.toggle").catch((e) => pushToast(String((e as Error).message ?? e)));
  };

  const stop = () => {
    if (!guard()) return;
    command("display.clear_live").catch((e) => pushToast(String((e as Error).message ?? e)));
  };

  if (!canTimer) {
    return (
      <Card className="text-center py-8">
        <Clock size={20} className="mx-auto mb-2 text-slate-500" />
        <p className="text-xs text-slate-300 font-semibold">Timers are locked</p>
        <p className="text-[10px] text-slate-500 mt-1">Ask the operator to grant Presentation permission for this device.</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="flex items-center gap-2">
          <span className={cx("w-2 h-2 rounded-full", timerRunning ? "bg-red-500 animate-pulse" : "bg-slate-600")} />
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-300">
            {timerRunning ? "Timer running" : liveTimer ? "Timer paused / staged" : "Timer stopped"}
          </p>
          {liveTimer && <p className="text-[9px] text-amber-500 uppercase font-bold ml-auto">On air</p>}
        </div>
      </Card>

      <Card>
        <Label>Timer type</Label>
        <div className="flex gap-2">
          {TIMER_TYPES.map((t) => (
            <button
              key={t.value}
              onClick={() => setTimerType(t.value)}
              className={cx(
                "flex-1 py-2 text-[9px] font-black uppercase rounded-lg border transition-all",
                timerType === t.value
                  ? "bg-cyan-600 border-cyan-500 text-white"
                  : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Card>

      {timerType === "countdown" && (
        <Card>
          <Label>Duration</Label>
          <div className="flex gap-2 items-center">
            {([
              ["Hours", hours, setHours, 23],
              ["Mins", minutes, setMinutes, 59],
              ["Secs", seconds, setSeconds, 59],
            ] as const).map(([lbl, val, setter, max]) => (
              <div key={lbl} className="flex flex-col items-center gap-0.5 flex-1">
                <span className="text-[8px] text-slate-600 uppercase">{lbl}</span>
                <input
                  type="number"
                  min={0}
                  max={max}
                  value={val}
                  onChange={(e) => setter(Math.max(0, Math.min(max, parseInt(e.target.value) || 0)))}
                  className="w-full bg-slate-800 text-slate-200 text-center font-mono text-sm rounded border border-slate-700 py-1"
                />
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <Label>Label (optional)</Label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Service Countdown, etc."
          className="w-full bg-slate-800 text-slate-200 text-sm rounded border border-slate-700 px-3 py-2"
        />
      </Card>

      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <button
            onClick={liveTimer ? toggle : start}
            className={cx(
              "flex-1 py-3 rounded-xl flex items-center justify-center gap-2 font-black uppercase transition-all active:scale-[0.98]",
              timerRunning ? "bg-amber-500 hover:bg-amber-400 text-black" : "bg-cyan-600 hover:bg-cyan-500 text-white"
            )}
          >
            {timerRunning ? <Pause size={16} /> : liveTimer ? <Play size={16} /> : <Play size={16} />}
            {timerRunning ? "Pause" : liveTimer ? "Resume" : "Start Timer"}
          </button>
          <button
            onClick={stop}
            disabled={!liveTimer}
            className="w-12 h-12 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-xl border border-slate-700 transition-all disabled:opacity-40"
            title="Stop and clear"
          >
            <Square size={16} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Btn variant="stage" onClick={stage} disabled={!!liveTimer}>
            Stage preview
          </Btn>
          <Btn variant="primary" onClick={start} disabled={!!liveTimer}>
            Display live
          </Btn>
        </div>
      </div>
    </div>
  );
}