import { describe, expect, it } from "vitest";
import { drawProgramFrame, getEffectiveBg } from "../../../components/outputs/canvasProgramFeed";
import {
  allItems,
  allProps,
  baseSettings,
  baseTheme,
  verseItem,
  sceneCompositionItem,
  lowerThirdFixture,
} from "../index";
import {
  PRESENTATION_SCHEMA_VERSION,
  OUTPUT_SCHEMA_VERSION,
} from "../../../types";

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
    fillRect: (...args: number[]) => calls.push(`fillRect:${args.join(",")}`),
    clearRect: (...args: number[]) => calls.push(`clearRect:${args.join(",")}`),
    fillText: (t: string, x: number, y: number) => calls.push(`fillText:${t}@${x},${y}`),
    beginPath: () => calls.push("beginPath"),
    closePath: () => calls.push("closePath"),
    moveTo: (...args: number[]) => calls.push(`moveTo:${args.join(",")}`),
    lineTo: (...args: number[]) => calls.push(`lineTo:${args.join(",")}`),
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
    createLinearGradient: () => ({ addColorStop: () => calls.push("addColorStop") }),
    measureText: (t: string) => ({ width: t.length * 10 }),
    drawImage: () => calls.push("drawImage"),
    canvas: { width: 1920, height: 1080 },
  };
  let fontValue = "";
  Object.defineProperty(ctx, "font", {
    get: () => fontValue,
    set: (v: string) => { fontValue = v; calls.push(`font:${v}`); },
    configurable: true,
  });
  return { ctx, calls };
}

/** Build a resolved `ProgramFrame` around a fixture item. `extra` overrides
 *  fields (e.g. pre-masked overlay payloads) as the resolver would emit. */
function frameFor(item: unknown, extra: Record<string, unknown> = {}) {
  return {
    revision: 0,
    timestamp: 0,
    canvas: { width: 1920, height: 1080, fps: 30 },
    source: { kind: "live", item },
    layers: [],
    background: { setting: getEffectiveBg(baseSettings, item as any), fallback: baseTheme.colors.background },
    overlays: { props: allProps, lower_third: lowerThirdFixture, logo: null },
    blackout: false,
    missing: [],
    audio: { kind: "none" },
    settings: baseSettings,
    colors: baseTheme.colors,
    reference_output_height: 1080,
    now: 0,
    ...extra,
  } as any;
}

describe("presentation fixtures (Phase 0)", () => {
  it("exports every representative item type", () => {
    const types = allItems.map((i) => i.type);
    expect(types).toContain("Verse");
    expect(types).toContain("Song");
    expect(types).toContain("CustomSlide");
    expect(types).toContain("Media");
    expect(types).toContain("Camera");
    expect(types).toContain("Timer");
    expect(types).toContain("SceneComposition");
  });

  it("renders every representative item through the compositor without throwing", () => {
    for (const item of allItems) {
      const { ctx } = makeCtx();
      expect(() => drawProgramFrame(ctx, frameFor(item))).not.toThrow();
    }
  });

  it("paints expected content per item kind", () => {
    const verse = makeCtx();
    drawProgramFrame(verse.ctx, frameFor(verseItem));
    expect(verse.calls.some((c) => c.startsWith("fillText:For God so loved"))).toBe(true);
    expect(verse.calls.some((c) => c.startsWith("fillText:JOHN 3:16"))).toBe(true);

    const scene = makeCtx();
    drawProgramFrame(scene.ctx, frameFor(sceneCompositionItem));
    // one clip per zone
    expect(scene.calls.filter((c) => c === "clip").length).toBe(2);
    // verse zone content present
    expect(scene.calls.some((c) => c.startsWith("fillText:For God so loved"))).toBe(true);
  });

  it("skips overlays when the frame carries none (masked off)", () => {
    const { ctx, calls } = makeCtx();
    drawProgramFrame(ctx, frameFor(null, {
      overlays: { props: [], lower_third: null, logo: null },
    }));
    // Only the waiting message may be text; props must not paint.
    const texts = calls.filter((c) => c.startsWith("fillText:"));
    expect(texts.length).toBe(1);
    expect(texts[0]).toMatch(/Waiting/);
  });

  it("keeps the lower-third fixture shape", () => {
    expect(lowerThirdFixture.data).toHaveProperty("kind");
    expect(lowerThirdFixture.template).toHaveProperty("name");
  });
});

describe("schema version contract (Phase 0)", () => {
  it("freezes the presentation snapshot schema version", () => {
    expect(PRESENTATION_SCHEMA_VERSION).toBe(2);
  });

  it("freezes the output config schema version", () => {
    expect(OUTPUT_SCHEMA_VERSION).toBe(1);
  });
});
