import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../index";
import type { ScheduleEntry, DisplayItem } from "../../types";

const entry = (ref: string): ScheduleEntry => ({
  id: ref,
  item: { type: "Verse", data: { book: "John", chapter: 3, verse: 16, version: "KJV", text: "v" } } as DisplayItem,
});

const entries = (ids: string[]): ScheduleEntry[] => ids.map(entry);

const initialState = useAppStore.getState();

describe("serviceSlice schedule undo/redo", () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
  });

  it("pushScheduleState records history and clears redo", () => {
    const s = useAppStore.getState();
    s.pushScheduleState(entries(["a", "b"]));
    expect(useAppStore.getState().scheduleEntries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(useAppStore.getState().pastScheduleStates).toHaveLength(1);

    s.pushScheduleState(entries(["a", "b", "c"]));
    expect(useAppStore.getState().pastScheduleStates).toHaveLength(2);
    expect(useAppStore.getState().futureScheduleStates).toEqual([]);
  });

  it("undo restores the previous snapshot", () => {
    const s = useAppStore.getState();
    s.pushScheduleState(entries(["a", "b"]));
    s.pushScheduleState(entries(["a", "b", "c"]));

    useAppStore.getState().undoSchedule();
    expect(useAppStore.getState().scheduleEntries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(useAppStore.getState().futureScheduleStates).toHaveLength(1);

    useAppStore.getState().undoSchedule();
    expect(useAppStore.getState().scheduleEntries.map((e) => e.id)).toEqual([]);
  });

  it("redo reapplies the undone snapshot", () => {
    const s = useAppStore.getState();
    s.pushScheduleState(entries(["a", "b"]));
    s.pushScheduleState(entries(["a", "b", "c"]));

    useAppStore.getState().undoSchedule();
    useAppStore.getState().redoSchedule();
    expect(useAppStore.getState().scheduleEntries.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(useAppStore.getState().futureScheduleStates).toEqual([]);
  });

  it("undo with no history and redo with no future are no-ops", () => {
    const s = useAppStore.getState();
    // Nothing staged yet: undo cannot invent a snapshot.
    s.undoSchedule();
    expect(useAppStore.getState().scheduleEntries).toEqual([]);

    s.pushScheduleState(entries(["a"]));
    // Nothing undone yet: redo cannot invent a snapshot.
    s.redoSchedule();
    expect(useAppStore.getState().scheduleEntries.map((e) => e.id)).toEqual(["a"]);
  });

  it("push caps history at 50 snapshots", () => {
    const s = useAppStore.getState();
    for (let i = 0; i < 60; i++) {
      s.pushScheduleState(entries([`x${i}`]));
    }
    expect(useAppStore.getState().pastScheduleStates.length).toBeLessThanOrEqual(50);
    expect(useAppStore.getState().pastScheduleStates.length).toBe(50);
  });
});
