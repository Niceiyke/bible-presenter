import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRtmpEncoder } from "../useRtmpEncoder";

// Mock the Tauri bridge before anything imports the real modules.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

/** A chunk carries bytes + byteLength + copyTo, like the real EncodedVideoChunk. */
class FakeEncodedChunk {
  byteLength: number;
  private data: Uint8Array;
  constructor(size: number, key: boolean) {
    this.data = new Uint8Array(size).fill(key ? 1 : 2);
    this.byteLength = this.data.length;
  }
  copyTo(buf: ArrayBuffer) {
    new Uint8Array(buf).set(this.data);
  }
  get type() {
    return "key";
  }
}

class FakeVideoEncoder {
  static instances: FakeVideoEncoder[] = [];
  static isConfigSupported = vi.fn(async () => ({ supported: true, config: {} }));
  state = "unconfigured";
  ondequeue: (() => void) | null = null;
  outputCb: EncodedVideoChunkOutputCallback | null = null;
  errorCb: WebCodecsErrorCallback | null = null;
  configureCalls: VideoEncoderConfig[] = [];
  encodeCalls: { keyFrame?: boolean }[] = [];

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
      // Emit a 4KB keyframe packet synchronously so tests can assert the feed.
      this.outputCb(new FakeEncodedChunk(4096, true) as unknown as EncodedVideoChunk, {});
    }
  }
  async flush() {}
  close() {
    this.state = "closed";
  }
}

class FakeVideoFrame {
  close = vi.fn();
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

const fakeStream = () => {
  const tracks = [{ kind: "video", id: "v1", getSettings: () => ({ width: 1920, height: 1080 }) }];
  return {
    getVideoTracks: () => tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream;
};

describe("useRtmpEncoder", () => {
  beforeEach(() => {
    FakeVideoEncoder.instances = [];
    FakeTrackProcessor.instances = [];
    FakeVideoEncoder.isConfigSupported.mockReset();
    FakeVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true, config: {} });
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    vi.stubGlobal("VideoEncoder", FakeVideoEncoder);
    vi.stubGlobal("VideoFrame", FakeVideoFrame);
    vi.stubGlobal("MediaStreamTrackProcessor", FakeTrackProcessor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts ffmpeg, encodes with H.264 annexb, and feeds packets", async () => {
    const { result } = renderHook(() => useRtmpEncoder({ bitrateKbps: 6000, fps: 30 }));

    let ok = false;
    await act(async () => {
      ok = await result.current.start(fakeStream(), "rtmp://host/live", "key123");
    });

    expect(ok).toBe(true);
    expect(result.current.status).toBe("live");
    expect(mockInvoke).toHaveBeenCalledWith("rtmp_start", {
      serverUrl: "rtmp://host/live",
      streamKey: "key123",
    });
    // The encoder was configured for H.264 Annex-B at 6 Mbps.
    const enc = FakeVideoEncoder.instances[0];
    expect(enc?.configureCalls.length).toBe(1);
    expect(enc?.configureCalls[0].codec).toBe("avc1.42E01E");
    expect(enc?.configureCalls[0].avc?.format).toBe("annexb");
    expect(enc?.configureCalls[0].bitrate).toBe(6_000_000);
    // Encoded packets were streamed to the backend.
    expect(mockInvoke).toHaveBeenCalledWith("rtmp_send", expect.objectContaining({ dataBase64: expect.any(String) }));
  });

  it("sends streamKey as null when omitted", async () => {
    const { result } = renderHook(() => useRtmpEncoder());
    await act(async () => {
      await result.current.start(fakeStream(), "rtmp://host/live");
    });
    expect(mockInvoke).toHaveBeenCalledWith("rtmp_start", {
      serverUrl: "rtmp://host/live",
      streamKey: null,
    });
  });

  it("surfaces backend start failures", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("ffmpeg not found on PATH"));
    const { result } = renderHook(() => useRtmpEncoder());

    let ok = true;
    await act(async () => {
      ok = await result.current.start(fakeStream(), "rtmp://host/live", "k");
    });
    expect(ok).toBe(false);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("ffmpeg not found");
  });

  it("errors when no H.264 profile is supported", async () => {
    FakeVideoEncoder.isConfigSupported.mockResolvedValue({ supported: false, config: {} });
    const { result } = renderHook(() => useRtmpEncoder());

    let ok = true;
    await act(async () => {
      ok = await result.current.start(fakeStream(), "rtmp://host/live", "k");
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("No supported H.264 profile");
  });

  it("errors when WebCodecs is unavailable", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    const { result } = renderHook(() => useRtmpEncoder());

    let ok = true;
    await act(async () => {
      ok = await result.current.start(fakeStream(), "rtmp://host/live", "k");
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("WebCodecs");
  });

  it("errors on a stream with no video track", async () => {
    const { result } = renderHook(() => useRtmpEncoder());
    let ok = true;
    await act(async () => {
      const noVideo = { getVideoTracks: () => [] } as unknown as MediaStream;
      ok = await result.current.start(noVideo, "rtmp://host/live");
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("no video track");
  });

  it("stop flushes the encoder and tears down the RTMP session", async () => {
    const { result } = renderHook(() => useRtmpEncoder());
    await act(async () => {
      await result.current.start(fakeStream(), "rtmp://host/live", "k");
    });

    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.status).toBe("idle");
    expect(mockInvoke).toHaveBeenCalledWith("rtmp_stop");
    expect(FakeVideoEncoder.instances[0]?.state).toBe("closed");
  });
});