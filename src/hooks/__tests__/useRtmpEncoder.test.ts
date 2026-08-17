import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRtmpEncoder, wrapAdts, requiredAvcLevel, supportsH264 } from "../useRtmpEncoder";
import type { EncoderFactory } from "../useRtmpEncoder";

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

/** Audio counterpart: yields a handful of `AudioData`-like frames. */
class FakeAudioProcessor {
  static instances: FakeAudioProcessor[] = [];
  readable: ReadableStream<AudioData>;
  constructor(_init: unknown) {
    FakeAudioProcessor.instances.push(this);
    let reads = 0;
    this.readable = {
      getReader: () => ({
        read: () => {
          reads += 1;
          if (reads > 3) return Promise.resolve({ done: true });
          return Promise.resolve({ done: false, value: new FakeAudioData() as unknown as AudioData });
        },
        cancel: () => Promise.resolve(),
      }),
      cancel: () => Promise.resolve(),
    } as unknown as ReadableStream<AudioData>;
  }
}

/** A chunk carrying encoded AAC bytes for the audio encoder output. */
class FakeAudioChunk {
  byteLength: number;
  private data: Uint8Array;
  constructor(size: number) {
    this.data = new Uint8Array(size).fill(7);
    this.byteLength = this.data.length;
  }
  copyTo(buf: ArrayBuffer) {
    new Uint8Array(buf).set(this.data);
  }
}

class FakeAudioEncoder {
  static instances: FakeAudioEncoder[] = [];
  static isConfigSupported = vi.fn(async () => ({ supported: true }));
  state = "unconfigured";
  outputCb: EncodedAudioChunkOutputCallback | null = null;
  errorCb: WebCodecsErrorCallback | null = null;
  configureCalls: AudioEncoderConfig[] = [];
  encodeCalls: unknown[] = [];

  constructor(init: AudioEncoderInit) {
    this.outputCb = init.output;
    this.errorCb = init.error;
    FakeAudioEncoder.instances.push(this);
  }

  configure(config: AudioEncoderConfig) {
    this.configureCalls.push(config);
    this.state = "configured";
  }
  encode(data: unknown) {
    this.encodeCalls.push(data);
    if (this.outputCb) {
      this.outputCb(new FakeAudioChunk(256) as unknown as EncodedAudioChunk, {});
    }
  }
  async flush() {}
  close() {
    this.state = "closed";
  }
}

class FakeAudioData {
  close = vi.fn();
}

const fakeStream = () => {
  const tracks = [{ kind: "video", id: "v1", getSettings: () => ({ width: 1920, height: 1080 }) }];
  return {
    getVideoTracks: () => tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream;
};

/** A getUserMedia stub returning a fake audio track. */
const stubGetUserMedia = () => {
  const audioTrack = {
    kind: "audio",
    id: "a1",
    stop: vi.fn(),
    getSettings: () => ({ sampleRate: 48000, channelCount: 2 }),
  };
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [audioTrack] })),
    },
  });
  return audioTrack;
};

describe("useRtmpEncoder", () => {
  beforeEach(() => {
    FakeVideoEncoder.instances = [];
    FakeTrackProcessor.instances = [];
    FakeAudioEncoder.instances = [];
    FakeAudioProcessor.instances = [];
    FakeVideoEncoder.isConfigSupported.mockReset();
    FakeVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true, config: {} });
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    vi.stubGlobal("VideoEncoder", FakeVideoEncoder);
    vi.stubGlobal("VideoFrame", FakeVideoFrame);
    vi.stubGlobal("MediaStreamTrackProcessor", FakeTrackProcessor);
    vi.stubGlobal("AudioEncoder", FakeAudioEncoder);
    vi.stubGlobal("AudioData", FakeAudioData);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts ffmpeg, encodes with H.264 annexb, and feeds packets", async () => {
    const { result } = renderHook(() => useRtmpEncoder({ sessionId: "dest-test", bitrateKbps: 6000, fps: 30 }));

    let ok = false;
    await act(async () => {
      ok = await result.current.start(fakeStream(), "rtmp://host/live", "key123");
    });

    expect(ok).toBe(true);
    expect(result.current.status).toBe("live");
    expect(mockInvoke).toHaveBeenCalledWith("rtmp_start", {
      sessionId: "dest-test",
      serverUrl: "rtmp://host/live",
      streamKey: "key123",
      withAudio: false,
    });
    // The encoder was configured for H.264 Annex-B at 6 Mbps.
    const enc = FakeVideoEncoder.instances[0];
    expect(enc?.configureCalls.length).toBe(1);
    expect(enc?.configureCalls[0].codec).toBe("avc1.42E028");
    expect(enc?.configureCalls[0].avc?.format).toBe("annexb");
    expect(enc?.configureCalls[0].bitrate).toBe(6_000_000);
    // Encoded packets were streamed to the backend.
    expect(mockInvoke).toHaveBeenCalledWith("rtmp_send", expect.objectContaining({ dataBase64: expect.any(String) }));
  });

  it("sends streamKey as null when omitted", async () => {
    const { result } = renderHook(() => useRtmpEncoder({ sessionId: "dest-test" }));
    await act(async () => {
      await result.current.start(fakeStream(), "rtmp://host/live");
    });
    expect(mockInvoke).toHaveBeenCalledWith("rtmp_start", {
      sessionId: "dest-test",
      serverUrl: "rtmp://host/live",
      streamKey: null,
      withAudio: false,
    });
  });

  it("surfaces backend start failures", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("ffmpeg not found on PATH"));
    const { result } = renderHook(() => useRtmpEncoder({ sessionId: "dest-test" }));

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
    const { result } = renderHook(() => useRtmpEncoder({ sessionId: "dest-test" }));

    let ok = true;
    await act(async () => {
      ok = await result.current.start(fakeStream(), "rtmp://host/live", "k");
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("No supported H.264 profile");
  });

  it("errors when WebCodecs is unavailable", async () => {
    vi.stubGlobal("VideoEncoder", undefined);
    const { result } = renderHook(() => useRtmpEncoder({ sessionId: "dest-test" }));

    let ok = true;
    await act(async () => {
      ok = await result.current.start(fakeStream(), "rtmp://host/live", "k");
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("WebCodecs");
  });

  it("errors on a stream with no video track", async () => {
    const { result } = renderHook(() => useRtmpEncoder({ sessionId: "dest-test" }));
    let ok = true;
    await act(async () => {
      const noVideo = { getVideoTracks: () => [] } as unknown as MediaStream;
      ok = await result.current.start(noVideo, "rtmp://host/live");
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("no video track");
  });

  it("stop flushes the encoder and tears down the RTMP session", async () => {
    const { result } = renderHook(() => useRtmpEncoder({ sessionId: "dest-test" }));
    await act(async () => {
      await result.current.start(fakeStream(), "rtmp://host/live", "k");
    });

    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.status).toBe("idle");
    expect(mockInvoke).toHaveBeenCalledWith("rtmp_stop", { sessionId: "dest-test" });
    expect(FakeVideoEncoder.instances[0]?.state).toBe("closed");
  });
});

describe("useRtmpEncoder audio", () => {
  beforeEach(() => {
    FakeVideoEncoder.instances = [];
    FakeTrackProcessor.instances = [];
    FakeAudioEncoder.instances = [];
    FakeAudioProcessor.instances = [];
    FakeVideoEncoder.isConfigSupported.mockReset();
    FakeVideoEncoder.isConfigSupported.mockResolvedValue({ supported: true, config: {} });
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    vi.stubGlobal("VideoEncoder", FakeVideoEncoder);
    vi.stubGlobal("VideoFrame", FakeVideoFrame);
    vi.stubGlobal("MediaStreamTrackProcessor", FakeTrackProcessor);
    vi.stubGlobal("AudioEncoder", FakeAudioEncoder);
    vi.stubGlobal("AudioData", FakeAudioData);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("captures an input, encodes AAC, and feeds ADTS to the audio input", async () => {
    const audioTrack = stubGetUserMedia();
    const { result } = renderHook(() =>
      useRtmpEncoder({ sessionId: "dest-test", audio: { enabled: true, bitrateKbps: 160 } })
    );

    let ok = false;
    await act(async () => {
      ok = await result.current.start(fakeStream(), "rtmp://host/live", "k");
    });

    expect(ok).toBe(true);
    expect(result.current.status).toBe("live");
    expect(mockInvoke).toHaveBeenCalledWith("rtmp_start", {
      sessionId: "dest-test",
      serverUrl: "rtmp://host/live",
      streamKey: "k",
      withAudio: true,
    });
    // The audio encoder is configured for AAC-LC stereo at 160 kbps.
    const enc = FakeAudioEncoder.instances[0];
    expect(enc?.configureCalls.length).toBe(1);
    expect(enc?.configureCalls[0].codec).toBe("mp4a.40.2");
    expect(enc?.configureCalls[0].sampleRate).toBe(48000);
    expect(enc?.configureCalls[0].numberOfChannels).toBe(2);
    expect(enc?.configureCalls[0].bitrate).toBe(160_000);
    // ADTS-wrapped AAC frames were streamed to the backend.
    expect(mockInvoke).toHaveBeenCalledWith("rtmp_send_audio", expect.objectContaining({ dataBase64: expect.any(String) }));
    // The captured track is released on stop.
    await act(async () => {
      await result.current.stop();
    });
    expect(audioTrack.stop).toHaveBeenCalled();
  });

  it("fails cleanly when getUserMedia rejects", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw new Error("Permission denied");
        }),
      },
    });
    const { result } = renderHook(() => useRtmpEncoder({ sessionId: "dest-test", audio: { enabled: true } }));

    let ok = true;
    await act(async () => {
      ok = await result.current.start(fakeStream(), "rtmp://host/live", "k");
    });
    expect(ok).toBe(false);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("audio input");
    expect(mockInvoke).not.toHaveBeenCalledWith("rtmp_start", expect.anything());
  });

  it("errors when audio is enabled but WebCodecs audio is unavailable", async () => {
    vi.stubGlobal("AudioEncoder", undefined);
    const { result } = renderHook(() => useRtmpEncoder({ sessionId: "dest-test", audio: { enabled: true } }));

    let ok = true;
    await act(async () => {
      ok = await result.current.start(fakeStream(), "rtmp://host/live", "k");
    });
    expect(ok).toBe(false);
    expect(result.current.error).toContain("AudioEncoder");
  });
});

describe("wrapAdts", () => {
  it("produces a valid 7-byte header carrying the frame length", () => {
    const payload = new Uint8Array(500).fill(1);
    const adts = wrapAdts(payload, 44100, 2);
    expect(adts.length).toBe(507);
    expect(adts[0]).toBe(0xff);
    expect(adts[1]).toBe(0xf1);
    // frameLength = 507 => bits 12..11 in byte3, rest across bytes 4-5.
    const frameLength = ((adts[3] & 0x03) << 11) | (adts[4] << 3) | (adts[5] >> 5);
    expect(frameLength).toBe(507);
    expect([...adts.subarray(7)]).toEqual([...payload]);
  });

  it("maps known sample rates to the MPEG-4 table", () => {
    expect(wrapAdts(new Uint8Array(10), 48000, 2)[2] >> 2).toBe(3);
    expect(wrapAdts(new Uint8Array(10), 44100, 2)[2] >> 2).toBe(4);
  });

  it("rejects unsupported sample rates", () => {
    expect(() => wrapAdts(new Uint8Array(10), 12345, 2)).toThrow(/sample rate/);
  });
});

describe("requiredAvcLevel", () => {
  it("picks level 4.0 for 1080p30", () => {
    expect(requiredAvcLevel(1920, 1080, 30)).toBe(40);
  });

  it("picks level 5.1 for 4K30", () => {
    expect(requiredAvcLevel(3840, 2160, 30)).toBe(51);
  });

  it("stays low for SD content", () => {
    expect(requiredAvcLevel(1280, 720, 30)).toBe(31);
  });

  it("caps at the top of the table for extreme resolutions", () => {
    expect(requiredAvcLevel(7680, 4320, 60)).toBe(52);
  });
});

describe("supportsH264", () => {
  it("probes profiles at the level required for the frame size", async () => {
    const isConfigSupported = vi.fn(async () => ({ supported: true, config: {} }));
    const codec = await supportsH264({ isConfigSupported } as unknown as EncoderFactory, 1920, 1080, 6000, 30);
    expect(codec).toBe("avc1.42E028");
    expect(isConfigSupported).toHaveBeenCalledWith(
      expect.objectContaining({
        codec: "avc1.42E028",
        width: 1920,
        height: 1080,
        bitrate: 6_000_000,
        framerate: 30,
        avc: { format: "annexb" },
      })
    );
  });

  it("falls back through profiles when a higher profile is required", async () => {
    const isConfigSupported = vi.fn(async (config: VideoEncoderConfig) => ({
      supported: config.codec.startsWith("avc1.64"),
      config: {},
    }));
    const codec = await supportsH264({ isConfigSupported } as unknown as EncoderFactory, 3840, 2160, 12000, 30);
    expect(codec).toBe("avc1.640033");
    expect(isConfigSupported).toHaveBeenCalledTimes(3);
  });

  it("returns null when no profile at the required level is supported", async () => {
    const isConfigSupported = vi.fn(async () => ({ supported: false, config: {} }));
    const codec = await supportsH264({ isConfigSupported } as unknown as EncoderFactory, 1920, 1080, 6000, 30);
    expect(codec).toBeNull();
  });
});