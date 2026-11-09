import { StateCreator } from "zustand";
import { AppStore } from "../index";
import type { DisplayItem, OutputBusInfo, OutputBusItems, OutputConfig, OutputState } from "../../types";

export interface OutputSlice {
  outputs: OutputConfig[];
  setOutputs: (v: OutputConfig[] | ((prev: OutputConfig[]) => OutputConfig[])) => void;
  outputStates: Record<string, OutputState>;
  setOutputState: (s: OutputState) => void;
  outputBuses: OutputBusInfo[];
  selectedOutputBusId: string;
  outputBusItems: Record<string, OutputBusItems>;
  setOutputBuses: (buses: OutputBusInfo[]) => void;
  setSelectedOutputBusId: (id: string) => void;
  setOutputBusItems: (busId: string, items: OutputBusItems) => void;
  setOutputBusLiveItem: (busId: string, item: DisplayItem | null) => void;
  setOutputBusStagedItem: (busId: string, item: DisplayItem | null) => void;
}

export const createOutputSlice: StateCreator<AppStore, [], [], OutputSlice> = (set) => ({
  outputs: [],
  setOutputs: (v) => set((s) => ({ outputs: typeof v === "function" ? v(s.outputs) : v })),
  outputStates: {},
  setOutputState: (st) => set((s) => ({ outputStates: { ...s.outputStates, [st.id]: st } })),
  outputBuses: [{ id: "primary", label: "Primary", primary: true }],
  selectedOutputBusId: "primary",
  outputBusItems: {},
  setOutputBuses: (buses) => set((s) => ({
    outputBuses: buses,
    selectedOutputBusId: buses.some((bus) => bus.id === s.selectedOutputBusId)
      ? s.selectedOutputBusId
      : "primary",
  })),
  setSelectedOutputBusId: (id) => set((s) => ({
    selectedOutputBusId: s.outputBuses.some((bus) => bus.id === id) ? id : "primary",
  })),
  setOutputBusItems: (busId, items) => set((s) => ({
    outputBusItems: { ...s.outputBusItems, [busId]: items },
  })),
  setOutputBusLiveItem: (busId, liveItem) => set((s) => ({
    outputBusItems: {
      ...s.outputBusItems,
      [busId]: { liveItem, stagedItem: s.outputBusItems[busId]?.stagedItem ?? null },
    },
  })),
  setOutputBusStagedItem: (busId, stagedItem) => set((s) => ({
    outputBusItems: {
      ...s.outputBusItems,
      [busId]: { liveItem: s.outputBusItems[busId]?.liveItem ?? null, stagedItem },
    },
  })),
});
