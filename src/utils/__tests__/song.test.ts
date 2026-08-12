import { describe, expect, it } from "vitest";
import {
  normalizeSong,
  getSongSequence,
  flattenSongLyrics,
  buildSongDisplayItem,
  getNextSongIndex,
  getPreviousSongIndex,
  getSongCounts,
  songSearchText,
  searchSongs,
  songNeedsMetadata,
  splitLyricLines,
  buildArrangementStepsFromSections,
  songValidate,
  SONG_SCHEMA_VERSION,
} from "../song";
import type { Song, DisplayItem } from "../../types";

const mkSong = (over: Partial<Song> = {}): Song => ({
  id: "s1",
  title: "Test",
  sections: [
    { label: "Verse 1", lines: ["Line A", "Line B"] },
    { label: "Chorus", lines: ["Chorus line"] },
    { label: "Verse 2", lines: ["Line C"] },
  ],
  ...over,
});

describe("normalizeSong", () => {
  it("assigns ids to sections without one", () => {
    const song = mkSong();
    expect(song.sections[0].id).toBeUndefined();
    const n = normalizeSong(song);
    n.sections.forEach(s => expect(s.id).toBeTruthy());
  });

  it("preserves existing section ids", () => {
    const song = mkSong({
      sections: [{ id: "keep", label: "V", lines: ["x"] }],
    });
    expect(normalizeSong(song).sections[0].id).toBe("keep");
  });

  it("stamps schema_version", () => {
    expect(normalizeSong(mkSong()).schema_version).toBe(SONG_SCHEMA_VERSION);
  });

  it("generates natural-order arrangement_steps when none exist", () => {
    const n = normalizeSong(mkSong());
    expect(n.arrangement_steps).toHaveLength(3);
    expect(n.arrangement_steps![0].section_id).toBe(n.sections[0].id);
    expect(n.arrangement_steps![2].section_id).toBe(n.sections[2].id);
  });

  it("migrates legacy label arrangement to id-based steps", () => {
    const song = mkSong({ arrangement: ["Chorus", "Verse 1", "Verse 2"] });
    const n = normalizeSong(song);
    expect(n.arrangement_steps).toHaveLength(3);
    expect(n.arrangement_steps![0].section_id).toBe(n.sections[1].id);
    expect(n.arrangement_steps![1].section_id).toBe(n.sections[0].id);
  });

  it("handles duplicate labels in arrangement by occurrence order", () => {
    const song = mkSong({
      sections: [
        { label: "Chorus", lines: ["c1"] },
        { label: "Verse", lines: ["v1"] },
        { label: "Chorus", lines: ["c2"] },
      ],
      arrangement: ["Chorus", "Chorus", "Verse"],
    });
    const n = normalizeSong(song);
    expect(n.arrangement_steps).toHaveLength(3);
    expect(n.arrangement_steps![0].section_id).toBe(n.sections[0].id);
    expect(n.arrangement_steps![1].section_id).toBe(n.sections[2].id);
    expect(n.arrangement_steps![2].section_id).toBe(n.sections[1].id);
  });

  it("drops stale arrangement_steps referencing missing sections", () => {
    const song = mkSong({
      arrangement_steps: [
        { section_id: "gone" },
        ...[], // will be filled by normalize
      ],
    });
    song.arrangement_steps = [{ section_id: "gone" }, { section_id: "" as any }];
    const n = normalizeSong(song);
    expect(n.arrangement_steps!.length).toBe(3); // falls back to natural order
  });

  it("does not lose lyric lines", () => {
    const song = mkSong();
    const n = normalizeSong(song);
    expect(n.sections.flatMap(s => s.lines)).toEqual(["Line A", "Line B", "Chorus line", "Line C"]);
  });

  it("handles song with no sections gracefully", () => {
    const n = normalizeSong({ id: "x", title: "y", sections: [] as any });
    expect(n.sections).toEqual([]);
    expect(n.arrangement_steps).toEqual([]);
  });
});

describe("getSongSequence", () => {
  it("uses arrangement_steps when present", () => {
    const song = normalizeSong(mkSong({ arrangement: ["Verse 2", "Chorus", "Verse 1"] }));
    const seq = getSongSequence(song);
    expect(seq.map(s => s.label)).toEqual(["Verse 2", "Chorus", "Verse 1"]);
  });

  it("falls back to natural order when no arrangement", () => {
    const song = normalizeSong(mkSong());
    const seq = getSongSequence(song);
    expect(seq.map(s => s.label)).toEqual(["Verse 1", "Chorus", "Verse 2"]);
  });

  it("repeated chorus resolves to same source section", () => {
    const song = normalizeSong(mkSong({ arrangement: ["Chorus", "Verse 1", "Chorus"] }));
    const seq = getSongSequence(song);
    expect(seq[0].id).toBe(seq[2].id);
    expect(seq[0].label).toBe("Chorus");
  });
});

describe("flattenSongLyrics", () => {
  it("flattens with sequence + line indices", () => {
    const songsong = normalizeSong(mkSong({ arrangement: ["Chorus"] }));
    const lines = flattenSongLyrics(songsong);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      text: "Chorus line",
      sectionId: songsong.sections[1].id!,
      sectionLabel: "Chorus",
      sequenceIndex: 0,
      lineIndex: 0,
    });
  });

  it("full natural-order flatten", () => {
    const song = normalizeSong(mkSong());
    const lines = flattenSongLyrics(song);
    expect(lines.map(l => l.text)).toEqual(["Line A", "Line B", "Chorus line", "Line C"]);
  });
});

describe("buildSongDisplayItem", () => {
  it("builds the correct slide_index and total_slides", () => {
    const song = normalizeSong(mkSong({ arrangement: ["Chorus", "Verse 1"] }));
    const item = buildSongDisplayItem(song, 1) as Extract<DisplayItem, { type: "Song" }>;
    expect(item.type).toBe("Song");
    expect(item.data.slide_index).toBe(1);
    expect(item.data.total_slides).toBe(2);
    expect(item.data.section_label).toBe("Verse 1");
    expect(item.data.song_id).toBe("s1");
  });

  it("clamps out-of-range index to first slide", () => {
    const song = normalizeSong(mkSong());
    const item = buildSongDisplayItem(song, 99) as Extract<DisplayItem, { type: "Song" }>;
    expect(item.data.slide_index).toBe(99);
    expect(item.data.section_label).toBe("Verse 1");
  });

  it("carries style + font overrides", () => {
    const song = normalizeSong(mkSong({ style: "LowerThird", font: "Georgia", font_size: 40 }));
    const item = buildSongDisplayItem(song, 0) as Extract<DisplayItem, { type: "Song" }>;
    expect(item.data.style).toBe("LowerThird");
    expect(item.data.font).toBe("Georgia");
    expect(item.data.font_size).toBe(40);
  });
});

describe("next/previous navigation", () => {
  const song = normalizeSong(mkSong({ arrangement: ["Verse 1", "Chorus", "Verse 2"] }));

  it("next advances and returns null at end", () => {
    expect(getNextSongIndex(song, 0)).toBe(1);
    expect(getNextSongIndex(song, 2)).toBe(null);
  });

  it("previous retreats and returns null at start", () => {
    expect(getPreviousSongIndex(song, 1)).toBe(0);
    expect(getPreviousSongIndex(song, 0)).toBe(null);
  });

  it("empty song returns null", () => {
    const empty = normalizeSong({ id: "e", title: "x", sections: [] });
    expect(getNextSongIndex(empty, 0)).toBe(null);
    expect(getPreviousSongIndex(empty, 5)).toBe(null);
  });
});

describe("getSongCounts", () => {
  it("counts sections, sequence, and lines", () => {
    const song = normalizeSong(mkSong({ arrangement: ["Chorus", "Chorus"] }));
    const c = getSongCounts(song);
    expect(c.sections).toBe(3);
    expect(c.sequence).toBe(2);
    expect(c.lines).toBe(4);
  });
});

describe("songSearchText", () => {
  it("includes title, author, key, CCLI, labels, and lyrics", () => {
    const song = mkSong({
      author: "John Newton",
      key: "G",
      ccli: "12345",
      sections: [
        { label: "Verse 1", lines: ["Amazing grace"] },
        { label: "Chorus", lines: ["How sweet the sound"] },
      ],
    });
    const text = songSearchText(song);
    expect(text).toContain("amazing grace");
    expect(text).toContain("john newton");
    expect(text).toContain("g");
    expect(text).toContain("12345");
    expect(text).toContain("verse 1");
    expect(text).toContain("how sweet the sound");
  });
});

describe("searchSongs", () => {
  const songs = [
    mkSong({ id: "a", title: "Amazing Grace", author: "John Newton", key: "F#", ccli: "111" }),
    mkSong({
      id: "b",
      title: "How Great Thou Art",
      sections: [{ label: "Verse 1", lines: ["O Lord my God"] }],
    }),
  ];

  it("returns the collection unchanged for an empty query", () => {
    expect(searchSongs(songs, "")).toBe(songs);
    expect(searchSongs(songs, "   ")).toBe(songs);
  });

  it("finds by title", () => {
    expect(searchSongs(songs, "amazing")).toHaveLength(1);
  });

  it("finds by lyric text", () => {
    expect(searchSongs(songs, "O Lord my God").map(s => s.id)).toEqual(["b"]);
  });

  it("finds by author and key", () => {
    expect(searchSongs(songs, "newton").map(s => s.id)).toEqual(["a"]);
    expect(searchSongs(songs, "f#").map(s => s.id)).toEqual(["a"]);
  });

  it("finds by CCLI number", () => {
    expect(searchSongs(songs, "111").map(s => s.id)).toEqual(["a"]);
  });

  it("is case-insensitive", () => {
    expect(searchSongs(songs, "AMAZING GRACE").map(s => s.id)).toEqual(["a"]);
  });
});

describe("songNeedsMetadata", () => {
  it("flags missing author, copyright, or CCLI", () => {
    expect(songNeedsMetadata(mkSong())).toBe(true);
    expect(songNeedsMetadata(mkSong({ author: "A", copyright: "C", ccli: "1" }))).toBe(false);
    expect(songNeedsMetadata(mkSong({ author: "A", copyright: "C" }))).toBe(true);
  });

  it("ignores a missing key", () => {
    expect(songNeedsMetadata(mkSong({ author: "A", copyright: "C", ccli: "1", key: undefined }))).toBe(false);
  });
});

describe("splitLyricLines", () => {
  it("preserves line order", () => {
    expect(splitLyricLines("first\nsecond\nthird")).toEqual(["first", "second", "third"]);
  });

  it("preserves intentional internal blank lines", () => {
    expect(splitLyricLines("a\n\nb")).toEqual(["a", "", "b"]);
  });

  it("trims trailing blank lines", () => {
    expect(splitLyricLines("a\nb\n  \n\n")).toEqual(["a", "b"]);
  });

  it("normalizes CRLF and empty input", () => {
    expect(splitLyricLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLyricLines("")).toEqual([]);
  });
});

describe("buildArrangementStepsFromSections", () => {
  it("references sections by id in natural order", () => {
    const a = normalizeSong(mkSong());
    const steps = buildArrangementStepsFromSections(a.sections);
    expect(steps.map((s) => s.section_id)).toEqual(a.sections.map((s) => s.id));
  });

  it("skips sections without an id", () => {
    const steps = buildArrangementStepsFromSections([{ label: "X", lines: ["y"] }]);
    expect(steps).toEqual([]);
  });
});

describe("songValidate", () => {
  it("flags a missing title", () => {
    expect(songValidate(mkSong({ title: "  " })).ok).toBe(false);
  });

  it("flags an empty sections array", () => {
    expect(songValidate({ ...mkSong(), sections: [] }).ok).toBe(false);
  });

  it("flags sections with only blank lines", () => {
    expect(songValidate(mkSong({ sections: [{ label: "V", lines: ["  ", ""] }] })).ok).toBe(false);
  });

  it("accepts a song with a title and at least one lyric line", () => {
    expect(songValidate(mkSong()).ok).toBe(true);
  });
});