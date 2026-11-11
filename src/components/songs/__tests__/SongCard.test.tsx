import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SongCard } from "../SongCard";
import type { Song } from "../../../types";

// SongLyricThumbnail pulls in the projection renderer; the card test only
// asserts action vocabulary / badges, so stub it out.
vi.mock("../SongLyricThumbnail", () => ({
  SongLyricThumbnail: () => null,
}));

const makeSong = (over: Partial<Song> = {}): Song => ({
  id: "s1",
  title: "Amazing Grace",
  author: "John Newton",
  copyright: "Public domain",
  ccli: "12345",
  key: "G",
  sections: [{ label: "Verse 1", lines: ["Amazing grace", "How sweet the sound"] }],
  arrangement: [],
  style: "LowerThird",
  ...over,
});

const noop = () => {};

describe("SongCard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps one primary action and moves management into More", () => {
    render(
      <SongCard
        song={makeSong()}
        source="mine"
        onOpen={noop}
        onAddToPlan={noop}
        onEdit={noop}
        onDuplicate={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Add to plan" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /More actions/ }));
    expect(screen.getByRole("menuitem", { name: /Edit/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Duplicate/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Delete/ })).toBeTruthy();
  });

  it("hymn cards swap management for Add to my songs", () => {
    render(
      <SongCard
        song={makeSong()}
        source="library"
        onOpen={noop}
        onAddToPlan={noop}
        onAddToMySongs={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Add to plan" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /More actions/ }));
    expect(screen.getByRole("menuitem", { name: /Add to my songs/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Delete/ })).toBeNull();
  });

  it("shows mode, source and page-count information", () => {
    render(
      <SongCard song={makeSong()} source="mine" onOpen={noop} onAddToPlan={noop} />,
    );
    expect(screen.getByText("Lyrics overlay")).toBeTruthy();
    expect(screen.getByText("My song")).toBeTruthy();
    expect(screen.getByText(/2 pages? · 1 section · 2 lyric lines/)).toBeTruthy();
  });

  it("opens the runner from the title and the thumbnail", () => {
    const onOpen = vi.fn();
    render(<SongCard song={makeSong()} source="mine" onOpen={onOpen} onAddToPlan={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Amazing Grace" }));
    const titleButton = screen.getByText("Amazing Grace").closest("button");
    expect(titleButton).toBeTruthy();
    fireEvent.click(titleButton!);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("flags songs that need metadata and hides the badge once complete", () => {
    const { rerender } = render(
      <SongCard
        song={makeSong({ author: undefined, copyright: undefined, ccli: undefined })}
        source="mine"
        onOpen={noop}
        onAddToPlan={noop}
      />,
    );
    expect(screen.getByText("Needs metadata")).toBeTruthy();

    rerender(<SongCard song={makeSong()} source="mine" onOpen={noop} onAddToPlan={noop} />);
    expect(screen.queryByText("Needs metadata")).toBeNull();
  });

  it("More menu closes after selecting an item", () => {
    const onDelete = vi.fn();
    render(
      <SongCard
        song={makeSong()}
        source="mine"
        onOpen={noop}
        onAddToPlan={noop}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /More actions/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("Add to plan adds the whole song without opening the runner", () => {
    const onAddToPlan = vi.fn();
    const onOpen = vi.fn();
    render(<SongCard song={makeSong()} source="mine" onOpen={onOpen} onAddToPlan={onAddToPlan} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to plan" }));
    expect(onAddToPlan).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
