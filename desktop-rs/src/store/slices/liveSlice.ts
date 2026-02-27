import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { DisplayItem, Verse } from "../../types";

export interface LiveSlice {
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
  setVerseHistory: (v: DisplayItem[] | ((prev: DisplayItem[]) => DisplayItem[])) => void;
  historyOpen: boolean;
  setHistoryOpen: (v: boolean) => void;
  isBlackout: boolean;
  setIsBlackout: (v: boolean) => void;
}

export const createLiveSlice: StateCreator<AppStore, [], [], LiveSlice> = (set) => ({
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
  setVerseHistory: (v) => set((s) => ({ verseHistory: typeof v === "function" ? v(s.verseHistory) : v })),
  historyOpen: false,
  setHistoryOpen: (v) => set({ historyOpen: v }),
  isBlackout: false,
  setIsBlackout: (v) => set({ isBlackout: v }),
});
