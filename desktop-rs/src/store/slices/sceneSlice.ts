import { StateCreator } from "zustand";
import { AppStore } from "../index";
import { SceneData } from "../../types";

export interface SceneSlice {
  workingScene: SceneData;
  setWorkingScene: (v: SceneData | ((prev: SceneData) => SceneData)) => void;
  activeLayerId: string | null;
  setActiveLayerId: (v: string | null) => void;
  savedScenes: SceneData[];
  setSavedScenes: (v: SceneData[]) => void;
}

export const createSceneSlice: StateCreator<AppStore, [], [], SceneSlice> = (set) => ({
  workingScene: { id: crypto.randomUUID(), name: "New Scene", layers: [] },
  setWorkingScene: (v) => set((s) => ({ workingScene: typeof v === "function" ? v(s.workingScene) : v })),
  activeLayerId: null,
  setActiveLayerId: (v) => set({ activeLayerId: v }),
  savedScenes: [],
  setSavedScenes: (v) => set({ savedScenes: v }),
});
