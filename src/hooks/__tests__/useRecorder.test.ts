import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRecorder, recordingSizeError } from "../useRecorder";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

interface MockRecorder {
  state: string;
  mimeType: string;
  ondataavailable: ((e: BlobEvent) => void) | null;
  onstop: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

let lastRecorder: MockRecorder | null = null;
let recorderInstanceCount = 0;

class FakeMediaRecorder {
  state: string = "inactive";
  mimeType: string;
  ondataavailable: ((e: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    // Simulate the final dataavailable chunk (real MediaRecorder emits one
    // containing everything not yet flushed).
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob(["final-chunk"], { type: this.mimeType }) } as BlobEvent);
    }
    this.onstop?.();
  });

  constructor(_stream: MediaStream, _opts?: any) {
    this.mimeType = _opts?.mimeType ?? "video/webm";
    recorderInstanceCount += 1;
    lastRecorder = this;
  }

  static isTypeSupported(type: string): boolean {
    return type.startsWith("video/webm");
  }
}

const fakeStream = () => ({ getTracks: () => [] }) as unknown as MediaStream;

describe("useRecorder", () => {
  beforeEach(() => {
    lastRecorder = null;
    recorderInstanceCount = 0;
    mockInvoke.mockReset();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records and saves a webm blob with a default timestamped name", async () => {
    mockInvoke.mockResolvedValue({ name: "recording-test.webm", size: 100, modified: 1 });

    const { result } = renderHook(() => useRecorder({ mimeType: "video/webm" }));

    await act(async () => {
      await result.current.start(fakeStream());
    });

    expect(result.current.recording).toBe(true);
    expect(lastRecorder?.start).toHaveBeenCalled();

    let saved: string | null = null;
    await act(async () => {
      saved = await result.current.stop();
    });

    expect(saved).toBe("recording-test.webm");
    expect(result.current.recording).toBe(false);
    expect(result.current.lastSaved).toBe("recording-test.webm");
    expect(result.current.error).toBeNull();
    // The save command received the base64 body and a file name.
    const [cmd, args] = mockInvoke.mock.calls[0];
    expect(cmd).toBe("recording_save");
    expect(args.fileName).toMatch(/^recording-\d{8}-\d{6}\.webm$/);
    expect(args.dataBase64).toContain("ZmluYWwtY2h1bms");
  });

  it("uses a suggested file name when provided", async () => {
    mockInvoke.mockResolvedValue({ name: "custom.webm", size: 5, modified: 1 });
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.start(fakeStream(), "custom.webm");
      await result.current.stop();
    });

    const [cmd, args] = mockInvoke.mock.calls[0];
    expect(cmd).toBe("recording_save");
    expect(args.fileName).toBe("custom.webm");
  });

  it("no-ops a second start while recording", async () => {
    mockInvoke.mockResolvedValue({ name: "x.webm", size: 5, modified: 1 });
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.start(fakeStream());
      await result.current.start(fakeStream());
    });

    expect(recorderInstanceCount).toBe(1);
  });

  it("cancel aborts without saving", async () => {
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.start(fakeStream());
      result.current.cancel();
    });

    expect(result.current.recording).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result.current.lastSaved).toBeNull();
  });

  it("surfaces save failures without throwing", async () => {
    mockInvoke.mockRejectedValue(new Error("disk full"));
    const { result } = renderHook(() => useRecorder());

    let saved: string | null = "sentinel";
    await act(async () => {
      await result.current.start(fakeStream());
      saved = await result.current.stop();
    });

    expect(saved).toBeNull();
    expect(result.current.error).toContain("disk full");
  });

  it("returns an error when MediaRecorder is unavailable", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const { result } = renderHook(() => useRecorder());

    await act(async () => {
      await result.current.start(fakeStream());
    });

    expect(result.current.recording).toBe(false);
    expect(result.current.error).toContain("MediaRecorder is not available");
  });

  it("reports empty captures as an error", async () => {
    // A recorder whose final chunk is empty (0-byte blob) must not save.
    const EmptyFake = class extends FakeMediaRecorder {
      stop = vi.fn(() => {
        this.state = "inactive";
        if (this.ondataavailable) {
          this.ondataavailable({ data: new Blob([], { type: "video/webm" }) } as BlobEvent);
        }
        this.onstop?.();
      });
    };
    vi.stubGlobal("MediaRecorder", EmptyFake);

    const { result } = renderHook(() => useRecorder());
    let saved: string | null = "sentinel";
    await act(async () => {
      await result.current.start(fakeStream());
      saved = await result.current.stop();
    });

    expect(saved).toBeNull();
    expect(result.current.error).toContain("no frames");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("recordingSizeError", () => {
  it("accepts normal recordings", () => {
    expect(recordingSizeError(1024 * 1024)).toBeNull();
    expect(recordingSizeError(2 * 1024 * 1024 * 1024)).toBeNull();
  });

  it("rejects empty captures", () => {
    expect(recordingSizeError(0)).toContain("no frames");
  });

  it("rejects recordings beyond the 2 GiB cap", () => {
    expect(recordingSizeError(2 * 1024 * 1024 * 1024 + 1)).toContain("2 GiB limit");
  });
});