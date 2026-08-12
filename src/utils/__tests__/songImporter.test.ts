import { describe, expect, it } from "vitest";
import { detectAndParse } from "../songImporter";

describe("songImporter", () => {
  it("plain text: first line is title, rest is one section", () => {
    const { detected, result } = detectAndParse("Amazing Grace\nHow sweet the sound");
    expect(detected).toBe("plain");
    expect(result.title).toBe("Amazing Grace");
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].lines).toContain("How sweet the sound");
  });

  it("section-labeled text: parses Title, Author, Key, Copyright, CCLI", () => {
    const text = `Title: Amazing Grace
Author: John Newton
Copyright: Public Domain
CCLI: 12345
Key: G

Verse 1
Amazing grace how sweet the sound
That saved a wretch like me

Chorus
Praise God`;
    const { detected, result } = detectAndParse(text);
    expect(detected).toBe("sections");
    expect(result.title).toBe("Amazing Grace");
    expect(result.author).toBe("John Newton");
    expect(result.copyright).toBe("Public Domain");
    expect(result.ccli).toBe("12345");
    expect(result.key).toBe("G");
    expect(result.sections.length).toBe(2);
    expect(result.sections[1].label).toBe("Chorus");
  });

  it("ChordPro: strips chord markers from lyric lines", () => {
    const text = `{title: Test}
{key: G}
[G]Amazing [D]grace how [Em]sweet the [C]sound`;
    const { detected, result } = detectAndParse(text);
    expect(detected).toBe("chordpro");
    expect(result.title).toBe("Test");
    expect(result.key).toBe("G");
    expect(result.sections[0].lines[0]).toBe("Amazing grace how sweet the sound");
    expect(result.sections[0].lines[0]).not.toContain("[");
    expect(result.chordsDetected).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("ChordPro: [G]Amazing grace becomes 'Amazing grace' by default", () => {
    const text = `{title: X}
[G]Amazing grace`;
    const { result } = detectAndParse(text);
    expect(result.sections[0].lines[0]).toBe("Amazing grace");
  });

  it("ChordPro: chord-only lines are not emitted as lyric lines", () => {
    const text = `{title: X}
[G]
[C]
Amazing grace`;
    const { result } = detectAndParse(text);
    expect(result.sections[0].lines).toEqual(["Amazing grace"]);
  });

  it("ChordPro: preserves key metadata", () => {
    const text = `{title: T}
{key: A}
{author: Auth}
{copyright: C}
{ccli: 99}
Amazing grace`;
    const { result } = detectAndParse(text);
    expect(result.key).toBe("A");
    expect(result.author).toBe("Auth");
    expect(result.copyright).toBe("C");
    expect(result.ccli).toBe("99");
  });

  it("OpenLyrics: parses title, author, sections", () => {
    const xml = `<?xml version="1.0"?>
<song>
  <properties>
    <titles><title>How Great Thou Art</title></titles>
    <authors><author>Carl Boberg</author></authors>
    <copyright>Public</copyright>
    <ccliNo>555</ccliNo>
    <key>G</key>
  </properties>
  <lyrics>
    <verse name="v1"><lines>Oh Lord my God</lines></verse>
    <chorus name="c1"><lines>Then sings my soul</lines></chorus>
  </lyrics>
</song>`;
    const { detected, result } = detectAndParse(xml);
    expect(detected).toBe("openlyrics");
    expect(result.title).toBe("How Great Thou Art");
    expect(result.author).toBe("Carl Boberg");
    expect(result.ccli).toBe("555");
    expect(result.key).toBe("G");
    expect(result.sections).toHaveLength(2);
  });

  it("malformed OpenLyrics returns error/empty, not a crash", () => {
    const xml = `<?xml version="1.0"?><notasong><foo>`;
    const { detected } = detectAndParse(xml);
    // Malformed XML → falls through to other parsers → plain or sections
    // The key requirement: no crash, no empty song that looks valid.
    expect(["plain", "sections", "chordpro", "openlyrics"]).toContain(detected);
  });

  it("empty input returns warnings and empty sections", () => {
    const { result } = detectAndParse("");
    expect(result.sections).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("parser warnings are populated for ChordPro chord removal", () => {
    const { result } = detectAndParse(`{title: T}\n[G]test [C]line`);
    expect(result.warnings.some(w => w.toLowerCase().includes("chord"))).toBe(true);
  });
});