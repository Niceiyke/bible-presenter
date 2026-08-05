import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { DEFAULT_SETTINGS, PresentationSettings, CustomPresentation, CustomSlide, PresentationSummary, SlideTemplate } from "../../types";

export interface LogEntry {
  level: string;
  message: string;
  timestamp: number;
}

export interface AppSlice {
  label: string;
  setLabel: (v: string) => void;
  settings: PresentationSettings;
  setSettings: (v: PresentationSettings | ((prev: PresentationSettings) => PresentationSettings)) => void;
  activeTab: "bible" | "media" | "songs" | "lower-third" | "timers" | "studio" | "schedule" | "settings" | "props" | "camera";
  setActiveTab: (v: "bible" | "media" | "songs" | "lower-third" | "timers" | "studio" | "schedule" | "settings" | "props" | "camera") => void;
  toast: string | null;
  setToast: (v: string | null) => void;
  sidebarWidth: number;
  setSidebarWidth: (v: number | ((prev: number) => number)) => void;
  bottomDeckOpen: boolean;
  setBottomDeckOpen: (v: boolean) => void;
  bottomDeckMode: "live-lt" | "timer";
  setBottomDeckMode: (v: "live-lt" | "timer") => void;
  topPanelPct: number;
  setTopPanelPct: (v: number | ((prev: number) => number)) => void;
  stagePct: number;
  setStagePct: (v: number | ((prev: number) => number)) => void;
  appDataDir: string | null;
  setAppDataDir: (v: string | null) => void;
  isInitialized: boolean;
  setIsInitialized: (v: boolean) => void;
  startupIssues: string[];
  setStartupIssues: (v: string[]) => void;
  isSchedulePersistent: boolean;
  setIsSchedulePersistent: (v: boolean) => void;
  outputVisible: boolean;
  setOutputVisible: (v: boolean | ((prev: boolean) => boolean)) => void;
  showShortcuts: boolean;
  setShowShortcuts: (v: boolean | ((prev: boolean) => boolean)) => void;
  logs: LogEntry[];
  addLog: (entry: LogEntry) => void;
  clearLogs: () => void;
  isLogOpen: boolean;
  setIsLogOpen: (v: boolean) => void;
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
  studioList: PresentationSummary[];
  setStudioList: (v: PresentationSummary[] | ((prev: PresentationSummary[]) => PresentationSummary[])) => void;
  editorPresId: string | null;
  setEditorPresId: (v: string | null) => void;
  editorPres: CustomPresentation | null;
  setEditorPres: (v: CustomPresentation | null) => void;
  isDirty: boolean;
  setIsDirty: (v: boolean) => void;
  expandedStudioPresId: string | null;
  setExpandedStudioPresId: (v: string | null) => void;
  studioSlides: Record<string, CustomSlide[]>;
  setStudioSlides: (v: Record<string, CustomSlide[]> | ((prev: Record<string, CustomSlide[]>) => Record<string, CustomSlide[]>)) => void;
  templates: SlideTemplate[];
  setTemplates: (v: SlideTemplate[] | ((prev: SlideTemplate[]) => SlideTemplate[])) => void;
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
  startupIssues: [],
  setStartupIssues: (v) => set({ startupIssues: v }),
  isSchedulePersistent: true,
  setIsSchedulePersistent: (v) => set({ isSchedulePersistent: v }),
  outputVisible: false,
  setOutputVisible: (v) => set((s) => ({ outputVisible: typeof v === "function" ? v(s.outputVisible) : v })),
  showShortcuts: false,
  setShowShortcuts: (v) => set((s) => ({ showShortcuts: typeof v === "function" ? v(s.showShortcuts) : v })),
  logs: [],
  addLog: (entry) => set((s) => ({ logs: [entry, ...s.logs].slice(0, 500) })),
  clearLogs: () => set({ logs: [] }),
  isLogOpen: false,
  setIsLogOpen: (v) => set({ isLogOpen: v }),
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
  studioList: [],
  setStudioList: (v) => set((s) => ({ studioList: typeof v === "function" ? v(s.studioList) : v })),
  editorPresId: null,
  setEditorPresId: (v) => set({ editorPresId: v }),
  editorPres: null,
  setEditorPres: (v) => set({ editorPres: v }),
  isDirty: false,
  setIsDirty: (v) => set({ isDirty: v }),
  expandedStudioPresId: null,
  setExpandedStudioPresId: (v) => set({ expandedStudioPresId: v }),
  studioSlides: {},
  setStudioSlides: (v) => set((s) => ({ studioSlides: typeof v === "function" ? v(s.studioSlides) : v })),
  templates: [],
  setTemplates: (v) => set((s) => ({ templates: typeof v === "function" ? v(s.templates) : v })),
});
