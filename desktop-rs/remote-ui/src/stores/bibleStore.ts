import { create } from 'zustand';
import type { Verse } from '../api/types';

interface BibleState {
  versions: string[];
  currentVersion: string;
  books: string[];
  chapters: number[];
  verses: number[];
  selectedBook: string;
  selectedChapter: number;
  selectedVerse: number;
  navVerse: Verse | null;
  searchResults: Verse[];
  searchQuery: string;
  searchMode: 'keyword' | 'hybrid';

  setVersions: (v: string[]) => void;
  setCurrentVersion: (v: string) => void;
  setBooks: (b: string[]) => void;
  setChapters: (c: number[]) => void;
  setVerses: (v: number[]) => void;
  setSelectedBook: (b: string) => void;
  setSelectedChapter: (c: number) => void;
  setSelectedVerse: (v: number) => void;
  setNavVerse: (v: Verse | null) => void;
  setSearchResults: (r: Verse[]) => void;
  setSearchQuery: (q: string) => void;
  setSearchMode: (m: 'keyword' | 'hybrid') => void;
}

export const useBibleStore = create<BibleState>((set) => ({
  versions: [],
  currentVersion: '',
  books: [],
  chapters: [],
  verses: [],
  selectedBook: '',
  selectedChapter: 0,
  selectedVerse: 0,
  navVerse: null,
  searchResults: [],
  searchQuery: '',
  searchMode: 'keyword',

  setVersions: (versions) => set({ versions }),
  setCurrentVersion: (currentVersion) => set({ currentVersion }),
  setBooks: (books) => set({ books }),
  setChapters: (chapters) => set({ chapters }),
  setVerses: (verses) => set({ verses }),
  setSelectedBook: (selectedBook) => set({ selectedBook }),
  setSelectedChapter: (selectedChapter) => set({ selectedChapter }),
  setSelectedVerse: (selectedVerse) => set({ selectedVerse }),
  setNavVerse: (navVerse) => set({ navVerse }),
  setSearchResults: (searchResults) => set({ searchResults }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSearchMode: (searchMode) => set({ searchMode }),
}));
