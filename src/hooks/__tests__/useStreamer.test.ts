import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStreamer } from "../useStreamer";

interface MockStats {
  type: string;
  bytesSent?: number;
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  iceGatheringState: string = "new";
  connectionState: string = "new";
  onicegatheringstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addTrack = vi.fn();
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" }) as RTCSessionDescriptionInit);
  setLocalDescription = vi.fn(async (d: RTCSessionDescriptionInit) => {
    this.localDescription = { type: d.type, sdp: d.sdp ?? "", toJSON: () => ({}) } as RTCSessionDescription;
    this.iceGatheringState = "complete";
    // Simulate the async gathering completion the hook waits on.
    setTimeout(() => {
      this.iceGatheringState = "complete";
      this.onicegatheringstatechange?.();
    }, 0);
  });
  setRemoteDescription = vi.fn(async (d: RTCSessionDescriptionInit) => {
    this.remoteDescription = { type: d.type, sdp: d.sdp ?? "", toJSON: () => ({}) } as RTCSessionDescription;
  });
  getStats = vi.fn(async (): Promise<Map<string, MockStats>> => {
    const m = new Map<string, MockStats>();
    m.set("outbound", { type: "outbound-rtp", bytesSent: 256_000 });
    return m as unknown as Map<string, RTCStats>;
  });
  close = vi.fn(() => {
    this.connectionState = "closed";
  });

  constructor(_config?: RTCConfiguration) {
    FakeRTCPeerConnection.instances.push(this);
  }
}

const fakeStream = () => {
  const tracks = [{ kind: "video", id: "v1" }, { kind: "audio", id: "a1" }];
  return {
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getTracks: () => tracks,
  } as unknown as MediaStream;
};

const mockFetchResponse = (body = "answer-sdp", opts: { ok?: boolean; status?: number; location?: string } = {}) => {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 201,
    text: vi.fn(async () => body),
    headers: new Headers(opts.location ? { Location: opts.location } : {}),
  } as unknown as Response;
};

describe("useStreamer", () => {
  beforeEach(() => {
    FakeRTCPeerConnection.instances = [];
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("negotiates WHIP: offer POST, answer applied, live on connected", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse("answer-sdp", { status: 201, location: "https://whip.example/res/abc" })
    );

    const { result } = renderHook(() => useStreamer());

    let ok = false;
    await act(async () => {
      ok = await result.current.start(fakeStream(), { url: "https://whip.example/stream", token: "secret" });
    });

    expect(ok).toBe(true);
    const pc = FakeRTCPeerConnection.instances[0];
    expect(pc?.addTrack).toHaveBeenCalled();
    // The offer was POSTed to the endpoint with a Bearer token.
    const [calledUrl, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledUrl).toBe("https://whip.example/stream");
    expect(init.method).toBe("POST");
    expect(init.headers["Authorization"]).toBe("Bearer secret");
    expect(init.headers["Content-Type"]).toBe("application/sdp");
    expect(init.body).toBe("offer-sdp");
    expect(pc?.remoteDescription?.sdp).toBe("answer-sdp");
    expect(result.current.resourceUrl).toBe("https://whip.example/res/abc");

    // Fire the connected transition.
    await act(async () => {
      pc!.connectionState = "connected";
      pc!.onconnectionstatechange?.();
    });
    expect(result.current.status).toBe("live");

    // Bitrate polling kicked in after a tick.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200));
    });
    expect(result.current.bitrateKbps).toBeGreaterThan(0);
  });

  it("reports endpoint rejection without throwing", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse("", { ok: false, status: 401 })
    );

    const { result } = renderHook(() => useStreamer());
    let ok = true;
    await act(async () => {
      ok = await result.current.start(fakeStream(), { url: "https://whip.example/stream" });
    });

    expect(ok).toBe(false);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("401");
  });

  it("errors when the endpoint returns an empty answer", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockFetchResponse("  ", { status: 200 }));

    const { result } = renderHook(() => useStreamer());
    let ok = true;
    await act(async () => {
      ok = await result.current.start(fakeStream(), { url: "https://whip.example/stream" });
    });

    expect(ok).toBe(false);
    expect(result.current.error).toContain("empty answer");
  });

  it("errors on missing URL and on missing video track", async () => {
    const { result } = renderHook(() => useStreamer());

    await act(async () => {
      await result.current.start(fakeStream(), { url: "  " });
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("URL is empty");

    await act(async () => {
      const noVideo = { getVideoTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
      await result.current.start(noVideo, { url: "https://whip.example/stream" });
    });
    expect(result.current.error).toContain("no video track");
  });

  it("errors when RTCPeerConnection is unavailable", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    const { result } = renderHook(() => useStreamer());

    await act(async () => {
      await result.current.start(fakeStream(), { url: "https://whip.example/stream" });
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("RTCPeerConnection is not available");
  });

  it("no-ops a second start while streaming", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockFetchResponse("answer-sdp"));

    const { result } = renderHook(() => useStreamer());
    await act(async () => {
      await result.current.start(fakeStream(), { url: "https://whip.example/stream" });
      await result.current.start(fakeStream(), { url: "https://whip.example/stream" });
    });
    expect(FakeRTCPeerConnection.instances.length).toBe(1);
  });

  it("stop deletes the WHIP resource and tears down", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse("answer-sdp", { location: "https://whip.example/res/abc" })
    );

    const { result } = renderHook(() => useStreamer());
    await act(async () => {
      await result.current.start(fakeStream(), { url: "https://whip.example/stream" });
      await result.current.stop();
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.resourceUrl).toBeNull();
    const pc = FakeRTCPeerConnection.instances[0];
    expect(pc?.close).toHaveBeenCalled();
    // Second fetch call was the DELETE.
    const deletes = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, init]) => (init as RequestInit)?.method === "DELETE"
    );
    expect(deletes.length).toBe(1);
    expect(deletes[0][0]).toBe("https://whip.example/res/abc");
  });
});