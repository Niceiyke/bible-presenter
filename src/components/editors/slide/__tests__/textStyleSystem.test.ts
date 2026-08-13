import { describe, expect, it } from "vitest";
import {
  clampFontSize,
  FONT_SIZE_STEP,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  findParagraphStyle,
  parsePt,
  paragraphStyleCss,
  resolveElementTextStyle,
  resolveFontSize,
  stepFontSize,
  elementFontSize,
} from "../textStyleSystem";
import { synthesizeDefaultTheme } from "../helpers";

const theme = synthesizeDefaultTheme();

describe("textStyleSystem — step/clamp policy", () => {
  it("clamps into [8, 600] and rounds", () => {
    expect(clampFontSize(40)).toBe(40);
    expect(clampFontSize(3)).toBe(8);
    expect(clampFontSize(900)).toBe(600);
    expect(clampFontSize(40.6)).toBe(41);
    expect(clampFontSize(Number.NaN)).toBe(8);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(600);
  });

  it("steps by the shared delta and clamps at the floor/ceiling", () => {
    expect(stepFontSize(40, FONT_SIZE_STEP)).toBe(42);
    expect(stepFontSize(40, -FONT_SIZE_STEP)).toBe(38);
    // Floor: 8 + (−2) must stay at 8, never collapse to unreadable.
    expect(stepFontSize(8, -2)).toBe(8);
    // Ceiling: 599 + 2 saturates.
    expect(stepFontSize(599, 2)).toBe(600);
  });

  it("is a single consistent step across controls", () => {
    expect(FONT_SIZE_STEP).toBe(2);
    expect(FONT_SIZE_MIN).toBe(8);
    expect(FONT_SIZE_MAX).toBe(600);
  });
});

describe("textStyleSystem — parsePt", () => {
  it("parses pt strings and bare numbers", () => {
    expect(parsePt("48pt")).toBe(48);
    expect(parsePt("32.5pt")).toBe(32.5);
    expect(parsePt("48PT")).toBe(48);
    expect(parsePt(40)).toBe(40);
  });

  it("rejects non-sizes", () => {
    expect(parsePt("foo")).toBeNull();
    expect(parsePt("16px")).toBeNull();
    expect(parsePt(undefined)).toBeNull();
    expect(parsePt(null)).toBeNull();
    expect(parsePt("  ")).toBeNull();
  });
});

describe("textStyleSystem — paragraph-style recipes (P4.3)", () => {
  it("builds the render CSS the node stores", () => {
    const css = paragraphStyleCss("Header", theme.paragraphStyles!.Header, theme);
    expect(css).toContain("font-family: Arial");
    expect(css).toContain("font-size: 48pt");
    expect(css).toContain("font-weight: bold");
  });

  it("matches a stored blob back to its recipe", () => {
    const css = paragraphStyleCss("Header", theme.paragraphStyles!.Header, theme);
    expect(findParagraphStyle(css, theme)?.name).toBe("Header");
  });

  it("returns null for unknown blobs", () => {
    expect(findParagraphStyle("font-size: 999pt", theme)).toBeNull();
    expect(findParagraphStyle(null, theme)).toBeNull();
  });
});

describe("textStyleSystem — selection cascade (readout + bump base)", () => {
  it("selection mark wins over the recipe", () => {
    const css = paragraphStyleCss("Header", theme.paragraphStyles!.Header, theme);
    expect(resolveFontSize({ markSize: "60pt", paragraphCss: css, elementSize: 32, theme })).toBe(60);
  });

  it("a recipe paints at its declared size, not the element default", () => {
    // The pre-fix behavior: a Header (48pt) paragraph reported the
    // element's 32pt default on both the readout and the bump base.
    const css = paragraphStyleCss("Header", theme.paragraphStyles!.Header, theme);
    expect(resolveFontSize({ markSize: null, paragraphCss: css, elementSize: 32, theme })).toBe(48);
  });

  it("falls back to the element default, then the theme default", () => {
    expect(resolveFontSize({ markSize: null, paragraphCss: null, elementSize: 24, theme })).toBe(24);
    expect(resolveFontSize({ markSize: null, paragraphCss: null, elementSize: undefined, theme })).toBe(theme.defaultFontSize);
    // No theme → historical fallback.
    expect(resolveFontSize({ markSize: null, paragraphCss: null, elementSize: undefined, theme: undefined })).toBe(32);
  });
});

describe("textStyleSystem — element-level inherit cascade", () => {
  const el = { font_family: "inherit", font_size: "inherit", color: "inherit" } as unknown as Parameters<typeof resolveElementTextStyle>[0];

  it("resolves inherit/undefined against the theme", () => {
    const { fontFamily, fontSize, color } = resolveElementTextStyle(el, theme);
    expect(fontFamily).toBe(theme.defaultFontFamily);
    expect(fontSize).toBe(theme.defaultFontSize);
    expect(color).toBe(theme.textColor);
  });

  it("concrete element values win over the theme", () => {
    const { fontFamily, fontSize, color } = resolveElementTextStyle({ font_family: "Georgia", font_size: 40, color: "#123456" }, theme);
    expect(fontFamily).toBe("Georgia");
    expect(fontSize).toBe(40);
    expect(color).toBe("#123456");
  });

  it("elementFontSize resolves inherit and falls back to 32 without a theme", () => {
    expect(elementFontSize({ font_size: 40 }, theme)).toBe(40);
    expect(elementFontSize({ font_size: "inherit" }, theme)).toBe(theme.defaultFontSize);
    expect(elementFontSize({}, undefined)).toBe(32);
  });
});