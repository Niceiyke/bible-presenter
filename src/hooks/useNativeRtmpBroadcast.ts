import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StreamDestination } from "../types";

/**
 * Master transport for the native backend RTMP broadcast (Phase 6).
 *
 * One backend broadcast captures the dedicated off-screen `capture` window's
 * pixels (Windows Graphics Capture — the same program DOM surface as the
 * audience `output` window) and fans them out to N `ffmpeg` processes — one per
 * enabled RTMP destination — each encoding rawvideo -> libx264 -> FLV -> its
 * RTMP ingest. The operator starts/stops the whole broadcast at once; there is
 * no per-destination independent transport. Program audio (external mic /
 * line-in) is captured natively by ffmpeg and muxed into every enabled
 * destination when the broadcast is started with an `audioDevice` name.
 *
 * This hook is a thin controller around the `stream_rtmp_*` backend commands;
 * it polls `stream_rtmp_status` while a broadcast is live and exposes the
 * per-destination statuses so the hub cards can reflect reality.
 */

export interface NativeStreamDestStatus {
  id: string;
  label: string;
  active: boolean;
  url: string | null;
  frames: number;
  bytes: number;
  error: string | null;
  /** Whether program audio is attached and being muxed into this destination. */
  audioAttached: boolean;
}

export interface NativeStreamStatus {
  active: boolean;
  captureSessionId: string | null;
  width: number;
  height: number;
  fps: number;
  startedMs: number;
  destinations: NativeStreamDestStatus[];
}

const IDLE: NativeStreamStatus = {
  active: false,
  captureSessionId: null,
  width: 0,
  height: 0,
  fps: 0,
  startedMs: 0,
  destinations: [],
};

/** Map the display-status a card should render for a backend destination. */
export type DestDisplayStatus = "idle" | "live" | "error";

export interface NativeRtmpBroadcast {
  /** Whole-broadcast state. */
  status: NativeStreamStatus;
  /** True while a start/stop command is in flight (disable transports). */
  pending: boolean;
  /** Per-destination display status keyed by destination id. */
  destStatus: Record<string, { status: DestDisplayStatus; bitrateKbps: number }>;
  goLive: (
    destinations: StreamDestination[],
    width: number,
    height: number,
    fps: number,
    audioDevice?: string | null,
  ) => Promise<void>;
  stopAll: () => Promise<void>;
}

export function useNativeRtmpBroadcast(): NativeRtmpBroadcast {
  const [status, setStatus] = useState<NativeStreamStatus>(IDLE);
  const [pending, setPending] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<NativeStreamStatus>("stream_rtmp_status");
      setStatus(s);
    } catch {
      /* backend unavailable — keep last status */
    }
  }, []);

  // Poll while a broadcast is live; also refresh once on mount so a broadcast
  // started before this window opened is reflected immediately.
  useEffect(() => {
    void refresh();
    if (status.active) {
      pollRef.current = setInterval(() => void refresh(), 1000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [status.active, refresh]);

  const goLive = useCallback(
    async (
      destinations: StreamDestination[],
      width: number,
      height: number,
      fps: number,
      audioDevice?: string | null,
    ) => {
      setPending(true);
      try {
        const hasAudio = !!audioDevice && audioDevice.trim().length > 0;
        const payload = destinations
          .filter((d) => d.enabled && d.mode === "rtmp")
          .map((d) => ({
            id: d.id,
            label: d.label,
            url: d.url,
            streamKey: d.stream_key ?? null,
            enabled: true,
            audio: hasAudio,
          }));
        const s = await invoke<NativeStreamStatus>("stream_rtmp_start", {
          destinations: payload,
          width,
          height,
          fps,
          audioDevice: hasAudio ? audioDevice : null,
        });
        setStatus(s);
      } finally {
        setPending(false);
      }
    },
    []
  );

  const stopAll = useCallback(async () => {
    setPending(true);
    try {
      await invoke("stream_rtmp_stop");
      setStatus(IDLE);
    } finally {
      setPending(false);
    }
  }, []);

  // Derive per-destination display statuses: when the broadcast is active map
  // from the backend report; otherwise everything is idle.
  const destStatus: Record<string, { status: DestDisplayStatus; bitrateKbps: number }> = {};
  if (status.active) {
    for (const d of status.destinations) {
      destStatus[d.id] = {
        status: d.error ? "error" : "live",
        bitrateKbps: 0,
      };
    }
  }

  return { status, pending, destStatus, goLive, stopAll };
}
