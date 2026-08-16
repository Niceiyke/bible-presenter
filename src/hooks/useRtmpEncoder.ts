import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * `useRtmpEncoder` — WebCodecs H.264 + AAC encoder for the RTMP streamer
 * surface (Phase 6).
 *
 * Takes the `ProgramFeedCanvas` compositor's `MediaStream` video track, encodes
 * it in the webview with `VideoEncoder` (H.264, Annex-B output — the OBS-style
 * single-encode path), and streams the encoded packets to the backend, which
 * feeds ffmpeg (`-c copy`) for mux-only RTMP publish. No re-encode, hardware
 * acceleration preferred, low latency.
 *
 * Optional audio (`options.audio.enabled`): captures the operator's input
 * device with `getUserMedia` (mic / line-in / mixer feed — audio processing
 * disabled so the PA mix is not mangled), encodes AAC with `AudioEncoder`, wraps
 * each frame in an ADTS header, and feeds `rtmp_send_audio` to the backend's
 * loopback TCP input.
 *
 * The hook is window-agnostic and unit-testable: the WebCodecs classes,
 * `MediaStreamTrackProcessor`, `getUserMedia`, and `invoke` are the only
 * globals, all stubbed in tests.
 */

export type RtmpStreamerStatus = "idle" | "connecting" | "live" | "error";

export interface UseRtmpEncoderAudioOptions {
  /** Capture and encode an input device's audio. */
  enabled?: boolean;
  /** `MediaDeviceInfo.deviceId` of the input to capture (default device when unset). */
  deviceId?: string;
  /** Target AAC bitrate in kbps. */
  bitrateKbps?: number;
}

export interface UseRtmpEncoderOptions {
  /** Target video encode bitrate in kbps. */
  bitrateKbps?: number;
  /** Keyframe interval in seconds (ffmpeg/RTMP needs regular IDRs). */
  keyframeIntervalSec?: number;
  /** Encode frame rate (must match the compositor's capture FPS). */
  fps?: number;
  /** Optional audio capture + AAC encode. */
  audio?: UseRtmpEncoderAudioOptions;
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
  const { bitrateKbps = 5000, keyframeIntervalSec = 2, fps = 30, audio } = options;
  const audioBitrateKbps = audio?.bitrateKbps ?? 128;
  const encoderRef = useRef<VideoEncoder | null>(null);
  const audioEncoderRef = useRef<AudioEncoder | null>(null);
  const processorRef = useRef<any>(null);
  const audioProcessorRef = useRef<any>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<VideoFrame> | null>(null);
  const audioReaderRef = useRef<ReadableStreamDefaultReader<AudioData> | null>(null);
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
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

  const stop = useCallback(async () => {
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

      let audioTrack: MediaStreamTrack | null = null;
      let audioSampleRate = 48000;
      let audioChannels = 2;
      if (audio?.enabled) {
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
        if (audioTrack) audioTrack.stop();
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
        if (audioTrack) audioTrack.stop();
        return false;
      }
      encoderRef.current = encoder;

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
                  setStatus("error");
                  setError(`AAC encode failed: ${e?.message ?? e}`);
                  teardown();
                }
                return;
              }
              invoke("rtmp_send_audio", { dataBase64: bytesToBase64(adts) }).catch((e: any) => {
                if (runningRef.current) {
                  setStatus("error");
                  setError(`RTMP audio feed failed: ${e?.message ?? e}`);
                  teardown();
                }
              });
            },
            error: (e) => {
              if (runningRef.current) {
                setStatus("error");
                setError(`Audio encoder error: ${e?.message ?? e}`);
                teardown();
              }
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
          setStatus("error");
          setError(`Failed to create the audio encoder: ${e?.message ?? e}`);
          audioTrack.stop();
          teardown();
          return false;
        }
      }

      try {
        await invoke("rtmp_start", { serverUrl, streamKey: streamKey || null, withAudio: !!audioTrack });
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
    [audio, audioBitrateKbps, bitrateKbps, keyframeIntervalSec, fps, teardown, startBitratePolling]
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