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

  it("my-songs cards expose Preview / Use / Service plus Edit, Duplicate, Delete in More", () => {
    render(
      <SongCard
        song={makeSong()}
        source="mine"
        onPreview={noop}
        onUse={noop}
        onAddToSchedule={noop}
        onEdit={noop}
        onDuplicate={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Service" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /More actions/ }));
    expect(screen.getByRole("menuitem", { name: /Edit/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Duplicate/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Delete/ })).toBeTruthy();
  });

  it("hymn cards share the primary vocabulary but swap the secondary actions", () => {
    render(
      <SongCard
        song={makeSong()}
        source="library"
        onPreview={noop}
        onUse={noop}
        onAddToSchedule={noop}
        onAddToMySongs={noop}
      />,
    );
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Service" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /More actions/ }));
    expect(screen.getByRole("menuitem", { name: /Add to my songs/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Delete/ })).toBeNull();
  });

  it("shows mode and source badges for both sources", () => {
    const { rerender } = render(
      <SongCard song={makeSong()} source="mine" onPreview={noop} onUse={noop} onAddToSchedule={noop} />,
    );
    expect(screen.getByText("Lyrics overlay")).toBeTruthy();
    expect(screen.getByText("My song")).toBeTruthy();

    rerender(
      <SongCard
        song={makeSong({ style: "FullSlide" })}
        source="library"
        onPreview={noop}
        onUse={noop}
        onAddToSchedule={noop}
      />,
    );
    expect(screen.getByText("Full-screen")).toBeTruthy();
    expect(screen.getByText("Hymn")).toBeTruthy();
  });

  it("flags songs that need metadata and hides the badge once complete", () => {
    const { rerender } = render(
      <SongCard
        song={makeSong({ author: undefined, copyright: undefined, ccli: undefined })}
        source="mine"
        onPreview={noop}
        onUse={noop}
        onAddToSchedule={noop}
      />,
    );
    expect(screen.getByText("Needs metadata")).toBeTruthy();

    rerender(<SongCard song={makeSong()} source="mine" onPreview={noop} onUse={noop} onAddToSchedule={noop} />);
    expect(screen.queryByText("Needs metadata")).toBeNull();
  });

  it("More menu closes after selecting an item", () => {
    const onDelete = vi.fn();
    render(
      <SongCard
        song={makeSong()}
        source="mine"
        onPreview={noop}
        onUse={noop}
        onAddToSchedule={noop}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /More actions/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("Preview fires onPreview without any broadcast", () => {
    const onPreview = vi.fn();
    render(<SongCard song={makeSong()} source="mine" onPreview={onPreview} onUse={noop} onAddToSchedule={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(onPreview).toHaveBeenCalledTimes(1);
  });
});