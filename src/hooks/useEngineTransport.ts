import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TransportStatus } from "../types/engine";

/**
 * `useEngineTransport` — Phase D transport status polling.
 *
 * The `wordlyte-engine` sidecar owns the whole encode → fan-out → mux pipeline
 * (one shared H.264 ffmpeg encoder, per-session mux-only ffmpeg for RTMP and
 * MP4 recording). The console's `rtmp_status` / `recording_status` commands are
 * thin proxies over the engine's session table; this hook polls both and
 * exposes the live session map keyed by session id.
 *
 * Polling only runs while `enabled` so the app doesn't generate stdio traffic
 * when no surface is watching.
 */
export interface UseEngineTransportResult {
  /** Active RTMP sessions keyed by session id (destination id). */
  rtmp: Record<string, TransportStatus>;
  /** Active recording sessions keyed by session id. */
  recording: Record<string, TransportStatus>;
  connected: boolean;
  error: string | null;
}

const POLL_INTERVAL_MS = 1000;

export function useEngineTransport(enabled: boolean): UseEngineTransportResult {
  const [rtmp, setRtmp] = useState<Record<string, TransportStatus>>({});
  const [recording, setRecording] = useState<Record<string, TransportStatus>>({});
  // Optimistic: the sidecar is spawned alongside the console, so treat the
  // transport as available until a poll actually fails (a failed poll flips
  // this false within one interval). Otherwise surfaces would be gated before
  // the first poll completes.
  const [connected, setConnected] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  const poll = useCallback(async () => {
    try {
      const [rtmpStatus, recordingStatus] = await Promise.all([
        invoke<TransportStatus[]>("rtmp_status"),
        invoke<TransportStatus[]>("recording_status"),
      ]);
      if (!aliveRef.current) return;
      const rtmpMap: Record<string, TransportStatus> = {};
      for (const s of rtmpStatus) rtmpMap[s.id] = s;
      const recMap: Record<string, TransportStatus> = {};
      for (const s of recordingStatus) recMap[s.id] = s;
      setRtmp(rtmpMap);
      setRecording(recMap);
      setConnected(true);
      setError(null);
    } catch (e: any) {
      if (!aliveRef.current) return;
      setConnected(false);
      setError(e?.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    if (!enabled) return;
    poll();
    const id = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(id);
    };
  }, [enabled, poll]);

  return { rtmp, recording, connected, error };
}