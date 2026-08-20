import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useEnginePreview } from "../useEnginePreview";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];

describe("Phase C3 — engine MJPEG preview hook", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stays idle (no polling) while disabled", () => {
    mockInvoke.mockResolvedValue({ response: { id: 1, ok: true }, events: [] });
    const { result } = renderHook(() => useEnginePreview(false));
    expect(result.current.connected).toBe(false);
    expect(result.current.polling).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("decodes preview frames and keeps the latest per output", async () => {
    vi.useFakeTimers();
    mockInvoke.mockResolvedValue({
      response: { id: 1, ok: true },
      events: [
        { event: { event: "preview_frame", output_id: "output", frame_index: 1, width: 480, height: 270, image_base64: b64(JPEG) } },
        { event: { event: "preview_frame", output_id: "stage", frame_index: 2, width: 480, height: 270, image_base64: b64(JPEG) } },
      ],
    });
    const { result } = renderHook(() => useEnginePreview(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.connected).toBe(true);
    expect(result.current.frames["output"]).toBeDefined();
    expect(result.current.frames["output"].width).toBe(480);
    expect(result.current.frames["output"].height).toBe(270);
    expect(result.current.frames["output"].frameIndex).toBe(1);
    expect(result.current.frames["stage"].frameIndex).toBe(2);

    // A stale frame (lower index) is ignored.
    mockInvoke.mockResolvedValue({
      response: { id: 2, ok: true },
      events: [{ event: { event: "preview_frame", output_id: "output", frame_index: 0, width: 480, height: 270, image_base64: b64(JPEG) } }],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current.frames["output"].frameIndex).toBe(1);
  });

  it("reports a disconnected engine on invoke failure", async () => {
    vi.useFakeTimers();
    mockInvoke.mockRejectedValue(new Error("engine_unavailable"));
    const { result } = renderHook(() => useEnginePreview(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.connected).toBe(false);
    expect(result.current.error).toContain("engine_unavailable");
  });
});