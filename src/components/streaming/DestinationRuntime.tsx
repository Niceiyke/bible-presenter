import { useCallback, useEffect, useRef } from "react";
import { useStreamer } from "../../hooks/useStreamer";
import { useRtmpEncoder } from "../../hooks/useRtmpEncoder";
import { useNdiSender } from "../../hooks/useNdiSender";
import type { StreamDestination } from "../../types";
import type { DestTransportStatus, DestinationCardHandle } from "./DestinationCard";

/**
 * `DestinationRuntime` — non-visual transport owner for ONE streaming
 * destination (Phase 6.2 / WP2 P0-1 fix).
 *
 * The `StreamingProvider` renders one runtime child per destination so the
 * transport hooks (`useRtmpEncoder` / `useStreamer` / `useNdiSender`) stay
 * mounted for the lifetime of the app, even after the operator navigates away
 * from the Streaming workspace (which unmounts the UI-only `DestinationCard`s).
 * A live transport can therefore never be torn down by a workspace switch.
 *
 * The runtime registers a stable `start`/`stop` handle with the provider
 * (keyed by the destination id) and reports its transport status upward. It
 * renders nothing — the provider owns the composition and the cards only
 * consume status + drive commands.
 */
export interface DestinationRuntimeProps {
  destination: StreamDestination;
  /** Resolved at start time so edits don't invalidate running transports. */
  getSourceTracks: () => { video: MediaStreamTrack | null; audio: MediaStreamTrack | null };
  /** Master capture fps — fed to the RTMP/NDI encoder config. */
  fps?: number;
  /** Master capture bitrate (auto-derived from resolution/fps). */
  bitrateKbps?: number;
  onStatus: (
    id: string,
    status: DestTransportStatus,
    bitrateKbps: number,
    extra?: {
      error?: string | null;
      resourceUrl?: string | null;
      sentPackets?: number;
      droppedPackets?: number;
      queuedPackets?: number;
      reconnectAttempt?: number;
    }
  ) => void;
  onRegister: (id: string, handle: DestinationCardHandle | null) => void;
}

export function DestinationRuntime({
  destination: dest,
  getSourceTracks,
  fps = 30,
  bitrateKbps,
  onStatus,
  onRegister,
}: DestinationRuntimeProps) {
  const rtmp = useRtmpEncoder({ sessionId: dest.id, fps, bitrateKbps });
  const streamer = useStreamer();
  const ndi = useNdiSender({ sessionId: dest.id, fps, bitrateKbps });
  const streamRef = useRef<MediaStream | null>(null);
  const runningRef = useRef(false);

  const live = dest.mode === "rtmp" ? rtmp : dest.mode === "ndi" ? ndi : streamer;
  const active = live.status === "live" || live.status === "connecting";

  useEffect(() => {
    runningRef.current = active;
  }, [active]);

  const start = useCallback(async (): Promise<boolean> => {
    if (runningRef.current) return false;
    const { video, audio } = getSourceTracks();
    if (!video) return false;
    const v = video.clone();
    const a = dest.audio ? (audio ? audio.clone() : null) : null;
    const tracks: MediaStreamTrack[] = [v];
    if (a) tracks.push(a);
    const stream = new MediaStream(tracks);
    streamRef.current = stream;
    if (dest.mode === "rtmp") {
      return rtmp.start(stream, dest.url, dest.stream_key || undefined, a);
    }
    if (dest.mode === "ndi") {
      return ndi.start(stream, dest.label);
    }
    return streamer.start(stream, { url: dest.url, token: dest.stream_key });
  }, [dest, getSourceTracks, rtmp, ndi, streamer]);

  const stop = useCallback(async () => {
    if (dest.mode === "rtmp") {
      await rtmp.stop();
    } else if (dest.mode === "ndi") {
      await ndi.stop();
    } else {
      await streamer.stop();
    }
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [dest.mode, rtmp, ndi, streamer]);

  // Register the runtime handle. The runtime is always mounted while the
  // destination exists, so card unmounts can never deregister a live transport.
  useEffect(() => {
    onRegister(dest.id, { start, stop });
    return () => onRegister(dest.id, null);
  }, [onRegister, dest.id, start, stop]);

  // Report the transport status for the operator-facing cards/status map.
  const error = live.error ?? null;
  const resourceUrl = "resourceUrl" in live ? live.resourceUrl ?? null : null;
  const rt = live as typeof live & {
    sentPackets?: number;
    droppedPackets?: number;
    queuedPackets?: number;
    reconnectAttempt?: number;
  };
  useEffect(() => {
    onStatus(dest.id, live.status, live.bitrateKbps, {
      error,
      resourceUrl,
      sentPackets: rt.sentPackets ?? 0,
      droppedPackets: rt.droppedPackets ?? 0,
      queuedPackets: rt.queuedPackets ?? 0,
      reconnectAttempt: rt.reconnectAttempt ?? 0,
    });
  }, [dest.id, live.status, live.bitrateKbps, error, resourceUrl, rt.sentPackets, rt.droppedPackets, rt.queuedPackets, rt.reconnectAttempt, onStatus]);

  return null;
}