import { useCallback, useEffect, useRef, useState } from "react";
import { engineInvoke } from "../system/engineClient";
import type { EngineEvent } from "../types/engine";

/**
 * Phase C3 — engine MJPEG preview frames.
 *
 * The `wordlyte-engine` winit host downscales + JPEG-encodes each rendered
 * window and pushes `PreviewFrame` events into its event buffer; the console
 * polls a cheap `ping` here and the frames ride along in the reply. This hook
 * decodes the base64 JPEGs into object URLs and exposes the latest frame per
 * window label, plus the engine connection state.
 *
 * Polling only runs while `enabled` (the preview panel is open) so the app
 * doesn't generate stdio traffic when no one is watching.
 */
export interface EnginePreviewFrameData {
  url: string;
  width: number;
  height: number;
  frameIndex: number;
}

export interface UseEnginePreviewResult {
  frames: Record<string, EnginePreviewFrameData>;
  connected: boolean;
  polling: boolean;
  error: string | null;
}

const POLL_INTERVAL_MS = 200;

function decodeBase64ToUrl(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
}

export function useEnginePreview(enabled: boolean): UseEnginePreviewResult {
  const [frames, setFrames] = useState<Record<string, EnginePreviewFrameData>>({});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const framesRef = useRef<Record<string, EnginePreviewFrameData>>({});
  const idRef = useRef(0);

  const handleEvents = useCallback((events: EngineEvent[]) => {
    let changed = false;
    for (const frame of events) {
      if (frame.event !== "preview_frame") continue;
      const p = frame as Extract<EngineEvent, { event: "preview_frame" }> & {
        width: number;
        height: number;
        image_base64: string;
      };
      const existing = framesRef.current[p.output_id];
      // Frames are monotonic per window — ignore out-of-order/duplicate emits.
      if (existing && existing.frameIndex >= p.frame_index) continue;
      const url = decodeBase64ToUrl(p.image_base64);
      if (existing) URL.revokeObjectURL(existing.url);
      framesRef.current[p.output_id] = {
        url,
        width: p.width,
        height: p.height,
        frameIndex: p.frame_index,
      };
      changed = true;
    }
    if (changed) setFrames({ ...framesRef.current });
  }, []);

  useEffect(() => {
    if (!enabled) {
      setPolling(false);
      return;
    }
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      const id = ++idRef.current;
      try {
        const reply = await engineInvoke({ id, command: { cmd: "ping" } });
        if (!alive) return;
        setConnected(true);
        setError(null);
        handleEvents(reply.events.map((f) => f.event));
      } catch (e: any) {
        if (!alive) return;
        setConnected(false);
        setError(e?.message ?? String(e));
      }
    };
    setPolling(true);
    poll();
    timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [enabled, handleEvents]);

  const [polling, setPolling] = useState(false);

  return { frames, connected, polling, error };
}