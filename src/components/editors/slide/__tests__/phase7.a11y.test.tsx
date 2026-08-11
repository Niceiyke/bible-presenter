import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditorMenu } from "../components";

describe("Phase 7 — accessibility + i18n", () => {
  it("EditorMenu restores focus to the trigger after Escape close", () => {
    render(<EditorMenu label="Pick" trigger={<span>Pick</span>} items={[{ value: "a", label: "A" }]} onSelect={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Pick" });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.getByRole("menuitem", { name: "A" })).toBeTruthy();

    // Escape closes and restores focus to the trigger.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("EditorMenu escape key is documented via aria-haspopup + aria-expanded", () => {
    render(<EditorMenu label="Pick" trigger={<span>Pick</span>} items={[{ value: "a", label: "A" }]} onSelect={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Pick" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });
});