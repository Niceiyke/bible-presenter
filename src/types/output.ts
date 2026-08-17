import type { DisplayItem, BackgroundSetting } from "./";

/**
 * Output manager types (Phase 1).
 *
 * An Output is a configurable surface that subscribes to a program source and
 * renders it. Outputs never mutate engine state; they only subscribe. Kinds:
 *   - "window":    a Tauri webview (output / stage / a future overflow monitor).
 *   - "recorder":  a MediaRecorder on the program-feed canvas writing WebM.
 *   - "streamer":  a WebRTC/WHIP (or later RTMP/SRT) upload of the same stream.
 */

export type OutputKind = "window" | "recorder" | "streamer";

/** What an output renders. */
export type OutputSource =
  | { type: "live" } // the engine's live program feed
  | { type: "staged" } // the staged (up-next) item
  | { type: "scene"; scene_id: string } // pin to a saved scene
  | { type: "item"; item: DisplayItem } // fixed content, e.g. clock, logo
  | { type: "blank" }; // black/safe fallback

/** Presentation overrides. Absent = inherit engine settings. */
export interface OutputPresentation {
  theme?: string;
  reference_output_height?: number;
  background?: BackgroundSetting;
  blanked?: boolean;
}

/** Which overlay layers render on this output. */
export interface OutputOverlays {
  props: boolean;
  lower_third: boolean;
  logo: boolean;
}

/** Geometry — the render surface is sized to this. */
export interface OutputGeometry {
  width: number;
  height: number;
}

export interface OutputRecording {
  format: "webm";
  directory?: string;
}

export interface OutputStreaming {
  mode: "whip" | "rtmp" | "srt";
  url: string;
  stream_key?: string;
}

/** Platform presets the Streaming hub offers (Custom covers everything else). */
export type StreamPlatform =
  | "youtube"
  | "facebook"
  | "twitch"
  | "custom-rtmp"
  | "custom-whip"
  | "ndi";

/**
 * One streaming destination in the multi-platform hub. A preset + resolved
 * ingest endpoint; `enabled` joins the master Go Live and `audio` carries the
 * shared input track. Persisted on the `stream-main` output config.
 */
export interface StreamDestination {
  id: string;
  label: string;
  platform: StreamPlatform;
  mode: "whip" | "rtmp" | "ndi";
  url: string;
  stream_key?: string;
  enabled: boolean;
  audio: boolean;
}

export interface OutputConfig {
  id: string;
  kind: OutputKind;
  label: string;
  enabled: boolean;
  visible: boolean;
  source: OutputSource;
  geometry: OutputGeometry;
  /** Recorder/streamer capture frame rate. Window outputs ignore it; when
   *  absent the surfaces fall back to 30. */
  capture_fps?: number;
  presentation?: OutputPresentation;
  overlays: OutputOverlays;
  /** Window-specific: Tauri window label this binds to. */
  window_label?: string;
  recording?: OutputRecording;
  streaming?: OutputStreaming;
  /** Streamer-specific: multi-destination hub config. */
  stream_destinations?: StreamDestination[];
}

/** 16:9 capture resolutions offered to the recorder/streamer surfaces. */
export const CAPTURE_RESOLUTIONS = [
  { label: "1280×720", width: 1280, height: 720 },
  { label: "1600×900", width: 1600, height: 900 },
  { label: "1920×1080", width: 1920, height: 1080 },
  { label: "2560×1440", width: 2560, height: 1440 },
  { label: "3840×2160", width: 3840, height: 2160 },
] as const;

/** Capture frame rates offered to the recorder/streamer surfaces. */
export const CAPTURE_FPS_OPTIONS = [24, 25, 30, 50, 60] as const;

/** Runtime status of an output (ephemeral, not persisted). */
export interface OutputState {
  id: string;
  visible: boolean;
  rendering: boolean;
  fps: number;
  error?: string;
}