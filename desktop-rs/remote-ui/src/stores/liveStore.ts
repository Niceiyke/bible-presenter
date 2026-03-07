import { create } from 'zustand';
import type { DisplayItem, LtTemplate } from '../api/types';

interface LiveState {
  liveItem: DisplayItem | null;
  ltShowing: boolean;
  isOutputBlanked: boolean;
  transcription: string;
  ltTemplates: LtTemplate[];
  selectedTemplateIdx: number | null; // null = default

  setLiveItem: (item: DisplayItem | null) => void;
  setLtShowing: (v: boolean) => void;
  setBlanked: (v: boolean) => void;
  setTranscription: (t: string) => void;
  setLtTemplates: (t: LtTemplate[]) => void;
  setSelectedTemplate: (idx: number | null) => void;
}

export const useLiveStore = create<LiveState>((set) => ({
  liveItem: null,
  ltShowing: false,
  isOutputBlanked: false,
  transcription: '',
  ltTemplates: [],
  selectedTemplateIdx: null,

  setLiveItem: (liveItem) => set({ liveItem }),
  setLtShowing: (ltShowing) => set({ ltShowing }),
  setBlanked: (isOutputBlanked) => set({ isOutputBlanked }),
  setTranscription: (transcription) => set({ transcription }),
  setLtTemplates: (ltTemplates) => set({ ltTemplates }),
  setSelectedTemplate: (selectedTemplateIdx) => set({ selectedTemplateIdx }),
}));
