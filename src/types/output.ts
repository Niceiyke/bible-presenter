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

export interface OutputConfig {
  id: string;
  kind: OutputKind;
  label: string;
  enabled: boolean;
  visible: boolean;
  source: OutputSource;
  geometry: OutputGeometry;
  presentation?: OutputPresentation;
  overlays: OutputOverlays;
  /** Window-specific: Tauri window label this binds to. */
  window_label?: string;
  recording?: OutputRecording;
  streaming?: OutputStreaming;
}

/** Runtime status of an output (ephemeral, not persisted). */
export interface OutputState {
  id: string;
  visible: boolean;
  rendering: boolean;
  fps: number;
  error?: string;
}