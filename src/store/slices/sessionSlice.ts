import { StateCreator } from "zustand";
import { AppStore } from "../index";

export interface TranscriptSegment {
  text: string;
  timestamp_ms: number;
  is_final: boolean;
  source: string; // "deepgram" | "assemblyai" | "local"
}

export interface SessionSlice {
  startupIssues: string[];
  setStartupIssues: (v: string[]) => void;
  transcript: string;
  setTranscript: (v: string) => void;
  devices: [string, string][];
  setDevices: (v: [string, string][]) => void;
  operatorDevice: string;
  setOperatorDevice: (v: string) => void;
  preacherDevice: string;
  setPreacherDevice: (v: string) => void;
  transcriptionWindowSec: number;
  setTranscriptionWindowSec: (v: number) => void;
  sessionState: "idle" | "loading" | "running" | "stopping";
  setSessionState: (v: "idle" | "loading" | "running" | "stopping") => void;
  audioError: string | null;
  setAudioError: (v: string | null) => void;
  deviceError: string | null;
  setDeviceError: (v: string | null) => void;
  operatorMicLevel: number;
  setOperatorMicLevel: (v: number | ((prev: number) => number)) => void;
  preacherMicLevel: number;
  setPreacherMicLevel: (v: number | ((prev: number) => number)) => void;
  operatorMuted: boolean;
  setOperatorMuted: (v: boolean) => void;
  preacherMuted: boolean;
  setPreacherMuted: (v: boolean) => void;
  operatorRecordingActive: boolean;
  setOperatorRecordingActive: (v: boolean) => void;
  preacherRecordingActive: boolean;
  setPreacherRecordingActive: (v: boolean) => void;
  /** Full transcript log for the running service session. */
  sessionTranscript: TranscriptSegment[];
  setSessionTranscript: (v: TranscriptSegment[]) => void;
  appendTranscriptSegment: (seg: TranscriptSegment) => void;
  /**
   * Epoch ms until which the current verse is locked (no auto-replace).
   * null = no lock active.
   */
  verseLockUntil: number | null;
  setVerseLockUntil: (v: number | null) => void;
  /**
   * Epoch ms until which auto-detection is suppressed (operator just
   * manually selected a verse).
   * null = no override active.
   */
  manualOverrideUntil: number | null;
  setManualOverrideUntil: (v: number | null) => void;
}

export const createSessionSlice: StateCreator<AppStore, [], [], SessionSlice> = (set) => ({
  startupIssues: [],
  setStartupIssues: (v) => set({ startupIssues: v }),
  transcript: "",
  setTranscript: (v) => set({ transcript: v }),
  devices: [],
  setDevices: (v) => set({ devices: v }),
  operatorDevice: localStorage.getItem("pref_operatorDevice") ?? "",
  setOperatorDevice: (v) => set({ operatorDevice: v }),
  preacherDevice: localStorage.getItem("pref_preacherDevice") ?? "",
  setPreacherDevice: (v) => set({ preacherDevice: v }),
  transcriptionWindowSec: parseFloat(localStorage.getItem("pref_transcriptionWindowSec") ?? "1.0"),
  setTranscriptionWindowSec: (v) => set({ transcriptionWindowSec: v }),
  sessionState: "idle",
  setSessionState: (v) => set({ sessionState: v }),
  audioError: null,
  setAudioError: (v) => set({ audioError: v }),
  deviceError: null,
  setDeviceError: (v) => set({ deviceError: v }),
  operatorMicLevel: 0,
  setOperatorMicLevel: (v) => set((s) => ({ operatorMicLevel: typeof v === "function" ? v(s.operatorMicLevel) : v })),
  preacherMicLevel: 0,
  setPreacherMicLevel: (v) => set((s) => ({ preacherMicLevel: typeof v === "function" ? v(s.preacherMicLevel) : v })),
  operatorMuted: false,
  setOperatorMuted: (v) => set({ operatorMuted: v }),
  preacherMuted: false,
  setPreacherMuted: (v) => set({ preacherMuted: v }),
  operatorRecordingActive: false,
  setOperatorRecordingActive: (v) => set({ operatorRecordingActive: v }),
  preacherRecordingActive: false,
  setPreacherRecordingActive: (v) => set({ preacherRecordingActive: v }),
  sessionTranscript: [],
  setSessionTranscript: (v) => set({ sessionTranscript: v }),
  appendTranscriptSegment: (seg) =>
    set((s) => ({ sessionTranscript: [...s.sessionTranscript, seg] })),
  verseLockUntil: null,
  setVerseLockUntil: (v) => set({ verseLockUntil: v }),
  manualOverrideUntil: null,
  setManualOverrideUntil: (v) => set({ manualOverrideUntil: v }),
});
