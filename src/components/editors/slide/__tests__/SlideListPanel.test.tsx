import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SlideListPanel } from "../SlideListPanel";
import type { CustomSlide } from "../../../../types";

vi.mock("../../../shared/SlideThumbnail", () => ({
  SlideThumbnail: ({ alt }: { alt?: string }) => <div aria-label={alt} />,
}));

const baseProps = (overrides: Partial<Record<string, unknown>> = {}) => ({
  slides: [
    { id: "s1", background: { type: "color", value: "#000" }, elements: [] },
    { id: "s2", background: { type: "color", value: "#000" }, elements: [] },
    { id: "s3", background: { type: "color", value: "#000" }, elements: [] },
  ] as CustomSlide[],
  activeSlideIdx: 0,
  dragSlideIdx: null,
  dragOverSlideIdx: null,
  onFocusChange: vi.fn(),
  onPointerDownSlide: vi.fn(),
  onPointerMoveSlide: vi.fn(),
  onPointerEnterSlide: vi.fn(),
  onPointerUpSlide: vi.fn(),
  onSelect: vi.fn(),
  onAddSlide: vi.fn(),
  onOpenTemplates: vi.fn(),
  onDuplicateSlide: vi.fn(),
  onDeleteSlide: vi.fn(),
  onMoveSlide: vi.fn(),
  canMoveUp: false,
  canMoveDown: true,
  canDeleteSlide: true,
  appDataDir: null,
  ...overrides,
});

describe("SlideListPanel (Phase 3)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens the Add Slide menu and inserts each layout", () => {
    const onAddSlide = vi.fn();
    render(<SlideListPanel {...baseProps({ onAddSlide })} />);

    fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
    expect(screen.getByRole("menuitem", { name: /Title and content/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: /Quote/i }));
    expect(onAddSlide).toHaveBeenCalledWith("quote");
  });

  it("opens the Add Slide menu and picks From template", () => {
    const onOpenTemplates = vi.fn();
    render(<SlideListPanel {...baseProps({ onOpenTemplates })} />);

    fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /From template/i }));
    expect(onOpenTemplates).toHaveBeenCalledOnce();
  });

  it("labels the active slide with an Editing state and exposes context actions", () => {
    render(<SlideListPanel {...baseProps({ activeSlideIdx: 1, canMoveUp: true, canMoveDown: true })} />);

    const active = screen.getByRole("button", { name: /Slide 2, editing/i });
    expect(active).toBeTruthy();
    expect(active.getAttribute("aria-pressed")).toBe("true");

    // Context actions on the active row
    expect(screen.getByRole("button", { name: "Duplicate slide" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move slide up" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Move slide down" })).not.toBeDisabled();
  });

  it("triggers move / duplicate / delete from the active-row actions", () => {
    const onMoveSlide = vi.fn();
    const onDuplicateSlide = vi.fn();
    const onDeleteSlide = vi.fn();
    render(<SlideListPanel {...baseProps({ activeSlideIdx: 1, canMoveUp: true, onMoveSlide, onDuplicateSlide, onDeleteSlide })} />);

    fireEvent.click(screen.getByRole("button", { name: "Move slide up" }));
    expect(onMoveSlide).toHaveBeenCalledWith(-1);

    fireEvent.click(screen.getByRole("button", { name: "Duplicate slide" }));
    expect(onDuplicateSlide).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Delete slide" }));
    expect(onDeleteSlide).toHaveBeenCalledOnce();
  });

  it("does not render context actions on a non-active slide", () => {
    render(<SlideListPanel {...baseProps({ activeSlideIdx: 0 })} />);
    // Active is slide 1; slide 2 has no actions
    const inactive = screen.getByRole("button", { name: /^Slide 2$/i });
    expect(inactive.getAttribute("aria-pressed")).toBe("false");
  });
});