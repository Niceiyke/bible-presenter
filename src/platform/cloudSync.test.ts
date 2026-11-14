import { describe, expect, it, vi } from "vitest";
import type { Verse } from "../types";
import {
  buildCloudPlanEntries,
  type CloudServicePlan,
  type CloudSyncResult,
} from "./cloudSync";

const verse: Verse = {
  book: "John",
  chapter: 3,
  verse: 16,
  text: "For God so loved the world.",
  version: "KJV",
};

function planWith(items: CloudServicePlan["items"]): CloudServicePlan {
  return {
    id: "plan-1",
    organizationId: "org-1",
    title: "Sunday Morning",
    serviceAt: 1_790_000_000,
    status: "published",
    revision: 2,
    items,
    createdAt: 1,
    updatedAt: 2,
  };
}

function syncWith(overrides: Partial<CloudSyncResult> = {}): CloudSyncResult {
  return {
    organization: { id: "org-1", name: "Wordlyte Church" },
    device: { machineId: "a".repeat(64) },
    expiresAt: 1_790_000_000,
    servicePlans: [],
    planCursor: 10,
    presentations: [],
    presentationCursor: 10,
    presentationDetails: {},
    ...overrides,
  };
}

describe("cloud plan import", () => {
  it("maps a Scripture item through the local resolver", async () => {
    const resolve = vi.fn(async () => [verse]);
    const result = await buildCloudPlanEntries(
      planWith([{
        id: "item-1",
        type: "scripture",
        title: "John 3:16",
        reference: "John 3:16",
        position: 0,
        payload: { version: "KJV" },
      }]),
      syncWith(),
      { resolveScripture: resolve },
    );

    expect(resolve).toHaveBeenCalledWith("John 3:16", "KJV");
    expect(result.warnings).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe("item-1");
    expect(result.entries[0]?.item.type).toBe("Verse");
  });

  it("maps a presentation reference to a CustomSlide", async () => {
    const result = await buildCloudPlanEntries(
      planWith([{
        id: "item-2",
        type: "presentation",
        title: "Opening slide",
        sourceId: "pres-1",
        position: 0,
        payload: { slideIndex: 0 },
      }]),
      syncWith({
        presentationDetails: {
          "pres-1": {
            id: "pres-1",
            organizationId: "org-1",
            name: "Welcome",
            slideCount: 1,
            slides: [{
              id: "slide-1",
              background: { type: "color", value: "#0b1117" },
              elements: [],
              notes: "Welcome the congregation",
            }],
            revision: 1,
            createdAt: 1,
            updatedAt: 2,
          },
        },
      }),
    );

    expect(result.warnings).toEqual([]);
    expect(result.entries[0]?.item.type).toBe("CustomSlide");
    if (result.entries[0]?.item.type === "CustomSlide") {
      expect(result.entries[0].item.data.presentation_id).toBe("pres-1");
      expect(result.entries[0].item.data.slide_index).toBe(0);
      expect(result.entries[0].item.data.notes).toBe("Welcome the congregation");
    }
  });

  it("maps notes to a text slide and warns for unsupported song items", async () => {
    const result = await buildCloudPlanEntries(
      planWith([
        {
          id: "item-3",
          type: "note",
          title: "Announcements",
          position: 0,
          notes: "Men's breakfast on Saturday.",
        },
        {
          id: "item-4",
          type: "song",
          title: "Amazing Grace",
          position: 1,
          sourceId: "song-1",
        },
      ]),
      syncWith(),
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.item.type).toBe("CustomSlide");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("song");
  });

  it("warns when a presentation is missing", async () => {
    const result = await buildCloudPlanEntries(
      planWith([{
        id: "item-5",
        type: "presentation",
        title: "Missing deck",
        sourceId: "pres-missing",
        position: 0,
        payload: { slideIndex: 0 },
      }]),
      syncWith(),
    );
    expect(result.entries).toHaveLength(0);
    expect(result.warnings[0]).toContain("unavailable");
  });
});
