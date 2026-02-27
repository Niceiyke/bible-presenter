import { create } from "zustand";
import type {
  DisplayItem,
  Verse,
  MediaItem,
  PresentationFile,
  CustomPresentation,
  CustomSlide,
  ScheduleEntry,
  Song,
  LowerThirdData,
  LowerThirdTemplate,
  PresentationSettings,
  ServiceMeta,
  PropItem,
  SceneData,
  BackgroundSetting,
} from "./App";
import type { ParsedSlide } from "./pptxParser";

// Re-export DEFAULT_LT_TEMPLATE from App.tsx for use in store initialization
const DEFAULT_SETTINGS: PresentationSettings = {
  theme: "dark",
  reference_position: "bottom",
  background: { type: "None" },
  is_blanked: false,
  font_size: 72,
  slide_transition: "fade",
  slide_transition_duration: 0.4,
};

export interface AppStore {
  // Window identity
  label: string;
  setLabel: (v: string) => void;

  // Presentation state
  liveItem: DisplayItem | null;
  setLiveItem: (v: DisplayItem | null) => void;
  stagedItem: DisplayItem | null;
  setStagedItem: (v: DisplayItem | null) => void;
  suggestedItem: DisplayItem | null;
  setSuggestedItem: (v: DisplayItem | null) => void;
  suggestedConfidence: number;
  setSuggestedConfidence: (v: number) => void;
  nextVerse: Verse | null;
  setNextVerse: (v: Verse | null) => void;
  verseHistory: DisplayItem[];
  setVerseHistory: (v: DisplayItem[]) => void;
  historyOpen: boolean;
  setHistoryOpen: (v: boolean) => void;

  // Layout
  sidebarWidth: number;
  setSidebarWidth: (v: number) => void;
  isTranscriptionCollapsed: boolean;
  setIsTranscriptionCollapsed: (v: boolean) => void;
  isSchedulePersistent: boolean;
  setIsSchedulePersistent: (v: boolean) => void;
  bottomDeckOpen: boolean;
  setBottomDeckOpen: (v: boolean) => void;
  bottomDeckMode: "live-lt" | "studio-slides" | "studio-lt" | "scene-composer" | "timer";
  setBottomDeckMode: (v: "live-lt" | "studio-slides" | "studio-lt" | "scene-composer" | "timer") => void;
  topPanelPct: number;
  setTopPanelPct: (v: number) => void;
  stagePct: number;
  setStagePct: (v: number) => void;

  // Timer
  timerType: "countdown" | "countup" | "clock";
  setTimerType: (v: "countdown" | "countup" | "clock") => void;
  timerHours: number;
  setTimerHours: (v: number) => void;
  timerMinutes: number;
  setTimerMinutes: (v: number) => void;
  timerSeconds: number;
  setTimerSeconds: (v: number) => void;
  timerLabel: string;
  setTimerLabel: (v: string) => void;
  timerRunning: boolean;
  setTimerRunning: (v: boolean) => void;
  isBlackout: boolean;
  setIsBlackout: (v: boolean) => void;

  // Scene Composer
  workingScene: SceneData;
  setWorkingScene: (v: SceneData) => void;
  activeLayerId: string | null;
  setActiveLayerId: (v: string | null) => void;
  savedScenes: SceneData[];
  setSavedScenes: (v: SceneData[]) => void;

  // Settings
  settings: PresentationSettings;
  setSettings: (v: PresentationSettings) => void;

  // Studio
  studioList: { id: string; name: string; slide_count: number }[];
  setStudioList: (v: { id: string; name: string; slide_count: number }[]) => void;
  editorPresId: string | null;
  setEditorPresId: (v: string | null) => void;
  editorPres: CustomPresentation | null;
  setEditorPres: (v: CustomPresentation | null) => void;
  expandedStudioPresId: string | null;
  setExpandedStudioPresId: (v: string | null) => void;
  studioSlides: Record<string, CustomSlide[]>;
  setStudioSlides: (v: Record<string, CustomSlide[]>) => void;

  // UI
  activeTab: "bible" | "media" | "presentations" | "songs" | "lower-third" | "timers";
  setActiveTab: (v: "bible" | "media" | "presentations" | "songs" | "lower-third" | "timers") => void;
  toast: string | null;
  setToast: (v: string | null) => void;

  // Songs
  songs: Song[];
  setSongs: (v: Song[]) => void;
  songSearch: string;
  setSongSearch: (v: string) => void;
  editingSong: Song | null;
  setEditingSong: (v: Song | null) => void;
  songImportText: string;
  setSongImportText: (v: string) => void;
  showSongImport: boolean;
  setShowSongImport: (v: boolean) => void;

  // Lower Third
  ltMode: "nameplate" | "lyrics" | "freetext";
  setLtMode: (v: "nameplate" | "lyrics" | "freetext") => void;
  ltVisible: boolean;
  setLtVisible: (v: boolean) => void;
  ltTemplate: LowerThirdTemplate;
  setLtTemplate: (v: LowerThirdTemplate | ((prev: LowerThirdTemplate) => LowerThirdTemplate)) => void;
  ltSavedTemplates: LowerThirdTemplate[];
  setLtSavedTemplates: (v: LowerThirdTemplate[]) => void;
  ltDesignOpen: boolean;
  setLtDesignOpen: (v: boolean) => void;
  showLtImgPicker: boolean;
  setShowLtImgPicker: (v: boolean) => void;
  ltName: string;
  setLtName: (v: string) => void;
  ltTitle: string;
  setLtTitle: (v: string) => void;
  ltFreeText: string;
  setLtFreeText: (v: string) => void;
  ltSongId: string | null;
  setLtSongId: (v: string | null) => void;
  ltLineIndex: number;
  setLtLineIndex: (v: number | ((prev: number) => number)) => void;
  ltLinesPerDisplay: 1 | 2;
  setLtLinesPerDisplay: (v: 1 | 2) => void;
  ltAutoAdvance: boolean;
  setLtAutoAdvance: (v: boolean) => void;
  ltAutoSeconds: number;
  setLtAutoSeconds: (v: number) => void;
  ltAtEnd: boolean;
  setLtAtEnd: (v: boolean) => void;

  // Schedule
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

  // Props Layer
  propItems: PropItem[];
  setPropItems: (v: PropItem[]) => void;

  // Media
  media: MediaItem[];
  setMedia: (v: MediaItem[]) => void;
  cameras: MediaDeviceInfo[];
  setCameras: (v: MediaDeviceInfo[]) => void;
  enabledLocalCameras: Set<string>;
  setEnabledLocalCameras: (v: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  mediaFilter: "image" | "video" | "camera";
  setMediaFilter: (v: "image" | "video" | "camera") => void;
  pauseWhisper: boolean;
  setPauseWhisper: (v: boolean | ((prev: boolean) => boolean)) => void;
  showLogoPicker: boolean;
  setShowLogoPicker: (v: boolean) => void;
  showGlobalBgPicker: boolean;
  setShowGlobalBgPicker: (v: boolean) => void;

  // Presentations (PPTX)
  presentations: PresentationFile[];
  setPresentations: (v: PresentationFile[]) => void;
  selectedPresId: string | null;
  setSelectedPresId: (v: string | null) => void;
  loadedSlides: Record<string, ParsedSlide[]>;
  setLoadedSlides: (v: Record<string, ParsedSlide[]>) => void;
  libreOfficeAvailable: boolean;
  setLibreOfficeAvailable: (v: boolean) => void;
  pptxPngSlides: Record<string, string[]>;
  setPptxPngSlides: (v: Record<string, string[]> | ((prev: Record<string, string[]>) => Record<string, string[]>)) => void;

  // Session / Audio
  transcript: string;
  setTranscript: (v: string) => void;
  devices: [string, string][];
  setDevices: (v: [string, string][]) => void;
  selectedDevice: string;
  setSelectedDevice: (v: string) => void;
  vadThreshold: number;
  setVadThreshold: (v: number) => void;
  transcriptionWindowSec: number;
  setTranscriptionWindowSec: (v: number) => void;
  sessionState: "idle" | "loading" | "running";
  setSessionState: (v: "idle" | "loading" | "running") => void;
  audioError: string | null;
  setAudioError: (v: string | null) => void;
  deviceError: string | null;
  setDeviceError: (v: string | null) => void;
  micLevel: number;
  setMicLevel: (v: number) => void;

  // Remote Control
  remoteUrl: string;
  setRemoteUrl: (v: string) => void;
  remotePin: string;
  setRemotePin: (v: string) => void;
  tailscaleUrl: string | null;
  setTailscaleUrl: (v: string | null) => void;

  // Bible
  availableVersions: string[];
  setAvailableVersions: (v: string[]) => void;
  bibleVersion: string;
  setBibleVersion: (v: string) => void;
  books: string[];
  setBooks: (v: string[]) => void;
  chapters: number[];
  setChapters: (v: number[]) => void;
  verses: number[];
  setVerses: (v: number[]) => void;
  selectedBook: string;
  setSelectedBook: (v: string | ((prev: string) => string)) => void;
  selectedChapter: number;
  setSelectedChapter: (v: number) => void;
  selectedVerse: number;
  setSelectedVerse: (v: number) => void;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  searchResults: Verse[];
  setSearchResults: (v: Verse[]) => void;
  bibleOpen: { quickEntry: boolean; manualSelection: boolean; keywordSearch: boolean };
  setBibleOpen: (v: { quickEntry: boolean; manualSelection: boolean; keywordSearch: boolean } | ((prev: { quickEntry: boolean; manualSelection: boolean; keywordSearch: boolean }) => { quickEntry: boolean; manualSelection: boolean; keywordSearch: boolean })) => void;
}

export const useAppStore = create<AppStore>()((set) => ({
  // Window identity
  label: "",
  setLabel: (v) => set({ label: v }),

  // Presentation state
  liveItem: null,
  setLiveItem: (v) => set({ liveItem: v }),
  stagedItem: null,
  setStagedItem: (v) => set({ stagedItem: v }),
  suggestedItem: null,
  setSuggestedItem: (v) => set({ suggestedItem: v }),
  suggestedConfidence: 0,
  setSuggestedConfidence: (v) => set({ suggestedConfidence: v }),
  nextVerse: null,
  setNextVerse: (v) => set({ nextVerse: v }),
  verseHistory: [],
  setVerseHistory: (v) => set({ verseHistory: v }),
  historyOpen: false,
  setHistoryOpen: (v) => set({ historyOpen: v }),

  // Layout
  sidebarWidth: 320,
  setSidebarWidth: (v) => set({ sidebarWidth: v }),
  isTranscriptionCollapsed: false,
  setIsTranscriptionCollapsed: (v) => set({ isTranscriptionCollapsed: v }),
  isSchedulePersistent: true,
  setIsSchedulePersistent: (v) => set({ isSchedulePersistent: v }),
  bottomDeckOpen: false,
  setBottomDeckOpen: (v) => set({ bottomDeckOpen: v }),
  bottomDeckMode: "live-lt",
  setBottomDeckMode: (v) => set({ bottomDeckMode: v }),
  topPanelPct: parseInt(localStorage.getItem("pref_topPanelPct") ?? "33", 10),
  setTopPanelPct: (v) => set({ topPanelPct: v }),
  stagePct: parseInt(localStorage.getItem("pref_stagePct") ?? "50", 10),
  setStagePct: (v) => set({ stagePct: v }),

  // Timer
  timerType: "countdown",
  setTimerType: (v) => set({ timerType: v }),
  timerHours: 0,
  setTimerHours: (v) => set({ timerHours: v }),
  timerMinutes: 5,
  setTimerMinutes: (v) => set({ timerMinutes: v }),
  timerSeconds: 0,
  setTimerSeconds: (v) => set({ timerSeconds: v }),
  timerLabel: "",
  setTimerLabel: (v) => set({ timerLabel: v }),
  timerRunning: false,
  setTimerRunning: (v) => set({ timerRunning: v }),
  isBlackout: false,
  setIsBlackout: (v) => set({ isBlackout: v }),

  // Scene Composer
  workingScene: { id: crypto.randomUUID(), name: "New Scene", layers: [] },
  setWorkingScene: (v) => set({ workingScene: v }),
  activeLayerId: null,
  setActiveLayerId: (v) => set({ activeLayerId: v }),
  savedScenes: [],
  setSavedScenes: (v) => set({ savedScenes: v }),

  // Settings
  settings: DEFAULT_SETTINGS,
  setSettings: (v) => set({ settings: v }),

  // Studio
  studioList: [],
  setStudioList: (v) => set({ studioList: v }),
  editorPresId: null,
  setEditorPresId: (v) => set({ editorPresId: v }),
  editorPres: null,
  setEditorPres: (v) => set({ editorPres: v }),
  expandedStudioPresId: null,
  setExpandedStudioPresId: (v) => set({ expandedStudioPresId: v }),
  studioSlides: {},
  setStudioSlides: (v) => set({ studioSlides: v }),

  // UI
  activeTab: "bible" as const,
  setActiveTab: (v) => set({ activeTab: v }),
  toast: null,
  setToast: (v) => set({ toast: v }),

  // Songs
  songs: [],
  setSongs: (v) => set({ songs: v }),
  songSearch: "",
  setSongSearch: (v) => set({ songSearch: v }),
  editingSong: null,
  setEditingSong: (v) => set({ editingSong: v }),
  songImportText: "",
  setSongImportText: (v) => set({ songImportText: v }),
  showSongImport: false,
  setShowSongImport: (v) => set({ showSongImport: v }),

  // Lower Third
  ltMode: "nameplate",
  setLtMode: (v) => set({ ltMode: v }),
  ltVisible: false,
  setLtVisible: (v) => set({ ltVisible: v }),
  ltTemplate: {
    id: "default", name: "Default",
    bgType: "solid", bgColor: "#000000", bgOpacity: 85, bgGradientEnd: "#141428", bgBlur: false,
    accentEnabled: true, accentColor: "#f59e0b", accentSide: "left", accentWidth: 4,
    hAlign: "left", vAlign: "bottom", offsetX: 48, offsetY: 40,
    widthPct: 60, paddingX: 24, paddingY: 16, borderRadius: 12,
    primaryFont: "Georgia", primarySize: 36, primaryColor: "#ffffff",
    primaryBold: true, primaryItalic: false, primaryUppercase: false,
    secondaryFont: "Arial", secondarySize: 22, secondaryColor: "#f59e0b",
    secondaryBold: false, secondaryItalic: false, secondaryUppercase: false,
    labelVisible: true, labelColor: "#f59e0b", labelSize: 13, labelUppercase: true,
    animation: "slide-up",
    variant: "classic",
    scrollEnabled: false, scrollDirection: "ltr", scrollSpeed: 5,
  },
  setLtTemplate: (v) => set((s) => ({ ltTemplate: typeof v === "function" ? v(s.ltTemplate) : v })),
  ltSavedTemplates: [],
  setLtSavedTemplates: (v) => set({ ltSavedTemplates: v }),
  ltDesignOpen: false,
  setLtDesignOpen: (v) => set({ ltDesignOpen: v }),
  showLtImgPicker: false,
  setShowLtImgPicker: (v) => set({ showLtImgPicker: v }),
  ltName: "",
  setLtName: (v) => set({ ltName: v }),
  ltTitle: "",
  setLtTitle: (v) => set({ ltTitle: v }),
  ltFreeText: "",
  setLtFreeText: (v) => set({ ltFreeText: v }),
  ltSongId: null,
  setLtSongId: (v) => set({ ltSongId: v }),
  ltLineIndex: 0,
  setLtLineIndex: (v) => set((s) => ({ ltLineIndex: typeof v === "function" ? v(s.ltLineIndex) : v })),
  ltLinesPerDisplay: 2,
  setLtLinesPerDisplay: (v) => set({ ltLinesPerDisplay: v }),
  ltAutoAdvance: false,
  setLtAutoAdvance: (v) => set({ ltAutoAdvance: v }),
  ltAutoSeconds: 4,
  setLtAutoSeconds: (v) => set({ ltAutoSeconds: v }),
  ltAtEnd: false,
  setLtAtEnd: (v) => set({ ltAtEnd: v }),

  // Schedule
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

  // Props Layer
  propItems: [],
  setPropItems: (v) => set({ propItems: v }),

  // Media
  media: [],
  setMedia: (v) => set({ media: v }),
  cameras: [],
  setCameras: (v) => set({ cameras: v }),
  enabledLocalCameras: new Set<string>(),
  setEnabledLocalCameras: (v) => set((s) => ({ enabledLocalCameras: typeof v === "function" ? v(s.enabledLocalCameras) : v })),
  mediaFilter: "image",
  setMediaFilter: (v) => set({ mediaFilter: v }),
  pauseWhisper: localStorage.getItem("pref_pauseWhisper") === "true",
  setPauseWhisper: (v) => set((s) => ({ pauseWhisper: typeof v === "function" ? v(s.pauseWhisper) : v })),
  showLogoPicker: false,
  setShowLogoPicker: (v) => set({ showLogoPicker: v }),
  showGlobalBgPicker: false,
  setShowGlobalBgPicker: (v) => set({ showGlobalBgPicker: v }),

  // Presentations (PPTX)
  presentations: [],
  setPresentations: (v) => set({ presentations: v }),
  selectedPresId: null,
  setSelectedPresId: (v) => set({ selectedPresId: v }),
  loadedSlides: {},
  setLoadedSlides: (v) => set({ loadedSlides: v }),
  libreOfficeAvailable: false,
  setLibreOfficeAvailable: (v) => set({ libreOfficeAvailable: v }),
  pptxPngSlides: {},
  setPptxPngSlides: (v) => set((s) => ({ pptxPngSlides: typeof v === "function" ? v(s.pptxPngSlides) : v })),

  // Session / Audio
  transcript: "",
  setTranscript: (v) => set({ transcript: v }),
  devices: [],
  setDevices: (v) => set({ devices: v }),
  selectedDevice: "",
  setSelectedDevice: (v) => set({ selectedDevice: v }),
  vadThreshold: parseFloat(localStorage.getItem("pref_vadThreshold") ?? "0.002"),
  setVadThreshold: (v) => set({ vadThreshold: v }),
  transcriptionWindowSec: parseFloat(localStorage.getItem("pref_transcriptionWindowSec") ?? "1.0"),
  setTranscriptionWindowSec: (v) => set({ transcriptionWindowSec: v }),
  sessionState: "idle",
  setSessionState: (v) => set({ sessionState: v }),
  audioError: null,
  setAudioError: (v) => set({ audioError: v }),
  deviceError: null,
  setDeviceError: (v) => set({ deviceError: v }),
  micLevel: 0,
  setMicLevel: (v) => set({ micLevel: v }),

  // Remote Control
  remoteUrl: "",
  setRemoteUrl: (v) => set({ remoteUrl: v }),
  remotePin: "",
  setRemotePin: (v) => set({ remotePin: v }),
  tailscaleUrl: null,
  setTailscaleUrl: (v) => set({ tailscaleUrl: v }),

  // Bible
  availableVersions: ["KJV"],
  setAvailableVersions: (v) => set({ availableVersions: v }),
  bibleVersion: "KJV",
  setBibleVersion: (v) => set({ bibleVersion: v }),
  books: [],
  setBooks: (v) => set({ books: v }),
  chapters: [],
  setChapters: (v) => set({ chapters: v }),
  verses: [],
  setVerses: (v) => set({ verses: v }),
  selectedBook: "",
  setSelectedBook: (v) => set((s) => ({ selectedBook: typeof v === "function" ? v(s.selectedBook) : v })),
  selectedChapter: 0,
  setSelectedChapter: (v) => set({ selectedChapter: v }),
  selectedVerse: 0,
  setSelectedVerse: (v) => set({ selectedVerse: v }),
  searchQuery: "",
  setSearchQuery: (v) => set({ searchQuery: v }),
  searchResults: [],
  setSearchResults: (v) => set({ searchResults: v }),
  bibleOpen: { quickEntry: true, manualSelection: true, keywordSearch: true },
  setBibleOpen: (v) => set((s) => ({ bibleOpen: typeof v === "function" ? v(s.bibleOpen) : v })),
}));
