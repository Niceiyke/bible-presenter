import { describe, expect, it } from "vitest";
import { itemNav, itemNextLive, type ItemLookup } from "../registry";
import type { DisplayItem, Verse } from "../../types";

const verse = (book: string, chapter: number, v: number, version = "KJV"): Verse => ({
  book, chapter, verse: v, version,
  text: `${book} ${chapter}:${v}`,
});

const lookup = (): ItemLookup => ({
  studioSlides: {},
  songs: [],
  hymns: [],
  nextVerse: null,
  verseSplits: {},
  verseSplitThreshold: 8,
});

const makeScene = (zones: { id: string; item: DisplayItem; source?: { type: "verse" | "camera" | "timer" | "song" | "media" | "slide" | "item" } }[]): DisplayItem => ({
  type: "SceneComposition",
  data: {
    scene_id: "s1",
    name: "Cam + Bible",
    zones: zones.map((z, i) => ({
      id: z.id,
      item: z.item,
      source: z.source ?? { type: "item" },
      x: 0, y: 0, w: 0.5, h: 1, fit: "cover", opacity: 1, z: i,
    })),
  },
});

describe("scene composition stepping (Phase 5)", () => {
  it("nextLive follows the verse-pinned zone when a scene is live", () => {
    const live = makeScene([
      { id: "cam", item: { type: "Camera", data: { deviceId: "cam1", opacity: 1, objectFit: "cover", mirrored: false } }, source: { type: "camera" } },
      { id: "verse", item: { type: "Verse", data: verse("John", 3, 16) }, source: { type: "verse" } },
    ]);
    const next = itemNextLive(live, { ...lookup(), nextVerse: verse("John", 3, 17) });
    expect(next).not.toBeNull();
    expect(next!.type).toBe("Verse");
    expect((next!.data as Verse).verse).toBe(17);
  });

  it("nav delegates prev/next to the verse-pinned zone", () => {
    const live = makeScene([
      { id: "cam", item: { type: "Camera", data: { deviceId: "cam1", opacity: 1, objectFit: "cover", mirrored: false } }, source: { type: "camera" } },
      { id: "verse", item: { type: "Verse", data: { ...verse("John", 3, 16), split_index: 0, total_splits: 2 } }, source: { type: "verse" } },
    ]);
    const lookup = {
      studioSlides: {},
      songs: [],
      hymns: [],
      nextVerse: null,
      verseSplits: {
        "John-3-16-KJV-8": [verse("John", 3, 16), verse("John", 3, 16)],
      },
      verseSplitThreshold: 8,
    };
    const nav = itemNav(live, lookup);
    expect(nav.next).not.toBeNull();
    expect((nav.next!.data as Verse).verse).toBe(16);
    expect(nav.prev).toBeNull();
  });

  it("returns no step when no zone is pinned to a navigable class", () => {
    const live = makeScene([
      { id: "cam", item: { type: "Camera", data: { deviceId: "cam1", opacity: 1, objectFit: "cover", mirrored: false } }, source: { type: "camera" } },
    ]);
    expect(itemNextLive(live, lookup())).toBeNull();
    expect(itemNav(live, lookup())).toEqual({ prev: null, next: null, first: null, last: null });
  });

  it("does not drive stepping from static (unpinned) zones", () => {
    const live = makeScene([
      { id: "static", item: { type: "Verse", data: verse("John", 3, 16) } },
    ]);
    expect(itemNextLive(live, lookup())).toBeNull();
  });
});