import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { invoke } from "@tauri-apps/api/core";

export interface Recording {
  id: string;
  name: string;
  duration: string;
  date: string;
  path: string;
  size_mb: number;
  transcribed: boolean;
  _ts?: number; // Cache buster
}

export interface AudioStudioSlice {
  recordings: Recording[];
  selectedRecording: Recording | null;
  devices: [string, string][];
  selectedDevice: string;
  isRecording: boolean;
  isImporting: boolean;
  isTranscribing: boolean;
  isTrimming: boolean;
  micLevel: number;
  transMode: "local" | "cloud";
  error: string | null;
  
  // Actions
  setRecordings: (recordings: Recording[]) => void;
  setSelectedRecording: (recording: Recording | null) => void;
  setDevices: (devices: [string, string][]) => void;
  setSelectedDevice: (device: string) => void;
  setIsRecording: (v: boolean) => void;
  setIsImporting: (v: boolean) => void;
  setIsTranscribing: (v: boolean) => void;
  setIsTrimming: (v: boolean) => void;
  setMicLevel: (v: number) => void;
  setTransMode: (v: "local" | "cloud") => void;
  setError: (v: string | null) => void;
  
  // Async Actions
  fetchRecordings: (autoSelectId?: string) => Promise<void>;
  fetchDevices: () => Promise<void>;
  handleDeviceChange: (name: string) => Promise<void>;
  handleStartRecording: () => Promise<void>;
  handleStopRecording: () => Promise<void>;
  handleDeleteRecording: (id: string) => Promise<void>;
  handleRenameRecording: (id: string, newName: string) => Promise<void>;
  handleTranscribe: (id: string, mode: "local" | "cloud") => Promise<void>;
}

export const createAudioStudioSlice: StateCreator<AppStore, [], [], AudioStudioSlice> = (set, get) => ({
  recordings: [],
  selectedRecording: null,
  devices: [],
  selectedDevice: "",
  isRecording: false,
  isImporting: false,
  isTranscribing: false,
  isTrimming: false,
  micLevel: 0,
  transMode: "local",
  error: null,

  setRecordings: (recordings) => set({ recordings }),
  setSelectedRecording: (recording) => set({ selectedRecording: recording }),
  setDevices: (devices) => set({ devices }),
  setSelectedDevice: (selectedDevice) => set({ selectedDevice }),
  setIsRecording: (isRecording) => set({ isRecording }),
  setIsImporting: (isImporting) => set({ isImporting }),
  setIsTranscribing: (isTranscribing) => set({ isTranscribing }),
  setIsTrimming: (isTrimming) => set({ isTrimming }),
  setMicLevel: (micLevel) => set({ micLevel }),
  setTransMode: (transMode) => set({ transMode }),
  setError: (error) => set({ error }),

  fetchRecordings: async (autoSelectId) => {
    try {
      const list = await invoke<Recording[]>("list_studio_recordings");
      set({ recordings: list });
      if (autoSelectId) {
        const found = list.find((r) => r.id === autoSelectId);
        if (found) set({ selectedRecording: found });
      }
    } catch (error) {
      console.error("Failed to fetch recordings:", error);
    }
  },

  fetchDevices: async () => {
    try {
      const devices = await invoke<[string, string][]>("get_audio_devices");
      set({ devices });
    } catch (error) {
      console.error("Failed to fetch devices:", error);
    }
  },

  handleDeviceChange: async (name) => {
    set({ selectedDevice: name });
    try {
      await invoke("set_studio_device", { deviceName: name });
    } catch (error) {
      console.error("Failed to set studio device:", error);
    }
  },

  handleStartRecording: async () => {
    try {
      await invoke("start_studio_recording");
      set({ isRecording: true });
    } catch (error) {
      console.error("Failed to start recording:", error);
      throw error;
    }
  },

  handleStopRecording: async () => {
    try {
      await invoke("stop_studio_recording");
      set({ isRecording: false });
    } catch (error) {
      console.error("Failed to stop recording:", error);
    }
  },

  handleDeleteRecording: async (id) => {
    try {
      await invoke("delete_studio_recording", { id });
      const { recordings, selectedRecording, fetchRecordings } = get();
      if (selectedRecording?.id === id) {
        set({ selectedRecording: null });
      }
      await fetchRecordings();
    } catch (error) {
      console.error("Failed to delete recording:", error);
    }
  },

  handleRenameRecording: async (id, newName) => {
    try {
      await invoke("rename_studio_recording", { id, newName });
      const { fetchRecordings, selectedRecording } = get();
      await fetchRecordings();
      if (selectedRecording?.id === id) {
        set({ 
          selectedRecording: { 
            ...selectedRecording, 
            name: newName, 
            id: newName,
            path: selectedRecording.path.replace(/[^\/]+\.wav$/, `${newName}.wav`)
          } 
        });
      }
    } catch (error) {
      console.error("Failed to rename recording:", error);
      throw error;
    }
  },

  handleTranscribe: async (id, mode) => {
    try {
      set({ isTranscribing: true });
      await invoke("transcribe_studio_recording", { id, mode });
    } catch (error) {
      set({ isTranscribing: false });
      console.error("Failed to transcribe:", error);
      throw error;
    }
  },
});
