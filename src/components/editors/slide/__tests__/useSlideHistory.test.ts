import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSlideHistory, textCoalesceKey } from "../useSlideHistory";
import type { CustomPresentation } from "../../../../types";

const makePres = (name = "Deck"): CustomPresentation => ({
  id: "p",
  name,
  version: 2,
  slides: [
    { id: "s1", background: { type: "color", value: "#000" }, elements: [] },
    { id: "s2", background: { type: "color", value: "#000" }, elements: [] },
  ],
});

describe("useSlideHistory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushes one history entry per committed mutation", () => {
    const { result } = renderHook(() => useSlideHistory(makePres()));
    act(() => { result.current.setPres({ ...result.current.present, name: "A" }); });
    act(() => { result.current.setPres({ ...result.current.present, name: "B" }); });
    expect(result.current.length).toBe(3);
    expect(result.current.present.name).toBe("B");
    expect(result.current.canUndo).toBe(true);
  });

  it("does not create history entries for drag frames (save: false)", () => {
    const { result } = renderHook(() => useSlideHistory(makePres()));
    act(() => { result.current.setPres({ ...result.current.present, name: "A" }, { save: false }); });
    act(() => { result.current.setPres({ ...result.current.present, name: "B" }, { save: false }); });
    act(() => { result.current.setPres({ ...result.current.present, name: "C" }, { save: true }); });
    expect(result.current.length).toBe(2);
    act(() => { result.current.undo(); });
    expect(result.current.present.name).toBe("Deck");
  });

  it("coalesces consecutive same-element text commits into one entry", () => {
    const { result } = renderHook(() => useSlideHistory(makePres()));
    act(() => {
      result.current.setPres({ ...result.current.present, name: "A" }, { coalesceKey: textCoalesceKey("e1") });
    });
    act(() => {
      result.current.setPres({ ...result.current.present, name: "AB" }, { coalesceKey: textCoalesceKey("e1") });
    });
    expect(result.current.length).toBe(2);
    act(() => { result.current.undo(); });
    expect(result.current.present.name).toBe("Deck");
  });

  it("clears the redo branch after a new mutation", () => {
    const { result } = renderHook(() => useSlideHistory(makePres()));
    act(() => { result.current.setPres({ ...result.current.present, name: "A" }); });
    act(() => { result.current.undo(); });
    expect(result.current.canRedo).toBe(true);
    act(() => { result.current.setPres({ ...result.current.present, name: "B" }); });
    expect(result.current.canRedo).toBe(false);
    expect(result.current.present.name).toBe("B");
  });

  it("undo then redo restores the document state", () => {
    const { result } = renderHook(() => useSlideHistory(makePres()));
    act(() => { result.current.setPres({ ...result.current.present, name: "A" }); });
    act(() => { result.current.undo(); });
    expect(result.current.present.name).toBe("Deck");
    act(() => { result.current.redo(); });
    expect(result.current.present.name).toBe("A");
  });
});
