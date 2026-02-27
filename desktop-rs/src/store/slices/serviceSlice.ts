import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { ScheduleEntry, ServiceMeta, PropItem } from "../../types";

export interface ServiceSlice {
  scheduleEntries: ScheduleEntry[];
  setScheduleEntries: (v: ScheduleEntry[]) => void;
  activeScheduleIdx: number | null;
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
