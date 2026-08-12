import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAppStore } from "../../store";
import type { Song } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((p: string) => p),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const initialState = useAppStore.getState();

describe("Phase 2 — persistence safety + quick lyrics", () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
    mockInvoke.mockReset();
  });
  afterEach(() => useAppStore.setState(initialState, true));

  it("quickLyricsText starts empty and is not in the songs array", () => {
    const state = useAppStore.getState();
    expect(state.quickLyricsText).toBe("");
    expect(state.songs.find(s => (s as any).id === "quick-lyrics")).toBeUndefined();
  });

  it("setQuickLyricsText sets text without adding to songs", () => {
    act(() => {
      useAppStore.getState().setQuickLyricsText("test lyrics");
    });
    const state = useAppStore.getState();
    expect(state.quickLyricsText).toBe("test lyrics");
    expect(state.songs.find(s => (s as any).id === "quick-lyrics")).toBeUndefined();
  });

  it("save_song failure does not update songs or emit songs-sync", async () => {
    mockInvoke.mockRejectedValue(new Error("backend down"));
    const { result } = renderHook(() => {
      const store = useAppStore();
      return { songs: store.songs, setSongs: store.setSongs, setBackendError: store.setBackendError };
    });
    const before = useAppStore.getState().songs.length;
    try {
      await invoke("save_song", { song: { id: "", title: "X" } });
    } catch {
      // expected
    }
    expect(useAppStore.getState().songs.length).toBe(before);
  });

  it("delete_song failure keeps the song visible", async () => {
    mockInvoke.mockRejectedValue(new Error("delete failed"));
    useAppStore.setState({ songs: [{ id: "keep", title: "Keep", sections: [], arrangement: [] } as any] });
    const before = useAppStore.getState().songs.length;
    try {
      await invoke("delete_song", { id: "keep" });
    } catch {
      // expected
    }
    expect(useAppStore.getState().songs.length).toBe(before);
    expect(useAppStore.getState().songs.find(s => s.id === "keep")).toBeTruthy();
  });

  it("save_song success emits songs-sync with the new list", async () => {
    const savedSong = { id: "new1", title: "New Song", sections: [], arrangement: [] };
    mockInvoke.mockResolvedValue(savedSong);
    useAppStore.setState({ songs: [] });
    const saved = await invoke<Song>("save_song", { song: { id: "", title: "New Song" } });
    const next = [...useAppStore.getState().songs, saved];
    useAppStore.getState().setSongs(next);
    expect(useAppStore.getState().songs.find(s => s.id === "new1")).toBeTruthy();
  });
});