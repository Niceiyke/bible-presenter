import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { CustomPresentation, CustomSlide } from "../../types";

export interface StudioSlice {
  studioList: { id: string; name: string; slide_count: number }[];
  setStudioList: (v: { id: string; name: string; slide_count: number }[] | ((prev: { id: string; name: string; slide_count: number }[]) => { id: string; name: string; slide_count: number }[])) => void;
  editorPresId: string | null;
  setEditorPresId: (v: string | null) => void;
  editorPres: CustomPresentation | null;
  setEditorPres: (v: CustomPresentation | null) => void;
  expandedStudioPresId: string | null;
  setExpandedStudioPresId: (v: string | null) => void;
  studioSlides: Record<string, CustomSlide[]>;
  setStudioSlides: (v: Record<string, CustomSlide[]> | ((prev: Record<string, CustomSlide[]>) => Record<string, CustomSlide[]>)) => void;
}

export const createStudioSlice: StateCreator<AppStore, [], [], StudioSlice> = (set) => ({
  studioList: [],
  setStudioList: (v) => set((s) => ({ studioList: typeof v === "function" ? v(s.studioList) : v })),
  editorPresId: null,
  setEditorPresId: (v) => set({ editorPresId: v }),
  editorPres: null,
  setEditorPres: (v) => set({ editorPres: v }),
  expandedStudioPresId: null,
  setExpandedStudioPresId: (v) => set({ expandedStudioPresId: v }),
  studioSlides: {},
  setStudioSlides: (v) => set((s) => ({ studioSlides: typeof v === "function" ? v(s.studioSlides) : v })),
});
