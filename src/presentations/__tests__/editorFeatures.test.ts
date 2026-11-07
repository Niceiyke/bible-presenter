import { describe, expect, it } from "vitest";
import type { CustomPresentation, CustomSlide } from "../../types";
import { applyBrandKit, applySmartLayout, slideLabel } from "../editorFeatures";

const slide = (): CustomSlide => ({
  id: "slide", background: { type: "color", value: "#000000" },
  elements: [
    { id: "title", kind: "text", role: "title", content: { type: "doc", content: [{ type: "text", text: "Hope" }] }, x: 0, y: 0, w: 20, h: 20, z_index: 2 },
    { id: "image", kind: "image", content: "photo.jpg", x: 0, y: 0, w: 20, h: 20, z_index: 1 },
  ],
});

describe("presentation editor features", () => {
  it("applies deterministic layouts without replacing content identities", () => {
    const next = applySmartLayout(slide(), "split-right");
    expect(next.elements.map((element) => element.id)).toEqual(["title", "image"]);
    expect(next.elements.find((element) => element.id === "image")).toMatchObject({ x: 55, w: 45, h: 100 });
    expect(next.elements.find((element) => element.id === "title")).toMatchObject({ x: 7, align: "left" });
  });

  it("applies a brand kit across editable text and color backgrounds", () => {
    const presentation: CustomPresentation = { id: "deck", name: "Deck", slides: [slide()] };
    const next = applyBrandKit(presentation, { name: "Wordlyte", fontFamily: "Georgia", textColor: "#eeeeee", accentColor: "#ff9900", backgroundColor: "#111111" });
    expect(next.theme).toMatchObject({ name: "Wordlyte", defaultFontFamily: "Georgia", accentColor: "#ff9900" });
    expect(next.slides[0].background).toEqual({ type: "color", value: "#111111" });
    expect(next.slides[0].elements[0]).toMatchObject({ font_family: "Georgia", color: "#eeeeee" });
  });

  it("derives outline labels from slide text", () => {
    expect(slideLabel(slide(), 0)).toBe("Hope");
  });
});
