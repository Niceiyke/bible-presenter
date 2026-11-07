import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditorToolbar } from "../EditorToolbar";
import { EditorMenu, FontPicker } from "../components";
import type { SlideElement } from "../../../../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
  convertFileSrc: vi.fn((p: string) => p),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({ label: "main" })),
}));

const baseProps = {
  activeEl: null as SlideElement | null,
  selectedCount: 0,
  multiSelectActive: false,
  hasGroup: false,
  insertVerseEnabled: false,
  canDeleteSlide: true,
  gridSize: 0,
  onSetGridSize: vi.fn(),
  onInsertVerse: vi.fn(),
  onAddText: vi.fn(),
  onAddShape: vi.fn(),
  onAddVideo: vi.fn(),
  onOpenImgPicker: vi.fn(),
  onOpenVideoPicker: vi.fn(),
  onOpenBiblePicker: vi.fn(),
  onGroup: vi.fn(),
  onUngroup: vi.fn(),
  onDuplicateSelected: vi.fn(),
  onDeleteSelected: vi.fn(),
  onUpdateElement: vi.fn(),
  onDuplicateSlide: vi.fn(),
  onDeleteSlide: vi.fn(),
  onApplySmartLayout: vi.fn(),
  canApplySmartLayout: true,
  onOpenBrandKit: vi.fn(),
  onToggleOutline: vi.fn(),
  outlineOpen: false,
  onTogglePreflight: vi.fn(),
  preflightOpen: false,
  onOpenRehearsal: vi.fn(),
};

describe("EditorToolbar (Phase 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the Shape menu on click instead of hover and inserts a shape", () => {
    const onAddShape = vi.fn();
    render(<EditorToolbar {...baseProps} onAddShape={onAddShape} />);

    fireEvent.click(screen.getByRole("button", { name: "Insert shape" }));
    const menuItem = screen.getByRole("menuitem", { name: /Circle/i });
    expect(menuItem).toBeTruthy();

    fireEvent.click(menuItem);
    expect(onAddShape).toHaveBeenCalledWith("circle");
  });

  it("opens the Snap-to-grid menu on click and selects a value", () => {
    const onSetGridSize = vi.fn();
    render(<EditorToolbar {...baseProps} onSetGridSize={onSetGridSize} gridSize={4} />);

    fireEvent.click(screen.getByRole("button", { name: "Snap to grid" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /8%/i }));

    expect(onSetGridSize).toHaveBeenCalledWith(8);
  });

  it("closes the Shape menu on Escape", () => {
    render(<EditorToolbar {...baseProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Insert shape" }));
    expect(screen.getAllByRole("menuitem").length).toBe(5);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("gives icon-only actions accessible names", () => {
    render(<EditorToolbar {...baseProps} />);
    expect(screen.getByRole("button", { name: "Delete slide" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Insert shape" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Snap to grid" })).toBeTruthy();
  });

  it("labels primary insert actions with visible text", () => {
    render(<EditorToolbar {...baseProps} />);
    expect(screen.getByRole("button", { name: /Text/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Image/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Video/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Bible/i })).toBeTruthy();
  });

  it("offers contextual AI actions for a selected text element", () => {
    const onAiAction = vi.fn();
    const activeEl = {
      id: "text-1", kind: "text", x: 10, y: 10, w: 80, h: 30, z_index: 1,
      content: { type: "doc", content: [{ type: "paragraph" }] },
      font_size: 40, font_family: "Arial", color: "#fff",
      align: "center", v_align: "middle",
    } as SlideElement;
    render(<EditorToolbar {...baseProps} activeEl={activeEl} selectedCount={1} onAiAction={onAiAction} />);
    fireEvent.click(screen.getByRole("button", { name: "AI slide assistant" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Shorten for projection" }));
    expect(onAiAction).toHaveBeenCalledWith("shorten");
  });

});

describe("EditorMenu (Phase 2)", () => {
  it("renders in a body portal so scrolling toolbars cannot clip it", () => {
    render(<EditorMenu label="Pick" trigger={<span>Pick</span>} items={[{ value: "a", label: "A" }]} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pick" }));
    expect(screen.getByRole("menu").parentElement).toBe(document.body);
  });

  it("closes on outside click", () => {
    const onSelect = vi.fn();
    render(
      <div>
        <EditorMenu label="Pick" trigger={<span>Pick</span>} items={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} onSelect={onSelect} />
        <button>outside</button>
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pick" }));
    expect(screen.getByRole("menuitem", { name: "A" })).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("is keyboard reachable: Space/Enter toggles it", () => {
    const onSelect = vi.fn();
    render(<EditorMenu label="Pick" trigger={<span>Pick</span>} items={[{ value: "a", label: "A" }]} onSelect={onSelect} />);

    const trigger = screen.getByRole("button", { name: "Pick" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.getByRole("menuitem", { name: "A" })).toBeTruthy();
  });
});

describe("FontPicker", () => {
  it("opens a searchable portal and selects a font family", () => {
    const onSelect = vi.fn();
    render(<FontPicker fonts={["Arial", "Georgia"]} value="Arial" fullWidth onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Font family" }));
    expect(screen.getByPlaceholderText("Search fonts…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Georgia" }));

    expect(onSelect).toHaveBeenCalledWith("Georgia");
  });
});
