import { describe, expect, it } from "vitest";
import { getEffectiveBg, collectCameraDeviceIds } from "../canvasProgramFeed";
import type { PresentationSettings } from "../../../types";

const baseSettings: PresentationSettings = {
  theme: "dark",
  reference_position: "bottom",
  background: { type: "Color", value: "#000000" },
  is_blanked: false,
  font_size: 72,
  disabled_bible_versions: [],
  auto_split_verses: true,
  verse_split_threshold: 200,
};

describe("getEffectiveBg", () => {
  it("falls back to settings background when no item override", () => {
    expect(getEffectiveBg(baseSettings, null)).toEqual({ type: "Color", value: "#000000" });
  });
  it("uses the bible background for verses", () => {
    const s = { ...baseSettings, bible_background: { type: "Color" as const, value: "#123456" } };
    const verse = { type: "Verse", data: { book: "JHN", chapter: 3, verse: 16, text: "hi", version: "KJV" } } as any;
    expect(getEffectiveBg(s, verse)).toEqual({ type: "Color", value: "#123456" });
  });
});

describe("collectCameraDeviceIds", () => {
  it("collects a camera used as the effective background", () => {
    const s = {
      ...baseSettings,
      bible_background: { type: "Camera", value: { deviceId: "phone-camera-abcd", opacity: 1, objectFit: "cover", mirrored: false } },
    } as any;
    const verse = { type: "Verse", data: { book: "JHN", chapter: 3, verse: 16, text: "hi", version: "KJV" } } as any;
    expect(collectCameraDeviceIds(verse, s)).toEqual(["phone-camera-abcd"]);
  });
  it("collects a live Camera item's device id", () => {
    const cam = { type: "Camera", data: { deviceId: "cam-local-1", opacity: 1, objectFit: "cover", mirrored: false } } as any;
    expect(collectCameraDeviceIds(cam, baseSettings)).toEqual(["cam-local-1"]);
  });
  it("collects cameras pinned inside scene-composition zones", () => {
    const scene = {
      type: "SceneComposition",
      data: {
        scene_id: "s1",
        name: "Cam+Bible",
        zones: [
          { id: "z1", item: { type: "Camera", data: { deviceId: "phone-camera-1234" } }, x: 0, y: 0, w: 0.5, h: 1, fit: "cover", opacity: 1, z: 1 },
          { id: "z2", item: { type: "Timer", data: {} }, x: 0.5, y: 0, w: 0.5, h: 1, fit: "cover", opacity: 1, z: 2 },
        ],
      },
    } as any;
    expect(collectCameraDeviceIds(scene, baseSettings)).toEqual(["phone-camera-1234"]);
  });
  it("returns an empty list when nothing references a camera", () => {
    expect(collectCameraDeviceIds(null, baseSettings)).toEqual([]);
  });
});
