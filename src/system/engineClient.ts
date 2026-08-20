import { invoke } from "@tauri-apps/api/core";
import type { EngineRequest, EngineReply } from "../types/engine";

/**
 * Engine client bridge (Phase C3). Sends one command to the `wordlyte-engine`
 * sidecar through the Tauri shell (`engine_invoke` command) and returns the
 * response plus every event frame the engine drained before it. The console
 * polls a cheap `ping` and the engine's window-host MJPEG preview frames ride
 * along in the reply's `events`.
 */
export async function engineInvoke(request: EngineRequest): Promise<EngineReply> {
  return invoke<EngineReply>("engine_invoke", { request });
}