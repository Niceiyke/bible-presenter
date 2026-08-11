import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSlideEditor } from "../useSlideEditor";
import { useAppStore } from "../../../../store";
import type { CustomPresentation, SlideElement } from "../../../../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((p: string) => p),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const imageEl = (id: string, content: string): SlideElement =>
  ({ id, kind: "image", x: 10, y: 10, w: 40, h: 30, z_index: 1, content }) as SlideElement;

const makePres = (els: SlideElement[]): CustomPresentation => ({
  id: "p", name: "Deck", version: 2,
  theme: { id: "t", name: "d", defaultFontFamily: "Arial", defaultFontSize: 32, titleStyle: {}, bodyStyle: {}, textColor: "#fff", accentColor: "#f59e0b", background: { type: "color", value: "#111" } },
  slides: [{ id: "s1", background: { type: "color", value: "#1a1a2e" }, elements: els }],
});

const initialState = useAppStore.getState();

describe("Phase 5 — media replacement", () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
  });
  afterEach(() => useAppStore.setState(initialState, true));

  it("replacing the selected image's media updates content and leaves no stale path", () => {
    const { result } = renderHook(() => useSlideEditor({
      initialPres: makePres([imageEl("img", "old/photo.png")]),
      onClose: () => {},
    }));
    act(() => { result.current.setActiveElementIds(["img"]); });
    act(() => result.current.handleImageSelect("new/photo.png"));
    const el = result.current.pres.slides[0].elements[0] as any;
    expect(el.content).toBe("new/photo.png");
    expect(el.content).not.toContain("old");
  });

  it("inserting an image when none is selected adds a new element with the path", () => {
    const { result } = renderHook(() => useSlideEditor({
      initialPres: makePres([]),
      onClose: () => {},
    }));
    act(() => result.current.handleImageSelect("library/pic.jpg"));
    const els = result.current.pres.slides[0].elements;
    expect(els).toHaveLength(1);
    expect((els[0] as any).content).toBe("library/pic.jpg");
    expect(els[0].kind).toBe("image");
  });

  it("missing media path stays present so it can be recovered (relativized, not purged)", () => {
    const { result } = renderHook(() => useSlideEditor({
      initialPres: makePres([{ id: "img", kind: "image", x: 0, y: 0, w: 40, h: 30, z_index: 1, content: "gone/missing.mp4" } as any]),
      onClose: () => {},
    }));
    const el = result.current.pres.slides[0].elements[0] as any;
    // The element and its path survive load; recovery tooling can relink it.
    expect(el.content).toBe("gone/missing.mp4");
    expect(el.kind).toBe("image");
  });
});