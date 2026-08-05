export type DetectedFormat = "plain" | "sections" | "chordpro" | "openlyrics";

export interface ParsedSong {
  title: string;
  author?: string;
  copyright?: string;
  ccli?: string;
  key?: string;
  sections: { label: string; lines: string[] }[];
  format: DetectedFormat;
}

function stripChords(line: string): string {
  return line.replace(/\[[^\]]*\]/g, "").trim();
}

function tryParseChordPro(text: string): ParsedSong | null {
  const lines = text.split("\n");
  const meta: Record<string, string> = {};
  const sections: { label: string; lines: string[] }[] = [];
  let currentSection: string[] = [];
  let currentLabel = "Verse 1";

  const metaRe = /^\{(title|key|author|copyright|ccli|ccli_no|ccli_number|comments)\s*:\s*(.+)\}$/i;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const metaMatch = line.match(metaRe);
    if (metaMatch) {
      const key = metaMatch[1].toLowerCase();
      if (key === "ccli_no" || key === "ccli_number") meta.ccli = metaMatch[2].trim();
      else if (key === "comments") continue;
      else meta[key] = metaMatch[2].trim();
      continue;
    }

    if (line.startsWith("{") && line.endsWith("}")) {
      const tag = line.slice(1, -1).trim();
      if (tag.startsWith("soc") || tag.startsWith("start_of_chorus")) {
        if (currentSection.length > 0) {
          sections.push({ label: currentLabel, lines: [...currentSection] });
          currentSection = [];
        }
        currentLabel = "Chorus";
        continue;
      }
      if (tag.startsWith("eoc") || tag.startsWith("end_of_chorus")) {
        if (currentSection.length > 0) {
          sections.push({ label: currentLabel, lines: [...currentSection] });
          currentSection = [];
        }
        currentLabel = `Verse ${sections.filter(s => s.label.startsWith("Verse")).length + 1}`;
        continue;
      }
      if (tag.startsWith("sov") || tag.startsWith("start_of_verse")) {
        if (currentSection.length > 0) {
          sections.push({ label: currentLabel, lines: [...currentSection] });
          currentSection = [];
        }
        currentLabel = `Verse ${sections.filter(s => s.label.startsWith("Verse")).length + 1}`;
        continue;
      }
      if (tag.startsWith("eov") || tag.startsWith("end_of_verse")) {
        continue;
      }
      if (/^(verse|chorus|bridge|prechorus|outro|intro|coda|tag)\b/i.test(tag)) {
        if (currentSection.length > 0) {
          sections.push({ label: currentLabel, lines: [...currentSection] });
          currentSection = [];
        }
        currentLabel = tag.charAt(0).toUpperCase() + tag.slice(1).toLowerCase();
        continue;
      }
      continue;
    }

    if (/^\[[A-G][#b]?m?(maj|min|dim|aug|sus\d*)?\]/i.test(line)) {
      const clean = stripChords(line);
      if (clean) currentSection.push(line);
      continue;
    }
    if (/\[[A-G]/.test(line)) {
      currentSection.push(line);
      continue;
    }
    currentSection.push(line);
  }

  if (currentSection.length > 0) {
    sections.push({ label: currentLabel, lines: [...currentSection] });
  }

  if (sections.length === 0) return null;

  return {
    title: meta["title"] || "",
    author: meta["author"],
    copyright: meta["copyright"],
    ccli: meta["ccli"],
    key: meta["key"],
    sections,
    format: "chordpro",
  };
}

function tryParseOpenLyrics(text: string): ParsedSong | null {
  const parser = new DOMParser();
  let doc: Document;
  try {
    doc = parser.parseFromString(text, "text/xml");
  } catch {
    return null;
  }

  const songEl = doc.querySelector("song");
  if (!songEl) return null;

  const props = songEl.querySelector("properties");
  const titles = props?.querySelector("titles");
  const title = titles?.querySelector("title")?.textContent || "";
  if (!title) return null;

  const author = props?.querySelector("authors author")?.textContent;
  const copyright = props?.querySelector("copyright")?.textContent;
  const ccli = props?.querySelector("ccliNo")?.textContent;
  const key = props?.querySelector("key")?.textContent;

  const sections: { label: string; lines: string[] }[] = [];
  const lyrics = songEl.querySelector("lyrics");
  const verses = lyrics?.querySelectorAll("verse, chorus, bridge, preChorus");
  verses?.forEach((verse) => {
    const label = verse.getAttribute("name") || verse.tagName;
    const nameMap: Record<string, string> = {
      v1: "Verse 1", v2: "Verse 2", v3: "Verse 3", v4: "Verse 4", v5: "Verse 5",
      c1: "Chorus", c2: "Chorus", b1: "Bridge", p1: "Pre-Chorus",
    };
    const displayLabel = nameMap[label] || label;
    const lines = Array.from(verse.querySelectorAll("lines")).map(l => l.textContent || "").filter(Boolean);
    if (lines.length > 0) {
      sections.push({ label: displayLabel, lines });
    }
  });

  if (sections.length === 0) return null;

  return {
    title,
    author: author || undefined,
    copyright: copyright || undefined,
    ccli: ccli || undefined,
    key: key || undefined,
    sections,
    format: "openlyrics",
  };
}

function tryParseSections(text: string): ParsedSong | null {
  const lines = text.split("\n");
  let title = "";
  let author = "";
  let copyright = "";
  let ccli = "";
  const sections: { label: string; lines: string[] }[] = [];
  let currentSection: string[] = [];
  let currentLabel = "";

  const sectionRe = /^(Verse\s*\d*|Chorus|Bridge|Pre[- ]?Chorus|Outro|Intro|Tag|Ending|Coda)\s*:?\s*$/i;
  const titleRe = /^Title\s*:\s*(.+)$/i;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (titleRe.test(line)) {
      const m = line.match(titleRe);
      if (m) title = m[1].trim();
      continue;
    }

    const sectionMatch = line.match(sectionRe);
    if (sectionMatch) {
      if (currentSection.length > 0 && currentLabel) {
        sections.push({ label: currentLabel, lines: [...currentSection] });
        currentSection = [];
      }
      const rawLabel = sectionMatch[1];
      currentLabel = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1).toLowerCase();
      if (/^Verse$/i.test(rawLabel)) {
        const verseCount = sections.filter(s => /^Verse\s*\d+$/i.test(s.label)).length;
        currentLabel = `Verse ${verseCount + 1}`;
      }
      continue;
    }

    if (!line) {
      continue;
    }

    if (currentLabel || sections.length === 0) {
      if (!currentLabel) {
        if (!title) {
          title = line;
          continue;
        }
        currentLabel = "Verse 1";
      }
      currentSection.push(line);
    }
  }

  if (currentSection.length > 0 && currentLabel) {
    sections.push({ label: currentLabel, lines: [...currentSection] });
  }

  if (sections.length === 0) return null;

  return {
    title,
    author: author || undefined,
    copyright: copyright || undefined,
    ccli: ccli || undefined,
    sections,
    format: "sections",
  };
}

function tryParsePlain(text: string): ParsedSong | null {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l !== "");
  if (lines.length === 0) return null;
  return {
    title: lines[0],
    sections: [{ label: "", lines }],
    format: "plain",
  };
}

export function detectAndParse(text: string): { detected: DetectedFormat; result: ParsedSong } {
  const trimmed = text.trim();
  if (!trimmed) return { detected: "plain", result: { title: "", sections: [], format: "plain" } };

  if (/^\s*</.test(trimmed)) {
    const result = tryParseOpenLyrics(trimmed);
    if (result) return { detected: "openlyrics", result };
  }

  const chordProResult = tryParseChordPro(trimmed);
  if (chordProResult && chordProResult.sections.some(s => /\[[A-G]/.test(s.lines.join(" ")))) {
    return { detected: "chordpro", result: chordProResult };
  }

  const sectionsResult = tryParseSections(trimmed);
  if (sectionsResult && sectionsResult.sections.length > 1) {
    return { detected: "sections", result: sectionsResult };
  }

  const plainResult = tryParsePlain(trimmed);
  if (plainResult) return { detected: "plain", result: plainResult };

  return { detected: "plain", result: { title: "", sections: [], format: "plain" } };
}
