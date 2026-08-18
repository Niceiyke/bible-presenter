import { invoke } from "@tauri-apps/api/core";
import type { OutputState } from "../types";

const STREAM_OUTPUT_ID = "stream-main";
export { STREAM_OUTPUT_ID };

/**
 * Recorder/streamer runtime adapters push lifecycle transitions to the
 * OutputManager here (Phase 4). The backend merges the state into its runtime
 * map (it owns `started_at` derivation) and broadcasts `output-state-changed`
 * to every window, so the operator shell, the Recordings/Streaming workspaces,
 * and the backend all agree on a surface's phase. This path never touches the
 * presentation engine — a failed output can never change live program state.
 */
export async function reportOutputState(state: OutputState): Promise<void> {
  try {
    await invoke("report_output_state", { state });
  } catch (e: any) {
    console.error("report_output_state failed:", e);
  }
}

/**
 * Flip the persisted `visible` (operator-intent) flag for a recorder/streamer
 * output through the authoritative backend path. The backend persists FIRST,
 * then swaps config + runtime (re-seeding the phase) and broadcasts — so a
 * failed write leaves disk and runtime untouched, and the adapter can abort its
 * own state transition to stay consistent. Throws on failure; callers must not
 * report a `live`/`starting` phase if this rejects.
 */
export async function setOutputVisible(id: string, visible: boolean): Promise<void> {
  await invoke("outputs_set_visible", { id, visible });
}