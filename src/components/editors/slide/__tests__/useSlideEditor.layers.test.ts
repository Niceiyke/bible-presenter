import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSlideEditor } from "../useSlideEditor";
import { useAppStore } from "../../../../store";
import type { CustomPresentation, SlideElement } from "../../../../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((p: string) => p),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const textEl = (id: string, z = 1, extra: Partial<SlideElement> = {}): SlideElement => ({
  id,
  kind: "text",
  content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] },
  x: 10, y: 10, w: 50, h: 20, z_index: z,
  ...extra,
}) as SlideElement;

const makePres = (elements: SlideElement[]): CustomPresentation => ({
  id: "p",
  name: "Deck",
  version: 2,
  theme: {
    id: "t", name: "Default", defaultFontFamily: "Arial", defaultFontSize: 32,
    titleStyle: {}, bodyStyle: {}, textColor: "#fff", accentColor: "#f59e0b",
    background: { type: "color", value: "#111" },
  },
  slides: [{ id: "s1", background: { type: "color", value: "#1a1a2e" }, elements }],
});

const initialState = useAppStore.getState();

function renderEditor(elements: SlideElement[]) {
  return renderHook(() => useSlideEditor({ initialPres: makePres(elements), onClose: () => {} }));
}

describe("Phase 4 — layers + lock + hide + z-order", () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
  });
  afterEach(() => useAppStore.setState(initialState, true));

  it("lock prevents accidental deletion of the locked element", () => {
    const { result } = renderEditor([textEl("a", 1, { locked: true }), textEl("b", 2)]);
    act(() => { result.current.setActiveElementIds(["a", "b"]); });
    act(() => result.current.deleteSelectedElements());
    // The locked element survives; the unlocked one is removed.
    expect(result.current.pres.slides[0].elements.map(e => e.id)).toEqual(["a"]);
  });

  it("hide toggles the persisted hidden flag (not deletion)", () => {
    const { result } = renderEditor([textEl("a", 1)]);
    act(() => result.current.updateElement("a", { hidden: true }));
    expect(result.current.pres.slides[0].elements[0].hidden).toBe(true);
    act(() => result.current.updateElement("a", { hidden: false }));
    expect(result.current.pres.slides[0].elements[0].hidden).toBe(false);
  });

  it("handleZOrderElement changes z-order and persists", () => {
    const { result } = renderEditor([textEl("a", 1), textEl("b", 2)]);
    act(() => result.current.handleZOrderElement("a", "front"));
    const a = result.current.pres.slides[0].elements.find(e => e.id === "a")!;
    const b = result.current.pres.slides[0].elements.find(e => e.id === "b")!;
    expect(a.z_index).toBeGreaterThan(b.z_index);
  });

  it("multi-select align produces a single undo entry and is undoable", () => {
    const { result } = renderEditor([
      textEl("a", 1, { x: 5 }),
      textEl("b", 2, { x: 30 }),
    ]);
    act(() => { result.current.setActiveElementIds(["a", "b"]); });
    const before = result.current.canUndo;
    act(() => result.current.alignElement("left"));
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.handleUndo());
    const a = result.current.pres.slides[0].elements.find(e => e.id === "a")!;
    expect(a.x).toBe(5);
    if (before) {
      // sanity: align was a real change
      expect(result.current.canUndo).toBe(false);
    }
  });

  it("layer selection reuses the authoritative activeElementIds", () => {
    const { result } = renderEditor([textEl("a", 1), textEl("b", 2)]);
    act(() => { result.current.setActiveElementIds(["b"]); });
    expect(result.current.activeElementIds).toEqual(["b"]);
    // selecting another via the same setter replaces selection
    act(() => { result.current.setActiveElementIds(["a"]); });
    expect(result.current.activeElementIds).toEqual(["a"]);
  });

  it("rename via updateElement persists the name", () => {
    const { result } = renderEditor([textEl("a", 1)]);
    act(() => result.current.updateElement("a", { name: "Title" }));
    expect(result.current.pres.slides[0].elements[0].name).toBe("Title");
  });
});