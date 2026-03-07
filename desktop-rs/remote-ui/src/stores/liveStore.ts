import { create } from 'zustand';
import type { DisplayItem, LtTemplate, LtPreset, RemoteOperator } from '../api/types';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'warn' | 'error';
}

interface LiveState {
  liveItem: DisplayItem | null;
  stagedItem: DisplayItem | null;
  ltShowing: boolean;
  isOutputBlanked: boolean;
  transcription: string;
  ltTemplates: LtTemplate[];
  selectedTemplateIdx: number | null;
  ltPresets: LtPreset[];
  /** Connected non-mobile remote operators */
  operators: RemoteOperator[];
  /** Name of last operator who changed the live item */
  lastChangedBy: string | null;
  /** Transient toast notification */
  toast: Toast | null;

  setLiveItem: (item: DisplayItem | null) => void;
  setStagedItem: (item: DisplayItem | null) => void;
  setLtShowing: (v: boolean) => void;
  setBlanked: (v: boolean) => void;
  setTranscription: (t: string) => void;
  setLtTemplates: (t: LtTemplate[]) => void;
  setSelectedTemplate: (idx: number | null) => void;
  setLtPresets: (p: LtPreset[]) => void;
  setOperators: (ops: RemoteOperator[]) => void;
  setLastChangedBy: (name: string | null) => void;
  showToast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: () => void;
}

let toastSeq = 0;

export const useLiveStore = create<LiveState>((set) => ({
  liveItem: null,
  stagedItem: null,
  ltShowing: false,
  isOutputBlanked: false,
  transcription: '',
  ltTemplates: [],
  selectedTemplateIdx: null,
  ltPresets: [],
  operators: [],
  lastChangedBy: null,
  toast: null,

  setLiveItem: (liveItem) => set({ liveItem }),
  setStagedItem: (stagedItem) => set({ stagedItem }),
  setLtShowing: (ltShowing) => set({ ltShowing }),
  setBlanked: (isOutputBlanked) => set({ isOutputBlanked }),
  setTranscription: (transcription) => set({ transcription }),
  setLtTemplates: (ltTemplates) => set({ ltTemplates }),
  setSelectedTemplate: (selectedTemplateIdx) => set({ selectedTemplateIdx }),
  setLtPresets: (ltPresets) => set({ ltPresets }),
  setOperators: (operators) => set({ operators }),
  setLastChangedBy: (lastChangedBy) => set({ lastChangedBy }),
  showToast: (message, kind = 'info') => {
    const id = ++toastSeq;
    set({ toast: { id, message, kind } });
    setTimeout(() => set(s => s.toast?.id === id ? { toast: null } : {}), 3500);
  },
  dismissToast: () => set({ toast: null }),
}));
