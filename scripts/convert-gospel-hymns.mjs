#!/usr/bin/env node
// Converts marvinjude/gospel-hymns (Hymns/*.txt) into bible_data/hymns.json.
//
// One-shot build-time converter. Replaces src-tauri/bible_data/hymns.json in place.
// Parses each text file into a Song object using the legacy hymn schema used by
// src-tauri/src/commands/misc.rs::get_hymn_library and src/types/song.ts.
//
// Rules:
//   - Title comes from the filename (strip leading "<number> " prefix and ".txt").
//   - Stanzas are separated by blank lines.
//   - A stanza is treated as a Chorus when every non-empty line is indented
//     (leading whitespace), or when the stanza starts with a "Chorus:" label.
//   - Only the first Chorus text is kept as the canonical Chorus section.
//   - arrangement is interleaved: [Verse 1, Chorus, Verse 2, Chorus, ...].
//   - style is always "FullSlide".
//
// Usage:
//   node scripts/convert-gospel-hymns.mjs [--source path/to/gospel-hymns]
//
// Without --source, the repo is shallow-cloned into a temp dir and removed after.

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_URL = "https://github.com/marvinjude/gospel-hymns.git";
const OUT_PATH = resolve(__dirname, "..", "src-tauri", "bible_data", "hymns.json");

function parseArgs(argv) {
  const args = argv.slice(2);
  let source = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source") source = args[++i];
  }
  return { source };
}

function ensureSource(providedSource) {
  if (providedSource && existsSync(join(providedSource, "Hymns"))) {
    return { dir: providedSource, owned: false };
  }
  // The repo contains a Windows-invalid path ("archive/Converts/did you think to pray?.txt")
  // that aborts a plain `git clone` checkout on Windows. We fetch the tarball instead and
  // extract only the Hymns/ subdirectory so the bad path is never materialized.
  const tmp = mkdtempSync(join(tmpdir(), "gospel-hymns-"));
  const TARBALL_URL = "https://codeload.github.com/marvinjude/gospel-hymns/tar.gz/refs/heads/master";
  const tarPath = join(tmp, "repo.tar.gz");
  console.log(`Downloading ${TARBALL_URL} ...`);
  execSync(`curl -L --fail -o "${tarPath}" "${TARBALL_URL}"`, { stdio: "inherit" });
  execSync(`tar -xzf "${tarPath}" -C "${tmp}" --strip-components=1 -- "gospel-hymns-master/Hymns"`, { stdio: "inherit" });
  return { dir: tmp, owned: true };
}

function slugify(title) {
  return "hymn-" + title
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function naturalSort(a, b) {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true });
}

function splitStanzas(text) {
  // Normalize line endings and collapse whitespace-only blank lines to empty, then split on
  // one-or-more blank lines. Using /\n\s*\n/ would eat the leading whitespace of the next
  // stanza (e.g. an indented Chorus first line) and corrupt chorus detection.
  // NOTE: String.prototype.trim() ignores its argument and trims ALL whitespace, so
  // we trim only "\n" via regex to preserve leading indentation inside each stanza.
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]+\n/g, "\n\n");

  // Many source files indent EVERY line (verses included) by a uniform amount
  // (commonly a single leading space). "Indented line starts" alone would then
  // mark every stanza as a Chorus and collapse the whole hymn into one section.
  // Strip the common leading indentation first so only genuinely deeper
  // (chorus) stanzas keep leading whitespace.
  const lines = normalized.split("\n");
  let commonIndent = Infinity;
  for (const l of lines) {
    if (l.trim().length === 0) continue;
    const leading = /^[ \t]*/.exec(l);
    const width = leading ? leading[0].length : 0;
    if (width < commonIndent) commonIndent = width;
  }
  const strip = Number.isFinite(commonIndent) ? commonIndent : 0;
  const dedented = lines
    .map((l) => (l.trim().length === 0 ? l : l.slice(strip)))
    .join("\n");

  return dedented
    .split(/\n{2,}/)
    .map((s) => s.replace(/^\n+/, "").replace(/\n+$/, ""))
    .filter((s) => s.trim().length > 0);
}

function isChorusStanza(stanza) {
  const lines = stanza.split("\n").map((l) => l.replace(/\s+$/, ""));
  const nonEmpty = lines.filter((l) => l.length > 0);
  if (nonEmpty.length === 0) return false;
  // Explicit "Chorus" or "Chorus:" prefix label line.
  if (/^\s*chorus\s*:?\s*$/i.test(nonEmpty[0])) return true;
  // All non-empty lines start with whitespace.
  return nonEmpty.every((l) => /^\s+\S/.test(l));
}

function stripChorusLabelLine(stanza) {
  const lines = stanza.split("\n");
  if (lines.length > 0 && /^\s*chorus\s*:?\s*$/i.test(lines[0].trim())) {
    return lines.slice(1).join("\n");
  }
  return stanza;
}

function cleanLines(stanza) {
  return stanza
    .split("\n")
    .map((l) => l.replace(/\s+$/, "").replace(/^\s+/, ""))
    .filter((l) => l.length > 0);
}

function parseHymnFile(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const fileName = basename(filePath);
  const title = fileName
    .replace(/\.txt$/i, "")
    .replace(/^\d+\s+/, "")
    .trim();

  const stanzas = splitStanzas(raw);
  if (stanzas.length === 0) return null;

  const sections = [];
  let verseCounter = 0;
  let chorusText = null;
  let chorusDifferences = 0;

  for (const stanza of stanzas) {
    const isChorus = isChorusStanza(stanza);
    if (isChorus) {
      const body = stripChorusLabelLine(stanza);
      const lines = cleanLines(body);
      if (lines.length === 0) continue;
      const joined = lines.join("\n");
      if (chorusText === null) {
        chorusText = joined;
        sections.push({ label: "Chorus", lines });
      } else if (joined !== chorusText) {
        chorusDifferences++;
      }
      continue;
    }
    verseCounter++;
    const lines = cleanLines(stanza);
    if (lines.length === 0) continue;
    sections.push({ label: `Verse ${verseCounter}`, lines });
  }

  if (sections.length === 0) return null;

  const verses = sections.filter((s) => s.label.startsWith("Verse"));
  const hasChorus = !!chorusText;
  const arrangement = [];
  for (const v of verses) {
    arrangement.push(v.label);
    if (hasChorus) arrangement.push("Chorus");
  }

  return {
    id: slugify(title),
    title,
    sections,
    arrangement,
    style: "FullSlide",
    warnings: chorusDifferences > 0 ? [`${chorusDifferences} differing later chorus stanza(s) collapsed into the first`] : [],
  };
}

function main() {
  const { source: providedSource } = parseArgs(process.argv);
  const { dir, owned } = ensureSource(providedSource);
  const hymnsDir = join(dir, "Hymns");

  if (!existsSync(hymnsDir)) {
    console.error(`Hymns directory not found at ${hymnsDir}`);
    if (owned) rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }

  const files = readdirSync(hymnsDir)
    .filter((f) => /\.txt$/i.test(f))
    .sort(naturalSort);

  console.log(`Found ${files.length} text files.`);

  const songs = [];
  const skipped = [];
  const idCount = new Map();

  for (const file of files) {
    const song = parseHymnFile(join(hymnsDir, file));
    if (!song) {
      skipped.push(file);
      continue;
    }
    let id = song.id;
    if (idCount.has(id)) {
      const n = idCount.get(id) + 1;
      idCount.set(id, n);
      id = `${song.id}-${n}`;
      song.id = id;
    } else {
      idCount.set(song.id, 1);
    }
    if (song.warnings && song.warnings.length > 0) {
      console.warn(`[warn] ${file}: ${song.warnings.join("; ")}`);
    }
    delete song.warnings;
    songs.push(song);
  }

  if (skipped.length > 0) {
    console.warn(`Skipped ${skipped.length} file(s) with no parseable content:`, skipped.slice(0, 5), "...");
  }

  const json = JSON.stringify(songs, null, 2) + "\n";
  writeFileSync(OUT_PATH, json, "utf8");
  console.log(`Wrote ${songs.length} hymns -> ${OUT_PATH} (${(json.length / 1024).toFixed(1)} KB)`);

  if (owned) rmSync(dir, { recursive: true, force: true });
}

main();