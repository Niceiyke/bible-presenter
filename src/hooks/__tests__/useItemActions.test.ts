import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useItemActions } from "../useItemActions";
import { useAppStore } from "../../store";
import type { DisplayItem, PropItem } from "../../types";
import { DEFAULT_LT_TEMPLATE } from "../../types";

// Mock the Tauri bridge before anything imports the real modules.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const makeVerse = (verse = 16): DisplayItem => ({
  type: "Verse",
  data: { book: "John", chapter: 3, verse, version: "KJV", text: "For God so loved the world..." },
});

const propItem = (): PropItem => ({
  id: "p1",
  kind: "clock",
  x: 0, y: 0, w: 100, h: 100, opacity: 1, visible: true,
});

const initialState = useAppStore.getState();

describe("useItemActions", () => {
  beforeEach(() => {
    // Full store reset: restore every slice to its created defaults.
    useAppStore.setState(initialState, true);
    mockInvoke.mockReset();
    // Verse staging only reaches the backend when auto-split is off.
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, auto_split_verses: false },
    });
  });

  describe("stageItem", () => {
    it("applies the staged item when the backend accepts it", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      const { result } = renderHook(() => useItemActions());
      const item = makeVerse();

      let ok = false;
      await act(async () => { ok = await result.current.stageItem(item); });

      expect(ok).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith("stage_item", { item });
      expect(useAppStore.getState().stagedItem).toEqual(item);
    });

    it("reverts staged state and reports the error when the backend fails", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("stage boom"));
      const { result } = renderHook(() => useItemActions());
      const item = makeVerse();

      let ok = true;
      await act(async () => { ok = await result.current.stageItem(item); });

      expect(ok).toBe(false);
      expect(useAppStore.getState().stagedItem).toBeNull();
      expect(useAppStore.getState().backendError).toContain("Failed to stage item");
    });
  });

  describe("sendLive (transactional single round-trip)", () => {
    it("returns false and keeps live untouched when the backend rejects the atomic send", async () => {
      const current = makeVerse(15);
      const item = makeVerse();
      useAppStore.setState({ liveItem: current });
      mockInvoke.mockRejectedValueOnce(new Error("send live boom"));
      const { result } = renderHook(() => useItemActions());

      let ok = true;
      await act(async () => { ok = await result.current.sendLive(item); });

      expect(ok).toBe(false);
      expect(mockInvoke).toHaveBeenCalledWith("send_live_item", { item });
      // The prior live item is untouched — nothing wrong went on air.
      expect(useAppStore.getState().liveItem).toEqual(current);
      expect(useAppStore.getState().previousItem).toBeNull();
      expect(useAppStore.getState().backendError).toContain("Failed to send live");
    });

    it("promotes the returned item to live in a single round-trip", async () => {
      const item = makeVerse();
      // send_live_item resolves with the committed item.
      mockInvoke.mockResolvedValueOnce(item);
      const { result } = renderHook(() => useItemActions());

      let ok = false;
      await act(async () => { ok = await result.current.sendLive(item); });

      expect(ok).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith("send_live_item", { item });
      expect(mockInvoke).not.toHaveBeenCalledWith("stage_item");
      expect(mockInvoke).not.toHaveBeenCalledWith("commit_staged");
      expect(useAppStore.getState().liveItem).toEqual(item);
      expect(useAppStore.getState().previousItem).toBeNull();
    });

    it("restores the previous staged item locally when the atomic send fails", async () => {
      const current = makeVerse(15);
      const item = makeVerse();
      const previousStaged = makeVerse(10);
      useAppStore.setState({ liveItem: current, stagedItem: previousStaged });
      mockInvoke.mockRejectedValueOnce(new Error("commit boom"));
      const { result } = renderHook(() => useItemActions());

      let ok = true;
      await act(async () => { ok = await result.current.sendLive(item); });

      expect(ok).toBe(false);
      expect(useAppStore.getState().liveItem).toEqual(current);
      expect(useAppStore.getState().previousItem).toBeNull();
      expect(useAppStore.getState().stagedItem).toEqual(previousStaged);
      expect(useAppStore.getState().backendError).toContain("Failed to send live");
    });

    it("promotes the patched scene composition returned by send_live_item (Phase 5 zone bus)", async () => {
      // A scene composition with a verse zone is live; taking a verse live
      // returns the *patched* composition (backend refreshed the pinned zone).
      const sceneItem: DisplayItem = {
        type: "SceneComposition",
        data: {
          scene_id: "s1",
          name: "Cam + Bible",
          zones: [
            { id: "cam", item: { type: "Camera", data: { deviceId: "cam1", opacity: 1, objectFit: "cover", mirrored: false } }, source: { type: "camera" }, x: 0, y: 0, w: 0.5, h: 1, fit: "cover", opacity: 1, z: 1 },
            { id: "verse", item: makeVerse(3), source: { type: "verse" }, x: 0.5, y: 0, w: 0.5, h: 1, fit: "cover", opacity: 1, z: 2 },
          ],
        },
      };
      useAppStore.setState({ liveItem: sceneItem });
      mockInvoke.mockResolvedValueOnce(sceneItem);  // send_live_item -> patched scene

      const { result } = renderHook(() => useItemActions());
      let ok = false;
      await act(async () => { ok = await result.current.sendLive(makeVerse()); });

      expect(ok).toBe(true);
      // The scene stays on air (not replaced by the verse); previous is the old scene.
      expect(useAppStore.getState().liveItem).toEqual(sceneItem);
      expect(useAppStore.getState().previousItem).toEqual(sceneItem);
    });
  });

  describe("goLive", () => {
    it("moves the previous live item to history and commits staged", async () => {
      const staged = makeVerse();
      const current = makeVerse(1);
      useAppStore.setState({ liveItem: current, stagedItem: staged });
      mockInvoke.mockResolvedValueOnce(staged); // commit_staged
      const { result } = renderHook(() => useItemActions());

      let ok = false;
      await act(async () => { ok = await result.current.goLive(); });

      expect(ok).toBe(true);
      expect(useAppStore.getState().liveItem).toEqual(staged);
      expect(useAppStore.getState().previousItem).toEqual(current);
    });

    it("does not change live when commit fails", async () => {
      const current = makeVerse();
      useAppStore.setState({ liveItem: current, stagedItem: makeVerse() });
      mockInvoke.mockRejectedValueOnce(new Error("go live boom"));
      const { result } = renderHook(() => useItemActions());

      let ok = true;
      await act(async () => { ok = await result.current.goLive(); });

      expect(ok).toBe(false);
      expect(useAppStore.getState().liveItem).toEqual(current);
      expect(useAppStore.getState().previousItem).toBeNull();
    });

    it("returns false and reports when there is nothing staged", async () => {
      useAppStore.setState({ liveItem: makeVerse(), stagedItem: null });
      mockInvoke.mockResolvedValueOnce(null); // commit_staged -> null
      const { result } = renderHook(() => useItemActions());

      let ok = true;
      await act(async () => { ok = await result.current.goLive(); });

      expect(ok).toBe(false);
      expect(useAppStore.getState().liveItem).toEqual(makeVerse());
      expect(useAppStore.getState().previousItem).toBeNull();
      expect(useAppStore.getState().backendError).toContain("Nothing staged");
    });
  });

  describe("clearAll", () => {
    it("clears live, staged, props and lower third on success and returns a snapshot", async () => {
      useAppStore.setState({
        liveItem: makeVerse(),
        stagedItem: makeVerse(),
        propItems: [propItem()],
        ltVisible: true,
        currentLowerThird: { data: { kind: "Nameplate", data: { name: "Test" } }, template: { ...DEFAULT_LT_TEMPLATE } },
      });
      mockInvoke.mockResolvedValueOnce(undefined); // clear_all
      const { result } = renderHook(() => useItemActions());

      let snapshot: Awaited<ReturnType<typeof result.current.clearAll>> = null;
      await act(async () => { snapshot = await result.current.clearAll(); });

      expect(snapshot).not.toBeNull();
      expect(snapshot!.liveItem).toEqual(makeVerse());
      expect(snapshot!.ltVisible).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith("clear_all");
      expect(useAppStore.getState().liveItem).toBeNull();
      expect(useAppStore.getState().stagedItem).toBeNull();
      expect(useAppStore.getState().propItems).toEqual([]);
      expect(useAppStore.getState().ltVisible).toBe(false);
      expect(useAppStore.getState().currentLowerThird).toBeNull();
    });

    it("restores the prior state and returns null when clear fails", async () => {
      const live = makeVerse();
      const props = [propItem()];
      useAppStore.setState({ liveItem: live, stagedItem: null, propItems: props, ltVisible: true });
      mockInvoke.mockRejectedValueOnce(new Error("clear boom"));
      const { result } = renderHook(() => useItemActions());

      let snapshot: Awaited<ReturnType<typeof result.current.clearAll>> = null;
      await act(async () => { snapshot = await result.current.clearAll(); });

      expect(snapshot).toBeNull();
      expect(useAppStore.getState().liveItem).toEqual(live);
      expect(useAppStore.getState().propItems).toEqual(props);
      expect(useAppStore.getState().ltVisible).toBe(true);
      expect(useAppStore.getState().backendError).toContain("Clear All failed");
    });
  });

  describe("clearStaged", () => {
    it("clears the staged item through the backend on success", async () => {
      useAppStore.setState({ stagedItem: makeVerse() });
      mockInvoke.mockResolvedValueOnce(undefined); // clear_staged
      const { result } = renderHook(() => useItemActions());

      let ok = false;
      await act(async () => { ok = await result.current.clearStaged(); });

      expect(ok).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith("clear_staged");
      expect(useAppStore.getState().stagedItem).toBeNull();
    });

    it("restores the staged item and reports the error when the backend rejects", async () => {
      const staged = makeVerse();
      useAppStore.setState({ stagedItem: staged });
      mockInvoke.mockRejectedValueOnce(new Error("clear staged boom"));
      const { result } = renderHook(() => useItemActions());

      let ok = true;
      await act(async () => { ok = await result.current.clearStaged(); });

      expect(ok).toBe(false);
      expect(useAppStore.getState().stagedItem).toEqual(staged);
      expect(useAppStore.getState().backendError).toContain("Failed to clear staged");
    });
  });

  describe("settings and props rollback", () => {
    it("reverts settings when the save command fails", async () => {
      const before = useAppStore.getState().settings;
      mockInvoke.mockRejectedValueOnce(new Error("save boom"));
      const { result } = renderHook(() => useItemActions());

      await act(async () => {
        await result.current.updateSettings({ ...before, font_size: 120 });
      });

      expect(useAppStore.getState().settings.font_size).toBe(before.font_size);
      expect(useAppStore.getState().backendError).toContain("Failed to save settings");
    });

    it("reverts props when the props command fails", async () => {
      const before = [propItem()];
      useAppStore.setState({ propItems: before });
      mockInvoke.mockRejectedValueOnce(new Error("props boom"));
      const { result } = renderHook(() => useItemActions());

      await act(async () => {
        await result.current.updateProps([]);
      });

      expect(useAppStore.getState().propItems).toEqual(before);
      expect(useAppStore.getState().backendError).toContain("Failed to update props");
    });
  });

describe("song overlay go-live failures (Phase 6)", () => {
    const overlayItem = (): DisplayItem => ({
      type: "Song",
      data: {
        song_id: "s1",
        title: "Song",
        section_label: "Chorus",
        lines: ["line one", "line two"],
        slide_index: 0,
        total_slides: 2,
        style: "LowerThird",
      } as any,
    });

    it("sendLive does not claim the overlay is visible when show_lower_third fails", async () => {
      useAppStore.setState({ ltVisible: false });
      const item = overlayItem();
      mockInvoke.mockResolvedValueOnce(item);        // send_live_item
      mockInvoke.mockRejectedValueOnce(new Error("lt boom")); // show_lower_third
      const { result } = renderHook(() => useItemActions());

      let ok = false;
      await act(async () => { ok = await result.current.sendLive(item); });

      expect(ok).toBe(true);
      // The live item is the committed song, but the overlay flag must NOT
      // have been flipped on a failed show command.
      expect(useAppStore.getState().ltVisible).toBe(false);
      expect(useAppStore.getState().backendError).toContain("Lower-third failed");
    });

    it("sendLive flips the overlay visible only when show_lower_third succeeds", async () => {
      useAppStore.setState({ ltVisible: false });
      const item = overlayItem();
      mockInvoke.mockResolvedValueOnce(item);        // send_live_item
      mockInvoke.mockResolvedValueOnce(undefined);   // show_lower_third
      const { result } = renderHook(() => useItemActions());

      await act(async () => { await result.current.sendLive(item); });

      expect(useAppStore.getState().ltVisible).toBe(true);
      expect(useAppStore.getState().ltSongId).toBe("s1");
      expect(useAppStore.getState().ltMode).toBe("lyrics");
    });

    it("goLive does not flip the overlay visible when show_lower_third fails", async () => {
      useAppStore.setState({ ltVisible: false, stagedItem: overlayItem(), liveItem: null });
      mockInvoke.mockResolvedValueOnce(overlayItem()); // commit_staged
      mockInvoke.mockRejectedValueOnce(new Error("lt boom")); // show_lower_third
      const { result } = renderHook(() => useItemActions());

      let ok = true;
      await act(async () => { ok = await result.current.goLive(); });

      expect(ok).toBe(true);
      expect(useAppStore.getState().ltVisible).toBe(false);
      expect(useAppStore.getState().backendError).toContain("Lower-third failed");
    });
  });

  describe("service persistence", () => {
    it("saves the active service with its schedule entries", async () => {
      const item = makeVerse();
      useAppStore.setState({
        activeServiceId: "svc-1",
        services: [{ id: "svc-1", name: "Sunday AM", item_count: 1, updated_at: 0 }],
        scheduleEntries: [{ id: "e1", item }],
      });
      mockInvoke.mockResolvedValueOnce(undefined); // save_service
      const { result } = renderHook(() => useItemActions());

      await act(async () => { await result.current.persistSchedule(); });

      expect(mockInvoke).toHaveBeenCalledWith("save_service", {
        schedule: {
          id: "svc-1",
          name: "Sunday AM",
          items: [{ id: "e1", item }],
        },
      });
      expect(useAppStore.getState().toast).toContain("Service saved");
    });

    it("surfaces an error and does not toast on save failure", async () => {
      useAppStore.setState({ activeServiceId: "svc-1", services: [], scheduleEntries: [] });
      mockInvoke.mockRejectedValueOnce(new Error("save service boom"));
      const { result } = renderHook(() => useItemActions());

      await act(async () => { await result.current.persistSchedule(); });

      expect(useAppStore.getState().backendError).toContain("Save service failed");
      expect(useAppStore.getState().toast).toBeNull();
    });
  });
});
