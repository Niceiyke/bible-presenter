import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { DEFAULT_SETTINGS, PresentationSettings, CustomPresentation, CustomSlide, PresentationSummary, SlideTemplate, Scene, CameraBackground } from "../../types";
import type { DisplayItem } from "../../types";
import type { PhoneCameraOrientation, CameraLook, CameraChromaConfig } from "../../types/remote";
import { DEFAULT_CAMERA_LOOK, DEFAULT_CAMERA_CHROMA } from "../../types/remote";

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
  /** Primary operator mode (Phase 8): Prepare (build content), Service (run the
   *  live service), System (recording/streaming/diagnostics/settings). Service
   *  is the default live workspace. */
  operatorMode: "prepare" | "service" | "system";
  setOperatorMode: (v: "prepare" | "service" | "system") => void;
  activeTab: "bible" | "media" | "songs" | "lower-third" | "timers" | "studio" | "schedule" | "settings" | "props" | "lt-designer" | "camera" | "scenes" | "scene-builder" | "remote" | "recordings" | "streaming" | "diagnostics";
  setActiveTab: (v: "bible" | "media" | "songs" | "lower-third" | "timers" | "studio" | "schedule" | "settings" | "props" | "lt-designer" | "camera" | "scenes" | "scene-builder" | "remote" | "recordings" | "streaming" | "diagnostics") => void;
  toast: string | null;
  setToast: (v: string | null) => void;
  sidebarWidth: number;
  setSidebarWidth: (v: number | ((prev: number) => number)) => void;
  bottomDeckOpen: boolean;
  setBottomDeckOpen: (v: boolean) => void;
  bottomDeckMode: "live-lt" | "timer" | "props" | "camera" | "scenes";
  setBottomDeckMode: (v: "live-lt" | "timer" | "props" | "camera" | "scenes") => void;
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
  /** True while the Bible FTS search index is being built off-thread after
   *  a fresh install; search still works via the LIKE fallback. */
  bibleIndexing: boolean;
  setBibleIndexing: (v: boolean) => void;
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
  scenes: Scene[];
  setScenes: (v: Scene[] | ((prev: Scene[]) => Scene[])) => void;
  /** The scene currently open in the full-page Scene Builder tab. */
  sceneBuilderScene: Scene | null;
  setSceneBuilderScene: (v: Scene | null) => void;
  backendError: string | null;
  setBackendError: (v: string | null) => void;
  busyActions: string[];
  setBusyAction: (key: string, busy: boolean) => void;
  backendAvailable: boolean;
  setBackendAvailable: (v: boolean) => void;
  addToServiceOpen: boolean;
  setAddToServiceOpen: (v: boolean) => void;
  pendingScheduleItem: DisplayItem | null;
  setPendingScheduleItem: (v: DisplayItem | null) => void;
  cameraOrientations: Record<string, PhoneCameraOrientation>;
  setCameraOrientation: (deviceId: string, orientation: PhoneCameraOrientation) => void;
  cameraNames: Record<string, string>;
  setCameraName: (deviceId: string, name: string) => void;
  cameraDefaults: Record<string, Omit<CameraBackground, "deviceId">>;
  setCameraDefaults: (deviceId: string, partial: Partial<Omit<CameraBackground, "deviceId">>) => void;
  cameraLook: Record<string, CameraLook>;
  setCameraLook: (deviceId: string, partial: Partial<CameraLook>) => void;
  cameraChroma: Record<string, CameraChromaConfig>;
  setCameraChroma: (deviceId: string, partial: Partial<CameraChromaConfig>) => void;
}

export const createAppSlice: StateCreator<AppStore, [], [], AppSlice> = (set) => ({
  label: "",
  setLabel: (v) => set({ label: v }),
  settings: DEFAULT_SETTINGS,
  setSettings: (v) => set((s) => ({ settings: typeof v === "function" ? v(s.settings) : v })),
  operatorMode: "service",
  setOperatorMode: (v) => set({ operatorMode: v }),
  activeTab: "schedule",
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
  bibleIndexing: false,
  setBibleIndexing: (v) => set({ bibleIndexing: v }),
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
  scenes: [],
  setScenes: (v) => set((s) => ({ scenes: typeof v === "function" ? v(s.scenes) : v })),
  sceneBuilderScene: null,
  setSceneBuilderScene: (v) => set({ sceneBuilderScene: v }),
  backendError: null,
  setBackendError: (v) => set({ backendError: v }),
  busyActions: [],
  setBusyAction: (key, busy) => set((s) => {
    const has = s.busyActions.includes(key);
    if (busy && !has) return { busyActions: [...s.busyActions, key] };
    if (!busy && has) return { busyActions: s.busyActions.filter((k) => k !== key) };
    return {};
  }),
  backendAvailable: true,
  setBackendAvailable: (v) => set({ backendAvailable: v }),
  addToServiceOpen: false,
  setAddToServiceOpen: (v) => set({ addToServiceOpen: v }),
  pendingScheduleItem: null,
  setPendingScheduleItem: (v) => set({ pendingScheduleItem: v }),
  cameraOrientations: (() => {
    try {
      const raw = localStorage.getItem("cameraOrientations");
      return raw ? (JSON.parse(raw) as Record<string, PhoneCameraOrientation>) : {};
    } catch {
      return {};
    }
  })(),
  setCameraOrientation: (deviceId, orientation) => set((s) => {
    const cameraOrientations = { ...s.cameraOrientations, [deviceId]: orientation };
    try {
      localStorage.setItem("cameraOrientations", JSON.stringify(cameraOrientations));
    } catch {
      /* localStorage unavailable — keep in-memory only */
    }
    return { cameraOrientations };
  }),
  cameraNames: (() => {
    try {
      return JSON.parse(localStorage.getItem("cameraNames") ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  })(),
  setCameraName: (deviceId, name) => set((s) => {
    const cameraNames = { ...s.cameraNames, [deviceId]: name };
    try {
      localStorage.setItem("cameraNames", JSON.stringify(cameraNames));
    } catch {
      /* localStorage unavailable — keep in-memory only */
    }
    return { cameraNames };
  }),
  cameraDefaults: (() => {
    try {
      return JSON.parse(localStorage.getItem("cameraDefaults") ?? "{}") as Record<string, Omit<CameraBackground, "deviceId">>;
    } catch {
      return {};
    }
  })(),
  setCameraDefaults: (deviceId, partial) => set((s) => {
    const prev = s.cameraDefaults[deviceId] ?? { mirrored: false, objectFit: "cover", opacity: 1 };
    const cameraDefaults = { ...s.cameraDefaults, [deviceId]: { ...prev, ...partial } };
    try {
      localStorage.setItem("cameraDefaults", JSON.stringify(cameraDefaults));
    } catch {
      /* localStorage unavailable — keep in-memory only */
    }
    return { cameraDefaults };
  }),
  cameraLook: (() => {
    try {
      return JSON.parse(localStorage.getItem("cameraLook") ?? "{}") as Record<string, CameraLook>;
    } catch {
      return {};
    }
  })(),
  setCameraLook: (deviceId, partial) => set((s) => {
    const prev = s.cameraLook[deviceId];
    const cameraLook = { ...s.cameraLook, [deviceId]: { ...(prev ?? DEFAULT_CAMERA_LOOK), ...partial } };
    try {
      localStorage.setItem("cameraLook", JSON.stringify(cameraLook));
    } catch {
      /* localStorage unavailable — keep in-memory only */
    }
    return { cameraLook };
  }),
  cameraChroma: (() => {
    try {
      return JSON.parse(localStorage.getItem("cameraChroma") ?? "{}") as Record<string, CameraChromaConfig>;
    } catch {
      return {};
    }
  })(),
  setCameraChroma: (deviceId, partial) => set((s) => {
    const prev = s.cameraChroma[deviceId];
    const cameraChroma = { ...s.cameraChroma, [deviceId]: { ...(prev ?? DEFAULT_CAMERA_CHROMA), ...partial } };
    try {
      localStorage.setItem("cameraChroma", JSON.stringify(cameraChroma));
    } catch {
      /* localStorage unavailable — keep in-memory only */
    }
    return { cameraChroma };
  }),
});
