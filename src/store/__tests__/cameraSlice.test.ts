import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { useAppStore } from "../index";
import { resetSourceRegistry } from "../../system/sourceRegistry";

const initialState = useAppStore.getState();

describe("cameraSlice refreshCameras (WP4 P1-2)", () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
    resetSourceRegistry();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("warms camera permission once then enumerates, without holding a capture open", async () => {
    const stop = vi.fn();
    const getUM = vi.fn(async () => ({
      getTracks: () => [{ stop }],
    }));
    const enumerateDevices = vi.fn(async () => [
      { kind: "videoinput", deviceId: "cam-1", label: "Front" },
      { kind: "videoinput", deviceId: "cam-2", label: "" },
      { kind: "audioinput", deviceId: "mic-1", label: "Mic" },
    ]);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: getUM, enumerateDevices },
    });

    await useAppStore.getState().refreshCameras();

    // ONE permission request routed through the registry policy — this is what
    // makes browsers reveal the webcam list on first run — but the track is
    // immediately stopped (no persistent capture as a second acquisition path).
    expect(getUM).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalled();
    // Only videoinput devices are listed, with a fallback label.
    expect(useAppStore.getState().availableCameras).toEqual([
      { deviceId: "cam-1", label: "Front" },
      { deviceId: "cam-2", label: "Camera cam-2..." },
    ]);
    // First camera auto-selected.
    expect(useAppStore.getState().selectedCameraId).toBe("cam-1");
  });

  it("is idempotent — priming does not re-request permission on a second refresh", async () => {
    const getUM = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    const enumerateDevices = vi.fn(async () => []);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: getUM, enumerateDevices },
    });

    await useAppStore.getState().refreshCameras();
    await useAppStore.getState().refreshCameras();
    expect(getUM).toHaveBeenCalledTimes(1);
  });
});
