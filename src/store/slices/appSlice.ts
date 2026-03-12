import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { DEFAULT_SETTINGS, PresentationSettings } from "../../types";

export interface AppSlice {
  label: string;
  setLabel: (v: string) => void;
  settings: PresentationSettings;
  setSettings: (v: PresentationSettings | ((prev: PresentationSettings) => PresentationSettings)) => void;
  activeTab: "bible" | "media" | "songs" | "lower-third" | "timers" | "studio" | "schedule" | "settings" | "props" | "scenes" | "scene-builder" | "camera";
  setActiveTab: (v: "bible" | "media" | "songs" | "lower-third" | "timers" | "studio" | "schedule" | "settings" | "props" | "scenes" | "scene-builder" | "camera") => void;
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
  bottomDeckMode: "live-lt" | "timer" | "transcript" | "audio";
  setBottomDeckMode: (v: "live-lt" | "timer" | "transcript" | "audio") => void;
  topPanelPct: number;
  setTopPanelPct: (v: number | ((prev: number) => number)) => void;
  stagePct: number;
  setStagePct: (v: number | ((prev: number) => number)) => void;
  appDataDir: string | null;
  setAppDataDir: (v: string | null) => void;
  isInitialized: boolean;
  setIsInitialized: (v: boolean) => void;
  outputVisible: boolean;
  setOutputVisible: (v: boolean | ((prev: boolean) => boolean)) => void;
  showShortcuts: boolean;
  setShowShortcuts: (v: boolean | ((prev: boolean) => boolean)) => void;
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
  appDataDir: null,
  setAppDataDir: (v) => set({ appDataDir: v }),
  isInitialized: false,
  setIsInitialized: (v) => set({ isInitialized: v }),
  outputVisible: false,
  setOutputVisible: (v) => set((s) => ({ outputVisible: typeof v === "function" ? v(s.outputVisible) : v })),
  showShortcuts: false,
  setShowShortcuts: (v) => set((s) => ({ showShortcuts: typeof v === "function" ? v(s.showShortcuts) : v })),
});
