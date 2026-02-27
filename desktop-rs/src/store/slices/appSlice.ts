import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { DEFAULT_SETTINGS, PresentationSettings } from "../../types";

export interface AppSlice {
  label: string;
  setLabel: (v: string) => void;
  settings: PresentationSettings;
  setSettings: (v: PresentationSettings | ((prev: PresentationSettings) => PresentationSettings)) => void;
  activeTab: "bible" | "media" | "presentations" | "songs" | "lower-third" | "timers" | "studio" | "schedule" | "settings" | "props";
  setActiveTab: (v: "bible" | "media" | "presentations" | "songs" | "lower-third" | "timers" | "studio" | "schedule" | "settings" | "props") => void;
  toast: string | null;
  setToast: (v: string | null) => void;
  sidebarWidth: number;
  setSidebarWidth: (v: number | ((prev: number) => number)) => void;
  isTranscriptionCollapsed: boolean;
  setIsTranscriptionCollapsed: (v: boolean) => void;
  isSchedulePersistent: boolean;
  setIsSchedulePersistent: (v: boolean) => void;
  bottomDeckOpen: boolean;
  setBottomDeckOpen: (v: boolean) => void;
  bottomDeckMode: "live-lt" | "timer";
  setBottomDeckMode: (v: "live-lt" | "timer") => void;
  topPanelPct: number;
  setTopPanelPct: (v: number | ((prev: number) => number)) => void;
  stagePct: number;
  setStagePct: (v: number | ((prev: number) => number)) => void;
}

export const createAppSlice: StateCreator<AppStore, [], [], AppSlice> = (set) => ({
  label: "",
  setLabel: (v) => set({ label: v }),
  settings: DEFAULT_SETTINGS,
  setSettings: (v) => set((s) => ({ settings: typeof v === "function" ? v(s.settings) : v })),
  activeTab: "bible",
  setActiveTab: (v) => set({ activeTab: v }),
  toast: null,
  setToast: (v) => set({ toast: v }),
  sidebarWidth: 320,
  setSidebarWidth: (v) => set((s) => ({ sidebarWidth: typeof v === "function" ? v(s.sidebarWidth) : v })),
  isTranscriptionCollapsed: false,
  setIsTranscriptionCollapsed: (v) => set({ isTranscriptionCollapsed: v }),
  isSchedulePersistent: true,
  setIsSchedulePersistent: (v) => set({ isSchedulePersistent: v }),
  bottomDeckOpen: false,
  setBottomDeckOpen: (v) => set({ bottomDeckOpen: v }),
  bottomDeckMode: "live-lt",
  setBottomDeckMode: (v) => set({ bottomDeckMode: v }),
  topPanelPct: parseInt(localStorage.getItem("pref_topPanelPct") ?? "33", 10),
  setTopPanelPct: (v) => set((s) => ({ topPanelPct: typeof v === "function" ? v(s.topPanelPct) : v })),
  stagePct: parseInt(localStorage.getItem("pref_stagePct") ?? "50", 10),
  setStagePct: (v) => set((s) => ({ stagePct: typeof v === "function" ? v(s.stagePct) : v })),
});
