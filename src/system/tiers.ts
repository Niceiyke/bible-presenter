import type { LicenseTier } from "../types/license";

/**
 * Tier capability matrix (free / pro / premium).
 *
 * The authoritative plan comes from the license server at validation time and
 * is surfaced as `LicenseInfo.tier` (already degraded: a paid plan whose time
 * ran out reports `free` so the app keeps running at Free capability). This map
 * is the single place the frontend reads counts and flags from; the backend
 * re-checks the most sensitive gates (`remote_enable`, output reveal) itself.
 */
export interface TierCapabilities {
  /** Machine activation slots (server-enforced at issue time; informational). */
  maxMachines: number;
  /** Bible versions that may be enabled at once. */
  maxBibleVersions: number;
  /** On-air window outputs at once. */
  maxOutputs: number;
  /** Camera feeds usable at once. */
  maxCameras: number;
  /** Saved scenes. */
  maxScenes: number;
  /** Simultaneous streaming destinations in the hub. */
  streamingDestinations: number;
  /** Offline grace before revalidation is required (days). */
  offlineGraceDays: number;
  /** Free plan shows a Wordlyte watermark on the output window. */
  watermark: boolean;
  recording: boolean;
  streaming: boolean;
  remoteControl: boolean;
  ndi: boolean;
  sharedAudioInput: boolean;
  customTemplates: boolean;
}

export const TIER_CAPABILITIES: Record<LicenseTier, TierCapabilities> = {
  free: {
    maxMachines: 1,
    maxBibleVersions: 1,
    maxOutputs: 1,
    maxCameras: 1,
    maxScenes: 3,
    streamingDestinations: 0,
    offlineGraceDays: 14,
    watermark: true,
    recording: false,
    streaming: false,
    remoteControl: false,
    ndi: false,
    sharedAudioInput: false,
    customTemplates: false,
  },
  pro: {
    maxMachines: 3,
    maxBibleVersions: Infinity,
    maxOutputs: 2,
    maxCameras: 3,
    maxScenes: Infinity,
    streamingDestinations: 1,
    offlineGraceDays: 30,
    watermark: false,
    recording: true,
    streaming: true,
    remoteControl: true,
    ndi: true,
    sharedAudioInput: false,
    customTemplates: true,
  },
  premium: {
    maxMachines: Infinity,
    maxBibleVersions: Infinity,
    maxOutputs: Infinity,
    maxCameras: Infinity,
    maxScenes: Infinity,
    streamingDestinations: Infinity,
    offlineGraceDays: 30,
    watermark: false,
    recording: true,
    streaming: true,
    remoteControl: true,
    ndi: true,
    sharedAudioInput: true,
    customTemplates: true,
  },
};

export function tierCapabilities(tier?: LicenseTier | null): TierCapabilities {
  return TIER_CAPABILITIES[tier ?? "free"] ?? TIER_CAPABILITIES.free;
}

/**
 * Whether a workspace tab is available on the given capabilities. Gated
 * workspaces (Remote, Recordings, Streaming) are hidden from the nav and
 * redirected away from for plans that cannot use them.
 */
export function tabAllowed(tab: string, caps: TierCapabilities): boolean {
  switch (tab) {
    case "remote":
      return caps.remoteControl;
    case "recordings":
      return caps.recording;
    case "streaming":
      return caps.streaming;
    default:
      return true;
  }
}

export const TIER_LABELS: Record<LicenseTier, string> = {
  free: "Free",
  pro: "Pro",
  premium: "Premium",
};
