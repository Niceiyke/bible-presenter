import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { AppHeader } from "../layout/AppHeader";
import { useAppStore } from "../../store";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const initialState = useAppStore.getState();

const outputState = (visible: boolean) => ({
  id: "output",
  visible,
  rendering: false,
  fps: 0,
  error: undefined,
});

describe("AppHeader output window toggle", () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
    mockInvoke.mockReset();
  });

  it("calls the backend and mirrors the authoritative output state", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "remote_status") return { enabled: false, devices: [] };
      if (cmd === "toggle_output_window") return undefined;
      throw new Error(`unexpected command ${cmd}`);
    });
    useAppStore.setState({ outputVisible: false, outputStates: { output: outputState(false) } });
    render(<AppHeader />);
    expect(screen.getByText("Output Off")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Toggle Output Window (Ctrl+O)"));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("toggle_output_window");
    });

    // The backend broadcasts output-state-changed → the store's OutputManager
    // state is the source of truth for the header indicator.
    act(() => {
      useAppStore.setState((s) => ({ outputStates: { ...s.outputStates, output: outputState(true) } }));
    });
    expect(screen.getByText("Output On")).toBeTruthy();
  });

  it("surfaces a failure without pretending the output changed", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "remote_status") return { enabled: false, devices: [] };
      if (cmd === "toggle_output_window") throw new Error("monitor gone");
      throw new Error(`unexpected command ${cmd}`);
    });
    useAppStore.setState({ outputVisible: false, outputStates: { output: outputState(false) } });
    render(<AppHeader />);

    fireEvent.click(screen.getByLabelText("Toggle Output Window (Ctrl+O)"));

    await waitFor(() => {
      expect(useAppStore.getState().backendError).toContain("Output window");
    });
    // The authoritative store state must be unchanged after the failed toggle.
    expect(useAppStore.getState().outputStates["output"]?.visible).toBe(false);
  });
});