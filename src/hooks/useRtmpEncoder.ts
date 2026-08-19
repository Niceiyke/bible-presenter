import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { programEncoderIsLive, subscribeProgramPackets } from "../system/programEncoder";

/**
 * `useRtmpEncoder` — WebCodecs H.264 + AAC encoder for one RTMP destination
 * (Phase 6).
 *
 * Takes the `ProgramFeedCanvas` compositor's `MediaStream` video track, encodes
 * it in the webview with `VideoEncoder` (H.264, Annex-B output — the OBS-style
 * single-encode path), and streams the encoded packets to the backend, which
 * feeds ffmpeg (`-c copy`) for mux-only RTMP publish. No re-encode, hardware
 * acceleration preferred, low latency.
 *
 * Multi-platform: each destination mounts its own instance with a distinct
 * `sessionId`; the backend keys ffmpeg sessions by it, so several destinations
 * can be live from the one compositor simultaneously (video track cloned per
 * destination upstream).
 *
 * Audio: either the shared input track is passed via `start`'s `audioTrack`
 * option (multi-platform hub), or — when `options.audio.enabled` is set and no
 * track is given — the hook captures an input device itself with `getUserMedia`
 * (mic / line-in / mixer feed — audio processing disabled so the PA mix is not
 * mangled), encodes AAC with `AudioEncoder`, wraps each frame in an ADTS header,
 * and feeds `rtmp_send_audio` to the backend's loopback TCP input.
 *
 * The hook is window-agnostic and unit-testable: the WebCodecs classes,
 * `MediaStreamTrackProcessor`, `getUserMedia`, and `invoke` are the only
 * globals, all stubbed in tests.
 */

export type RtmpStreamerStatus = "idle" | "connecting" | "live" | "error" | "reconnecting";

/// Bounded reconnect policy for transient RTMP failures (WP3 P1-1): up to
/// three attempts with exponential backoff (1s, 2s, 4s) before the destination
/// settles on `error`. A reconnect reuses the SAME destination id and stream —
/// `rtmp_start` rejects duplicate sessions, so it can never double-start.
export const MAX_RECONNECT_ATTEMPTS = 3;
export const RECONNECT_BASE_DELAY_MS = 1000;

export interface UseRtmpEncoderAudioOptions {
  /** Capture and encode an input device's audio. */
  enabled?: boolean;
  /** `MediaDeviceInfo.deviceId` of the input to capture (default device when unset). */
  deviceId?: string;
  /** Target AAC bitrate in kbps. */
  bitrateKbps?: number;
}

export interface UseRtmpEncoderOptions {
  /** Backend session key — one per destination so several can run at once. */
  sessionId: string;
  /** Target video encode bitrate in kbps. */
  bitrateKbps?: number;
  /** Keyframe interval in seconds (ffmpeg/RTMP needs regular IDRs). */
  keyframeIntervalSec?: number;
  /** Encode frame rate (must match the compositor's capture FPS). */
  fps?: number;
  /** Fallback audio capture when no shared track is passed to `start`. */
  audio?: UseRtmpEncoderAudioOptions;
}

export interface UseRtmpEncoderResult {
  status: RtmpStreamerStatus;
  error: string | null;
  /** Approximate encoded bitrate in kbps (0 until live). */
  bitrateKbps: number;
  /** Packets written to the backend since the session started. */
  sentPackets: number;
  /** Packets dropped by the bounded queue (queue full) since the session started. */
  droppedPackets: number;
  /** Packets currently buffered awaiting the backend writer thread. */
  queuedPackets: number;
  /** 1-based reconnect attempt in progress (0 = not reconnecting). */
  reconnectAttempt: number;
  /** Start encoding the given stream to this destination's RTMP session.
   *  Resolves when ffmpeg accepts the session. Pass `audioTrack` to use the
   *  hub's shared input instead of capturing one. */
  start: (
    stream: MediaStream,
    serverUrl: string,
    streamKey?: string,
    audioTrack?: MediaStreamTrack | null
  ) => Promise<boolean>;
  /** Stop encoding and tear down the RTMP session. */
  stop: () => Promise<void>;
}

export interface EncoderFactory {
  isConfigSupported: (config: VideoEncoderConfig) => Promise<VideoEncoderSupport>;
}

/** AVC levels: [level_idc, MaxFS (macroblocks/frame), MaxMBPS]. */
const AVC_LEVELS: Array<[idc: number, maxFs: number, maxMbps: number]> = [
  [10, 99, 1485],
  [11, 396, 3000],
  [12, 396, 6000],
  [13, 396, 11880],
  [20, 396, 11880],
  [21, 792, 19800],
  [22, 1620, 20250],
  [30, 1620, 40500],
  [31, 3600, 108000],
  [32, 5120, 216000],
  [40, 8192, 245760],
  [41, 8192, 245760],
  [42, 8704, 522240],
  [50, 22080, 589824],
  [51, 36864, 983040],
  [52, 36864, 2073600],
];

/**
 * Minimum AVC level_idc that can encode `width`×`height` at `fps`. Chromium
 * validates the codec string's level against the requested dimensions in
 * `VideoEncoder.isConfigSupported`, so an underspecified level (e.g. 3.1 for
 * 1080p30) is reported unsupported even though the profile is fine.
 */
export function requiredAvcLevel(width: number, height: number, fps: number): number {
  const mbPerFrame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = mbPerFrame * Math.max(1, Math.round(fps));
  for (const [idc, maxFs, maxMbps] of AVC_LEVELS) {
    if (mbPerFrame <= maxFs && mbps <= maxMbps) return idc;
  }
  return 52;
}

/** AVC codec strings per profile, at the level required for the frame size. */
function h264Codecs(width: number, height: number, fps: number): string[] {
  const level = requiredAvcLevel(width, height, fps).toString(16).padStart(2, "0").toUpperCase();
  return [
    `avc1.42E0${level}`, // Baseline — max compatibility
    `avc1.4D40${level}`, // Main
    `avc1.6400${level}`, // High
  ];
}

/**
 * Sensible H.264 video bitrate for a capture resolution/fps, snapped to tidy
 * values (roughly the OBS "high quality" tier). Used as the RTMP/NDI encode
 * default so 4K60 isn't starved at the 1080p30 default and 720p30 isn't
 * over-allocated.
 */
export function suggestedBitrateKbps(width: number, height: number, fps: number): number {
  const kbps = (width * height * fps * 0.1) / 1000;
  return Math.max(1000, Math.min(40000, Math.round(kbps / 500) * 500));
}

const AAC_CODEC = "mp4a.40.2"; // AAC-LC — universal RTMP audio

/** Sampling-frequency index table for the ADTS header (MPEG-4). */
const ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * Wrap a raw AAC access unit in a 7-byte ADTS header so ffmpeg's `-f adts`
 * demuxer can parse it without the codec description.
 */
export function wrapAdts(payload: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const sfIndex = ADTS_SAMPLE_RATES.indexOf(sampleRate);
  if (sfIndex < 0) {
    throw new Error(`Unsupported AAC sample rate: ${sampleRate} Hz`);
  }
  const frameLength = payload.length + 7;
  const header = new Uint8Array(7);
  header[0] = 0xff; // syncword
  header[1] = 0xf1; // MPEG-4, layer 0, no CRC
  header[2] = (sfIndex << 2) | ((channels >> 2) & 0x01);
  header[3] = ((channels & 0x03) << 6) | ((frameLength >> 11) & 0x03);
  header[4] = (frameLength >> 3) & 0xff;
  header[5] = ((frameLength & 0x07) << 5) | 0x1f; // full buffer fullness
  header[6] = 0xfc; // one frame
  const out = new Uint8Array(frameLength);
  out.set(header, 0);
  out.set(payload, 7);
  return out;
}

export function waitForEncoderConfig(encoder: VideoEncoder, config: VideoEncoderConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    encoder.configure(config);
    // Chrome resolves the config synchronously; treat `configure` as applied
    // after a microtask so tests don't need to fake the promise.
    queueMicrotask(resolve);
  });
}

export async function supportsH264(
  Factory: EncoderFactory,
  width: number,
  height: number,
  bitrateKbps: number,
  fps: number
): Promise<string | null> {
  for (const codec of h264Codecs(width, height, fps)) {
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

export function useRtmpEncoder(options: UseRtmpEncoderOptions): UseRtmpEncoderResult {
  const { sessionId, bitrateKbps = 5000, keyframeIntervalSec = 2, fps = 30, audio } = options;
  const audioBitrateKbps = audio?.bitrateKbps ?? 128;
  const encoderRef = useRef<VideoEncoder | null>(null);
  const audioEncoderRef = useRef<AudioEncoder | null>(null);
  const processorRef = useRef<any>(null);
  const audioProcessorRef = useRef<any>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<VideoFrame> | null>(null);
  const audioReaderRef = useRef<ReadableStreamDefaultReader<AudioData> | null>(null);
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  /** Unsubscribe from the shared program encoder's video packets (Phase 7). */
  const sharedVideoUnsubRef = useRef<(() => void) | null>(null);
  const bytesRef = useRef(0);
  const runningRef = useRef(false);
  /** Operator intent: whether this destination is supposed to be live. The
   *  transport can be temporarily down (reconnecting) while this stays true, so
   *  a failed teardown can't cancel a scheduled reconnect. */
  const wantsActiveRef = useRef(false);
  const frameCountRef = useRef(0);
  const [status, setStatus] = useState<RtmpStreamerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [bitrate, setBitrate] = useState(0);
  const [sentPackets, setSentPackets] = useState(0);
  const [droppedPackets, setDroppedPackets] = useState(0);
  const [queuedPackets, setQueuedPackets] = useState(0);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  /** Last successful start arguments so a bounded reconnect can replay them with
   *  the SAME destination id and stream (never a duplicate session). */
  const lastStartArgsRef = useRef<{
    stream: MediaStream;
    serverUrl: string;
    streamKey?: string;
    sharedAudioTrack?: MediaStreamTrack | null;
  } | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (sharedVideoUnsubRef.current) {
      sharedVideoUnsubRef.current();
      sharedVideoUnsubRef.current = null;
    }
    for (const ref of [readerRef, audioReaderRef]) {
      if (ref.current) {
        ref.current.cancel().catch(() => {});
        ref.current = null;
      }
    }
    for (const ref of [processorRef, audioProcessorRef]) {
      if (ref.current) {
        try {
          ref.current.readable.cancel();
        } catch {
          // already closed
        }
        ref.current = null;
      }
    }
    for (const ref of [encoderRef, audioEncoderRef]) {
      const enc = ref.current;
      if (enc) {
        try {
          enc.close();
        } catch {
          // already closed
        }
      }
      ref.current = null;
    }
    if (audioTrackRef.current) {
      audioTrackRef.current.stop();
      audioTrackRef.current = null;
    }
    frameCountRef.current = 0;
  }, [clearStats]);

  // Failure path: on a transient failure (encoder error, feed error, ffmpeg
  // exit) run a bounded reconnect — up to three attempts with exponential
  // backoff (1s, 2s, 4s). A reconnect replays the last start with the SAME
  // destination id and stream, so it can never duplicate a session (`rtmp_start`
  // rejects duplicates). After the cap, the destination settles on `error` and
  // the backend session is stopped so nothing is leaked. `start` and `fail` are
  // mutually recursive, so each resolves the other through a ref.
  const failRef = useRef<(message: string) => void>(() => {});
  const startRef = useRef<
    (stream: MediaStream, serverUrl: string, streamKey?: string, audioTrack?: MediaStreamTrack | null) => Promise<boolean>
  >(() => Promise.resolve(false));

  const fail = useCallback(
    (message: string) => {
      if (!wantsActiveRef.current) return; // already stopping / fully stopped
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        wantsActiveRef.current = false;
        setStatus("error");
        setError(message);
        teardown();
        invoke("rtmp_stop", { sessionId }).catch(() => {});
        return;
      }
      reconnectAttemptsRef.current += 1;
      const attempt = reconnectAttemptsRef.current;
      setStatus("reconnecting");
      setError(message);
      setReconnectAttempt(attempt);
      // Clear the encoder/processors so a reconnect can re-create them (the
      // first line of `start` guards on `encoderRef.current`).
      teardown();
      const delay = RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
      reconnectTimerRef.current = setTimeout(() => {
        const args = lastStartArgsRef.current;
        if (!args || !wantsActiveRef.current) return;
        void startRef.current?.(args.stream, args.serverUrl, args.streamKey, args.sharedAudioTrack);
      }, delay);
    },
    [teardown, sessionId]
  );
  failRef.current = fail;

  const stop = useCallback(async () => {
    wantsActiveRef.current = false;
    reconnectAttemptsRef.current = 0;
    setReconnectAttempt(0);
    for (const enc of [encoderRef.current, audioEncoderRef.current]) {
      if (enc && enc.state === "configured") {
        try {
          await enc.flush();
        } catch {
          // ignore flush errors on teardown
        }
      }
    }
    teardown();
    try {
      await invoke("rtmp_stop", { sessionId });
    } catch (e: any) {
      setError(`Failed to stop RTMP: ${e?.message ?? e}`);
    }
    setStatus("idle");
    setSentPackets(0);
    setDroppedPackets(0);
    setQueuedPackets(0);
  }, [teardown, sessionId]);

  const start = useCallback(
    async (
      stream: MediaStream,
      serverUrl: string,
      streamKey?: string,
      sharedAudioTrack?: MediaStreamTrack | null
    ): Promise<boolean> => {
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

      // Store the start args so a bounded reconnect can replay them with the
      // SAME destination id and stream (never a duplicate session).
      lastStartArgsRef.current = { stream, serverUrl, streamKey, sharedAudioTrack };
      runningRef.current = true;
      wantsActiveRef.current = true;

      if (typeof VideoEncoder === "undefined") {
        setStatus("error");
        setError("WebCodecs (VideoEncoder) is not available in this webview.");
        return false;
      }

      let audioTrack: MediaStreamTrack | null = null;
      let audioSampleRate = 48000;
      let audioChannels = 2;
      if (sharedAudioTrack) {
        // Hub-provided shared input — use it as-is (do not stop it on teardown,
        // the hub owns it).
        audioTrack = sharedAudioTrack;
        const as = sharedAudioTrack.getSettings();
        audioSampleRate = as?.sampleRate ?? 48000;
        audioChannels = as?.channelCount ?? 2;
      } else if (audio?.enabled) {
        if (typeof AudioEncoder === "undefined") {
          setStatus("error");
          setError("WebCodecs (AudioEncoder) is not available in this webview.");
          return false;
        }
        try {
          const audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: audio.deviceId ? { exact: audio.deviceId } : undefined,
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          });
          const t = audioStream.getAudioTracks()[0];
          if (!t) {
            setStatus("error");
            setError("Audio was enabled but no audio input device was found.");
            return false;
          }
          const as = t.getSettings();
          audioSampleRate = as?.sampleRate ?? 48000;
          audioChannels = as?.channelCount ?? 2;
          audioTrack = t;
          audioTrackRef.current = t;
        } catch (e: any) {
          setStatus("error");
          setError(`Failed to open the audio input: ${e?.message ?? e}`);
          return false;
        }
      }

      setStatus("connecting");
      setError(null);

      // Phase 7: when the shared program encoder is live (the hub started it
      // for the master transport), this destination consumes ITS video packets
      // instead of running its own encoder — so N destinations share one
      // encoder. Otherwise it falls back to its own per-session encoder.
      const useSharedVideo = programEncoderIsLive();

      let audioEncoder: AudioEncoder | null = null;
      if (audioTrack) {
        try {
          audioEncoder = new AudioEncoder({
            output: (chunk) => {
              bytesRef.current += chunk.byteLength;
              const buf = new Uint8Array(chunk.byteLength);
              chunk.copyTo(buf);
              let adts: Uint8Array;
              try {
                adts = wrapAdts(buf, audioSampleRate, audioChannels);
              } catch (e: any) {
                if (runningRef.current) {
                  failRef.current(`AAC encode failed: ${e?.message ?? e}`);
                }
                return;
              }
              invoke("rtmp_send_audio", { sessionId, dataBase64: bytesToBase64(adts) }).then(
                (res) => {
                  if (res === "dropped") setDroppedPackets((n) => n + 1);
                  else if (res === "queued") setSentPackets((n) => n + 1);
                },
                (e: any) => {
                  if (runningRef.current) failRef.current(`RTMP audio feed failed: ${e?.message ?? e}`);
                }
              );
            },
            error: (e) => {
              if (runningRef.current) failRef.current(`Audio encoder error: ${e?.message ?? e}`);
            },
          });
          audioEncoder.configure({
            codec: AAC_CODEC,
            sampleRate: audioSampleRate,
            numberOfChannels: audioChannels,
            bitrate: audioBitrateKbps * 1000,
          });
          audioEncoderRef.current = audioEncoder;
        } catch (e: any) {
          failRef.current(`Failed to create the audio encoder: ${e?.message ?? e}`);
          if (audioTrackRef.current === audioTrack) audioTrack?.stop();
          return false;
        }
      }

      try {
        await invoke("rtmp_start", {
          sessionId,
          serverUrl,
          streamKey: streamKey ?? null,
          withAudio: !!audioTrack,
          fps,
        });
      } catch (e: any) {
        failRef.current(`Failed to start RTMP: ${e?.message ?? e}`);
        return false;
      }

      // A successful (re)start clears the reconnect budget.
      reconnectAttemptsRef.current = 0;
      setReconnectAttempt(0);

      if (useSharedVideo) {
        // Subscribe to the shared program encoder's packets and forward each to
        // this session's ffmpeg ingest. The encoder (and its keyframe cadence)
        // is owned by the hub; we only relay + count bytes for bitrate.
        runningRef.current = true;
        frameCountRef.current = 0;
        setStatus("live");
        startBitratePolling();
        sharedVideoUnsubRef.current = subscribeProgramPackets((packet) => {
          bytesRef.current += packet.size;
          invoke("rtmp_send", { sessionId, dataBase64: bytesToBase64(packet.bytes) }).then(
            (res) => {
              if (res === "dropped") setDroppedPackets((n) => n + 1);
              else if (res === "queued") setSentPackets((n) => n + 1);
            },
            (e: any) => {
              if (runningRef.current) failRef.current(`RTMP feed failed: ${e?.message ?? e}`);
            }
          );
          return true;
        });
      } else {
        if (typeof MediaStreamTrackProcessor === "undefined") {
          setStatus("error");
          setError("MediaStreamTrackProcessor is not available in this webview.");
          return false;
        }
        const codec = await supportsH264(
          VideoEncoder as unknown as EncoderFactory,
          width,
          height,
          bitrateKbps,
          fps
        );
        if (!codec) {
          failRef.current("No supported H.264 profile found for this encoder.");
          if (audioTrackRef.current === audioTrack) audioTrack?.stop();
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
              invoke("rtmp_send", { sessionId, dataBase64: bytesToBase64(buf) }).then(
                (res) => {
                  if (res === "dropped") setDroppedPackets((n) => n + 1);
                  else if (res === "queued") setSentPackets((n) => n + 1);
                },
                (e: any) => {
                  if (runningRef.current) failRef.current(`RTMP feed failed: ${e?.message ?? e}`);
                }
              );
            },
            error: (e) => {
              if (runningRef.current) failRef.current(`Encoder error: ${e?.message ?? e}`);
            },
          });
        } catch (e: any) {
          failRef.current(`Failed to create encoder: ${e?.message ?? e}`);
          if (audioTrackRef.current === audioTrack) audioTrack?.stop();
          return false;
        }
        encoderRef.current = encoder;

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
      }

      if (audioEncoder && audioTrack) {
        const audioProcessor = new MediaStreamTrackProcessor<AudioData>({ track: audioTrack });
        audioProcessorRef.current = audioProcessor;
        const audioReader = audioProcessor.readable.getReader();
        audioReaderRef.current = audioReader;
        (async () => {
          try {
            for (;;) {
              const { value, done } = await audioReader.read();
              if (done || !runningRef.current) break;
              const data = value as AudioData;
              if (data) {
                try {
                  audioEncoder.encode(data);
                } catch {
                  // encoder closed mid-take
                } finally {
                  data.close();
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
    [audio, audioBitrateKbps, bitrateKbps, keyframeIntervalSec, fps, teardown, failRef, startBitratePolling, sessionId]
  );
  startRef.current = start;

  // Pause stats when no longer live.
  useEffect(() => {
    if (status !== "live") clearStats();
  }, [status, clearStats]);

  // Unmount: tear down the encoder AND tell the backend to stop the ffmpeg
  // ingest, so navigating away from the Streaming workspace while live never
  // leaks a child process (or a writer thread blocked on a dead pipe).
  useEffect(() => {
    return () => {
      const wasLive = wantsActiveRef.current;
      wantsActiveRef.current = false;
      teardown();
      if (wasLive) {
        invoke("rtmp_stop", { sessionId }).catch(() => {});
      }
    };
  }, [teardown, sessionId]);

  return { status, error, bitrateKbps: bitrate, sentPackets, droppedPackets, queuedPackets, reconnectAttempt, start, stop };
}

/** Base64-encode bytes without a Blob/FileReader hop. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}