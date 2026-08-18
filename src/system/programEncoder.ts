import { supportsH264, waitForEncoderConfig } from "../hooks/useRtmpEncoder";

/**
 * `programEncoder` — the Phase 7 shared encoder / transport packet bus.
 *
 * The program's visual feed is encoded ONCE, per visual profile, and the
 * resulting packets are fanned out to every transport (RTMP sessions, NDI, and
 * future destinations) — so N destinations never create N video encoders. The
 * module owns the single `VideoEncoder` + `MediaStreamTrackProcessor` over the
 * one compositor capture track, and emits `EncodedPacket`s carrying metadata
 * (sequence, timestamp, keyframe, codec, dimensions, fps, size) that transports
 * forward to their backends.
 *
 * Lifecycle is ref-counted-ish at the call-site (the streaming hub starts it
 * when the master transport goes live and stops it on Stop All); consumers
 * subscribe/unsubscribe around their session. Backpressure is signalled by each
 * consumer returning `false` when its own outbound queue is full; the module
 * counts the packet as dropped once per rejecting consumer.
 *
 * A/V sync: video packets carry the source `VideoFrame.timestamp` (µs) so a
 * transport can align them with audio; the shared audio graph supplies the
 * program audio (Phase 6).
 */

export interface ProgramEncoderProfile {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  keyframeIntervalSec?: number;
}

export interface EncodedPacket {
  sequence: number;
  /** Capture-timeline timestamp in microseconds (from the source frame). */
  timestampUs: number;
  keyframe: boolean;
  codec: string;
  width: number;
  height: number;
  fps: number;
  size: number;
  /** Annex-B H.264 bytes. */
  bytes: Uint8Array;
}

/** A transport's packet sink. Return `false` to signal its queue is full. */
export type PacketConsumer = (packet: EncodedPacket) => boolean;

export type ProgramEncoderStatus = "idle" | "starting" | "live" | "error" | "stopping";

export interface ProgramEncoderSnapshot {
  status: ProgramEncoderStatus;
  error: string | null;
  activeConsumers: number;
  packetsEncoded: number;
  packetsDropped: number;
  profile: ProgramEncoderProfile | null;
}

const listeners = new Set<() => void>();
let status: ProgramEncoderStatus = "idle";
let error: string | null = null;
let profile: ProgramEncoderProfile | null = null;
let encoder: VideoEncoder | null = null;
let processor: MediaStreamTrackProcessor<VideoFrame> | null = null;
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let track: MediaStreamTrack | null = null;
let consumers = new Set<PacketConsumer>();
let sequence = 0;
let frameCount = 0;
let packetsEncoded = 0;
let packetsDropped = 0;

function notify(): void {
  listeners.forEach((cb) => cb());
}

export function subscribeProgramEncoder(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Stable snapshot (the module keeps primitives; rebuild a small object). */
export function getProgramEncoderSnapshot(): ProgramEncoderSnapshot {
  return { status, error, activeConsumers: consumers.size, packetsEncoded, packetsDropped, profile };
}

export function programEncoderIsLive(): boolean {
  return status === "live" && !!encoder;
}

function setState(nextStatus: ProgramEncoderStatus, nextError: string | null = null): void {
  status = nextStatus;
  error = nextError;
  notify();
}

function teardown(): void {
  if (reader) {
    reader.cancel().catch(() => {});
    reader = null;
  }
  if (processor) {
    try {
      processor.readable.cancel();
    } catch {
      // already closed
    }
    processor = null;
  }
  if (encoder) {
    try {
      encoder.close();
    } catch {
      // already closed
    }
    encoder = null;
  }
  track = null;
  consumers.clear();
  sequence = 0;
  frameCount = 0;
}

/**
 * Start encoding the given capture track at the given visual profile. Idempotent
 * for the same profile (the encoder is reused for every transport); a different
 * profile restarts the encoder. Resolves `false` (and sets `error`) when
 * WebCodecs H.264 is unsupported for the profile.
 */
export async function startProgramEncoder(
  inputTrack: MediaStreamTrack,
  inputProfile: ProgramEncoderProfile
): Promise<boolean> {
  if (programEncoderIsLive() && profile && profileMatches(inputProfile, profile)) {
    return true;
  }
  if (typeof VideoEncoder === "undefined") {
    setState("error", "WebCodecs (VideoEncoder) is not available in this webview.");
    return false;
  }
  if (typeof MediaStreamTrackProcessor === "undefined") {
    setState("error", "MediaStreamTrackProcessor is not available in this webview.");
    return false;
  }

  if (programEncoderIsLive()) {
    teardown();
  }

  profile = { ...inputProfile, keyframeIntervalSec: inputProfile.keyframeIntervalSec ?? 2 };
  track = inputTrack;
  setState("starting");

  const { width, height, fps, bitrateKbps } = profile;
  const codec = await supportsH264(
    VideoEncoder as unknown as { isConfigSupported: typeof VideoEncoder.isConfigSupported },
    width,
    height,
    bitrateKbps,
    fps
  );
  if (!codec) {
    setState("error", "No supported H.264 profile found for this encoder.");
    teardown();
    return false;
  }

  let enc: VideoEncoder;
  try {
    enc = new VideoEncoder({
      output: (chunk, _meta) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        const packet: EncodedPacket = {
          sequence: ++sequence,
          timestampUs: timestampFromChunk(chunk),
          keyframe: chunk.type === "key",
          codec,
          width,
          height,
          fps,
          size: buf.length,
          bytes: buf,
        };
        packetsEncoded += 1;
        let hadDrop = false;
        for (const cb of consumers) {
          if (!cb(packet)) hadDrop = true;
        }
        if (hadDrop) packetsDropped += 1;
      },
      error: (e) => {
        setState("error", `Encoder error: ${e?.message ?? e}`);
        teardown();
      },
    });
  } catch (e: any) {
    setState("error", `Failed to create encoder: ${e?.message ?? e}`);
    teardown();
    return false;
  }
  encoder = enc;

  const config: VideoEncoderConfig = {
    codec,
    width,
    height,
    bitrate: bitrateKbps * 1000,
    framerate: fps,
    avc: { format: "annexb" },
  };
  await waitForEncoderConfig(enc, config);

  const keyframeEvery = Math.max(1, Math.round((profile.keyframeIntervalSec ?? 2) * fps));
  const proc = new MediaStreamTrackProcessor<VideoFrame>({ track: inputTrack });
  processor = proc;
  const rdr = proc.readable.getReader();
  reader = rdr;
  frameCount = 0;

  setState("live");

  (async () => {
    try {
      for (;;) {
        const { value, done } = await rdr.read();
        if (done || !programEncoderIsLive()) break;
        const frame = value as VideoFrame;
        if (frame) {
          frameCount += 1;
          const isKey = frameCount === 1 || frameCount % keyframeEvery === 0;
          try {
            enc.encode(frame, { keyFrame: isKey });
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
}

function profileMatches(a: ProgramEncoderProfile, b: ProgramEncoderProfile): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.fps === b.fps &&
    a.bitrateKbps === b.bitrateKbps
  );
}

/** Prefer the source frame timeline; fall back to wall clock (µs). */
function timestampFromChunk(chunk: EncodedVideoChunk): number {
  const ts = (chunk as unknown as { timestamp?: number }).timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  return performance.now() * 1000;
}

/** Register a transport's packet sink; returns an unsubscribe function. */
export function subscribeProgramPackets(cb: PacketConsumer): () => void {
  consumers.add(cb);
  notify();
  return () => {
    consumers.delete(cb);
    notify();
  };
}

/** Stop the shared encoder and close every transport sink. */
export function stopProgramEncoder(): void {
  if (status === "idle") return;
  setState("stopping");
  teardown();
  packetsDropped = 0;
  packetsEncoded = 0;
  profile = null;
  setState("idle");
}

/** For tests: reset the module-level encoder. */
export function resetProgramEncoder(): void {
  teardown();
  status = "idle";
  error = null;
  profile = null;
  packetsDropped = 0;
  packetsEncoded = 0;
  notify();
}
