import { describe, expect, it, vi } from "vitest";
import {
  hexToRgba,
  wrapText,
  drawImageCover,
  drawProgramFrame,
  flattenTextContent,
  ptToPx,
  getEffectiveBg,
  collectCameraDeviceIds,
} from "../canvasProgramFeed";
import type { DisplayItem, PresentationSettings } from "../../../types";
import { THEMES } from "../../../types";

/** Minimal CanvasRenderingContext2D stub — records calls so we can assert
 *  what the compositor painted without a real canvas (jsdom has none). */
function makeCtx() {
  const calls: string[] = [];
  const ctx: any = {
    calls,
    fillStyle: "#000000",
    strokeStyle: "#000000",
    globalAlpha: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    shadowColor: "transparent",
    shadowBlur: 0,
    shadowOffsetY: 0,
    fillRect: (...args: number[]) => calls.push(`fillRect:${args.join(",")}`),
    clearRect: (...args: number[]) => calls.push(`clearRect:${args.join(",")}`),
    fillText: (t: string, x: number, y: number) => calls.push(`fillText:${t}@${x},${y}`),
    strokeRect: (...args: number[]) => calls.push(`strokeRect:${args.join(",")}`),
    beginPath: () => calls.push("beginPath"),
    closePath: () => calls.push("closePath"),
    rect: (...args: number[]) => calls.push(`rect:${args.join(",")}`),
    arc: (...args: number[]) => calls.push(`arc:${args.join(",")}`),
    fill: () => calls.push("fill"),
    stroke: () => calls.push("stroke"),
    clip: () => calls.push("clip"),
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    translate: (...args: number[]) => calls.push(`translate:${args.join(",")}`),
    scale: (...args: number[]) => calls.push(`scale:${args.join(",")}`),
    rotate: (...args: number[]) => calls.push(`rotate:${args.join(",")}`),
    createLinearGradient: () => ({
      addColorStop: () => calls.push("addColorStop"),
    }),
    measureText: (t: string) => ({ width: t.length * 10 }),
    drawImage: (src: any, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) =>
      calls.push(`drawImage:${sx},${sy},${sw},${sh}->${dx},${dy},${dw},${dh}`),
    canvas: { width: 1920, height: 1080 },
  };
  return { ctx, calls };
}

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

const darkColors = THEMES.dark.colors;

function frameFor(item: DisplayItem | null, overrides: Partial<PresentationSettings> = {}, props = {}) {
  return {
    item,
    settings: { ...baseSettings, ...overrides },
    colors: darkColors,
    res: {},
    ...props,
  } as any;
}

describe("canvasProgramFeed", () => {
  describe("hexToRgba", () => {
    it("converts hex to rgba with opacity", () => {
      expect(hexToRgba("#ff0000", 0.5)).toBe("rgba(255,0,0,0.500)");
      expect(hexToRgba("#fff", 1)).toBe("rgba(255,255,255,1.000)");
    });
    it("handles short hex", () => {
      expect(hexToRgba("#0f0", 0.25)).toBe("rgba(0,255,0,0.250)");
    });
  });

  describe("wrapText", () => {
    it("wraps long text to multiple lines", () => {
      const ctx = { measureText: (t: string) => ({ width: t.length * 10 }) } as any;
      const lines = wrapText(ctx, "one two three four", 40);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.join(" ").replace(/\s+/g, " ")).toBe("one two three four");
    });
    it("handles empty text", () => {
      const ctx = { measureText: (t: string) => ({ width: t.length * 10 }) } as any;
      expect(wrapText(ctx, "", 40)).toEqual([""]);
    });
  });

  describe("ptToPx", () => {
    it("scales pt by the reference ratio", () => {
      expect(ptToPx(72, 1)).toBeCloseTo(96);
      expect(ptToPx(72, 0.5)).toBeCloseTo(48);
    });
  });

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

  describe("flattenTextContent", () => {
    it("flattens a ProseMirror doc to plain text", () => {
      const doc = {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Hello" }, { type: "text", text: " world" }] },
          { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
        ],
      };
      const out = flattenTextContent(doc);
      expect(out).toContain("Hello");
      expect(out).toContain(" world");
      expect(out).toContain("Second line");
    });
    it("strips tags from legacy HTML strings", () => {
      expect(flattenTextContent("<p><b>Hi</b> there</p>")).toBe("Hi there");
    });
  });

  describe("drawImageCover", () => {
    it("draws a cover-cropped frame", () => {
      const { ctx, calls } = makeCtx();
      const img = { naturalWidth: 1920, naturalHeight: 1080 } as HTMLImageElement;
      drawImageCover(ctx, img, 0, 0, 1920, 1080);
      // 16:9 into 16:9 -> full-bleed drawImage
      expect(calls.some((c) => c.startsWith("drawImage"))).toBe(true);
    });

    it("centers the crop for a mismatched-aspect source", () => {
      const { ctx, calls } = makeCtx();
      const img = { naturalWidth: 1920, naturalHeight: 1080 } as HTMLImageElement;
      drawImageCover(ctx, img, 0, 0, 1080, 1080);
      // 16:9 into 1:1 -> crop 1080 wide centered on the source x-axis
      const call = calls.find((c) => c.startsWith("drawImage")) ?? "";
      expect(call).toBe("drawImage:420,0,1080,1080->0,0,1080,1080");
    });
  });

  describe("drawProgramFrame", () => {
    it("paints black when blanked", () => {
      const { ctx, calls } = makeCtx();
      drawProgramFrame(ctx, { width: 1920, height: 1080 }, frameFor(null, { is_blanked: true }));
      expect(calls.some((c) => c === "fillRect:0,0,1920,1080")).toBe(true);
    });

    it("fills the background color then renders a verse", () => {
      const { ctx, calls } = makeCtx();
      const verse = {
        type: "Verse",
        data: { book: "JHN", chapter: 3, verse: 16, text: "For God so loved the world", version: "KJV" },
      } as DisplayItem;
      drawProgramFrame(ctx, { width: 1920, height: 1080 }, frameFor(verse));
      // background painted
      expect(calls.some((c) => c === "fillRect:0,0,1920,1080")).toBe(true);
      // verse text painted
      expect(calls.some((c) => c.startsWith("fillText:For God so loved"))).toBe(true);
      // reference tag painted
      expect(calls.some((c) => c.startsWith("fillText:JHN 3:16"))).toBe(true);
    });

    it("shows the waiting message when no item", () => {
      const { ctx, calls } = makeCtx();
      drawProgramFrame(ctx, { width: 1920, height: 1080 }, frameFor(null));
      expect(calls.some((c) => c.startsWith("fillText:Waiting for projection"))).toBe(true);
    });

    it("draws a custom slide background and text elements", () => {
      const { ctx, calls } = makeCtx();
      const slide = {
        type: "CustomSlide",
        data: {
          presentation_id: "p1",
          presentation_name: "Test",
          slide_index: 0,
          slide_count: 1,
          background: { type: "color", value: "#1a1a2e" },
          elements: [
            {
              id: "e1",
              kind: "text",
              x: 10, y: 10, w: 80, h: 20, z_index: 1,
              content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Slide title" }] }] },
              font_size: 48, font_family: "Arial", color: "#ffffff", align: "center", v_align: "middle",
            },
          ],
        },
      } as DisplayItem;
      drawProgramFrame(ctx, { width: 1920, height: 1080 }, frameFor(slide));
      expect(calls.some((c) => c === "fillRect:0,0,1920,1080")).toBe(true);
      expect(calls.some((c) => c.startsWith("fillText:Slide title"))).toBe(true);
    });

    it("draws a scene composition's zones", () => {
      const { ctx, calls } = makeCtx();
      const scene = {
        type: "SceneComposition",
        data: {
          scene_id: "s1",
          name: "Split",
          zones: [
            {
              id: "z1",
              item: { type: "Timer", data: { timer_type: "countup", started_at: Date.now() } },
              x: 0, y: 0, w: 0.5, h: 1, fit: "cover", opacity: 1, z: 1,
            },
          ],
        },
      } as DisplayItem;
      drawProgramFrame(ctx, { width: 1920, height: 1080 }, frameFor(scene));
      expect(calls.some((c) => c === "clip")).toBe(true);
      // timer glyph painted within the zone
      expect(calls.some((c) => c.startsWith("fillText:00:00"))).toBe(true);
    });

    it("honors the overlay mask (props drawn when enabled)", () => {
      const { ctx, calls } = makeCtx();
      const prop = {
        id: "p1",
        kind: "clock",
        x: 50, y: 50, w: 10, h: 10, opacity: 1, visible: true,
        text: "HH:mm:ss",
        color: "#ffffff",
      } as any;
      drawProgramFrame(ctx, { width: 1920, height: 1080 }, frameFor(null, {}, { propItems: [prop], overlays: { props: true, lower_third: false, logo: false } }));
      expect(calls.some((c) => c.startsWith("fillText:"))).toBe(true);
    });

    it("skips props when the overlay mask disables them", () => {
      const { ctx, calls } = makeCtx();
      const prop = {
        id: "p1",
        kind: "clock",
        x: 50, y: 50, w: 10, h: 10, opacity: 1, visible: true,
        text: "HH:mm:ss",
        color: "#ffffff",
      } as any;
      const before = calls.filter((c) => c.startsWith("fillText:")).length;
      drawProgramFrame(ctx, { width: 1920, height: 1080 }, frameFor(null, {}, { propItems: [prop], overlays: { props: false, lower_third: false, logo: false } }));
      const after = calls.filter((c) => c.startsWith("fillText:")).length;
      expect(after).toBe(before + 1); // only the waiting message
    });
  });
});

describe("useCanvasCapture wiring", () => {
  it("exposes ptToPx for compositor scale math", () => {
    expect(ptToPx(36, 1)).toBeCloseTo(48);
  });
});