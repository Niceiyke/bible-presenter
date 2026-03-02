import { StateCreator } from "zustand";
import { AppStore } from "../index";

export interface ModelStatus {
  id: string;
  display_name: string;
  filename: string;
  size_mb: number;
  downloaded: boolean;
  path: string | null;
  is_active: boolean;
  is_recommended: boolean;
}

export interface DownloadProgress {
  model_id: string;
  bytes_downloaded: number;
  total_bytes: number;
  percent: number;
  done: boolean;
  error: string | null;
}

export interface HardwareInfo {
  cpu_cores: number;
  total_ram_mb: number;
  gpu_detected: boolean;
  gpu_name: string | null;
  recommended_model: string;
  recommendation_reason: string;
}

export interface TranscriptionConfig {
  active_model: string | null;
  use_gpu: boolean;
  cloud_provider: string | null; // "deepgram"|"openai"|"assemblyai"|"google"|null
  cloud_api_key: string | null;
  /** Override API hostname for enterprise endpoints. null = use provider default. */
  cloud_hostname: string | null;
  /** Model string passed to provider (e.g. "nova-2", "best", "whisper-1"). */
  cloud_model: string | null;
  /** BCP-47 language code (e.g. "en", "en-US"). null = provider default. */
  cloud_language: string | null;
  /** When true, auto-project suggested verses without operator confirmation. */
  auto_project: boolean;
  /** Seconds to hold a projected verse before allowing auto-replace. */
  verse_lock_secs: number;
  /** Minimum semantic similarity (0–1) to trigger auto-projection. */
  confidence_threshold: number;
}

export interface ModelSlice {
  whisperModels: ModelStatus[];
  setWhisperModels: (v: ModelStatus[]) => void;

  downloadProgress: Record<string, DownloadProgress>;
  setDownloadProgress: (model_id: string, p: DownloadProgress | null) => void;

  hardwareInfo: HardwareInfo | null;
  setHardwareInfo: (v: HardwareInfo | null) => void;

  transcriptionConfig: TranscriptionConfig;
  setTranscriptionConfig: (v: TranscriptionConfig) => void;
}

export const createModelSlice: StateCreator<AppStore, [], [], ModelSlice> = (set) => ({
  whisperModels: [],
  setWhisperModels: (v) => set({ whisperModels: v }),

  downloadProgress: {},
  setDownloadProgress: (model_id, p) =>
    set((s) => {
      const next = { ...s.downloadProgress };
      if (p === null) {
        delete next[model_id];
      } else {
        next[model_id] = p;
      }
      return { downloadProgress: next };
    }),

  hardwareInfo: null,
  setHardwareInfo: (v) => set({ hardwareInfo: v }),

  transcriptionConfig: {
    active_model: null, use_gpu: false,
    cloud_provider: null, cloud_api_key: null,
    cloud_hostname: null, cloud_model: null, cloud_language: null,
    auto_project: false, verse_lock_secs: 8, confidence_threshold: 0.55,
  },
  setTranscriptionConfig: (v) => set({ transcriptionConfig: v }),
});
