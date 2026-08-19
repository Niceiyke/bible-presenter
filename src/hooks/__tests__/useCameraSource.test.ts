import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCameraSource } from "../useCameraSource";
import { resetSourceRegistry } from "../../system/sourceRegistry";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("useCameraSource (output-window stability)", () => {
  beforeEach(() => {
    resetSourceRegistry();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => []),
        getUserMedia: vi.fn(async () => {
          throw new Error("no device");
        }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders for an UNREGISTERED local source without a React #185 loop", () => {
    // Regression: useSyncExternalStore re-reads the snapshot on every render and
    // compares with Object.is. The getter previously returned a fresh fallback
    // object each call, so an unregistered source (as seen by the output
    // window's background/main cameras) appeared to change forever → React error
    // #185. The stable fallback reference lets it render once and settle.
    const { result } = renderHook(() => useCameraSource("unregistered-cam-1", "test-consumer"));
    // Rendered without throwing / infinite-looping (#185); the source may be
    // idle or opening depending on the async acquisition.
    expect(result.current).toBeDefined();
    expect(result.current.retry).toBeTypeOf("function");
    expect(["idle", "opening"]).toContain(result.current.status);
  });

  it("renders for a null deviceId without looping", () => {
    const { result } = renderHook(() => useCameraSource(null, "test-consumer"));
    expect(result.current.stream).toBeNull();
    expect(result.current.status).toBe("idle");
  });
});
