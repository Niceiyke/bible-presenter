import type { StreamDestination, StreamPlatform } from "../../types";

/**
 * Streaming Hub platform presets. The operator picks a platform and the form
 * pre-fills the ingest server; only the stream key is needed from their
 * dashboard. `Custom RTMP` / `Custom WHIP` cover anything else (Restream, SRS,
 * MediaMTX, Cloudflare Stream, …).
 */
export interface PlatformPreset {
  platform: StreamPlatform;
  label: string;
  mode: "whip" | "rtmp" | "ndi";
  /** Ingest server URL (no stream key). */
  url: string;
  /** Where the operator finds their key. */
  hint: string;
}

export const PLATFORM_PRESETS: PlatformPreset[] = [
  {
    platform: "youtube",
    label: "YouTube",
    mode: "rtmp",
    url: "rtmp://a.rtmp.youtube.com/live2",
    hint: "Stream key from YouTube Studio → Go live → Stream settings.",
  },
  {
    platform: "facebook",
    label: "Facebook Live",
    mode: "rtmp",
    url: "rtmp://live-api-s.facebook.com:443/rtmp",
    hint: "Stream key from the Facebook Live producer.",
  },
  {
    platform: "twitch",
    label: "Twitch",
    mode: "rtmp",
    url: "rtmp://live.twitch.tv/app",
    hint: "Stream key from the Twitch Creator Dashboard.",
  },
  {
    platform: "custom-rtmp",
    label: "Custom RTMP",
    mode: "rtmp",
    url: "",
    hint: "Any RTMP ingest — e.g. a Restream URL or your own media server.",
  },
  {
    platform: "custom-whip",
    label: "Custom WHIP",
    mode: "whip",
    url: "",
    hint: "Any WHIP endpoint — Cloudflare Stream, SRS, MediaMTX, Eyevinn.",
  },
  {
    platform: "ndi",
    label: "NDI",
    mode: "ndi",
    url: "",
    hint: "Publishes this machine's program as an NDI source on the LAN (NDI|HX) — consumable by OBS (obs-ndi), vMix, ProPresenter, and NDI-enabled gear. Requires the NDI SDK.",
  },
];

export function presetFor(platform: StreamPlatform): PlatformPreset {
  return PLATFORM_PRESETS.find((p) => p.platform === platform) ?? PLATFORM_PRESETS[3];
}

/** Generate a stable-enough destination id (not persisted across restarts). */
export function newDestinationId(): string {
  return `dest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a destination from a platform preset with a fresh id. */
export function makeDestination(platform: StreamPlatform, id?: string): StreamDestination {
  const preset = presetFor(platform);
  return {
    id: id ?? newDestinationId(),
    label: preset.label,
    platform: preset.platform,
    mode: preset.mode,
    url: preset.url,
    enabled: true,
    audio: true,
  };
}

/** Switch a destination to another platform preset, keeping its id + key. */
export function applyPreset(dest: StreamDestination, platform: StreamPlatform): StreamDestination {
  const preset = presetFor(platform);
  return { ...dest, label: preset.label, platform, mode: preset.mode, url: preset.url };
}
