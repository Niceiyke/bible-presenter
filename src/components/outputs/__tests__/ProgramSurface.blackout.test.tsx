import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { ProgramSurface, type ProgramSurfaceRuntimeProps } from "../ProgramSurface";
import { resolveOutputFrame } from "../../../outputs/resolveOutputFrame";
import { DEFAULT_SETTINGS } from "../../../types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => path),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

const runtime: ProgramSurfaceRuntimeProps = {
  windowScale: 0.25,
  appDataDir: null,
  monitorTest: false,
  videoRef: { current: null },
  bgVideoRef: { current: null },
  bgAudioRef: { current: null },
  cameraStream: null,
  mainCameraStream: null,
  phoneStreams: {},
};

function frame(blanked: boolean) {
  return resolveOutputFrame({
    live: null,
    staged: null,
    settings: { ...DEFAULT_SETTINGS, is_blanked: blanked },
    lowerThird: null,
    propItems: [],
    config: null,
    license: null,
  });
}

describe("ProgramSurface blackout", () => {
  it("can toggle blackout while mounted without changing React hook order", () => {
    const view = render(<ProgramSurface mode="preview" silent frame={frame(false)} runtime={runtime} />);
    expect(() => view.rerender(<ProgramSurface mode="preview" silent frame={frame(true)} runtime={runtime} />)).not.toThrow();
    expect(() => view.rerender(<ProgramSurface mode="preview" silent frame={frame(false)} runtime={runtime} />)).not.toThrow();
  });
});
