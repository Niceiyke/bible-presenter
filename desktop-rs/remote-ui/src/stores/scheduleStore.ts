import { create } from 'zustand';
import type { ScheduleEntry, MediaItem } from '../api/types';

interface ScheduleState {
  entries: ScheduleEntry[];
  mediaItems: MediaItem[];
  setEntries: (e: ScheduleEntry[]) => void;
  setMediaItems: (m: MediaItem[]) => void;
}

export const useScheduleStore = create<ScheduleState>((set) => ({
  entries: [],
  mediaItems: [],
  setEntries: (entries) => set({ entries }),
  setMediaItems: (mediaItems) => set({ mediaItems }),
}));
