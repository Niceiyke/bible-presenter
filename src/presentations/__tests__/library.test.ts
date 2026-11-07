import { beforeEach, describe, expect, it } from "vitest";
import type { CustomPresentation, PresentationSummary } from "../../types";
import {
  createBlankPresentation,
  duplicatePresentation,
  filterAndSortPresentations,
  formatPresentationUpdatedAt,
  loadPresentationLibraryPreferences,
  savePresentationLibraryPreferences,
} from "../library";

const summaries: PresentationSummary[] = [
  { id: "older", name: "Alpha", slide_count: 12, version: 2, updated_at: 100 },
  { id: "newer", name: "Sunday", slide_count: 5, version: 2, updated_at: 300 },
  { id: "favorite", name: "Youth", slide_count: 8, version: 2, updated_at: 200 },
];

describe("presentation library", () => {
  beforeEach(() => localStorage.clear());

  it("filters, sorts, and always promotes favorites", () => {
    expect(filterAndSortPresentations(summaries, "", "updated", ["favorite"]).map((item) => item.id))
      .toEqual(["favorite", "newer", "older"]);
    expect(filterAndSortPresentations(summaries, "y", "name", []).map((item) => item.name))
      .toEqual(["Sunday", "Youth"]);
    expect(filterAndSortPresentations(summaries, "", "slides", []).map((item) => item.id))
      .toEqual(["older", "favorite", "newer"]);
  });

  it("persists validated workspace preferences", () => {
    savePresentationLibraryPreferences({ sort: "name", view: "list", favorites: ["one"] });
    expect(loadPresentationLibraryPreferences()).toEqual({ sort: "name", view: "list", favorites: ["one"] });
    localStorage.setItem("pref_presentationLibraryV1", JSON.stringify({ sort: "invalid", view: "invalid", favorites: [1, "two"] }));
    expect(loadPresentationLibraryPreferences()).toEqual({ sort: "updated", view: "grid", favorites: ["two"] });
  });

  it("creates versioned blank decks with a complete theme", () => {
    const deck = createBlankPresentation("Vision Night");
    expect(deck).toMatchObject({ name: "Vision Night", version: 2 });
    expect(deck.slides).toHaveLength(1);
    expect(deck.theme?.accentColor).toBe("#f4b740");
  });

  it("duplicates every mutable identity while preserving media content", () => {
    const source: CustomPresentation = {
      id: "deck",
      name: "Original",
      version: 2,
      theme: {
        id: "theme", name: "Theme", defaultFontFamily: "Arial", defaultFontSize: 30,
        titleStyle: {}, bodyStyle: {}, textColor: "#fff", accentColor: "#f00",
        background: { type: "color", value: "#000" },
      },
      masters: [{ id: "master", name: "Main", background: { type: "color", value: "#000" }, elements: [] }],
      slides: [{
        id: "slide", masterRef: "master", background: { type: "color", value: "#000" },
        elements: [
          { id: "image", kind: "image", content: "media/photo.jpg", x: 0, y: 0, w: 50, h: 50, z_index: 1, groupId: "group" },
          { id: "shape", kind: "shape", x: 50, y: 0, w: 50, h: 50, z_index: 2, groupId: "group" },
        ],
      }],
    };
    const copy = duplicatePresentation(source);
    expect(copy.id).not.toBe(source.id);
    expect(copy.theme?.id).not.toBe(source.theme?.id);
    expect(copy.slides[0].id).not.toBe(source.slides[0].id);
    expect(copy.slides[0].masterRef).toBe(copy.masters?.[0].id);
    expect(copy.slides[0].elements[0].id).not.toBe(source.slides[0].elements[0].id);
    expect(copy.slides[0].elements[0].groupId).toBe(copy.slides[0].elements[1].groupId);
    expect(copy.slides[0].elements[0].kind === "image" && copy.slides[0].elements[0].content).toBe("media/photo.jpg");
  });

  it("formats recent update times for scanning", () => {
    expect(formatPresentationUpdatedAt(9_940_000, 10_000_000)).toBe("Updated 1m ago");
    expect(formatPresentationUpdatedAt(6_400_000, 10_000_000)).toBe("Updated 1h ago");
  });
});
