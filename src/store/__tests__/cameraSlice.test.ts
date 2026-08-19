import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { useAppStore } from "../index";

const initialState = useAppStore.getState();

describe("cameraSlice refreshCameras (WP4 P1-2)", () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enumerates devices without opening a temporary getUserMedia capture", async () => {
    const getUM = vi.fn();
    const enumerateDevices = vi.fn(async () => [
      { kind: "videoinput", deviceId: "cam-1", label: "Front" },
      { kind: "videoinput", deviceId: "cam-2", label: "" },
      { kind: "audioinput", deviceId: "mic-1", label: "Mic" },
    ]);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: getUM, enumerateDevices },
    });

    await useAppStore.getState().refreshCameras();

    // No temporary capture is opened as a second acquisition path.
    expect(getUM).not.toHaveBeenCalled();
    // Only videoinput devices are listed, with a fallback label.
    expect(useAppStore.getState().availableCameras).toEqual([
      { deviceId: "cam-1", label: "Front" },
      { deviceId: "cam-2", label: "Camera cam-2..." },
    ]);
    // First camera auto-selected.
    expect(useAppStore.getState().selectedCameraId).toBe("cam-1");
  });
});