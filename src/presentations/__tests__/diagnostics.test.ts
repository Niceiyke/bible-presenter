import { describe, expect, it } from "vitest";
import type { CustomPresentation } from "../../types";
import { analyzePresentation } from "../diagnostics";

function deck(): CustomPresentation {
  return {
    id: "deck",
    name: "Preflight",
    slides: [
      { id: "blank", background: { type: "color", value: "#000" }, elements: [] },
      {
        id: "issues",
        background: { type: "color", value: "#000" },
        elements: [
          { id: "image", kind: "image", content: "", x: 95, y: 10, w: 20, h: 20, z_index: 1 },
          { id: "text", kind: "text", content: { type: "doc", content: [{ type: "text", text: "Readable" }] }, x: 5, y: 5, w: 80, h: 20, z_index: 2, font_size: 16 },
        ],
      },
      { id: "rendered", background: { type: "image", value: "slides/1.png" }, elements: [] },
    ],
  };
}

describe("presentation preflight", () => {
  it("finds projection risks without flagging rendered-slide backgrounds as blank", () => {
    const issues = analyzePresentation(deck());
    expect(issues.map((issue) => issue.code)).toEqual([
      "blank-slide",
      "missing-source",
      "unsafe-geometry",
      "small-text",
    ]);
    expect(issues.some((issue) => issue.slideIndex === 2)).toBe(false);
  });

  it("flags dense text blocks", () => {
    const presentation = deck();
    presentation.slides = [{
      id: "dense",
      background: { type: "color", value: "#000" },
      elements: [{ id: "text", kind: "text", content: `<p>${"word ".repeat(100)}</p>`, x: 5, y: 5, w: 90, h: 90, z_index: 1, font_size: 28 }],
    }];
    expect(analyzePresentation(presentation)).toEqual([
      expect.objectContaining({ code: "dense-text", severity: "warning", slideIndex: 0 }),
    ]);
  });
});
