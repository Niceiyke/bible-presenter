import { StateCreator } from "zustand";
import { AppStore } from "../index";

export interface SessionSlice {
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
  remotePin: string;
  setRemotePin: (v: string) => void;
  tailscaleUrl: string | null;
  setTailscaleUrl: (v: string | null) => void;
}

export const createSessionSlice: StateCreator<AppStore, [], [], SessionSlice> = (set) => ({
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
  remotePin: "",
  setRemotePin: (v) => set({ remotePin: v }),
  tailscaleUrl: null,
  setTailscaleUrl: (v) => set({ tailscaleUrl: v }),
});
