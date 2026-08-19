import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { ProgramFeedPreview } from "../ProgramFeedPreview";
import { useAppStore } from "../../../store";
import { OUTPUT_SCHEMA_VERSION } from "../../../types";
import type { OutputConfig, PresentationSettings, DisplayItem } from "../../../types";
import type { ProgramFrame } from "../../../compositor/ProgramFrame";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../ProgramFeedCanvas", () => ({
  ProgramFeedCanvas: (props: any) => {
    lastCanvasProps = props;
    return null;
  },
}));

vi.mock("../../usePhoneCameraHost", () => ({
  usePhoneCameraStreams: () => ({}),
}));

vi.mock("../../useSharedLocalCameraStream", () => ({
  useSharedLocalCameraStreams: () => ({}),
}));

let lastCanvasProps: { frame: ProgramFrame; geometry: { width: number; height: number }; fps: number } | null = null;

const baseSettings: PresentationSettings = {
  theme: "dark",
  reference_position: "bottom",
  background: { type: "None" },
  is_blanked: false,
  font_size: 72,
  disabled_bible_versions: [],
  auto_split_verses: true,
  verse_split_threshold: 200,
};

const makeConfig = (overrides: Partial<OutputConfig> = {}): OutputConfig => ({
  schema_version: OUTPUT_SCHEMA_VERSION,
  id: "record-main",
  kind: "recorder",
  label: "Recording",
  enabled: true,
  visible: true,
  source: { type: "live" },
  geometry: { width: 1280, height: 720 },
  capture_fps: 24,
  overlays: { props: true, lower_third: true, logo: true },
  ...overrides,
});

describe("ProgramFeedPreview config handling (WP1)", () => {
  beforeEach(() => {
    useAppStore.setState(
      {
        liveItem: null,
        stagedItem: null,
        settings: baseSettings,
        propItems: [],
        currentLowerThird: null,
        scenes: [],
        appDataDir: null,
      },
      false
    );
    lastCanvasProps = null;
  });

  it("resolves the passed record config, not a hardcoded live preview", () => {
    const staged = {
      type: "Verse",
      data: { book: "JHN", chapter: 3, verse: 16, text: "For God so loved the world", version: "KJV" },
    } as DisplayItem;
    useAppStore.setState({ stagedItem: staged });
    render(
      <ProgramFeedPreview
        config={makeConfig({ source: { type: "staged" }, overlays: { props: false, lower_third: false, logo: false } })}
      />
    );
    expect(lastCanvasProps).not.toBeNull();
    expect(lastCanvasProps!.frame.source.kind).toBe("staged");
    expect(lastCanvasProps!.frame.overlays.props).toEqual([]);
    expect(lastCanvasProps!.frame.overlays.lower_third).toBeNull();
    expect(lastCanvasProps!.frame.canvas).toEqual({ width: 1280, height: 720, fps: 24 });
    expect(lastCanvasProps!.geometry).toEqual({ width: 1280, height: 720 });
    expect(lastCanvasProps!.fps).toBe(24);
  });

  it("resolves a blank source config to a black frame", () => {
    render(<ProgramFeedPreview config={makeConfig({ source: { type: "blank" } })} />);
    expect(lastCanvasProps!.frame.source.kind).toBe("blank");
    expect(lastCanvasProps!.frame.blackout).toBe(true);
    expect(lastCanvasProps!.frame.layers).toEqual([{ kind: "blank" }]);
  });

  it("falls back to the full unmasked live program when no config is given", () => {
    const live = {
      type: "Verse",
      data: { book: "JHN", chapter: 3, verse: 16, text: "For God so loved the world", version: "KJV" },
    } as DisplayItem;
    useAppStore.setState({ liveItem: live });
    render(<ProgramFeedPreview />);
    expect(lastCanvasProps!.frame.source.kind).toBe("live");
    expect(lastCanvasProps!.frame.source.kind === "live" ? lastCanvasProps!.frame.source.item : null).toEqual(live);
    // Default masks are all enabled.
    expect(lastCanvasProps!.frame.overlays).toEqual({ props: [], lower_third: null, logo: null });
    expect(lastCanvasProps!.geometry).toEqual({ width: 1920, height: 1080 });
    expect(lastCanvasProps!.fps).toBe(30);
  });

  it("passes an item source config through unchanged", () => {
    const timer = {
      type: "Timer",
      data: { timer_type: "countup", started_at: 0 },
    } as DisplayItem;
    render(<ProgramFeedPreview config={makeConfig({ source: { type: "item", item: timer } })} />);
    expect(lastCanvasProps!.frame.source.kind).toBe("item");
    expect(lastCanvasProps!.frame.source.kind === "item" ? lastCanvasProps!.frame.source.item : null).toEqual(timer);
  });
});
