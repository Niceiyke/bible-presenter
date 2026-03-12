import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { ScheduleEntry, ServiceMeta, PropItem } from "../../types";

export interface ServiceSlice {
  scheduleEntries: ScheduleEntry[];
  setScheduleEntries: (v: ScheduleEntry[]) => void;
  pushScheduleState: (v: ScheduleEntry[]) => void;
  undoSchedule: () => void;
  redoSchedule: () => void;
  pastScheduleStates: ScheduleEntry[][];
  futureScheduleStates: ScheduleEntry[][];
  activeScheduleIdx: number | null;
  // ... rest of the interface
  setActiveScheduleIdx: (v: number | null) => void;
  services: ServiceMeta[];
  setServices: (v: ServiceMeta[]) => void;
  activeServiceId: string;
  setActiveServiceId: (v: string) => void;
  serviceManagerOpen: boolean;
  setServiceManagerOpen: (v: boolean) => void;
  newServiceName: string;
  setNewServiceName: (v: string) => void;
  propItems: PropItem[];
  setPropItems: (v: PropItem[]) => void;
}

export const createServiceSlice: StateCreator<AppStore, [], [], ServiceSlice> = (set) => ({
  scheduleEntries: [],
  setScheduleEntries: (v) => set({ scheduleEntries: v }),
  pastScheduleStates: [],
  futureScheduleStates: [],
  pushScheduleState: (next) => set((s) => ({
    pastScheduleStates: [...s.pastScheduleStates, s.scheduleEntries].slice(-50),
    scheduleEntries: next,
    futureScheduleStates: []
  })),
  undoSchedule: () => set((s) => {
    if (s.pastScheduleStates.length === 0) return s;
    const prev = s.pastScheduleStates[s.pastScheduleStates.length - 1];
    return {
      pastScheduleStates: s.pastScheduleStates.slice(0, -1),
      scheduleEntries: prev,
      futureScheduleStates: [s.scheduleEntries, ...s.futureScheduleStates]
    };
  }),
  redoSchedule: () => set((s) => {
    if (s.futureScheduleStates.length === 0) return s;
    const next = s.futureScheduleStates[0];
    return {
      futureScheduleStates: s.futureScheduleStates.slice(1),
      scheduleEntries: next,
      pastScheduleStates: [...s.pastScheduleStates, s.scheduleEntries]
    };
  }),
  activeScheduleIdx: null,
  setActiveScheduleIdx: (v) => set({ activeScheduleIdx: v }),
  services: [],
  setServices: (v) => set({ services: v }),
  activeServiceId: "default",
  setActiveServiceId: (v) => set({ activeServiceId: v }),
  serviceManagerOpen: false,
  setServiceManagerOpen: (v) => set({ serviceManagerOpen: v }),
  newServiceName: "",
  setNewServiceName: (v) => set({ newServiceName: v }),
  propItems: [],
  setPropItems: (v) => set({ propItems: v }),
});
