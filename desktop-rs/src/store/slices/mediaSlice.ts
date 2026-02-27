import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { MediaItem, PresentationFile } from "../../types";
import { ParsedSlide } from "../../pptxParser";

export interface MediaSlice {
  media: MediaItem[];
  setMedia: (v: MediaItem[]) => void;
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
  presentations: PresentationFile[];
  setPresentations: (v: PresentationFile[]) => void;
  selectedPresId: string | null;
  setSelectedPresId: (v: string | null) => void;
  loadedSlides: Record<string, ParsedSlide[]>;
  setLoadedSlides: (v: Record<string, ParsedSlide[]>) => void;
  libreOfficeAvailable: boolean;
  setLibreOfficeAvailable: (v: boolean) => void;
  pptxPngSlides: Record<string, string[]>;
  setPptxPngSlides: (v: Record<string, string[]> | ((prev: Record<string, string[]>) => Record<string, string[]>)) => void;
}

export const createMediaSlice: StateCreator<AppStore, [], [], MediaSlice> = (set) => ({
  media: [],
  setMedia: (v) => set({ media: v }),
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
  presentations: [],
  setPresentations: (v) => set({ presentations: v }),
  selectedPresId: null,
  setSelectedPresId: (v) => set({ selectedPresId: v }),
  loadedSlides: {},
  setLoadedSlides: (v) => set({ loadedSlides: v }),
  libreOfficeAvailable: false,
  setLibreOfficeAvailable: (v) => set({ libreOfficeAvailable: v }),
  pptxPngSlides: {},
  setPptxPngSlides: (v) => set((s) => ({ pptxPngSlides: typeof v === "function" ? v(s.pptxPngSlides) : v })),
});
