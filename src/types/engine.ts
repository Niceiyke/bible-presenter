import type { DisplayItem, PresentationSnapshot } from "./display";
import type { PresentationSettings } from "./settings";
import type { PropItem } from "./props";
import type { LowerThirdPayload } from "./lowerThird";
import type { OutputConfig } from "./output";

/**
 * Engine IPC contract (Phase A1). Wire contract between the Tauri operator
 * console and the standalone Rust video engine process
 * (`docs/RUST_VIDEO_ENGINE_PLAN.md`, `src-tauri/src/engine/ipc.rs`).
 *
 * Rules: one versioned contract (`ENGINE_PROTOCOL_VERSION` must match the Rust
 * const); commands are additive and typed; unknown commands/events are
 * tolerated via `#[serde(other)] Unknown` so a NEW client talking to an OLD
 * engine gets a clear "unsupported" response. The engine is the ONLY writer of
 * program state.
 */

/** Must equal `ENGINE_PROTOCOL_VERSION` in `src-tauri/src/engine/ipc.rs`. */
export const ENGINE_PROTOCOL_VERSION = 3;

/** Additive capability negotiation — matches `ENGINE_CAPABILITIES` (ipc.rs). */
export const ENGINE_CAPABILITIES = [
  "presentation",
  "output_windows",
  "recording",
  "streaming",
  "ndi",
  "preview_frames",
] as const;

/** A command the console sends to the engine. Mirrors the current Tauri
 *  command surface (serde `tag = "cmd"`, snake_case). */
export type EngineCommand =
  | { cmd: "ping" }
  | { cmd: "shutdown" }
  | { cmd: "presentation_snapshot" }
  | { cmd: "stage_item"; item: DisplayItem; source?: string | null }
  | { cmd: "commit_staged"; source?: string | null }
  | { cmd: "go_live"; source?: string | null }
  | { cmd: "send_live_item"; item: DisplayItem; source?: string | null }
  | { cmd: "go_live_item"; item: DisplayItem; source?: string | null }
  | { cmd: "clear_live"; source?: string | null }
  | { cmd: "clear_staged"; source?: string | null }
  | { cmd: "clear_all"; source?: string | null }
  | { cmd: "update_timer"; started_at?: number | null }
  | { cmd: "save_settings"; settings: PresentationSettings }
  | { cmd: "set_blackout"; on: boolean; source?: string | null }
  | { cmd: "set_logo"; on: boolean; source?: string | null }
  | { cmd: "show_lower_third"; data: LowerThirdPayload["data"]; template?: unknown; source?: string | null }
  | { cmd: "hide_lower_third"; source?: string | null }
  | { cmd: "set_props"; props: PropItem[] }
  | { cmd: "get_props" }
  | { cmd: "apply_scene"; id: string }
  | { cmd: "get_current_item" }
  | { cmd: "get_staged_item" }
  | { cmd: "get_settings" }
  // ---- Engine-owned output/stage windows (Phase C2) ----
  | { cmd: "output_window_show"; label: string; style: EngineWindowStyle; preferred_monitor?: string | null; width: number; height: number }
  | { cmd: "output_window_hide"; label: string }
  | { cmd: "output_window_set_monitor"; label: string; monitor: string }
  | { cmd: "output_window_resize"; label: string; width: number; height: number }
  | { cmd: "output_window_set_config"; label: string; config: OutputConfig }
  | { cmd: "list_monitors" }
  | { cmd: string };

/** One request frame on the stdio channel. */
export interface EngineRequest {
  id: number;
  command: EngineCommand;
}

/** Structured error returned by the engine. */
export interface EngineError {
  code: string;
  message: string;
}

/** One response frame. `ok` + `result` on success, `ok: false` + `error` on
 *  failure; `revision` lets the console advance its sync guard even when the
 *  mutation's events were also delivered. */
export interface EngineResponse {
  id: number;
  ok: boolean;
  revision?: number | null;
  error?: EngineError | null;
  result?: unknown;
}

/** An event the engine pushes to the console. Presentation events carry the
 *  presentation revision so `PresentationSync` drops stale broadcasts. */
/** A preview frame ready for console display (Phase C3). MJPEG bytes are
 *  base64-encoded inline so the frame rides the JSON event channel. */
export interface EnginePreviewFrame {
  output_id: string;
  frame_index: number;
  width: number;
  height: number;
  image_base64: string;
}

export type EngineEvent =
  | { event: "live_item_update"; detected_item: DisplayItem | null; revision: number }
  | { event: "item_staged"; item: DisplayItem | null; revision: number }
  | { event: "settings_changed"; settings: PresentationSettings; revision: number }
  | { event: "lower_third_update"; lower_third: unknown | null; revision: number }
  | { event: "props_update"; props: PropItem[]; revision: number }
  | { event: "output_state_changed"; output_id: string; state: unknown }
  | { event: "preview_frame"; output_id: string; frame_index: number } & EnginePreviewFrame
  | { event: "ndi_source_changed"; payload: unknown }
  | { event: string };

export interface EngineEventFrame {
  event: EngineEvent;
}

/** A relayed engine reply: the command response plus every event frame the
 *  engine drained before it (mirrors `engine::client::EngineReply`). */
export interface EngineReply {
  response: EngineResponse;
  events: EngineEventFrame[];
}

/** Window presentation attributes (mirrors `windows::WindowStyle` in the
 *  engine: decorations / transparent / always-on-top / resizable). */
export interface EngineWindowStyle {
  decorations: boolean;
  transparent: boolean;
  always_on_top: boolean;
  resizable: boolean;
}

/** A monitor as seen by the engine's winit host (mirrors `MonitorInfo`). */
export interface EngineMonitorInfo {
  name: string;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  scale_factor: number;
}

export type { PresentationSnapshot };