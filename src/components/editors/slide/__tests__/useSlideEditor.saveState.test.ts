import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSlideEditor } from "../useSlideEditor";
import { useAppStore } from "../../../../store";
import type { CustomPresentation, SlideElement, SlideMaster } from "../../../../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const textEl = (id: string): SlideElement => ({
  id,
  kind: "text",
  content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }] },
  x: 10,
  y: 10,
  w: 50,
  h: 20,
  z_index: 1,
});

const makePres = (): CustomPresentation => ({
  id: "p",
  name: "Deck",
  version: 2,
  theme: {
    id: "t",
    name: "Default",
    defaultFontFamily: "Arial",
    defaultFontSize: 32,
    titleStyle: {},
    bodyStyle: {},
    textColor: "#fff",
    accentColor: "#f59e0b",
    background: { type: "color", value: "#111" },
  },
  slides: [
    { id: "s1", background: { type: "color", value: "#1a1a2e" }, elements: [textEl("e1")] },
    { id: "s2", background: { type: "color", value: "#1a1a2e" }, elements: [] },
  ],
});

const initialState = useAppStore.getState();

function renderEditor() {
  return renderHook(() => useSlideEditor({ initialPres: makePres(), onClose: () => {} }));
}

describe("useSlideEditor save state", () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts saved and marks dirty on every mutation path", () => {
    const { result } = renderEditor();
    expect(result.current.saveState).toBe("saved");

    act(() => { result.current.addTextElement(); });
    expect(result.current.saveState).toBe("dirty");

    act(() => { result.current.setPres({ ...result.current.pres, name: "Renamed" }); });
    expect(result.current.saveState).toBe("dirty");

    act(() => { result.current.handleAddSlide("default"); });
    expect(result.current.saveState).toBe("dirty");

    act(() => { result.current.updateTheme({ accentColor: "#123456" }); });
    expect(result.current.saveState).toBe("dirty");
  });

  it("routes presentation name edits through the mutation path", () => {
    const { result } = renderEditor();
    act(() => { result.current.setPres({ ...result.current.pres, name: "Sunday" }); });
    expect(result.current.pres.name).toBe("Sunday");
    expect(result.current.saveState).toBe("dirty");
  });

  it("successful retry save transitions dirty → saving → saved", async () => {
    const { result } = renderEditor();
    act(() => { result.current.addTextElement(); });
    expect(result.current.saveState).toBe("dirty");

    await act(async () => { await result.current.handleRetrySave(); });
    expect(result.current.saveState).toBe("saved");
    expect(mockInvoke).toHaveBeenCalledWith("save_studio_presentation", expect.anything());
  });

  it("failed retry save transitions to save-failed", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderEditor();
    act(() => { result.current.addTextElement(); });

    await act(async () => { await result.current.handleRetrySave(); });
    expect(result.current.saveState).toBe("save-failed");
  });

  it("undo after a save returns to dirty so the reverted state is persisted", async () => {
    const { result } = renderEditor();
    act(() => { result.current.addTextElement(); });
    await act(async () => { await result.current.handleRetrySave(); });
    expect(result.current.saveState).toBe("saved");

    act(() => { result.current.handleUndo(); });
    expect(result.current.saveState).toBe("dirty");
  });

  it("close with saved state does not open the unsaved confirmation", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useSlideEditor({ initialPres: makePres(), onClose }));
    act(() => { result.current.handleCloseRequest(); });
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it("close with dirty state opens the unsaved confirmation", () => {
    const { result } = renderEditor();
    act(() => { result.current.addTextElement(); });
    act(() => { result.current.handleCloseRequest(); });
    expect(result.current.showUnsavedConfirm).toBe(true);
    expect(result.current.saveState).toBe("dirty");
  });
});

describe("useSlideEditor master routing", () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function createMaster(result: { current: ReturnType<typeof useSlideEditor> }): string {
    act(() => { result.current.handleCreateMaster("My Master"); });
    const master = result.current.pres.masters![0];
    expect(master).toBeDefined();
    return master.id;
  }

  it("routes element geometry edits to the master, not the active slide", () => {
    const { result } = renderEditor();
    createMaster(result);
    expect(result.current.editingMasterId).toBe(result.current.pres.masters![0].id);

    act(() => { result.current.updateElement("e1", { x: 42 }); });

    expect(result.current.pres.masters![0].elements.find(e => e.id === "e1")?.x).toBe(42);
    expect(result.current.pres.slides[0].elements.find(e => e.id === "e1")?.x).toBe(10);
  });

  it("routes align to the master when editing a master", () => {
    const { result } = renderEditor();
    createMaster(result);
    act(() => { result.current.setActiveElementIds(["e1"]); });
    act(() => { result.current.alignElement("left"); });

    expect(result.current.pres.masters![0].elements.find(e => e.id === "e1")?.x).toBe(0);
    expect(result.current.pres.slides[0].elements.find(e => e.id === "e1")?.x).toBe(10);
  });

  it("routes z-order to the master when editing a master", () => {
    const { result } = renderEditor();
    createMaster(result);
    act(() => { result.current.setActiveElementIds(["e1"]); });
    act(() => { result.current.updateZOrder("front"); });

    const masterEl = result.current.pres.masters![0].elements.find(e => e.id === "e1")!;
    const slideEl = result.current.pres.slides[0].elements.find(e => e.id === "e1")!;
    expect(masterEl.z_index).toBe(2);
    expect(slideEl.z_index).toBe(1);
  });

  it("routes grouping to the master when editing a master", () => {
    const { result } = renderEditor();
    createMaster(result);
    act(() => { result.current.addTextElement(); });
    const secondId = result.current.pres.masters![0].elements[1].id;
    act(() => { result.current.setActiveElementIds(["e1", secondId]); });
    act(() => { result.current.groupSelectedElements(); });

    const masterEls = result.current.pres.masters![0].elements;
    expect(masterEls.every(e => e.groupId && e.groupId === masterEls[0].groupId)).toBe(true);
    expect(result.current.pres.slides[0].elements.find(e => e.id === "e1")?.groupId).toBeUndefined();
  });

  it("applying a master is one atomic undo step", () => {
    const { result } = renderEditor();
    const masterId = createMaster(result);
    const slidesBefore = JSON.stringify(result.current.pres.slides);

    act(() => { result.current.handleApplyMasterToSlide(masterId); });
    expect(result.current.pres.slides[0].masterRef).toBe(masterId);
    expect(result.current.pres.slides[0].elements.length).toBeGreaterThan(1);

    act(() => { result.current.handleUndo(); });
    expect(result.current.pres.slides[0].masterRef).toBeUndefined();
    expect(JSON.stringify(result.current.pres.slides)).toBe(slidesBefore);
  });

  it("deleting a master only removes the master, not the slides", () => {
    const { result } = renderEditor();
    const masterId = createMaster(result);
    const slides = JSON.stringify(result.current.pres.slides);
    act(() => { result.current.handleDeleteMaster(masterId); });
    expect(result.current.pres.masters ?? []).toHaveLength(0);
    expect(JSON.stringify(result.current.pres.slides)).toBe(slides);
  });
});
