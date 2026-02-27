import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { Verse } from "../../types";

export interface BibleSlice {
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

export const createBibleSlice: StateCreator<AppStore, [], [], BibleSlice> = (set) => ({
  availableVersions: [],
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
});
