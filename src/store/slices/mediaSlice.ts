import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { MediaItem } from "../../types";
import { invoke } from "@tauri-apps/api/core";

export interface MediaSlice {
    media: MediaItem[];
    setMedia: (v: MediaItem[]) => void;
    /** Merge a single updated/inserted item into the in-memory list (used by
     *  `media-probed` / `media-updated` events so cards refresh live). */
    upsertMediaItem: (item: MediaItem) => void;
    setMediaPlayback: (id: string, loopPlayback: boolean, playbackRate: number, volume: number) => Promise<void>;
    relinkMedia: (id: string, path: string) => Promise<void>;
    updateMediaItemMetadata: (
      id: string,
      description: string | undefined,
      tags: string[],
      category: string | undefined
    ) => Promise<void>;
    bulkDeleteMedia: (ids: string[]) => Promise<void>;
    bulkUpdateMedia: (
      ids: string[],
      tagsToAdd: string[],
      tagsToRemove: string[],
          category: string | undefined
        ) => Promise<void>;
        mediaFilter: "image" | "video" | "audio" | "camera";
        setMediaFilter: (v: "image" | "video" | "audio" | "camera") => void;
        showLogoPicker: boolean;

  setShowLogoPicker: (v: boolean) => void;
  showGlobalBgPicker: boolean;
  setShowGlobalBgPicker: (v: boolean) => void;
}

export const createMediaSlice: StateCreator<AppStore, [], [], MediaSlice> = (set, get) => ({
  media: [],
  setMedia: (v) => set({ media: v }),

  upsertMediaItem: (item) =>
    set((state) => {
      const exists = state.media.some((m) => m.id === item.id);
      return { media: exists ? state.media.map((m) => (m.id === item.id ? item : m)) : [item, ...state.media] };
    }),

  setMediaPlayback: async (id, loopPlayback, playbackRate, volume) => {
    try {
      await invoke("set_media_playback", { id, loopPlayback, playbackRate, volume });
      set((state) => ({
        media: state.media.map((item) =>
          item.id === id ? { ...item, loop_playback: loopPlayback, playback_rate: playbackRate, volume } : item
        ),
      }));
    } catch (error) {
      console.error("Failed to update media playback:", error);
    }
  },

  relinkMedia: async (id, path) => {
    try {
      const updated = await invoke<MediaItem>("relink_media", { id, path });
      set((state) => ({
        media: state.media.map((item) => (item.id === id ? updated : item)),
      }));
    } catch (error) {
      console.error("Failed to relink media:", error);
      throw error;
    }
  },

  updateMediaItemMetadata: async (id, description, tags, category) => {
    try {
      await invoke("update_media_metadata", { id, description, tags, category });
      set((state) => ({
        media: state.media.map((item) =>
          item.id === id ? { ...item, description, tags, category } : item
        ),
      }));
    } catch (error) {
      console.error("Failed to update media metadata:", error);
    }
  },
  bulkDeleteMedia: async (ids: string[]) => {
    try {
      await invoke("bulk_delete_media", { ids });
      set((state) => ({
        media: state.media.filter((item) => !ids.includes(item.id)),
      }));
    } catch (error) {
      console.error("Failed to bulk delete media:", error);
    }
  },
  bulkUpdateMedia: async (
    ids: string[],
    tagsToAdd: string[],
    tagsToRemove: string[],
    category: string | undefined
  ) => {
    try {
      await invoke("bulk_update_media", {
        ids,
        tagsToAdd,
        tagsToRemove,
        category,
      });
      set((state) => ({
        media: state.media.map((item) => {
          if (ids.includes(item.id)) {
            const newTags = [
              ...item.tags.filter((tag) => !tagsToRemove.includes(tag)),
              ...tagsToAdd.filter((tag) => !item.tags.includes(tag)),
            ];
            return {
              ...item,
              tags: newTags,
              category: category !== undefined ? category : item.category,
            };
          }
          return item;
        }),
      }));
    } catch (error) {
      console.error("Failed to bulk update media:", error);
    }
  },
  mediaFilter: "image",
  setMediaFilter: (v) => set({ mediaFilter: v }),
  showLogoPicker: false,
  setShowLogoPicker: (v) => set({ showLogoPicker: v }),
  showGlobalBgPicker: false,
  setShowGlobalBgPicker: (v) => set({ showGlobalBgPicker: v }),
});
