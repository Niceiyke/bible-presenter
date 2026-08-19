import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  getProgramEncoderSnapshot,
  resetProgramEncoder,
  startProgramEncoder,
  stopProgramEncoder,
  subscribeProgramPackets,
  programEncoderIsLive,
  type EncodedPacket,
} from "../programEncoder";

class FakeEncodedChunk {
  byteLength: number;
  type: string;
  timestamp: number;
  private data: Uint8Array;
  constructor(size: number, key: boolean, ts: number) {
    this.data = new Uint8Array(size).fill(key ? 1 : 2);
    this.byteLength = this.data.length;
    this.type = key ? "key" : "delta";
    this.timestamp = ts;
  }
  copyTo(buf: ArrayBuffer) {
    new Uint8Array(buf).set(this.data);
  }
}

class FakeVideoEncoder {
  static instances: FakeVideoEncoder[] = [];
  static isConfigSupported = vi.fn(async () => ({ supported: true, config: {} }));
  state = "unconfigured";
  outputCb: EncodedVideoChunkOutputCallback | null = null;
  errorCb: WebCodecsErrorCallback | null = null;
  configureCalls: VideoEncoderConfig[] = [];
  encodeCalls: { keyFrame?: boolean }[] = [];
  private ts = 0;

  constructor(init: VideoEncoderInit) {
    this.outputCb = init.output;
    this.errorCb = init.error;
    FakeVideoEncoder.instances.push(this);
  }

  configure(config: VideoEncoderConfig) {
    this.configureCalls.push(config);
    this.state = "configured";
  }
  encode(frame: unknown, opts?: { keyFrame?: boolean }) {
    this.encodeCalls.push(opts ?? {});
    if (this.outputCb) {
      this.ts += 33_333;
      this.outputCb(
        new FakeEncodedChunk(4096, opts?.keyFrame ?? false, this.ts) as unknown as EncodedVideoChunk,
        {}
      );
    }
  }
  async flush() {}
  close() {
    this.state = "closed";
  }
}

class FakeVideoFrame {
  close = vi.fn();
  timestamp = 0;
}

class FakeTrackProcessor {
  static instances: FakeTrackProcessor[] = [];
  readable: ReadableStream<VideoFrame>;
  constructor(_init: unknown) {
    FakeTrackProcessor.instances.push(this);
    let reads = 0;
    this.readable = {
      getReader: () => ({
        read: () => {
          reads += 1;
          if (reads > 3) return Promise.resolve({ done: true });
          return Promise.resolve({ done: false, value: new FakeVideoFrame() as unknown as VideoFrame });
        },
        cancel: () => Promise.resolve(),
      }),
      cancel: () => Promise.resolve(),
    } as unknown as ReadableStream<VideoFrame>;
  }
}

const fakeTrack = () =>
  ({ kind: "video", id: "v1", getSettings: () => ({ width: 1920, height: 1080 }) }) as unknown as MediaStreamTrack;

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  resetProgramEncoder();
  FakeVideoEncoder.instances = [];
  FakeTrackProcessor.instances = [];
  FakeVideoEncoder.isConfigSupported.mockReset();
  FakeVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true, config: {} });
  vi.stubGlobal("VideoEncoder", FakeVideoEncoder);
  vi.stubGlobal("VideoFrame", FakeVideoFrame);
  vi.stubGlobal("MediaStreamTrackProcessor", FakeTrackProcessor);
});

afterEach(() => {
  resetProgramEncoder();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const profile = { width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 };

describe("programEncoder", () => {
  it("runs ONE encoder and fans packets to multiple consumers", async () => {
    const got: Array<EncodedPacket>[] = [[], []];
    expect(await startProgramEncoder(fakeTrack(), profile)).toBe(true);
    const unsubA = subscribeProgramPackets((p) => (got[0].push(p), true));
    const unsubB = subscribeProgramPackets((p) => (got[1].push(p), true));

    // Let the async reader loop encode a few frames.
    for (let i = 0; i < 6; i++) await flushMicrotasks();

    expect(FakeVideoEncoder.instances.length).toBe(1);
    expect(got[0].length).toBeGreaterThan(0);
    expect(got[1].length).toBe(got[0].length);
    expect(getProgramEncoderSnapshot().activeConsumers).toBe(2);

    unsubA();
    unsubB();
  });

  it("emits packet metadata: sequence, keyframe, codec, dimensions, fps, timestamp", async () => {
    const got: EncodedPacket[] = [];
    const unsub = subscribeProgramPackets((p) => (got.push(p), true));
    await startProgramEncoder(fakeTrack(), profile);
    for (let i = 0; i < 6; i++) await flushMicrotasks();
    unsub();

    const first = got[0];
    expect(first.sequence).toBe(1);
    expect(first.keyframe).toBe(true);
    expect(first.codec).toBe("avc1.42E028");
    expect(first.width).toBe(1920);
    expect(first.height).toBe(1080);
    expect(first.fps).toBe(30);
    expect(first.size).toBe(4096);
    expect(first.timestampUs).toBeGreaterThan(0);
    // Sequences are strictly increasing.
    for (let i = 1; i < got.length; i++) expect(got[i].sequence).toBe(got[i - 1].sequence + 1);
  });

  it("counts drops when a consumer reports backpressure", async () => {
    await startProgramEncoder(fakeTrack(), profile);
    const dropping = subscribeProgramPackets(() => false);
    for (let i = 0; i < 6; i++) await flushMicrotasks();
    expect(getProgramEncoderSnapshot().packetsDropped).toBeGreaterThan(0);
    dropping();
  });

  it("is idempotent for the same profile (no second encoder)", async () => {
    await startProgramEncoder(fakeTrack(), profile);
    await startProgramEncoder(fakeTrack(), profile);
    expect(FakeVideoEncoder.instances.length).toBe(1);
  });

  it("restarts the encoder for a different profile", async () => {
    await startProgramEncoder(fakeTrack(), profile);
    await startProgramEncoder(fakeTrack(), { ...profile, width: 1280, height: 720 });
    expect(FakeVideoEncoder.instances.length).toBe(2);
    expect(FakeVideoEncoder.instances[0].state).toBe("closed");
  });

  it("stop closes the encoder and returns to idle", async () => {
    await startProgramEncoder(fakeTrack(), profile);
    expect(programEncoderIsLive()).toBe(true);
    stopProgramEncoder();
    expect(programEncoderIsLive()).toBe(false);
    expect(getProgramEncoderSnapshot().status).toBe("idle");
    expect(FakeVideoEncoder.instances[0].state).toBe("closed");
    expect(getProgramEncoderSnapshot().activeConsumers).toBe(0);
  });

  it("fails cleanly when WebCodecs is unavailable", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    expect(await startProgramEncoder(fakeTrack(), profile)).toBe(false);
    expect(getProgramEncoderSnapshot().status).toBe("error");
  });

  it("returns a STABLE snapshot reference while nothing changed (no React #185 loop)", async () => {
    // useSyncExternalStore compares snapshots with Object.is on every render. A
    // freshly-allocated object every call would look "changed" forever and loop
    // (React error #185). The cached snapshot must be reference-stable.
    const a = getProgramEncoderSnapshot();
    const b = getProgramEncoderSnapshot();
    const c = getProgramEncoderSnapshot();
    expect(a).toBe(b);
    expect(b).toBe(c);

    // After a real change (status -> live) the snapshot is a new object once,
    // then stable again.
    await startProgramEncoder(fakeTrack(), profile);
    expect(a).not.toBe(getProgramEncoderSnapshot());
    const d = getProgramEncoderSnapshot();
    expect(getProgramEncoderSnapshot()).toBe(d);
    expect(getProgramEncoderSnapshot()).toBe(d);
  });
});
