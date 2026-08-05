import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { DisplayItem, Verse } from "../../types";

export interface RecentItems {
  bible: DisplayItem[];
  media: DisplayItem[];
  presentation: DisplayItem[];
}

export interface LiveSlice {
  liveItem: DisplayItem | null;
  setLiveItem: (v: DisplayItem | null) => void;
  previousItem: DisplayItem | null;
  setPreviousItem: (v: DisplayItem | null) => void;
  stagedItem: DisplayItem | null;
  setStagedItem: (v: DisplayItem | null) => void;
  nextVerse: Verse | null;
  setNextVerse: (v: Verse | null) => void;
  recentItems: RecentItems;
  setRecentItems: (v: RecentItems | ((prev: RecentItems) => RecentItems)) => void;
  historyOpen: boolean;
  setHistoryOpen: (v: boolean) => void;
  isBlackout: boolean;
  setIsBlackout: (v: boolean) => void;
}

export const createLiveSlice: StateCreator<AppStore, [], [], LiveSlice> = (set) => ({
  liveItem: null,
  setLiveItem: (v) => set({ liveItem: v }),
  previousItem: null,
  setPreviousItem: (v) => set({ previousItem: v }),
  stagedItem: null,
  setStagedItem: (v) => set({ stagedItem: v }),
  nextVerse: null,
  setNextVerse: (v) => set({ nextVerse: v }),
  recentItems: { bible: [], media: [], presentation: [] },
  setRecentItems: (v) => set((s) => ({ recentItems: typeof v === "function" ? v(s.recentItems) : v })),
  historyOpen: false,
  setHistoryOpen: (v) => set({ historyOpen: v }),
  isBlackout: false,
  setIsBlackout: (v) => set({ isBlackout: v }),
});
