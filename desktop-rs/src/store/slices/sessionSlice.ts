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
  remoteClientCount: number;
  setRemoteClientCount: (v: number) => void;
  transcript: string;
  setTranscript: (v: string) => void;
  devices: [string, string][];
  setDevices: (v: [string, string][]) => void;
  selectedDevice: string;
  setSelectedDevice: (v: string) => void;
  vadThreshold: number;
  setVadThreshold: (v: number) => void;
  transcriptionWindowSec: number;
  setTranscriptionWindowSec: (v: number) => void;
  sessionState: "idle" | "loading" | "running";
  setSessionState: (v: "idle" | "loading" | "running") => void;
  audioError: string | null;
  setAudioError: (v: string | null) => void;
  deviceError: string | null;
  setDeviceError: (v: string | null) => void;
  micLevel: number;
  setMicLevel: (v: number | ((prev: number) => number)) => void;
  remoteUrl: string;
  setRemoteUrl: (v: string) => void;
  lanUrls: [string, string][];
  setLanUrls: (v: [string, string][]) => void;
  remotePin: string;
  setRemotePin: (v: string) => void;
  tailscaleUrl: string | null;
  setTailscaleUrl: (v: string | null) => void;
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
  remoteClientCount: 0,
  setRemoteClientCount: (v) => set({ remoteClientCount: v }),
  transcript: "",
  setTranscript: (v) => set({ transcript: v }),
  devices: [],
  setDevices: (v) => set({ devices: v }),
  selectedDevice: "",
  setSelectedDevice: (v) => set({ selectedDevice: v }),
  vadThreshold: parseFloat(localStorage.getItem("pref_vadThreshold") ?? "0.002"),
  setVadThreshold: (v) => set({ vadThreshold: v }),
  transcriptionWindowSec: parseFloat(localStorage.getItem("pref_transcriptionWindowSec") ?? "1.0"),
  setTranscriptionWindowSec: (v) => set({ transcriptionWindowSec: v }),
  sessionState: "idle",
  setSessionState: (v) => set({ sessionState: v }),
  audioError: null,
  setAudioError: (v) => set({ audioError: v }),
  deviceError: null,
  setDeviceError: (v) => set({ deviceError: v }),
  micLevel: 0,
  setMicLevel: (v) => set((s) => ({ micLevel: typeof v === "function" ? v(s.micLevel) : v })),
  remoteUrl: "",
  setRemoteUrl: (v) => set({ remoteUrl: v }),
  lanUrls: [],
  setLanUrls: (v) => set({ lanUrls: v }),
  remotePin: "",
  setRemotePin: (v) => set({ remotePin: v }),
  tailscaleUrl: null,
  setTailscaleUrl: (v) => set({ tailscaleUrl: v }),
  sessionTranscript: [],
  setSessionTranscript: (v) => set({ sessionTranscript: v }),
  appendTranscriptSegment: (seg) =>
    set((s) => ({ sessionTranscript: [...s.sessionTranscript, seg] })),
  verseLockUntil: null,
  setVerseLockUntil: (v) => set({ verseLockUntil: v }),
  manualOverrideUntil: null,
  setManualOverrideUntil: (v) => set({ manualOverrideUntil: v }),
});
