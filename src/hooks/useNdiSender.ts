import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { supportsH264, waitForEncoderConfig, bytesToBase64, type EncoderFactory } from "./useRtmpEncoder";
import { programEncoderIsLive, subscribeProgramPackets } from "../system/programEncoder";

/**
 * `useNdiSender` — NDI|HX transport for one NDI destination (Phase 8 scaffold).
 *
 * Takes the `ProgramFeedCanvas` compositor's `MediaStream` video track, encodes
 * it with WebCodecs (`VideoEncoder`, H.264 Annex-B — the same single-encode
 * path the RTMP hub uses), and streams the encoded packets to the backend via
 * `ndi_start`/`ndi_send`/`ndi_stop`. The backend wraps the packets in the NDI
 * SDK's H.264 send mode (NDI|HX), announcing `"Wordlyte – <name>"` on the LAN
 * for OBS (obs-ndi), vMix, ProPresenter, and NDI-enabled hardware.
 *
 * Video-only for now: NDI|HX audio (AAC in the NDI payload) lands with the SDK
 * phase, when `ndi_start` actually opens a session. Multi-destination: each
 * card owns its instance with a distinct `sessionId`, cloning the shared video
 * track (one `MediaStreamTrackProcessor` per track) exactly like `useRtmpEncoder`.
 *
 * The hook is window-agnostic and unit-testable: the WebCodecs classes,
 * `MediaStreamTrackProcessor`, and `invoke` are the only globals, all stubbed in
 * tests.
 */

export type NdiStreamerStatus = "idle" | "connecting" | "live" | "error";

export interface UseNdiSenderOptions {
  /** Backend session key — one per destination so several can run at once. */
  sessionId: string;
  /** Target video encode bitrate in kbps. */
  bitrateKbps?: number;
  /** Keyframe interval in seconds (NDI|HX consumers need regular IDRs). */
  keyframeIntervalSec?: number;
  /** Encode frame rate (must match the compositor's capture FPS). */
  fps?: number;
}

export interface UseNdiSenderResult {
  status: NdiStreamerStatus;
  error: string | null;
  /** Approximate encoded bitrate in kbps (0 until live). */
  bitrateKbps: number;
  /** Start encoding the given stream to this destination's NDI session under
   *  the given source name. Resolves when the backend accepts the session. */
  start: (stream: MediaStream, name: string) => Promise<boolean>;
  /** Stop encoding and tear down the NDI session. */
  stop: () => Promise<void>;
}

export function useNdiSender(options: UseNdiSenderOptions): UseNdiSenderResult {
  const { sessionId, bitrateKbps = 5000, keyframeIntervalSec = 2, fps = 30 } = options;
  const encoderRef = useRef<VideoEncoder | null>(null);
  const processorRef = useRef<any>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<VideoFrame> | null>(null);
  const bytesRef = useRef(0);
  const runningRef = useRef(false);
  const frameCountRef = useRef(0);
  /** Unsubscribe from the shared program encoder's video packets (Phase 7). */
  const sharedVideoUnsubRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<NdiStreamerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [bitrate, setBitrate] = useState(0);

  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearStats = useCallback(() => {
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    bytesRef.current = 0;
    setBitrate(0);
  }, []);

  const startBitratePolling = useCallback(() => {
    clearStats();
    const startMs = Date.now();
    statsTimerRef.current = setInterval(() => {
      const elapsedSec = (Date.now() - startMs) / 1000;
      if (elapsedSec > 0) setBitrate(Math.round((bytesRef.current * 8) / elapsedSec / 1000));
    }, 2000);
  }, [clearStats]);

  const teardown = useCallback(() => {
    runningRef.current = false;
    clearStats();
    if (sharedVideoUnsubRef.current) {
      sharedVideoUnsubRef.current();
      sharedVideoUnsubRef.current = null;
    }
    if (readerRef.current) {
      readerRef.current.cancel().catch(() => {});
      readerRef.current = null;
    }
    if (processorRef.current) {
      try {
        processorRef.current.readable.cancel();
      } catch {
        // already closed
      }
      processorRef.current = null;
    }
    if (encoderRef.current) {
      try {
        encoderRef.current.close();
      } catch {
        // already closed
      }
      encoderRef.current = null;
    }
    frameCountRef.current = 0;
  }, [clearStats]);

  const stop = useCallback(async () => {
    if (encoderRef.current && encoderRef.current.state === "configured") {
      try {
        await encoderRef.current.flush();
      } catch {
        // ignore flush errors on teardown
      }
    }
    teardown();
    try {
      await invoke("ndi_stop", { sessionId });
    } catch (e: any) {
      setError(`Failed to stop NDI: ${e?.message ?? e}`);
    }
    setStatus("idle");
  }, [teardown, sessionId]);

  const start = useCallback(
    async (stream: MediaStream, name: string): Promise<boolean> => {
      if (encoderRef.current) return false;
      const tracks = stream.getVideoTracks();
      if (tracks.length === 0) {
        setStatus("error");
        setError("Stream has no video track to encode.");
        return false;
      }
      const track = tracks[0];
      const settings = track.getSettings();
      const width = settings?.width ?? 1920;
      const height = settings?.height ?? 1080;

      if (typeof VideoEncoder === "undefined") {
        setStatus("error");
        setError("WebCodecs (VideoEncoder) is not available in this webview.");
        return false;
      }
      if (typeof MediaStreamTrackProcessor === "undefined" && !programEncoderIsLive()) {
        setStatus("error");
        setError("MediaStreamTrackProcessor is not available in this webview.");
        return false;
      }

      setStatus("connecting");
      setError(null);

      // Phase 7: when the shared program encoder is live, consume ITS video
      // packets instead of running a per-destination encoder.
      const useSharedVideo = programEncoderIsLive();

      let encoder: VideoEncoder | null = null;
      let codec: string | null = null;
      if (!useSharedVideo) {
        codec = await supportsH264(
          VideoEncoder as unknown as EncoderFactory,
          width,
          height,
          bitrateKbps,
          fps
        );
        if (!codec) {
          setStatus("error");
          setError("No supported H.264 profile found for this encoder.");
          return false;
        }

        try {
          encoder = new VideoEncoder({
            output: (chunk) => {
              bytesRef.current += chunk.byteLength;
              const buf = new Uint8Array(chunk.byteLength);
              chunk.copyTo(buf);
              // Best-effort feed; the backend surfaces real NDI failures.
              invoke("ndi_send", { sessionId, dataBase64: bytesToBase64(buf) }).catch((e: any) => {
                if (runningRef.current) {
                  setStatus("error");
                  setError(`NDI feed failed: ${e?.message ?? e}`);
                  teardown();
                }
              });
            },
            error: (e) => {
              if (runningRef.current) {
                setStatus("error");
                setError(`Encoder error: ${e?.message ?? e}`);
                teardown();
              }
            },
          });
        } catch (e: any) {
          setStatus("error");
          setError(`Failed to create encoder: ${e?.message ?? e}`);
          return false;
        }
        encoderRef.current = encoder;
      }

      try {
        await invoke("ndi_start", { sessionId, name });
      } catch (e: any) {
        setStatus("error");
        setError(`Failed to start NDI: ${e?.message ?? e}`);
        teardown();
        return false;
      }

      if (useSharedVideo) {
        runningRef.current = true;
        frameCountRef.current = 0;
        setStatus("live");
        startBitratePolling();
        sharedVideoUnsubRef.current = subscribeProgramPackets((packet) => {
          bytesRef.current += packet.size;
          invoke("ndi_send", { sessionId, dataBase64: bytesToBase64(packet.bytes) }).catch((e: any) => {
            if (runningRef.current) {
              setStatus("error");
              setError(`NDI feed failed: ${e?.message ?? e}`);
              teardown();
            }
          });
          return true;
        });
      } else {
        const config: VideoEncoderConfig = {
          codec: codec as string,
          width,
          height,
          bitrate: bitrateKbps * 1000,
          framerate: fps,
          avc: { format: "annexb" },
        };
        await waitForEncoderConfig(encoder as VideoEncoder, config);

        runningRef.current = true;
        frameCountRef.current = 0;
        setStatus("live");
        startBitratePolling();

        const processor = new MediaStreamTrackProcessor<VideoFrame>({ track });
        processorRef.current = processor;
        const reader = processor.readable.getReader();
        readerRef.current = reader;

        const keyframeEvery = Math.max(1, Math.round(keyframeIntervalSec * fps));
        (async () => {
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done || !runningRef.current) break;
              const frame = value as VideoFrame;
              if (frame) {
                frameCountRef.current += 1;
                const isKey = frameCountRef.current === 1 || frameCountRef.current % keyframeEvery === 0;
                try {
                  (encoder as VideoEncoder).encode(frame, { keyFrame: isKey });
                } catch {
                  // encoder closed mid-take
                } finally {
                  frame.close();
                }
              }
            }
          } catch {
            // reader cancelled on teardown
          }
        })();
      }

      return true;
    },
    [bitrateKbps, fps, keyframeIntervalSec, startBitratePolling, teardown, sessionId]
  );

  // Pause stats when no longer live.
  useEffect(() => {
    if (status !== "live") clearStats();
  }, [status, clearStats]);

  // Unmount: tear down the encoder AND tell the backend to close the NDI
  // session so navigating away while live never leaks a backend session
  // (mirrors `useRtmpEncoder`).
  useEffect(() => {
    return () => {
      const wasLive = runningRef.current;
      teardown();
      if (wasLive) {
        invoke("ndi_stop", { sessionId }).catch(() => {});
      }
    };
  }, [teardown, sessionId]);

  return { status, error, bitrateKbps: bitrate, start, stop };
}