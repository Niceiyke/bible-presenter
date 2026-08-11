import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppHeader } from "../layout/AppHeader";
import { useAppStore } from "../../store";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const initialState = useAppStore.getState();

describe("AppHeader output window toggle", () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
    mockInvoke.mockReset();
  });

  it("flips output visibility when the backend toggles the window", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    useAppStore.setState({ outputVisible: false });
    render(<AppHeader />);

    fireEvent.click(screen.getByLabelText("Toggle Output Window (Ctrl+O)"));

    await vi.waitFor(() => {
      expect(useAppStore.getState().outputVisible).toBe(true);
    });
    expect(mockInvoke).toHaveBeenCalledWith("toggle_output_window");
  });

  it("does not flip output and surfaces an error when the window toggle fails", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("monitor gone"));
    useAppStore.setState({ outputVisible: true });
    render(<AppHeader />);

    fireEvent.click(screen.getByLabelText("Toggle Output Window (Ctrl+O)"));

    await vi.waitFor(() => {
      expect(useAppStore.getState().outputVisible).toBe(true);
    });
    expect(useAppStore.getState().backendError).toContain("Output window");
  });
});
