import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { MediaItem } from "../../types";
import { invoke } from "@tauri-apps/api/core";

export interface MediaSlice {
    media: MediaItem[];
    setMedia: (v: MediaItem[]) => void;
    updateMediaItemMetadata: (
      id: string,
      description: string | undefined,
      tags: string[],
      category: string | undefined
    ) => Promise<void>;
  cameras: MediaDeviceInfo[];
  setCameras: (v: MediaDeviceInfo[]) => void;
  enabledLocalCameras: Set<string>;
  setEnabledLocalCameras: (v: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  mediaFilter: "image" | "video" | "camera";
  setMediaFilter: (v: "image" | "video" | "camera") => void;
  pauseWhisper: boolean;
  setPauseWhisper: (v: boolean | ((prev: boolean) => boolean)) => void;
  showLogoPicker: boolean;
  setShowLogoPicker: (v: boolean) => void;
  showGlobalBgPicker: boolean;
  setShowGlobalBgPicker: (v: boolean) => void;
}

export const createMediaSlice: StateCreator<AppStore, [], [], MediaSlice> = (set, get) => ({
  media: [],
  setMedia: (v) => set({ media: v }),

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
  cameras: [],
  setCameras: (v) => set({ cameras: v }),
  enabledLocalCameras: new Set<string>(),
  setEnabledLocalCameras: (v) => set((s) => ({ enabledLocalCameras: typeof v === "function" ? v(s.enabledLocalCameras) : v })),
  mediaFilter: "image",
  setMediaFilter: (v) => set({ mediaFilter: v }),
  pauseWhisper: localStorage.getItem("pref_pauseWhisper") === "true",
  setPauseWhisper: (v) => set((s) => ({ pauseWhisper: typeof v === "function" ? v(s.pauseWhisper) : v })),
  showLogoPicker: false,
  setShowLogoPicker: (v) => set({ showLogoPicker: v }),
  showGlobalBgPicker: false,
  setShowGlobalBgPicker: (v) => set({ showGlobalBgPicker: v }),
});
