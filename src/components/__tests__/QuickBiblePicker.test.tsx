import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuickBiblePicker } from "../QuickBiblePicker";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const verse = {
  book: "John",
  chapter: 3,
  verse: 16,
  version: "KJV",
  text: "For God so loved the world.",
};

describe("QuickBiblePicker", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("clears all input and retains focus after a double-Enter go-live", async () => {
    mockInvoke.mockResolvedValue(verse);
    const onStage = vi.fn().mockResolvedValue(true);
    const onLive = vi.fn().mockResolvedValue(true);

    render(
      <QuickBiblePicker
        books={["Genesis", "John"]}
        version="KJV"
        onStage={onStage}
        onLive={onLive}
      />,
    );

    const bookInput = screen.getByPlaceholderText("Type a book name...");
    fireEvent.change(bookInput, { target: { value: "John" } });
    fireEvent.keyDown(bookInput, { key: "Enter" });

    const cvInput = await screen.findByPlaceholderText(/3\s*16/);
    await waitFor(() => expect(document.activeElement).toBe(cvInput));

    fireEvent.change(cvInput, { target: { value: "3 16" } });
    fireEvent.keyDown(cvInput, { key: "Enter" });
    await waitFor(() => expect(onStage).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(cvInput, { key: "Enter" });
    await waitFor(() => expect(onLive).toHaveBeenCalledTimes(1));

    // The picker resets to its initial book field, but the field keeps focus
    // so the operator can type the next reference without clicking again.
    const resetBookInput = screen.getByPlaceholderText("Type a book name...");
    await waitFor(() => expect(document.activeElement).toBe(resetBookInput));
    expect((resetBookInput as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("John")).toBeNull();
  });
});
