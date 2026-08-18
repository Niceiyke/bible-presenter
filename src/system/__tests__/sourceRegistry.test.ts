import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireSource,
  describeSourceError,
  getAllSourceStreams,
  getSourceSnapshot,
  isPhoneSource,
  mapSourceError,
  phoneStatusFromConnection,
  releaseSource,
  removePhoneSource,
  resetSourceRegistry,
  resolveSourceKind,
  retrySource,
  setPhoneSource,
} from "../sourceRegistry";

function makeTrack(): MediaStreamTrack {
  const track = { stop: vi.fn(), onended: null, kind: "video", readyState: "live" } as unknown as MediaStreamTrack;
  return track;
}

function makeStream() {
  const track = makeTrack();
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

let gumMock: ReturnType<typeof vi.fn>;

const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  resetSourceRegistry();
  gumMock = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: gumMock },
    configurable: true,
  });
});

afterEach(() => {
  resetSourceRegistry();
  vi.useRealTimers();
});

describe("source kind classification", () => {
  it("classifies phone / native / ndi / local", () => {
    expect(resolveSourceKind("phone-camera-abc")).toBe("phone");
    expect(resolveSourceKind("native:webcam-0")).toBe("native");
    expect(resolveSourceKind("ndi:source")).toBe("ndi");
    expect(resolveSourceKind("webcam-0")).toBe("local");
    expect(isPhoneSource("phone-camera-abc")).toBe(true);
    expect(isPhoneSource("webcam-0")).toBe(false);
  });
});

describe("mapSourceError", () => {
  it("maps permission / device / unknown", () => {
    expect(mapSourceError({ name: "NotAllowedError" })).toBe("permission");
    expect(mapSourceError({ name: "NotFoundError" })).toBe("device");
    expect(mapSourceError({ name: "NotReadableError" })).toBe("device");
    expect(mapSourceError({ name: "SomethingElse" })).toBe("unknown");
    expect(mapSourceError(undefined)).toBe("unknown");
  });
});

describe("local camera acquisition", () => {
  it("opens a device once and shares it across consumers", async () => {
    const { stream } = makeStream();
    let resolve: (s: MediaStream) => void = () => {};
    gumMock.mockImplementation(() => new Promise((r) => (resolve = r)));

    acquireSource("webcam-0", "a");
    acquireSource("webcam-0", "b");

    expect(gumMock).toHaveBeenCalledTimes(1);
    expect(getSourceSnapshot("webcam-0")?.status).toBe("opening");

    resolve(stream);
    await Promise.resolve();

    const state = getSourceSnapshot("webcam-0");
    expect(state?.status).toBe("connected");
    expect(state?.stream).toBe(stream);
    expect(Object.keys(getAllSourceStreams())).toContain("webcam-0");
  });

  it("closes the stream when the last consumer releases it", async () => {
    const { stream, track } = makeStream();
    gumMock.mockResolvedValue(stream);

    acquireSource("webcam-0", "a");
    acquireSource("webcam-0", "b");
    await Promise.resolve();

    releaseSource("webcam-0", "a");
    expect(getSourceSnapshot("webcam-0")).not.toBeNull();
    expect(track.stop).not.toHaveBeenCalled();

    releaseSource("webcam-0", "b");
    expect(getSourceSnapshot("webcam-0")).toBeNull();
    expect(track.stop).toHaveBeenCalled();
  });

  it("does not open phone / native / ndi ids", () => {
    acquireSource("phone-camera-abc", "a");
    acquireSource("native:x", "a");
    acquireSource("ndi:y", "a");
    expect(gumMock).not.toHaveBeenCalled();
  });

  it("surfaces an error status with a classified reason", async () => {
    gumMock.mockRejectedValue({ name: "NotAllowedError" });
    acquireSource("webcam-0", "a");
    await flushMicrotasks();
    const state = getSourceSnapshot("webcam-0");
    expect(state?.status).toBe("error");
    expect(state?.errorKind).toBe("permission");
  });

  it("retry re-opens a failed device", async () => {
    gumMock.mockRejectedValueOnce({ name: "NotFoundError" });
    acquireSource("webcam-0", "a");
    await flushMicrotasks();
    expect(getSourceSnapshot("webcam-0")?.status).toBe("error");

    const { stream } = makeStream();
    gumMock.mockResolvedValueOnce(stream);
    retrySource("webcam-0");
    await Promise.resolve();
    expect(getSourceSnapshot("webcam-0")?.status).toBe("connected");
  });

  it("reconnects once when a live track ends", async () => {
    vi.useFakeTimers();
    const first = makeStream();
    gumMock.mockResolvedValueOnce(first.stream);

    acquireSource("webcam-0", "a");
    await vi.advanceTimersByTimeAsync(0);
    expect(getSourceSnapshot("webcam-0")?.status).toBe("connected");

    const second = makeStream();
    gumMock.mockResolvedValueOnce(second.stream);

    // Simulate the device being unplugged: the live track ends.
    first.track.onended?.({} as Event);
    expect(getSourceSnapshot("webcam-0")?.status).toBe("reconnecting");
    expect(gumMock).toHaveBeenCalledTimes(1);

    // Advance past the reconnect delay → re-open → connected.
    await vi.advanceTimersByTimeAsync(800);
    await vi.advanceTimersByTimeAsync(0);
    expect(gumMock).toHaveBeenCalledTimes(2);
    expect(getSourceSnapshot("webcam-0")?.status).toBe("connected");
    expect(getSourceSnapshot("webcam-0")?.stream).toBe(second.stream);
  });
});

describe("phone source registration", () => {
  it("registers / updates / removes a phone source", () => {
    setPhoneSource("phone-camera-abc", null, "opening");
    let state = getSourceSnapshot("phone-camera-abc");
    expect(state?.status).toBe("opening");
    expect(state?.kind).toBe("phone");

    setPhoneSource("phone-camera-abc", null, "connected");
    expect(getSourceSnapshot("phone-camera-abc")?.status).toBe("connected");

    removePhoneSource("phone-camera-abc");
    expect(getSourceSnapshot("phone-camera-abc")).toBeNull();
  });

  it("ignores non-phone ids for registration", () => {
    setPhoneSource("webcam-0", null, "connected");
    expect(getSourceSnapshot("webcam-0")).toBeNull();
  });

  it("maps peer-connection states to unified statuses", () => {
    expect(phoneStatusFromConnection("connected")).toBe("connected");
    expect(phoneStatusFromConnection("connecting")).toBe("opening");
    expect(phoneStatusFromConnection("disconnected")).toBe("reconnecting");
    expect(phoneStatusFromConnection("failed")).toBe("error");
    expect(phoneStatusFromConnection("closed")).toBe("disconnected");
  });
});

describe("describeSourceError", () => {
  it("returns human messages for error kinds", () => {
    expect(describeSourceError("permission")).toContain("permission");
    expect(describeSourceError("device")).toContain("unavailable");
    expect(describeSourceError("unknown")).toBeTruthy();
    expect(describeSourceError(null)).toBeNull();
  });
});
