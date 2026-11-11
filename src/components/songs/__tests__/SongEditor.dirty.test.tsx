import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SongEditorModal } from "../SongEditorModal";
import type { Song } from "../../../types";

vi.mock("../SongPreviewBox", () => ({
  SongPreviewBox: () => null,
}));
vi.mock("../SongOverlayPreview", () => ({
  SongOverlayPreview: () => null,
}));

const song: Song = {
  id: "s1",
  title: "Amazing Grace",
  author: "John Newton",
  sections: [{ id: "sec-1", label: "Verse 1", lines: ["Amazing grace"] }],
  arrangement: [],
  style: "LowerThird",
};

describe("SongEditorModal dirty state", () => {
  it("opens an existing song without claiming there are unsaved changes", () => {
    render(<SongEditorModal song={song} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.getByRole("button", { name: "Save song" })).toBeTruthy();
  });

  it("still reports unsaved changes after the user edits the draft", () => {
    render(<SongEditorModal song={song} onClose={vi.fn()} onSave={vi.fn()} />);
    const title = screen.getByDisplayValue("Amazing Grace");
    fireEvent.change(title, { target: { value: "Amazing Grace (new)" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });
});
