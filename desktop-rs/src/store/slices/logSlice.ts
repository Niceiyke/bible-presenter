import { StateCreator } from "zustand";
import { AppStore } from "../index";

export interface LogEntry {
  level: string;
  message: string;
  timestamp: number;
}

export interface LogSlice {
  logs: LogEntry[];
  addLog: (entry: LogEntry) => void;
  clearLogs: () => void;
  isLogOpen: boolean;
  setIsLogOpen: (v: boolean) => void;
}

export const createLogSlice: StateCreator<AppStore, [], [], LogSlice> = (set) => ({
  logs: [],
  addLog: (entry) => set((s) => ({ logs: [entry, ...s.logs].slice(0, 500) })), // Keep last 500 logs
  clearLogs: () => set({ logs: [] }),
  isLogOpen: false,
  setIsLogOpen: (v) => set({ isLogOpen: v }),
});
