import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SongRunner } from "../SongRunner";
import { useAppStore } from "../../../store";
import type { DisplayItem, Song } from "../../../types";

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
  key: "G",
  style: "LowerThird",
  sections: [
    { id: "v1", label: "Verse 1", lines: ["v1 a", "v1 b", "v1 c", "v1 d"] },
    { id: "c1", label: "Chorus", lines: ["c a", "c b"] },
  ],
  arrangement: [],
};

const noop = () => {};

describe("SongRunner", () => {
  beforeEach(() => {
    useAppStore.setState({ ltLinesPerDisplay: 2, ltVisible: false, ltSongId: null });
  });

  it("previews page by page and stages the selected page", () => {
    const onStage = vi.fn();
    render(
      <SongRunner
        song={song}
        source="mine"
        onClose={noop}
        onStage={onStage}
        onLive={noop}
        onAddToPlan={noop}
      />,
    );

    expect(screen.getByText(/page 1 of 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByText(/page 2 of 3/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stage page" }));
    expect(onStage).toHaveBeenCalledTimes(1);
    const staged = onStage.mock.calls[0][0] as Extract<DisplayItem, { type: "Song" }>;
    expect(staged.data.slide_index).toBe(1);
    expect(staged.data.lines).toEqual(["v1 c", "v1 d"]);
    expect(staged.data.line_start).toBe(2);
  });

  it("adds the whole song in the mode currently shown", () => {
    const onAddToPlan = vi.fn();
    render(
      <SongRunner
        song={song}
        source="mine"
        onClose={noop}
        onStage={noop}
        onLive={noop}
        onAddToPlan={onAddToPlan}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Full-screen lyrics" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to plan" }));
    expect(onAddToPlan).toHaveBeenCalledWith("FullSlide");
  });

  it("marks the current live page from the same song and mode", () => {
    const live: DisplayItem = {
      type: "Song",
      data: {
        song_id: song.id,
        title: song.title,
        section_label: "Chorus",
        section_id: "c1",
        lines: ["c a", "c b"],
        slide_index: 2,
        total_slides: 3,
        line_start: 4,
        style: "LowerThird",
      },
    };
    useAppStore.setState({ liveItem: live });
    render(
      <SongRunner
        song={song}
        source="mine"
        onClose={noop}
        onStage={noop}
        onLive={noop}
        onAddToPlan={noop}
      />,
    );
    expect(screen.getAllByText("Live").length).toBeGreaterThan(0);
  });
});
