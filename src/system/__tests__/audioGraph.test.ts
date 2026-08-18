import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  __setAudioContextFactoryForTest,
  getAudioGraphSnapshot,
  mapAudioError,
  refreshAudioDevices,
  resetAudioGraph,
  retryAudio,
  setAudioDeviceId,
  setAudioEnabled,
  setAudioMuted,
  setAudioVolume,
} from "../audioGraph";

function makeAudioTrack() {
  const track = {
    stop: vi.fn(),
    getSettings: () => ({ sampleRate: 48000, channelCount: 2 }),
    onended: null,
    kind: "audio",
  } as unknown as MediaStreamTrack;
  return track;
}

function makeAudioStream() {
  const track = makeAudioTrack();
  return {
    stream: {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream,
    track,
  };
}

/** A minimal fake AudioContext so gain/mute wiring is observable in jsdom. */
function makeFakeAudioContext() {
  const gain = { gain: { value: 1 }, connect: vi.fn() };
  const programTrack = makeAudioTrack();
  return {
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
    createGain: vi.fn(() => gain),
    createMediaStreamDestination: vi.fn(() => ({
      stream: { getAudioTracks: () => [programTrack] } as unknown as MediaStream,
    })),
    close: vi.fn(() => Promise.resolve()),
    _gain: gain,
    _programTrack: programTrack,
  };
}

let gumMock: ReturnType<typeof vi.fn>;
let enumMock: ReturnType<typeof vi.fn>;
let fakeContext: ReturnType<typeof makeFakeAudioContext>;
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

/** jsdom has no MediaStream; the graph wraps a raw track in one. */
function installMediaStreamPolyfill() {
  const tracks = new Set<MediaStreamTrack>();
  (globalThis as unknown as { MediaStream: unknown }).MediaStream = class {
    constructor(list?: MediaStreamTrack[]) {
      (list ?? []).forEach((t) => tracks.add(t));
    }
    getTracks() {
      return [...tracks];
    }
    getAudioTracks() {
      return [...tracks].filter((t) => t.kind === "audio");
    }
    getVideoTracks() {
      return [...tracks].filter((t) => t.kind === "video");
    }
    addTrack(t: MediaStreamTrack) {
      tracks.add(t);
    }
  };
}

beforeEach(() => {
  resetAudioGraph();
  installMediaStreamPolyfill();
  gumMock = vi.fn();
  enumMock = vi.fn().mockResolvedValue([
    { kind: "audioinput", deviceId: "mic-1", label: "Mic 1" },
    { kind: "audioinput", deviceId: "mic-2", label: "Mic 2" },
    { kind: "videoinput", deviceId: "cam-1", label: "Cam 1" },
  ]);
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: gumMock, enumerateDevices: enumMock },
    configurable: true,
  });
  fakeContext = makeFakeAudioContext();
  __setAudioContextFactoryForTest(() => fakeContext as unknown as AudioContext);
});

afterEach(() => {
  resetAudioGraph();
  __setAudioContextFactoryForTest(null);
  vi.useRealTimers();
});

describe("mapAudioError", () => {
  it("maps permission / device / unknown", () => {
    expect(mapAudioError({ name: "NotAllowedError" })).toBe("permission");
    expect(mapAudioError({ name: "NotFoundError" })).toBe("device");
    expect(mapAudioError({ name: "Something" })).toBe("unknown");
  });
});

describe("device enumeration", () => {
  it("lists audio inputs and auto-selects the first", async () => {
    refreshAudioDevices();
    await flushMicrotasks();
    const snap = getAudioGraphSnapshot();
    expect(snap.devices.map((d) => d.deviceId)).toEqual(["mic-1", "mic-2"]);
    expect(snap.deviceId).toBe("mic-1");
  });
});

describe("enable / disable", () => {
  it("opens the shared program track once when enabled", async () => {
    const { stream, track } = makeAudioStream();
    gumMock.mockResolvedValue(stream);

    setAudioEnabled(true);
    await flushMicrotasks();

    expect(gumMock).toHaveBeenCalledTimes(1);
    const snap = getAudioGraphSnapshot();
    expect(snap.status).toBe("connected");
    expect(snap.enabled).toBe(true);
    // Program track comes from the gain destination, not the raw track.
    expect(snap.programTrack).toBe(fakeContext._programTrack);
    expect(fakeContext.createGain).toHaveBeenCalledTimes(1);
    void track;
  });

  it("closes the capture when disabled", async () => {
    const { stream } = makeAudioStream();
    gumMock.mockResolvedValue(stream);
    setAudioEnabled(true);
    await flushMicrotasks();

    setAudioEnabled(false);
    const snap = getAudioGraphSnapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.status).toBe("idle");
    expect(snap.programTrack).toBeNull();
  });

  it("surfaces a permission error", async () => {
    gumMock.mockRejectedValue({ name: "NotAllowedError" });
    setAudioEnabled(true);
    await flushMicrotasks();
    const snap = getAudioGraphSnapshot();
    expect(snap.status).toBe("error");
    expect(snap.errorKind).toBe("permission");
    expect(snap.error).toContain("permission");
  });
});

describe("volume / mute", () => {
  it("applies volume and mute to the gain node without touching video", async () => {
    const { stream } = makeAudioStream();
    gumMock.mockResolvedValue(stream);
    setAudioEnabled(true);
    await flushMicrotasks();
    expect(fakeContext._gain.gain.value).toBe(1);

    setAudioVolume(0.4);
    expect(fakeContext._gain.gain.value).toBe(0.4);
    expect(getAudioGraphSnapshot().volume).toBe(0.4);

    setAudioMuted(true);
    expect(fakeContext._gain.gain.value).toBe(0);
    expect(getAudioGraphSnapshot().muted).toBe(true);

    setAudioMuted(false);
    expect(fakeContext._gain.gain.value).toBe(0.4);
  });
});

describe("device selection", () => {
  it("re-opens the capture with the new device id", async () => {
    const first = makeAudioStream();
    const second = makeAudioStream();
    gumMock.mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);

    setAudioEnabled(true);
    await flushMicrotasks();
    // Enumeration auto-selected the first input.
    expect(getAudioGraphSnapshot().deviceId).toBe("mic-1");

    setAudioDeviceId("mic-2");
    await flushMicrotasks();

    expect(gumMock).toHaveBeenCalledTimes(2);
    expect(getAudioGraphSnapshot().deviceId).toBe("mic-2");
    expect(getAudioGraphSnapshot().status).toBe("connected");
  });
});

describe("device loss reconnect", () => {
  it("reconnects once when the raw track ends", async () => {
    vi.useFakeTimers();
    const first = makeAudioStream();
    gumMock.mockResolvedValueOnce(first.stream);
    setAudioEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(getAudioGraphSnapshot().status).toBe("connected");

    const second = makeAudioStream();
    gumMock.mockResolvedValueOnce(second.stream);

    first.track.onended?.({} as Event);
    expect(getAudioGraphSnapshot().status).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(800);
    await vi.advanceTimersByTimeAsync(0);
    expect(gumMock).toHaveBeenCalledTimes(2);
    expect(getAudioGraphSnapshot().status).toBe("connected");
  });

  it("retry re-opens after a failure", async () => {
    gumMock.mockRejectedValueOnce({ name: "NotFoundError" });
    setAudioEnabled(true);
    await flushMicrotasks();
    expect(getAudioGraphSnapshot().status).toBe("error");

    const { stream } = makeAudioStream();
    gumMock.mockResolvedValueOnce(stream);
    retryAudio();
    await flushMicrotasks();
    expect(getAudioGraphSnapshot().status).toBe("connected");
  });
});
