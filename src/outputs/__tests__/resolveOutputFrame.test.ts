import { describe, expect, it } from "vitest";
import { resolveOutputFrame } from "../resolveOutputFrame";
import type { ResolveOutputFrameInput } from "../resolveOutputFrame";
import type {
  DisplayItem,
  OutputConfig,
  PresentationSettings,
} from "../../types";

const settings: PresentationSettings = {
  theme: "dark",
  reference_position: "bottom",
  background: { type: "None" },
  is_blanked: false,
  font_size: 72,
  disabled_bible_versions: [],
  auto_split_verses: true,
  verse_split_threshold: 200,
  reference_output_height: 1080,
};

function verse(book = "John", chapter = 3, verseNum = 16): DisplayItem {
  return {
    type: "Verse",
    data: {
      book,
      chapter,
      verse: verseNum,
      version: "KJV",
      text: "For God so loved the world...",
    } as never,
  };
}

function mediaPath(path: string): DisplayItem {
  return {
    type: "Media",
    data: {
      id: "m1",
      name: "video",
      kind: "media",
      media_type: "Video",
      path,
      fit_mode: "cover",
      volume: 1,
      playback_rate: 1,
      loop_playback: true,
    } as never,
  };
}

function outputConfig(overrides: Partial<OutputConfig> = {}): OutputConfig {
  return {
    id: "output-main",
    kind: "window",
    label: "Output",
    enabled: true,
    visible: true,
    source: { type: "live" },
    geometry: { width: 1920, height: 1080 },
    overlays: { props: true, lower_third: true, logo: true },
    window_label: "output",
    ...overrides,
  };
}

function input(overrides: Partial<ResolveOutputFrameInput> = {}): ResolveOutputFrameInput {
  return {
    live: verse(),
    staged: mediaPath("/movies/clip.mp4"),
    settings,
    lowerThird: null,
    propItems: [],
    config: null,
    license: null,
    ...overrides,
  };
}

describe("resolveOutputFrame source selection", () => {
  it("defaults to live for a null config", () => {
    const frame = resolveOutputFrame(input());
    expect(frame.item?.type).toBe("Verse");
    expect(frame.config).toBeNull();
  });

  it("renders the staged item for a staged source", () => {
    const frame = resolveOutputFrame(
      input({ config: outputConfig({ source: { type: "staged" } }) }),
    );
    expect(frame.item?.type).toBe("Media");
  });

  it("renders a blank black output for a blank source", () => {
    const frame = resolveOutputFrame(
      input({ config: outputConfig({ source: { type: "blank" } }) }),
    );
    expect(frame.item).toBeNull();
  });

  it("keeps live for an explicit live source", () => {
    const frame = resolveOutputFrame(
      input({ config: outputConfig({ source: { type: "live" } }) }),
    );
    expect(frame.item?.type).toBe("Verse");
  });
});

describe("resolveOutputFrame presentation overrides", () => {
  it("applies output theme / scale / background / blanked over broadcast settings", () => {
    const frame = resolveOutputFrame(
      input({
        config: outputConfig({
          presentation: {
            theme: "light",
            reference_output_height: 1440,
            blanked: true,
          },
        }),
      }),
    );
    expect(frame.settings.theme).toBe("light");
    expect(frame.blanked).toBe(true);
    // Blanked suppressed the item and forces black.
    expect(frame.item).toBeNull();
  });

  it("inherits broadcast settings when there is no presentation override", () => {
    const frame = resolveOutputFrame(input({ config: outputConfig() }));
    expect(frame.settings.theme).toBe("dark");
    expect(frame.settings.reference_output_height).toBe(1080);
    expect(frame.referenceOutputHeight).toBe(1080);
  });
});

describe("resolveOutputFrame overlay masks", () => {
  const lt = { data: { kind: "Nameplate", name: "Jane" } as never, template: {} as never };

    const prop = {
      id: "p1",
      kind: "image",
      path: "/x.png",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      opacity: 1,
      visible: true,
    } as never;

    it("masks lower third and props off per overlay config", () => {
      const frame = resolveOutputFrame(
        input({
          lowerThird: lt,
          propItems: [prop],
          config: outputConfig({ overlays: { props: false, lower_third: false, logo: false } }),
        }),
      );
      expect(frame.propItems).toEqual([]);
      expect(frame.lowerThird).toBeNull();
      // raw state is preserved for reasoning
      expect(frame.rawLowerThird).not.toBeNull();
    });

    it("keeps lower third and props when masks are on", () => {
      const frame = resolveOutputFrame(
        input({
          lowerThird: lt,
          propItems: [prop],
          config: outputConfig(),
        }),
      );
      expect(frame.propItems.length).toBe(1);
      expect(frame.lowerThird).not.toBeNull();
    });
});

describe("resolveOutputFrame watermark", () => {
  it("shows the watermark on an active Free license", () => {
    const frame = resolveOutputFrame(
      input({ license: { status: "active", tier: "free" } as never }),
    );
    expect(frame.watermark).toBe(true);
  });

  it("does not show the watermark on Pro/Premium", () => {
    const frame = resolveOutputFrame(
      input({ license: { status: "active", tier: "pro" } as never }),
    );
    expect(frame.watermark).toBe(false);
  });
});

describe("resolveOutputFrame backgrounds", () => {
  it("resolves background layers for the current item", () => {
    const s: PresentationSettings = {
      ...settings,
      background: { type: "Video", value: { path: "/bg.mp4", loopVideo: true, muted: true, objectFit: "cover", opacity: 0.5, playbackRate: 1 } },
    };
    const frame = resolveOutputFrame(input({ settings: s }));
    expect(frame.backgrounds.video?.path).toBe("/bg.mp4");
    expect(frame.backgrounds.camera).toBeNull();
  });
});
