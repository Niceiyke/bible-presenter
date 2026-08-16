import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * `useRtmpEncoder` — WebCodecs H.264 encoder for the RTMP streamer surface
 * (Phase 6).
 *
 * Takes the `ProgramFeedCanvas` compositor's `MediaStream` video track, encodes
 * it in the webview with `VideoEncoder` (H.264, Annex-B output — the OBS-style
 * single-encode path), and streams the encoded packets to the backend, which
 * feeds ffmpeg (`-c copy`) for mux-only RTMP publish. No re-encode, hardware
 * acceleration preferred, low latency.
 *
 * The hook is window-agnostic and unit-testable: `VideoEncoder`/`VideoFrame`/
 * `MediaStreamTrackProcessor`/`invoke` are the only globals, all stubbed in
 * tests.
 */

export type RtmpStreamerStatus = "idle" | "connecting" | "live" | "error";

export interface UseRtmpEncoderOptions {
  /** Target encode bitrate in kbps. */
  bitrateKbps?: number;
  /** Keyframe interval in seconds (ffmpeg/RTMP needs regular IDRs). */
  keyframeIntervalSec?: number;
  /** Encode frame rate (must match the compositor's capture FPS). */
  fps?: number;
}

export interface UseRtmpEncoderResult {
  status: RtmpStreamerStatus;
  error: string | null;
  /** Approximate encoded bitrate in kbps (0 until live). */
  bitrateKbps: number;
  /** Start encoding the given stream to RTMP. Resolves when ffmpeg accepts
   *  the session. */
  start: (stream: MediaStream, serverUrl: string, streamKey?: string) => Promise<boolean>;
  /** Stop encoding and tear down the RTMP session. */
  stop: () => Promise<void>;
}

interface EncoderFactory {
  isConfigSupported: (config: VideoEncoderConfig) => Promise<VideoEncoderSupport>;
}

const H264_CODECS = [
  "avc1.42E01E", // Baseline — max compatibility
  "avc1.4D401F", // Main
  "avc1.64001F", // High
];

function waitForEncoderConfig(encoder: VideoEncoder, config: VideoEncoderConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    encoder.configure(config);
    // Chrome resolves the config synchronously; treat `configure` as applied
    // after a microtask so tests don't need to fake the promise.
    queueMicrotask(resolve);
  });
}

async function supportsH264(
  Factory: EncoderFactory,
  width: number,
  height: number,
  bitrateKbps: number,
  fps: number
): Promise<string | null> {
  for (const codec of H264_CODECS) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate: bitrateKbps * 1000,
      framerate: fps,
      avc: { format: "annexb" },
    };
    try {
      const support = await Factory.isConfigSupported(config);
      if (support.supported) return codec;
    } catch {
      // fall through to the next codec
    }
  }
  return null;
}

export function useRtmpEncoder(options: UseRtmpEncoderOptions = {}): UseRtmpEncoderResult {
  const { bitrateKbps = 5000, keyframeIntervalSec = 2, fps = 30 } = options;
  const encoderRef = useRef<VideoEncoder | null>(null);
  const processorRef = useRef<any>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<VideoFrame> | null>(null);
  const bytesRef = useRef(0);
  const runningRef = useRef(false);
  const frameCountRef = useRef(0);
  const [status, setStatus] = useState<RtmpStreamerStatus>("idle");
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
    const enc = encoderRef.current;
    if (enc) {
      try {
        enc.close();
      } catch {
        // already closed
      }
    }
    encoderRef.current = null;
    frameCountRef.current = 0;
  }, [clearStats]);

  const stop = useCallback(async () => {
    const enc = encoderRef.current;
    if (enc && enc.state === "configured") {
      try {
        await enc.flush();
      } catch {
        // ignore flush errors on teardown
      }
    }
    teardown();
    try {
      await invoke("rtmp_stop");
    } catch (e: any) {
      setError(`Failed to stop RTMP: ${e?.message ?? e}`);
    }
    setStatus("idle");
  }, [teardown]);

  const start = useCallback(
    async (stream: MediaStream, serverUrl: string, streamKey?: string): Promise<boolean> => {
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
      if (typeof MediaStreamTrackProcessor === "undefined") {
        setStatus("error");
        setError("MediaStreamTrackProcessor is not available in this webview.");
        return false;
      }

      setStatus("connecting");
      setError(null);

      const codec = await supportsH264(
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

      let encoder: VideoEncoder;
      try {
        encoder = new VideoEncoder({
          output: (chunk, _meta) => {
            bytesRef.current += chunk.byteLength;
            const buf = new Uint8Array(chunk.byteLength);
            chunk.copyTo(buf);
            // Best-effort feed; the backend surfaces real ffmpeg failures.
            invoke("rtmp_send", { dataBase64: bytesToBase64(buf) }).catch((e: any) => {
              if (runningRef.current) {
                setStatus("error");
                setError(`RTMP feed failed: ${e?.message ?? e}`);
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

      try {
        await invoke("rtmp_start", { serverUrl, streamKey: streamKey || null });
      } catch (e: any) {
        setStatus("error");
        setError(`Failed to start RTMP: ${e?.message ?? e}`);
        teardown();
        return false;
      }

      const config: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate: bitrateKbps * 1000,
        framerate: fps,
        avc: { format: "annexb" },
      };
      await waitForEncoderConfig(encoder, config);

      runningRef.current = true;
      frameCountRef.current = 0;
      setStatus("live");
      startBitratePolling();

      const processor = new MediaStreamTrackProcessor({ track });
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
                encoder.encode(frame, { keyFrame: isKey });
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

      return true;
    },
    [bitrateKbps, keyframeIntervalSec, fps, teardown, startBitratePolling]
  );

  // Pause stats when no longer live.
  useEffect(() => {
    if (status !== "live") clearStats();
  }, [status, clearStats]);

  useEffect(() => teardown, [teardown]);

  return { status, error, bitrateKbps: bitrate, start, stop };
}

/** Base64-encode bytes without a Blob/FileReader hop. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}