import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { Song, DEFAULT_LT_TEMPLATE } from "../../types";
import type { LowerThirdData, LowerThirdTemplate } from "../../types";

export interface LtLivePayload {
  data: LowerThirdData;
  template: LowerThirdTemplate;
}

export interface LowerThirdSlice {
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
  currentLowerThird: LtLivePayload | null;
  setCurrentLowerThird: (v: LtLivePayload | null) => void;
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
  ltPreviewBg: "dark" | "green" | "checkered";
  setLtPreviewBg: (v: "dark" | "green" | "checkered") => void;
  songs: Song[];
  setSongs: (v: Song[]) => void;
  hymnLibrary: Song[];
  setHymnLibrary: (v: Song[]) => void;
  /** P2: transient Quick Lyrics draft — never persisted, never in `songs`. */
  quickLyricsText: string;
  setQuickLyricsText: (v: string) => void;
}

export const createLowerThirdSlice: StateCreator<AppStore, [], [], LowerThirdSlice> = (set) => ({
  ltMode: "nameplate",
  setLtMode: (v) => set({ ltMode: v }),
  ltVisible: false,
  setLtVisible: (v) => set({ ltVisible: v }),
  ltTemplate: DEFAULT_LT_TEMPLATE,
  setLtTemplate: (v) => set((s) => ({ ltTemplate: typeof v === "function" ? v(s.ltTemplate) : v })),
  ltSavedTemplates: [DEFAULT_LT_TEMPLATE],
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
  currentLowerThird: null,
  setCurrentLowerThird: (v) => set({ currentLowerThird: v }),
  ltSongId: null,
  setLtSongId: (v) => set({ ltSongId: v }),
  ltLineIndex: 0,
  setLtLineIndex: (v) => set((s) => ({ ltLineIndex: typeof v === "function" ? v(s.ltLineIndex) : v })),
  ltLinesPerDisplay: 1,
  setLtLinesPerDisplay: (v: 1 | 2) => set({ ltLinesPerDisplay: v }),
  ltAutoAdvance: false,
  setLtAutoAdvance: (v) => set({ ltAutoAdvance: v }),
  ltAutoSeconds: 4,
  setLtAutoSeconds: (v) => set({ ltAutoSeconds: v }),
  ltAtEnd: false,
  setLtAtEnd: (v) => set({ ltAtEnd: v }),
  ltPreviewBg: "dark",
  setLtPreviewBg: (v) => set({ ltPreviewBg: v }),
  songs: [],
  setSongs: (v) => set({ songs: v }),
  hymnLibrary: [],
  setHymnLibrary: (v) => set({ hymnLibrary: v }),
  quickLyricsText: "",
  setQuickLyricsText: (v) => set({ quickLyricsText: v }),
});
