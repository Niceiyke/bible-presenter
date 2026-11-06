import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import type { SlideElement } from "../../../../types";
import { useElementDrag } from "../useElementDragResize";

const element: SlideElement = {
  id: "text-1",
  kind: "text",
  x: 10,
  y: 20,
  w: 50,
  h: 30,
  z_index: 1,
  content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Prayer" }] }] },
  font_size: 40,
  font_family: "Arial",
  color: "#fff",
  align: "center",
  v_align: "middle",
};

function setup() {
  const onMoved = vi.fn();
  const onCommitted = vi.fn();
  const canvasRef = {
    current: {
      getBoundingClientRect: () => ({
        left: 0, top: 0, right: 1000, bottom: 562.5,
        width: 1000, height: 562.5, x: 0, y: 0,
        toJSON: () => ({}),
      }),
    },
  } as unknown as RefObject<HTMLDivElement>;
  const hook = renderHook(() => useElementDrag({
    canvasRef,
    activeElementIds: [element.id],
    elements: [element],
    onMoved,
    onCommitted,
  }));
  return { ...hook, onMoved, onCommitted };
}

describe("useElementDrag", () => {
  it("preserves a normal pointer sequence for click and double-click editing", () => {
    const { result, onMoved, onCommitted } = setup();
    const preventDefault = vi.fn();
    act(() => {
      result.current(element.id, {
        button: 0,
        clientX: 100,
        clientY: 100,
        altKey: false,
        stopPropagation: vi.fn(),
        preventDefault,
      } as unknown as React.PointerEvent);
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 100, clientY: 100 }));
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onMoved).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it("still moves and commits after crossing the drag threshold", () => {
    const { result, onMoved, onCommitted } = setup();
    act(() => {
      result.current(element.id, {
        button: 0,
        clientX: 100,
        clientY: 100,
        altKey: false,
        stopPropagation: vi.fn(),
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 120, clientY: 110, cancelable: true }));
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 120, clientY: 110 }));
    });
    expect(onMoved).toHaveBeenCalled();
    expect(onCommitted).toHaveBeenCalledWith(element.id, expect.objectContaining({ x: 12 }));
  });
});
