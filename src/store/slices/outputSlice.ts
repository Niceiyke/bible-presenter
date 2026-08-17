import { StateCreator } from "zustand";
import { AppStore } from "../index";
import type { OutputConfig, OutputState } from "../../types";

export interface OutputSlice {
  outputs: OutputConfig[];
  setOutputs: (v: OutputConfig[] | ((prev: OutputConfig[]) => OutputConfig[])) => void;
  outputStates: Record<string, OutputState>;
  setOutputState: (s: OutputState) => void;
}

export const createOutputSlice: StateCreator<AppStore, [], [], OutputSlice> = (set) => ({
  outputs: [],
  setOutputs: (v) => set((s) => ({ outputs: typeof v === "function" ? v(s.outputs) : v })),
  outputStates: {},
  setOutputState: (st) => set((s) => ({ outputStates: { ...s.outputStates, [st.id]: st } })),
});