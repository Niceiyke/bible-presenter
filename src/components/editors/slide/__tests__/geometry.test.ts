import { describe, expect, it } from "vitest";
import { clampElementGeometry, clampGroupDelta, MIN_ELEMENT_SIZE } from "../geometry";

describe("slide editor geometry bounds", () => {
  it("keeps an element inside the canvas", () => {
    expect(clampElementGeometry({ x: -20, y: 95, w: 40, h: 20 })).toEqual({
      x: 0,
      y: 80,
      w: 40,
      h: 20,
    });
    expect(clampElementGeometry({ x: 90, y: -5, w: 30, h: 15 })).toEqual({
      x: 70,
      y: 0,
      w: 30,
      h: 15,
    });
  });

  it("enforces a minimum element size", () => {
    expect(clampElementGeometry({ x: 10, y: 10, w: 1, h: 0 })).toEqual({
      x: 10,
      y: 10,
      w: MIN_ELEMENT_SIZE,
      h: MIN_ELEMENT_SIZE,
    });
  });

  it("limits a shared drag delta by the nearest group member", () => {
    const elements = [
      { x: 50, y: 20, w: 20, h: 20 },
      { x: 80, y: 60, w: 20, h: 20 },
    ];
    expect(clampGroupDelta(elements, 30, 30)).toEqual({ dx: 0, dy: 20 });
    expect(clampGroupDelta(elements, -80, -80)).toEqual({ dx: -50, dy: -20 });
  });

  it("pulls an already out-of-bounds element back on the first drag frame", () => {
    expect(clampGroupDelta([{ x: -10, y: 0, w: 20, h: 20 }], -5, 5)).toEqual({
      dx: 0,
      dy: 5,
    });
  });
});
