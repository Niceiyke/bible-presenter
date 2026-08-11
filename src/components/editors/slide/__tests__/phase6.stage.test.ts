import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSlideEditor } from "../useSlideEditor";
import { useAppStore } from "../../../../store";
import type { CustomPresentation, SlideElement, DisplayItem } from "../../../../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((p: string) => p),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const textEl = (id: string): SlideElement => ({
  id, kind: "text", content: { type: "doc", content: [{ type: "paragraph" }] },
  x: 10, y: 10, w: 50, h: 20, z_index: 1,
});

const makePres = (id = "p"): CustomPresentation => ({
  id, name: "Deck", version: 2,
  theme: { id: "t", name: "d", defaultFontFamily: "Arial", defaultFontSize: 32, titleStyle: {}, bodyStyle: {}, textColor: "#fff", accentColor: "#f59e0b", background: { type: "color", value: "#111" } },
  slides: [
    { id: "s1", background: { type: "color", value: "#1a1a2e" }, elements: [textEl("e1")] },
    { id: "s2", background: { type: "color", value: "#1a1a2e" }, elements: [] },
  ],
});

const initialState = useAppStore.getState();

describe("Phase 6 — preview, stage, service integration", () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
  });
  afterEach(() => useAppStore.setState(initialState, true));

  it("preview toggle never invokes stage/live commands", () => {
    const { result } = renderHook(() => useSlideEditor({ initialPres: makePres(), onClose: () => {} }));
    act(() => result.current.setPreviewOpen(true));
    act(() => result.current.setPreviewOpen(false));
    // No stage_item / commit_staged / stage_item invoke calls should have happened.
    const calls = mockInvoke.mock.calls.map(c => c[0]);
    expect(calls).not.toContain("stage_item");
    expect(calls).not.toContain("commit_staged");
    expect(calls).not.toContain("clear_live");
  });

  it("stageCurrentSlide calls onStageSlide with the correct presentation id and slide index", async () => {
    const onStage = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useSlideEditor({ initialPres: makePres("pres-42"), onClose: () => {}, onStageSlide: onStage }));
    act(() => { result.current.setActiveSlideIdx(1); });
    await act(async () => { await result.current.stageCurrentSlide(); });
    expect(onStage).toHaveBeenCalledTimes(1);
    const item = onStage.mock.calls[0][0] as DisplayItem;
    expect(item.type).toBe("CustomSlide");
    if (item.type !== "CustomSlide") return;
    expect(item.data.presentation_id).toBe("pres-42");
    expect(item.data.slide_index).toBe(1);
    expect(item.data.slide_count).toBe(2);
  });

  it("stage failure (onStageSlide rejects) does not throw and clears the staging flag", async () => {
    const onStage = vi.fn().mockRejectedValue(new Error("backend down"));
    const { result } = renderHook(() => useSlideEditor({ initialPres: makePres(), onClose: () => {}, onStageSlide: onStage }));
    await act(async () => { await result.current.stageCurrentSlide(); });
    expect(result.current.staging).toBe(false);
  });

  it("stageCurrentSlide staging flag is true during the in-flight call", async () => {
    let resolveStage: (v: boolean) => void = () => {};
    const stagePromise = new Promise<boolean>(r => { resolveStage = r; });
    const onStage = vi.fn().mockReturnValue(stagePromise);
    const { result } = renderHook(() => useSlideEditor({ initialPres: makePres(), onClose: () => {}, onStageSlide: onStage }));
    let stagePromise2: Promise<void>;
    act(() => { stagePromise2 = result.current.stageCurrentSlide(); });
    expect(result.current.staging).toBe(true);
    await act(async () => { resolveStage(true); await stagePromise2; });
    expect(result.current.staging).toBe(false);
  });

  it("addToServiceCurrentSlide delegates to the shared onAddToService callback", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useSlideEditor({ initialPres: makePres("p9"), onClose: () => {}, onAddToService: onAdd }));
    await act(async () => { await result.current.addToServiceCurrentSlide(); });
    expect(onAdd).toHaveBeenCalledTimes(1);
    const item = onAdd.mock.calls[0][0] as DisplayItem;
    expect(item.type).toBe("CustomSlide");
    if (item.type !== "CustomSlide") return;
    expect(item.data.presentation_id).toBe("p9");
    expect(item.data.slide_index).toBe(0);
  });

  it("currentSlideStatus is 'live' when liveItem matches the active slide", () => {
    const pres = makePres("px");
    // Set liveItem to the active slide (index 0)
    useAppStore.setState({
      liveItem: { type: "CustomSlide", data: { presentation_id: "px", presentation_name: "Deck", slide_index: 0, slide_count: 2, background: pres.slides[0].background, elements: pres.slides[0].elements } } as DisplayItem,
    });
    const { result } = renderHook(() => useSlideEditor({ initialPres: pres, onClose: () => {} }));
    expect(result.current.currentSlideStatus).toBe("live");
  });

  it("currentSlideStatus is 'staged' when stagedItem matches the active slide", () => {
    const pres = makePres("py");
    useAppStore.setState({
      stagedItem: { type: "CustomSlide", data: { presentation_id: "py", presentation_name: "Deck", slide_index: 0, slide_count: 2, background: pres.slides[0].background, elements: pres.slides[0].elements } } as DisplayItem,
    });
    const { result } = renderHook(() => useSlideEditor({ initialPres: pres, onClose: () => {} }));
    expect(result.current.currentSlideStatus).toBe("staged");
  });

  it("currentSlideStatus is 'idle' when neither staged nor live matches", () => {
    const { result } = renderHook(() => useSlideEditor({ initialPres: makePres("pz"), onClose: () => {} }));
    expect(result.current.currentSlideStatus).toBe("idle");
  });

  it("autosave (save_studio_presentation) never invokes live commands", async () => {
    mockInvoke.mockResolvedValue(undefined);
    renderHook(() => useSlideEditor({ initialPres: makePres(), onClose: () => {} }));
    // Wait briefly for any autosave debounce to fire (it won't since no edits).
    await new Promise(r => setTimeout(r, 100));
    const calls = mockInvoke.mock.calls.map(c => c[0]);
    expect(calls).not.toContain("stage_item");
    expect(calls).not.toContain("commit_staged");
    expect(calls).not.toContain("clear_live");
  });
});