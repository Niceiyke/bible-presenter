import { describe, expect, it } from "vitest";
import { resolveLowerThird, substituteTokens } from "../LowerThirdResolver";
import type { LowerThirdPayload } from "../../types";
import { DEFAULT_LT_TEMPLATE } from "../../types";

function makePayload(overrides: Partial<LowerThirdPayload> = {}): LowerThirdPayload {
  return {
    data: { kind: "Nameplate", data: { name: "Jane Doe", title: "Lead Pastor" } },
    template: DEFAULT_LT_TEMPLATE,
    ...overrides,
  };
}

describe("resolveLowerThird", () => {
  it("maps a Nameplate to headline/subline slots", () => {
    const layout = resolveLowerThird(makePayload());
    expect(layout.kind).toBe("Nameplate");
    expect(layout.content.headline).toBe("Jane Doe");
    expect(layout.content.subline).toBe("Lead Pastor");
    expect(layout.content.tickerMode).toBe(false);
    expect(layout.content.bodyText).toBe("");
    expect(layout.slots.showHeadline).toBe(true);
    expect(layout.slots.showSubline).toBe(true);
    expect(layout.slots.showKicker).toBe(false);
  });

  it("merges the template against defaults", () => {
    const layout = resolveLowerThird(makePayload({ template: { ...DEFAULT_LT_TEMPLATE, widthPct: 100, accentColor: "#ff0000" } }));
    expect(layout.geometry.isFullWidth).toBe(true);
    expect(layout.geometry.widthPct).toBe(100);
    expect(layout.accent.color).toBe("#ff0000");
    expect(layout.geometry.paddingX).toBe(DEFAULT_LT_TEMPLATE.paddingX);
    expect(layout.geometry.borderRadius).toBe(DEFAULT_LT_TEMPLATE.borderRadius);
  });

  it("maps lyrics section labels to the kicker slot when visible", () => {
    const layout = resolveLowerThird({
      data: { kind: "Lyrics", data: { line1: "Amazing Grace", line2: "How sweet the sound", section_label: "Verse 1" } },
      template: DEFAULT_LT_TEMPLATE,
    });
    expect(layout.content.headline).toBe("Amazing Grace");
    expect(layout.content.subline).toBe("How sweet the sound");
    expect(layout.content.kicker).toBe("Verse 1");
    expect(layout.slots.showKicker).toBe(true);
    expect(layout.content.badgeText).toBe("Verse 1");
  });

  it("hides the lyrics section label when labelVisible is off", () => {
    const layout = resolveLowerThird({
      data: { kind: "Lyrics", data: { line1: "Amazing Grace", section_label: "Verse 1" } },
      template: { ...DEFAULT_LT_TEMPLATE, labelVisible: false },
    });
    expect(layout.content.kicker).toBe("");
    expect(layout.slots.showKicker).toBe(false);
    expect(layout.content.badgeText).toBe("LIVE");
  });

  it("treats a scrolling FreeText as ticker mode with substituted body text", () => {
    const layout = resolveLowerThird({
      data: { kind: "FreeText", data: { text: "Verse of the day {time}" } },
      template: { ...DEFAULT_LT_TEMPLATE, scrollEnabled: true },
    });
    expect(layout.content.tickerMode).toBe(true);
    expect(layout.content.bodyText).not.toContain("{time}");
    expect(layout.slots.showHeadline).toBe(false);
    expect(layout.content.headline).toBe("");
  });

  it("keeps FreeText as a static headline unless scrolling", () => {
    const layout = resolveLowerThird({
      data: { kind: "FreeText", data: { text: "Welcome to our service" } },
      template: DEFAULT_LT_TEMPLATE,
    });
    expect(layout.content.tickerMode).toBe(false);
    expect(layout.content.headline).toBe("Welcome to our service");
    expect(layout.slots.showHeadline).toBe(true);
  });

  it("maps the content onto the configured style slots", () => {
    const layout = resolveLowerThird(makePayload({ template: { ...DEFAULT_LT_TEMPLATE, nameStyle: "secondary", titleStyle: "label" } }));
    expect(layout.slots.headline.size).toBe(DEFAULT_LT_TEMPLATE.secondarySize);
    expect(layout.slots.headline.font).toBe(DEFAULT_LT_TEMPLATE.secondaryFont);
    expect(layout.slots.subline.size).toBe(DEFAULT_LT_TEMPLATE.labelSize);
    expect(layout.slots.subline.bold).toBe(true);
  });

  it("hides slots whose style mapping is none", () => {
    const layout = resolveLowerThird(makePayload({ template: { ...DEFAULT_LT_TEMPLATE, nameStyle: "none" } }));
    expect(layout.slots.showHeadline).toBe(false);
  });

  it("resolves the background type (image without a path degrades to transparent)", () => {
    expect(resolveLowerThird(makePayload()).background.type).toBe("solid");
    expect(resolveLowerThird(makePayload({ template: { ...DEFAULT_LT_TEMPLATE, bgType: "gradient" } })).background.type).toBe("gradient");
    const img = resolveLowerThird(makePayload({ template: { ...DEFAULT_LT_TEMPLATE, bgType: "image", bgImagePath: "lt/bg.png" } }));
    expect(img.background.type).toBe("image");
    expect(img.background.imagePath).toBe("lt/bg.png");
    const none = resolveLowerThird(makePayload({ template: { ...DEFAULT_LT_TEMPLATE, bgType: "image" } }));
    expect(none.background.type).toBe("transparent");
  });

  it("normalizes accent, border, shadow, and outline tokens", () => {
    const layout = resolveLowerThird(makePayload({
      template: { ...DEFAULT_LT_TEMPLATE, accentSide: "right", borderEnabled: true, textOutline: true, boxShadow: true },
    }));
    expect(layout.accent.side).toBe("right");
    expect(layout.accent.width).toBe(DEFAULT_LT_TEMPLATE.accentWidth);
    expect(layout.border.enabled).toBe(true);
    expect(layout.outline.enabled).toBe(true);
    expect(layout.boxShadow.enabled).toBe(true);
    expect(layout.boxShadow.blur).toBe(DEFAULT_LT_TEMPLATE.boxShadowBlur);
  });
});

describe("substituteTokens", () => {
  it("replaces time and date tokens", () => {
    expect(substituteTokens("{time} {date}")).toMatch(/^\d{1,2}:\d{2}\s*(AM|PM)?\s*\S+$/i);
    expect(substituteTokens("plain text")).toBe("plain text");
  });
});