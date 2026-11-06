import React, { StrictMode } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TextElement } from "../../../../types";
import { InlineTextEditor } from "../InlineTextEditor";

vi.mock("../../../../hooks/useFonts", () => ({
  useFonts: () => ({ availableFonts: ["Arial", "Georgia"] }),
}));

const element: TextElement = {
  id: "text-1",
  kind: "text",
  x: 10, y: 10, w: 80, h: 60, z_index: 1,
  content: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Editable prayer" }] }],
  },
  font_size: 40,
  font_family: "Arial",
  color: "#ffffff",
  align: "center",
  v_align: "middle",
};

describe("InlineTextEditor", () => {
  afterEach(() => vi.useRealTimers());

  it("does not commit and close during Strict Mode's simulated cleanup", () => {
    vi.useFakeTimers();
    Range.prototype.getClientRects = vi.fn(() => [] as unknown as DOMRectList);
    Range.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0,
      width: 0, height: 0, toJSON: () => ({}),
    }));
    const onCommit = vi.fn();
    const view = render(
      <StrictMode>
        <div style={{ position: "relative", width: 800, height: 400 }}>
          <InlineTextEditor el={element} canvasScale={1} onCommit={onCommit} />
        </div>
      </StrictMode>,
    );

    expect(onCommit).not.toHaveBeenCalled();
    act(() => vi.runOnlyPendingTimers());
    expect(onCommit).not.toHaveBeenCalled();

    view.unmount();
    expect(onCommit).toHaveBeenCalledOnce();
  });
});
