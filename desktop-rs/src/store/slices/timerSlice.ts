import { StateCreator } from "zustand";
import { AppStore } from "../index";

export interface TimerSlice {
  timerType: "countdown" | "countup" | "clock";
  setTimerType: (v: "countdown" | "countup" | "clock") => void;
  timerHours: number;
  setTimerHours: (v: number | ((prev: number) => number)) => void;
  timerMinutes: number;
  setTimerMinutes: (v: number | ((prev: number) => number)) => void;
  timerSeconds: number;
  setTimerSeconds: (v: number | ((prev: number) => number)) => void;
  timerLabel: string;
  setTimerLabel: (v: string) => void;
  timerRunning: boolean;
  setTimerRunning: (v: boolean) => void;
}

export const createTimerSlice: StateCreator<AppStore, [], [], TimerSlice> = (set) => ({
  timerType: "countdown",
  setTimerType: (v) => set({ timerType: v }),
  timerHours: 0,
  setTimerHours: (v) => set((s) => ({ timerHours: typeof v === "function" ? v(s.timerHours) : v })),
  timerMinutes: 5,
  setTimerMinutes: (v) => set((s) => ({ timerMinutes: typeof v === "function" ? v(s.timerMinutes) : v })),
  timerSeconds: 0,
  setTimerSeconds: (v) => set((s) => ({ timerSeconds: typeof v === "function" ? v(s.timerSeconds) : v })),
  timerLabel: "",
  setTimerLabel: (v) => set({ timerLabel: v }),
  timerRunning: false,
  setTimerRunning: (v) => set({ timerRunning: v }),
});
