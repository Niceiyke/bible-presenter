import { describe, expect, it } from "vitest";
import { compilePrayerGuide, type PrayerGuideImport } from "../prayerGuide";

const imported: PrayerGuideImport = {
  sourceName: "Weekly Prayers",
  warnings: [],
  days: [
    {
      title: "Monday, 2nd November 2026",
      prayers: [
        {
          number: 1,
          text: "Father, thank You for Your Word.",
          reference: "Ps 118:23",
          verses: [{ book: "Psalms", chapter: 118, verse: 23, version: "KJV", text: "This is the Lord's doing." }],
        },
      ],
    },
    {
      title: "Tuesday, 3rd November 2026",
      prayers: [
        {
          number: 1,
          text: "Father, establish every new convert.",
          reference: "1 Kings 19:7-8",
          verses: [
            { book: "1 Kings", chapter: 19, verse: 7, version: "KJV", text: "Arise and eat." },
            { book: "1 Kings", chapter: 19, verse: 8, version: "KJV", text: "He arose, and did eat." },
          ],
        },
      ],
    },
  ],
};

describe("prayer DOCX compiler", () => {
  it("creates separate prayer and Scripture slides for every intercession", () => {
    const decks = compilePrayerGuide(imported);
    expect(decks).toHaveLength(2);
    expect(decks[0].slides).toHaveLength(3);
    expect(decks[0].name).toContain("Monday");
    expect(decks[1].slides[1].elements).toHaveLength(1);
    expect(decks[1].slides[2].elements).toHaveLength(2);
    expect(JSON.stringify(decks[1].slides[1])).not.toContain("Arise and eat");
    expect(JSON.stringify(decks[1].slides[2])).not.toContain("establish every new convert");
  });

  it("uses canonical references from verified local verses", () => {
    const decks = compilePrayerGuide(imported);
    const reference = decks[1].slides[2].elements[0];
    expect(JSON.stringify(reference)).toContain("1 Kings 19:7-8");
  });
});
