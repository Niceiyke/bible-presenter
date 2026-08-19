import { useCallback, useEffect, useRef, useState } from "react";

/**
 * `useStreamer` — WHIP (WebRTC HTTP Ingestion Protocol) client for the
 * output-manager streamer surface (Phase 4).
 *
 * Takes the `ProgramFeedCanvas` compositor's `MediaStream` and uploads it to a
 * WHIP endpoint: it gathers ICE candidates, POSTs the SDP offer as
 * `application/sdp` to the endpoint, applies the returned answer, and streams
 * over WebView2-native `RTCPeerConnection`. Config (url + bearer token) is
 * persisted separately via the existing `outputs_update` command (the
 * `stream-main` output's `streaming` field).
 *
 * The hook is window-agnostic and unit-testable: `RTCPeerConnection`/`fetch`
 * are the only globals, both stubbed in tests.
 */

export type StreamerStatus = "idle" | "connecting" | "live" | "error" | "reconnecting";

/// Bounded reconnect policy for transient WHIP failures (WP3 P1-1): up to
/// three attempts with exponential backoff (1s, 2s, 4s) before the destination
/// settles on `error`. A reconnect reuses the SAME destination id and stream.
export const MAX_RECONNECT_ATTEMPTS = 3;
export const RECONNECT_BASE_DELAY_MS = 1000;

export interface StreamerConfig {
  /** WHIP endpoint URL, e.g. https://example.com/whip/stream. */
  url: string;
  /** Optional bearer token (many servers use this as the stream key). */
  token?: string;
}

export interface UseStreamerOptions {
  /** ICE servers for candidate gathering. Defaults to Google STUN. */
  iceServers?: RTCIceServer[];
  /** Max ms to wait for ICE gathering before posting the offer. */
  gatherTimeoutMs?: number;
}

export interface UseStreamerResult {
  status: StreamerStatus;
  error: string | null;
  /** The WHIP resource URL returned in the Location header. */
  resourceUrl: string | null;
  /** Approximate upload bitrate in kbps (0 until connected). */
  bitrateKbps: number;
  /** 1-based reconnect attempt in progress (0 = not reconnecting). */
  reconnectAttempt: number;
  /** Start streaming. Resolves true when the peer reaches `connected`. */
  start: (stream: MediaStream, config: StreamerConfig) => Promise<boolean>;
  /** Stop streaming (best-effort DELETE of the WHIP resource) and tear down. */
  stop: () => Promise<void>;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        resolve();
      }
    };
  });
}

export function useStreamer(options: UseStreamerOptions = {}): UseStreamerResult {
  const { iceServers = DEFAULT_ICE_SERVERS, gatherTimeoutMs = 3000 } = options;
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const resourceUrlRef = useRef<string | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [status, setStatus] = useState<StreamerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [resourceUrl, setResourceUrl] = useState<string | null>(null);
  const [bitrateKbps, setBitrateKbps] = useState(0);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  /** Last successful start config/stream so a bounded reconnect can replay them
   *  with the SAME destination (never a duplicate peer/session). */
  const lastStartRef = useRef<{ stream: MediaStream; config: StreamerConfig } | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wantsActiveRef = useRef(false);

  const clearStats = useCallback(() => {
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    setBitrateKbps(0);
  }, []);

  const startBitratePolling = useCallback(() => {
    clearStats();
    const pc = pcRef.current;
    if (!pc) return;
    statsTimerRef.current = setInterval(async () => {
      const c = pcRef.current;
      if (!c) return;
      try {
        const stats = await c.getStats();
        let bytes = 0;
        stats.forEach((s) => {
          const st = s as RTCStats & { type: string };
          if (st.type === "outbound-rtp" && "bytesSent" in st) {
            bytes = Math.max(bytes, Number((st as any).bytesSent) || 0);
          }
        });
        setBitrateKbps(Math.round((bytes / 1024) * 8));
      } catch {
        // ignore transient getStats errors
      }
    }, 2000);
  }, [clearStats]);

  const teardown = useCallback(() => {
    clearStats();
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const pc = pcRef.current;
    if (pc) {
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // already closed
      }
    }
    pcRef.current = null;
    streamRef.current = null;
    resourceUrlRef.current = null;
    setResourceUrl(null);
  }, [clearStats]);

  // Failure path: bounded reconnect for transient WHIP failures (three attempts
  // with exponential backoff). A reconnect re-negotiates against the same
  // destination; after the cap the destination settles on `error`. `fail` and
  // `start` are mutually recursive, so each resolves the other through a ref.
  const failRef = useRef<(message: string) => void>(() => {});
  const startRef = useRef<(stream: MediaStream, config: StreamerConfig) => Promise<boolean>>(
    () => Promise.resolve(false)
  );

  const fail = useCallback(
    (message: string) => {
      if (!wantsActiveRef.current) return; // already stopping
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        wantsActiveRef.current = false;
        setStatus("error");
        setError(message);
        teardown();
        return;
      }
      reconnectAttemptsRef.current += 1;
      const attempt = reconnectAttemptsRef.current;
      setStatus("reconnecting");
      setError(message);
      setReconnectAttempt(attempt);
      // Clear the peer so a reconnect can create a fresh RTCPeerConnection.
      teardown();
      const delay = RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
      reconnectTimerRef.current = setTimeout(() => {
        const args = lastStartRef.current;
        if (!args || !wantsActiveRef.current) return;
        void startRef.current?.(args.stream, args.config);
      }, delay);
    },
    [teardown]
  );
  failRef.current = fail;

  const stop = useCallback(async () => {
    wantsActiveRef.current = false;
    reconnectAttemptsRef.current = 0;
    setReconnectAttempt(0);
    const resource = resourceUrlRef.current;
    teardown();
    setStatus("idle");
    setError(null);
    // Best-effort DELETE of the WHIP resource so the server frees the session.
    if (resource) {
      try {
        await fetch(resource, { method: "DELETE" });
      } catch {
        // Non-fatal: the server will reap idle sessions.
      }
    }
  }, [teardown]);

  const start = useCallback(
    async (stream: MediaStream, config: StreamerConfig): Promise<boolean> => {
      if (pcRef.current) return false;
      if (!config.url.trim()) {
        setStatus("error");
        setError("WHIP endpoint URL is empty.");
        return false;
      }
      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length === 0) {
        setStatus("error");
        setError("Stream has no video track to send.");
        return false;
      }
      if (typeof RTCPeerConnection === "undefined") {
        setStatus("error");
        setError("RTCPeerConnection is not available in this webview.");
        return false;
      }

      // Store the start args so a bounded reconnect can replay them with the
      // SAME destination (never a duplicate session/peer).
      lastStartRef.current = { stream, config };
      wantsActiveRef.current = true;

      let pc: RTCPeerConnection;
      try {
        pc = new RTCPeerConnection({ iceServers });
      } catch (e: any) {
        failRef.current(`Failed to create peer connection: ${e?.message ?? e}`);
        return false;
      }
      pcRef.current = pc;
      streamRef.current = stream;

      try {
        for (const track of stream.getTracks()) {
          pc.addTrack(track, stream);
        }

        pc.onconnectionstatechange = () => {
          const cs = pc.connectionState;
          if (cs === "connected") {
            // A successful (re)connect clears the reconnect budget.
            reconnectAttemptsRef.current = 0;
            setReconnectAttempt(0);
            setStatus("live");
            setError(null);
            startBitratePolling();
          } else if (cs === "failed" || cs === "closed") {
            const msg = cs === "failed" ? "Peer connection failed." : "Peer connection closed.";
            failRef.current(msg);
          }
          // "disconnected" is transient (renegotiation); stay live until failed.
        };

        setStatus("connecting");
        setError(null);

        const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc, gatherTimeoutMs);

        const local = pc.localDescription;
        if (!local) throw new Error("No local description after offer.");
        const sdp = local.sdp ?? "";

        const headers: Record<string, string> = {
          "Content-Type": "application/sdp",
          Accept: "application/sdp",
        };
        if (config.token) headers.Authorization = `Bearer ${config.token}`;

        const res = await fetch(config.url, { method: "POST", headers, body: sdp });
        if (!res.ok) {
          throw new Error(`WHIP endpoint rejected the offer (${res.status})`);
        }
        const answerSdp = await res.text();
        if (!answerSdp.trim()) throw new Error("WHIP endpoint returned an empty answer.");

        const location = res.headers.get("Location");
        if (location) {
          resourceUrlRef.current = location;
          setResourceUrl(location);
        }

        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
        return true;
      } catch (e: any) {
        failRef.current(e?.message ?? String(e));
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [iceServers, gatherTimeoutMs, teardown]
  );
  startRef.current = start;

  // Pause stats when no longer live.
  useEffect(() => {
    if (status !== "live") clearStats();
  }, [status, clearStats]);

  useEffect(() => {
    return () => {
      wantsActiveRef.current = false;
      teardown();
    };
  }, [teardown]);

  return { status, error, resourceUrl, bitrateKbps, reconnectAttempt, start, stop };
}