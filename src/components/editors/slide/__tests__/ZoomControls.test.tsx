import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ZoomControls, MIN_ZOOM, MAX_ZOOM } from "../ZoomControls";

describe("ZoomControls (Phase 3)", () => {
  it("shows the current zoom as a percentage", () => {
    render(<ZoomControls zoom={1} onZoomChange={vi.fn()} />);
    expect(screen.getByText("100%")).toBeTruthy();
  });

  it("zooms in and out via the + / − buttons", () => {
    const onChange = vi.fn();
    render(<ZoomControls zoom={1} onZoomChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(onChange).toHaveBeenLastCalledWith(1.1);

    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(onChange).toHaveBeenLastCalledWith(0.9);
  });

  it("resets to fit (100%) via the Fit button", () => {
    const onChange = vi.fn();
    render(<ZoomControls zoom={1.5} onZoomChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Fit canvas" }));
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it("clamps zoom out at the minimum and disables the − button", () => {
    render(<ZoomControls zoom={MIN_ZOOM} onZoomChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
  });

  it("clamps zoom in at the maximum and disables the + button", () => {
    render(<ZoomControls zoom={MAX_ZOOM} onZoomChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
  });
});