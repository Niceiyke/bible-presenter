import { describe, expect, it } from "vitest";
import {
  resolveProgramFrame,
  getEffectiveBg,
  deriveLogoState,
  collectFrameMediaPaths,
  resolveThemeColors,
} from "../ProgramFrameResolver";
import type { ProgramFrameInput } from "../ProgramFrameResolver";
import { OUTPUT_SCHEMA_VERSION, DEFAULT_LT_TEMPLATE } from "../../types";
import { THEMES } from "../../types";
import type {
  DisplayItem,
  OutputConfig,
  PresentationSettings,
  PropItem,
  LowerThirdPayload,
  Scene,
} from "../../types";

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

const verseItem: DisplayItem = {
  type: "Verse",
  data: { book: "JHN", chapter: 3, verse: 16, text: "For God so loved the world", version: "KJV" },
};

const mediaImage: DisplayItem = {
  type: "Media",
  data: { id: "m1", name: "Banner", path: "images/banner.png", media_type: "Image", fit_mode: "contain", tags: [] },
};

const cameraItem: DisplayItem = {
  type: "Camera",
  data: { deviceId: "cam-1", opacity: 1, objectFit: "cover", mirrored: false },
};

const timerItem: DisplayItem = {
  type: "Timer",
  data: { timer_type: "countup", started_at: 0 },
};

const songItem: DisplayItem = {
  type: "Song",
  data: {
    song_id: "s1",
    title: "Amazing Grace",
    section_label: "Chorus",
    lines: ["Amazing grace", "how sweet the sound"],
    slide_index: 0,
    total_slides: 1,
    style: "FullSlide",
  },
};

const customSlideItem: DisplayItem = {
  type: "CustomSlide",
  data: {
    presentation_id: "p1",
    presentation_name: "Sermon",
    slide_index: 0,
    slide_count: 1,
    background: { type: "color", value: "#1a1a2e" },
    elements: [
      {
        id: "e1",
        kind: "image",
        x: 10, y: 10, w: 80, h: 20, z_index: 1,
        content: "slides/photo.jpg",
        objectFit: "contain",
      },
    ],
  },
};

const propClock: PropItem = {
  id: "pr1",
  kind: "clock",
  x: 5, y: 5, w: 10, h: 10, opacity: 1, visible: true,
  text: "HH:mm:ss",
  color: "#ffffff",
};

const lowerThird: LowerThirdPayload = {
  data: { kind: "Nameplate", data: { name: "Jane Doe", title: "Pastor" } },
  template: DEFAULT_LT_TEMPLATE,
};

const makeConfig = (overrides: Partial<OutputConfig> = {}): OutputConfig => ({
  schema_version: OUTPUT_SCHEMA_VERSION,
  id: "output",
  kind: "window",
  label: "Output",
  enabled: true,
  visible: true,
  source: { type: "live" },
  geometry: { width: 1920, height: 1080 },
  overlays: { props: true, lower_third: true, logo: true },
  ...overrides,
});

const makeInput = (overrides: Partial<ProgramFrameInput> = {}): ProgramFrameInput => ({
  config: makeConfig(),
  snapshot: {
    live: verseItem,
    staged: null,
    settings: baseSettings,
    props: [propClock],
    lower_third: lowerThird,
    revision: 7,
  },
  timestamp: 1234,
  fps: 30,
  ...overrides,
});

/** Narrow the resolved source's content item (the union includes `blank`). */
function sourceItem(frame: ReturnType<typeof resolveProgramFrame>): DisplayItem | null {
  return frame.source.kind === "blank" ? null : frame.source.item;
}

describe("ProgramFrameResolver", () => {
  describe("getEffectiveBg", () => {
    it("falls back to the settings background when no content override applies", () => {
      expect(getEffectiveBg(baseSettings, null)).toEqual({ type: "None" });
    });
    it("uses the bible background for a verse", () => {
      const s = { ...baseSettings, bible_background: { type: "Color" as const, value: "#123456" } };
      expect(getEffectiveBg(s, verseItem)).toEqual({ type: "Color", value: "#123456" });
    });
    it("prefers the song's own background over the song setting", () => {
      const s = {
        ...baseSettings,
        song_background: { type: "Color" as const, value: "#111111" },
      };
      const song = { ...songItem, data: { ...songItem.data, background: { type: "Color" as const, value: "#222222" } } };
      expect(getEffectiveBg(s, song)).toEqual({ type: "Color", value: "#222222" });
    });
  });

  describe("resolveThemeColors", () => {
    it("prefers the output presentation theme override", () => {
      const colors = resolveThemeColors(makeConfig({ presentation: { theme: "light" } }), baseSettings);
      expect(colors).toBe(THEMES.light.colors);
    });
    it("falls back to the settings theme", () => {
      const colors = resolveThemeColors(makeConfig(), { ...baseSettings, theme: "navy" });
      expect(colors).toBe(THEMES.navy.colors);
    });
    it("falls back to dark", () => {
      const colors = resolveThemeColors(makeConfig(), baseSettings);
      expect(colors).toBe(THEMES.dark.colors);
    });
  });

  describe("deriveLogoState", () => {
    it("derives a text logo", () => {
      expect(deriveLogoState({ ...baseSettings, logo_text: "Wordlyte" })).toMatchObject({ text: "Wordlyte", opacity: 0.6 });
    });
    it("derives an image logo", () => {
      expect(deriveLogoState({ ...baseSettings, logo_path: "logo.png" })).toMatchObject({ path: "logo.png", opacity: 0.5 });
    });
    it("returns null when no logo configured", () => {
      expect(deriveLogoState(baseSettings)).toBeNull();
    });
  });

  describe("source resolution", () => {
    it("resolves the live source to the snapshot's live item", () => {
      const frame = resolveProgramFrame(makeInput());
      expect(frame.source).toEqual({ kind: "live", item: verseItem });
      expect(frame.layers).toContainEqual({ kind: "item", item: verseItem });
    });

    it("resolves a staged source to the staged item", () => {
      const frame = resolveProgramFrame(
        makeInput({ config: makeConfig({ source: { type: "staged" } }), snapshot: { ...makeInput().snapshot, live: null, staged: mediaImage } })
      );
      expect(frame.source.kind).toBe("staged");
      expect(sourceItem(frame)).toBe(mediaImage);
    });

    it("resolves an item source to the fixed content", () => {
      const frame = resolveProgramFrame(
        makeInput({ config: makeConfig({ source: { type: "item", item: timerItem } }) })
      );
      expect(frame.source.kind).toBe("item");
      expect(sourceItem(frame)).toBe(timerItem);
    });

    it("resolves every content item type through the live source", () => {
      for (const item of [verseItem, mediaImage, cameraItem, timerItem, songItem, customSlideItem]) {
        const frame = resolveProgramFrame(makeInput({ snapshot: { ...makeInput().snapshot, live: item } }));
        expect(sourceItem(frame)?.type).toBe(item.type);
      }
    });

    it("shows a waiting layer when live is empty", () => {
      const frame = resolveProgramFrame(makeInput({ snapshot: { ...makeInput().snapshot, live: null } }));
      expect(frame.layers).toContainEqual({ kind: "waiting" });
    });

    it("resolves a scene source with a layout into a SceneComposition item", () => {
      const zone = { id: "z1", item: verseItem, x: 0, y: 0, w: 0.5, h: 1, fit: "cover" as const, opacity: 1, z: 1 };
      const scenes: Scene[] = [
        { id: "sc1", name: "Cam+Bible", settings: baseSettings, props: [], camera: cameraItem, layout: { zones: [zone] }, created_at: 0 },
      ];
      const frame = resolveProgramFrame(makeInput({ scenes, config: makeConfig({ source: { type: "scene", scene_id: "sc1" } }) }));
      expect(frame.source.kind).toBe("scene");
      expect(sourceItem(frame)?.type).toBe("SceneComposition");
      expect(frame.layers).toContainEqual({ kind: "zone", zone });
      expect(frame.missing).not.toContain("scene:sc1");
    });

    it("resolves a scene source without a layout into its camera item", () => {
      const scenes: Scene[] = [{ id: "sc2", name: "Cam", settings: baseSettings, props: [], camera: cameraItem, created_at: 0 }];
      const frame = resolveProgramFrame(makeInput({ scenes, config: makeConfig({ source: { type: "scene", scene_id: "sc2" } }) }));
      expect(frame.source.kind).toBe("scene");
      expect(sourceItem(frame)).toBe(cameraItem);
    });

    it("resolves a missing scene to a safe waiting frame and reports it", () => {
      const frame = resolveProgramFrame(makeInput({ config: makeConfig({ source: { type: "scene", scene_id: "ghost" } }) }));
      expect(frame.source.kind).toBe("scene");
      expect(sourceItem(frame)).toBeNull();
      expect(frame.layers).toContainEqual({ kind: "waiting" });
      expect(frame.missing).toContain("scene:ghost");
    });

    it("resolves a blank source to a pure black frame with no overlays", () => {
      const frame = resolveProgramFrame(makeInput({ config: makeConfig({ source: { type: "blank" } }) }));
      expect(frame.source.kind).toBe("blank");
      expect(frame.blackout).toBe(true);
      expect(frame.overlays.props).toEqual([]);
      expect(frame.overlays.lower_third).toBeNull();
      expect(frame.overlays.logo).toBeNull();
      expect(frame.layers).toEqual([{ kind: "blank" }]);
    });
  });

  describe("blackout and presentation overrides", () => {
    it("blanked via settings", () => {
      const frame = resolveProgramFrame(
        makeInput({ snapshot: { ...makeInput().snapshot, settings: { ...baseSettings, is_blanked: true } } })
      );
      expect(frame.blackout).toBe(true);
      expect(frame.layers).toEqual([{ kind: "blank" }]);
    });

    it("blanked via output presentation override", () => {
      const frame = resolveProgramFrame(makeInput({ config: makeConfig({ presentation: { blanked: true } }) }));
      expect(frame.blackout).toBe(true);
    });

    it("output presentation blanked=false overrides blanked settings", () => {
      const frame = resolveProgramFrame(
        makeInput({
          config: makeConfig({ presentation: { blanked: false } }),
          snapshot: { ...makeInput().snapshot, settings: { ...baseSettings, is_blanked: true } },
        })
      );
      expect(frame.blackout).toBe(false);
    });

    it("applies the background override", () => {
      const bg = { type: "Color" as const, value: "#ff0000" };
      const frame = resolveProgramFrame(makeInput({ config: makeConfig({ presentation: { background: bg } }) }));
      expect(frame.background.setting).toEqual(bg);
    });

    it("uses the content-type effective background when no override", () => {
      const s = { ...baseSettings, bible_background: { type: "Color" as const, value: "#123456" } };
      const frame = resolveProgramFrame(makeInput({ snapshot: { ...makeInput().snapshot, settings: s } }));
      expect(frame.background.setting).toEqual({ type: "Color", value: "#123456" });
    });

    it("applies the reference_output_height override", () => {
      const frame = resolveProgramFrame(makeInput({ config: makeConfig({ presentation: { reference_output_height: 1440 } }) }));
      expect(frame.reference_output_height).toBe(1440);
    });

    it("falls back to the settings reference height", () => {
      const frame = resolveProgramFrame(
        makeInput({ snapshot: { ...makeInput().snapshot, settings: { ...baseSettings, reference_output_height: 720 } } })
      );
      expect(frame.reference_output_height).toBe(720);
    });
  });

  describe("overlay masks", () => {
    it("passes props through when the mask enables them", () => {
      const frame = resolveProgramFrame(makeInput());
      expect(frame.overlays.props).toEqual([propClock]);
    });

    it("drops props when the mask disables them", () => {
      const frame = resolveProgramFrame(makeInput({ config: makeConfig({ overlays: { ...makeConfig().overlays, props: false } }) }));
      expect(frame.overlays.props).toEqual([]);
    });

    it("drops the lower third when the mask disables it", () => {
      const frame = resolveProgramFrame(makeInput({ config: makeConfig({ overlays: { ...makeConfig().overlays, lower_third: false } }) }));
      expect(frame.overlays.lower_third).toBeNull();
    });

    it("drops the logo when the mask disables it", () => {
      const frame = resolveProgramFrame(
        makeInput({
          snapshot: { ...makeInput().snapshot, settings: { ...baseSettings, logo_text: "Wordlyte" } },
          config: makeConfig({ overlays: { ...makeConfig().overlays, logo: false } }),
        })
      );
      expect(frame.overlays.logo).toBeNull();
    });

    it("carries the lower third payload when unmasked", () => {
      const frame = resolveProgramFrame(makeInput());
      expect(frame.overlays.lower_third).toEqual(lowerThird);
    });

    it("orders layers as background -> content -> logo -> props -> lower third", () => {
      const frame = resolveProgramFrame(
        makeInput({
          snapshot: {
            ...makeInput().snapshot,
            settings: { ...baseSettings, logo_text: "Wordlyte" },
          },
        })
      );
      expect(frame.layers.map((l) => l.kind)).toEqual([
        "background",
        "item",
        "logo",
        "props",
        "lower_third",
      ]);
    });
  });

  describe("missing resources", () => {
    it("reports a media item with an empty path", () => {
      const bad = { type: "Media", data: { id: "m2", name: "Broken", path: "", media_type: "Image", tags: [] } } as DisplayItem;
      const frame = resolveProgramFrame(makeInput({ snapshot: { ...makeInput().snapshot, live: bad } }));
      expect(frame.missing).toContain("media");
    });

    it("reports an empty prop image path", () => {
      const prop: PropItem = { id: "pr2", kind: "image", x: 0, y: 0, w: 10, h: 10, opacity: 1, visible: true, path: "" };
      const frame = resolveProgramFrame(makeInput({ snapshot: { ...makeInput().snapshot, props: [prop] } }));
      expect(frame.missing).toContain("prop:pr2");
    });

    it("reports a logo without text or path", () => {
      const frame = resolveProgramFrame(makeInput());
      expect(frame.missing).not.toContain("logo");
    });
  });

  describe("audio descriptor", () => {
    it("describes media video as the program audio", () => {
      const video = { type: "Media", data: { id: "m3", name: "Clip", path: "videos/clip.mp4", media_type: "Video", tags: [] } } as DisplayItem;
      const frame = resolveProgramFrame(makeInput({ snapshot: { ...makeInput().snapshot, live: video } }));
      expect(frame.audio).toEqual({ kind: "media", muted: false });
    });

    it("describes no audio for a verse", () => {
      const frame = resolveProgramFrame(makeInput());
      expect(frame.audio).toEqual({ kind: "none" });
    });
  });

  describe("configured output parity (WP1)", () => {
    it("resolves projection and record configs against the SAME snapshot to different frames", () => {
      const snapshot = {
        live: verseItem,
        staged: mediaImage,
        settings: baseSettings,
        props: [propClock],
        lower_third: lowerThird,
        revision: 3,
      };
      const projection = makeConfig({
        id: "output",
        source: { type: "live" },
        overlays: { props: true, lower_third: true, logo: true },
      });
      const record = makeConfig({
        id: "record-main",
        kind: "recorder",
        source: { type: "staged" },
        geometry: { width: 1280, height: 720 },
        capture_fps: 24,
        overlays: { props: false, lower_third: false, logo: false },
      });
      const projFrame = resolveProgramFrame({ config: projection, snapshot, fps: 30 });
      const recFrame = resolveProgramFrame({ config: record, snapshot, fps: 24 });

      expect(recFrame.source).toEqual({ kind: "staged", item: mediaImage });
      expect(projFrame.source).toEqual({ kind: "live", item: verseItem });
      // The recorder config's masks hide every overlay the projection shows.
      expect(recFrame.overlays.props).toEqual([]);
      expect(recFrame.overlays.lower_third).toBeNull();
      expect(recFrame.overlays.logo).toBeNull();
      expect(projFrame.overlays.props).toEqual([propClock]);
      expect(projFrame.overlays.lower_third).toEqual(lowerThird);
      // Geometry + capture cadence come from the config, not a fixed 1080p/30.
      expect(recFrame.canvas).toEqual({ width: 1280, height: 720, fps: 24 });
      expect(projFrame.canvas).toEqual({ width: 1920, height: 1080, fps: 30 });
    });

    it("resolves every configured source type for a canvas record config", () => {
      const snapshot = {
        live: verseItem,
        staged: mediaImage,
        settings: baseSettings,
        props: [],
        lower_third: null,
        revision: 1,
      };
      const sceneZone = { id: "z1", item: verseItem, x: 0, y: 0, w: 0.5, h: 1, fit: "cover" as const, opacity: 1, z: 1 };
      const scenes: Scene[] = [
        { id: "sc1", name: "Cam+Bible", settings: baseSettings, props: [], camera: cameraItem, layout: { zones: [sceneZone] }, created_at: 0 },
      ];
      const sourceFrames: Array<[OutputConfig["source"], string]> = [
        [{ type: "live" }, "live"],
        [{ type: "staged" }, "staged"],
        [{ type: "item", item: timerItem }, "item"],
        [{ type: "scene", scene_id: "sc1" }, "scene"],
        [{ type: "blank" }, "blank"],
      ];
      for (const [source, kind] of sourceFrames) {
        const frame = resolveProgramFrame({
          config: makeConfig({ id: "record-main", kind: "recorder", source, overlays: { props: true, lower_third: true, logo: true } }),
          snapshot,
          scenes,
        });
        expect(frame.source.kind).toBe(kind);
      }
    });

    it("applies a blanked presentation override on the canvas path", () => {
      const frame = resolveProgramFrame({
        config: makeConfig({ id: "stream-main", kind: "streamer", presentation: { blanked: true } }),
        snapshot: { live: verseItem, staged: null, settings: baseSettings, props: [], lower_third: null, revision: 0 },
      });
      expect(frame.blackout).toBe(true);
      expect(frame.layers).toEqual([{ kind: "blank" }]);
    });
  });

  describe("collectFrameMediaPaths", () => {
    it("collects the effective background, item media, slide elements, props, logo, and zone paths", () => {
      const zoneMedia = {
        type: "Media",
        data: { id: "m4", name: "Zone", path: "zones/zone.jpg", media_type: "Image", tags: [] },
      } as DisplayItem;
      const sceneZone = { id: "z1", item: zoneMedia, x: 0, y: 0, w: 0.5, h: 1, fit: "cover" as const, opacity: 1, z: 1 };
      const scenes: Scene[] = [
        { id: "sc1", name: "Scene", settings: baseSettings, props: [], camera: null, layout: { zones: [sceneZone] }, created_at: 0 },
      ];
      const frame = resolveProgramFrame(
        makeInput({
          scenes,
          config: makeConfig({ source: { type: "scene", scene_id: "sc1" } }),
          snapshot: {
            ...makeInput().snapshot,
            live: null,
            props: [propClock, { id: "pr3", kind: "image", x: 0, y: 0, w: 10, h: 10, opacity: 1, visible: true, path: "props/logo.png" }],
            settings: { ...baseSettings, background: { type: "Image", value: { path: "bg/back.png", objectFit: "cover", opacity: 1 } }, logo_path: "logo/wordlyte.png" },
          },
        })
      );
      const paths = collectFrameMediaPaths(frame);
      expect(paths.images).toEqual(
        expect.arrayContaining(["bg/back.png", "zones/zone.jpg", "props/logo.png", "logo/wordlyte.png"])
      );
    });
  });
});
