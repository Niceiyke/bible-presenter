import { create } from 'zustand';
import type { Song } from '../api/types';

export interface FlatLine { sectionLabel: string; text: string; }

interface SongsState {
  songs: Song[];
  filter: string;
  selectedSong: Song | null;
  flatLines: FlatLine[];
  lineIdx: number;
  linesMode: 1 | 2;

  setSongs: (s: Song[]) => void;
  setFilter: (f: string) => void;
  selectSong: (s: Song) => void;
  setLineIdx: (i: number) => void;
  nextLine: () => void;
  prevLine: () => void;
  setLinesMode: (m: 1 | 2) => void;
}

function buildFlatLines(song: Song): FlatLine[] {
  const sectionMap = Object.fromEntries(song.sections.map(s => [s.label, s]));
  const ordered = song.arrangement.length > 0
    ? song.arrangement.map(label => sectionMap[label]).filter(Boolean)
    : song.sections;
  const lines: FlatLine[] = [];
  for (const sec of ordered) {
    sec.lines.forEach((text, i) => {
      lines.push({ sectionLabel: i === 0 ? sec.label : '', text });
    });
  }
  return lines;
}

export const useSongsStore = create<SongsState>((set, get) => ({
  songs: [],
  filter: '',
  selectedSong: null,
  flatLines: [],
  lineIdx: 0,
  linesMode: 1,

  setSongs: (songs) => set({ songs }),
  setFilter: (filter) => set({ filter }),
  selectSong: (s) => set({ selectedSong: s, flatLines: buildFlatLines(s), lineIdx: 0 }),
  setLineIdx: (lineIdx) => set({ lineIdx }),
  nextLine: () => {
    const { lineIdx, flatLines } = get();
    if (lineIdx < flatLines.length - 1) set({ lineIdx: lineIdx + 1 });
  },
  prevLine: () => {
    const { lineIdx } = get();
    if (lineIdx > 0) set({ lineIdx: lineIdx - 1 });
  },
  setLinesMode: (linesMode) => set({ linesMode }),
}));
