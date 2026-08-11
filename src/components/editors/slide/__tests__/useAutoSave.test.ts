import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutoSave, type EditorSaveState } from "../useAutoSave";
import type { CustomPresentation } from "../../../../types";

const makePres = (name = "Deck"): CustomPresentation => ({
  id: "p",
  name,
  version: 2,
  slides: [{ id: "s1", background: { type: "color", value: "#000" }, elements: [] }],
});

/**
 * Renders `useAutoSave` in a harness where the save-state machine is a
 * plain variable the test drives directly (`setState` + `rerender` mimic
 * React's re-render on state change). Autosave timers use fake timers.
 */
function setup(save: (p: CustomPresentation) => Promise<void>, delayMs = 1000) {
  let state: EditorSaveState = "dirty";
  const saveStateRef: { current: EditorSaveState } = { current: state };
  const revisionRef = { current: 1 };
  const inFlightRef = { current: null as Promise<void> | null };
  const setSaveState = vi.fn((s: EditorSaveState) => { state = s; saveStateRef.current = s; });

  const hook = renderHook(
    ({ pres }: { pres: CustomPresentation }) =>
      useAutoSave({
        pres,
        saveState: state,
        saveStateRef,
        setSaveState,
        revisionRef,
        save,
        inFlightRef,
        delayMs,
      }),
    { initialProps: { pres: makePres() } },
  );

  const flush = async () => {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  };

  return {
    hook,
    get state() { return state; },
    saveStateRef,
    revisionRef,
    inFlightRef,
    setSaveState,
    setState: (s: EditorSaveState) => { state = s; saveStateRef.current = s; },
    rerender: (pres: CustomPresentation) => { hook.rerender({ pres }); },
    advance: async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); },
    flush,
  };
}

describe("useAutoSave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the debounce then saves and transitions to saved", async () => {
    let resolve!: () => void;
    const save = vi.fn(() => new Promise<void>((res) => { resolve = res; }));
    const h = setup(save);

    await h.advance(999);
    expect(save).not.toHaveBeenCalled();

    await h.advance(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(h.saveStateRef.current).toBe("saving");

    resolve();
    await h.flush();
    expect(h.saveStateRef.current).toBe("saved");
  });

  it("does not start overlapping saves while one is in flight", async () => {
    let resolve!: () => void;
    const save = vi.fn(() => new Promise<void>((res) => { resolve = res; }));
    const h = setup(save);

    await h.advance(1000);
    expect(save).toHaveBeenCalledTimes(1);

    await h.advance(5000);
    expect(save).toHaveBeenCalledTimes(1);

    resolve();
    await h.flush();
    expect(h.saveStateRef.current).toBe("saved");
  });

  it("keeps dirty until the newer revision is saved after an in-flight save", async () => {
    let resolve!: () => void;
    const save = vi.fn(() => new Promise<void>((res) => { resolve = res; }));
    const h = setup(save);

    await h.advance(1000);
    expect(save).toHaveBeenCalledTimes(1);

    // A newer edit lands while the first save is in flight.
    h.revisionRef.current = 2;
    h.rerender(makePres("B"));
    expect(h.saveStateRef.current).toBe("saving");

    resolve(); // first snapshot completes
    await h.flush();
    // Dirty must NOT be cleared: a newer revision exists.
    expect(h.saveStateRef.current).toBe("dirty");

    // The re-render from the state change schedules the newer save.
    h.rerender(makePres("B"));
    await h.advance(1000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ name: "B" }));

    resolve();
    await h.flush();
    expect(h.saveStateRef.current).toBe("saved");
  });

  it("transitions to save-failed, keeps dirty, and retries on demand", async () => {
    let reject!: (e: unknown) => void;
    const save = vi.fn(() => new Promise<void>((_, rej) => { reject = rej; }));
    const h = setup(save);

    await h.advance(1000);
    expect(h.saveStateRef.current).toBe("saving");

    reject(new Error("disk full"));
    await h.flush();
    expect(h.saveStateRef.current).toBe("save-failed");

    // No automatic retry while save-failed.
    await h.advance(5000);
    expect(save).toHaveBeenCalledTimes(1);

    // Explicit retry (e.g. the top-bar Retry button) sets dirty again.
    h.setState("dirty");
    h.rerender(makePres());
    await h.advance(1000);
    expect(save).toHaveBeenCalledTimes(2);
  });
});
