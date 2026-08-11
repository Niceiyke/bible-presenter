import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LayersPanel, generatedLayerName } from "../LayersPanel";
import type { SlideElement } from "../../../../types";

const el = (id: string, kind: SlideElement["kind"], z: number, extra: Partial<SlideElement> = {}): SlideElement =>
  ({ id, kind, x: 0, y: 0, w: 10, h: 10, z_index: z, ...(extra as object) }) as SlideElement;

const baseProps = (elements: SlideElement[]) => ({
  elements,
  activeElementIds: [] as string[],
  onSelectElement: vi.fn(),
  onToggleLock: vi.fn(),
  onToggleHide: vi.fn(),
  onRenameElement: vi.fn(),
  onZOrderElement: vi.fn(),
});

describe("LayersPanel (Phase 4)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists elements top-most first", () => {
    const els = [el("a", "text", 1), el("b", "image", 5), el("c", "shape", 3)];
    render(<LayersPanel {...baseProps(els)} />);
    const rows = screen.getAllByRole("button");
    // First row is "b" (z=5, highest). Layer rows have aria-label starting "Layer".
    expect(rows[0].getAttribute("aria-label")).toContain("Image");
  });

  it("generated names are 'Text 1' / 'Image 2'", () => {
    const e1 = el("a", "text", 1);
    const e2 = el("b", "image", 2);
    const e3 = el("c", "image", 3);
    expect(generatedLayerName(e1, [e1, e2, e3])).toBe("Text 1");
    expect(generatedLayerName(e2, [e1, e2, e3])).toBe("Image 1");
    expect(generatedLayerName(e3, [e1, e2, e3])).toBe("Image 2");
  });

  it("clicking a row selects it (single source of truth)", () => {
    const els = [el("a", "text", 1), el("b", "image", 2)];
    const onSelect = vi.fn();
    render(<LayersPanel {...baseProps(els)} onSelectElement={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Layer Text 1/i }));
    expect(onSelect).toHaveBeenCalledWith("a", false);
  });

  it("ctrl-click adds to selection", () => {
    const els = [el("a", "text", 1), el("b", "image", 2)];
    const onSelect = vi.fn();
    render(<LayersPanel {...baseProps(els)} onSelectElement={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Layer Image 1/i }), { ctrlKey: true });
    expect(onSelect).toHaveBeenCalledWith("b", true);
  });

  it("toggles lock and hide from row buttons", () => {
    const els = [el("a", "text", 1)];
    const onToggleLock = vi.fn();
    const onToggleHide = vi.fn();
    render(<LayersPanel {...baseProps(els)} onToggleLock={onToggleLock} onToggleHide={onToggleHide} />);
    fireEvent.click(screen.getByRole("button", { name: /Lock Text 1/i }));
    expect(onToggleLock).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: /Hide Text 1/i }));
    expect(onToggleHide).toHaveBeenCalledWith("a");
  });

  it("brings forward / sends backward via z-order buttons", () => {
    const els = [el("a", "text", 1), el("b", "image", 2)];
    const onZ = vi.fn();
    render(<LayersPanel {...baseProps(els)} onZOrderElement={onZ} />);
    // "a" is the bottom element (z=1); it can be brought forward (up).
    fireEvent.click(screen.getByRole("button", { name: /Move Text 1 up/i }));
    expect(onZ).toHaveBeenCalledWith("a", "forward");
    // "b" is the top element (z=2); it can be sent backward (down).
    fireEvent.click(screen.getByRole("button", { name: /Move Image 1 down/i }));
    expect(onZ).toHaveBeenCalledWith("b", "backward");
  });

  it("renames an element via the inline edit", () => {
    const els = [el("a", "text", 1)];
    const onRename = vi.fn();
    render(<LayersPanel {...baseProps(els)} onRenameElement={onRename} />);
    fireEvent.click(screen.getByRole("button", { name: /Rename Text 1/i }));
    const input = screen.getByRole("textbox", { name: /Rename Text 1/i });
    fireEvent.change(input, { target: { value: "Verse" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("a", "Verse");
  });

  it("hidden element is flagged in the aria-label and rendered", () => {
    const els = [el("a", "text", 1, { hidden: true })];
    render(<LayersPanel {...baseProps(els)} />);
    expect(screen.getByRole("button", { name: /Layer Text 1, hidden/i })).toBeTruthy();
  });
});