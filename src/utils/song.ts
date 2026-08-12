/**
 * Song data normalization + sequence utilities
 * (SONG_SYSTEM_MODERNIZATION_PLAN §6.3 / Phase 1).
 *
 * One canonical place defines song section order. All previews, live
 * actions, schedule navigation, and lower-third controls use these
 * helpers so the sequence never disagrees across workspaces.
 */

import { stableId } from "./index";
import type { DisplayItem } from "../types";
import type { Song, LyricSection, SongLine, SongStyle, SongArrangementStep } from "../types";

/** Current frontend song schema version. `normalizeSong` stamps it. */
export const SONG_SCHEMA_VERSION = 2;

/**
 * normalizeSong — pure migration function.
 *
 * 1. Deep-clone the input.
 * 2. Ensure `sections` is an array.
 * 3. Assign an id to each section without one (preserving existing labels
 *    and lines exactly).
 * 4. If `arrangement_steps` exists, validate ids against sections (drop
 *    stale references).
 * 5. If only legacy `arrangement` labels exist, map each label to a section
 *    by occurrence order so duplicate labels resolve deterministically.
 * 6. If no arrangement exists, generate natural-order steps in memory.
 * 7. Stamp `schema_version`.
 *
 * Never silently deletes lyric lines or sections.
 */
export function normalizeSong(song: Song): Song {
  const clone: Song = JSON.parse(JSON.stringify(song));
  if (!Array.isArray(clone.sections)) clone.sections = [];

  // Assign stable ids to sections that lack them.
  const sectionsById = new Map<string, LyricSection>();
  for (const sec of clone.sections) {
    if (!sec.id) sec.id = stableId();
    sectionsById.set(sec.id, sec);
  }

  // Resolve canonical arrangement_steps.
  if (clone.arrangement_steps && clone.arrangement_steps.length > 0) {
    // Validate — drop steps pointing at missing section ids.
    clone.arrangement_steps = clone.arrangement_steps.filter(
      step => sectionsById.has(step.section_id),
    );
  }
  if (!clone.arrangement_steps || clone.arrangement_steps.length === 0) {
    // Either no canonical steps, or all were stale. Migrate or build them.
    if (clone.arrangement && clone.arrangement.length > 0) {
      // Migrate legacy label array → id-based steps.
      // For repeated labels, pick the nth section with that label (n = count
      // of how many times that label has been seen). This lets a single
      // "Chorus" section be repeated, while multiple "Verse" sections with
      // the same label resolve in order.
      const steps: SongArrangementStep[] = [];
      const labelCounts = new Map<string, number>();
      for (const label of clone.arrangement) {
        const matching = clone.sections.filter(s => s.label === label);
        if (matching.length === 0) continue;
        const count = labelCounts.get(label) ?? 0;
        const sec = matching[count % matching.length];
        if (sec && sec.id) {
          steps.push({ section_id: sec.id });
          labelCounts.set(label, count + 1);
        }
      }
      clone.arrangement_steps = steps.length > 0 ? steps : undefined;
    }
  }
  if (!clone.arrangement_steps || clone.arrangement_steps.length === 0) {
    // Natural order fallback.
    const steps: SongArrangementStep[] = [];
    for (const s of clone.sections) {
      if (s.id) steps.push({ section_id: s.id });
    }
    clone.arrangement_steps = steps;
  } else if (!clone.arrangement || clone.arrangement.length === 0) {
    // Backfill the legacy label array from canonical steps so old readers
    // stay loadable during the compatibility window.
    clone.arrangement = clone.arrangement_steps.map(step => {
      const sec = sectionsById.get(step.section_id);
      return sec?.label ?? "";
    }).filter(Boolean);
  }

  clone.schema_version = SONG_SCHEMA_VERSION;
  return clone;
}

/** Return the raw sections array (source of truth for lyric content). */
export function getSongSections(song: Song): LyricSection[] {
  return song.sections;
}

/** Look up a section by id. */
export function getSongSection(song: Song, sectionId: string): LyricSection | null {
  return song.sections.find(s => s.id === sectionId) ?? null;
}

/**
 * getSongSequence — the ordered list of sections to display/play.
 *
 * Uses `arrangement_steps` (canonical ids) when present, otherwise falls
 * back to natural section order. Never uses `Array.find` by label for
 * canonical navigation.
 */
export function getSongSequence(song: Song): LyricSection[] {
  const byId = new Map(song.sections.filter(s => s.id).map(s => [s.id!, s]));
  if (song.arrangement_steps && song.arrangement_steps.length > 0) {
    const out: LyricSection[] = [];
    for (const step of song.arrangement_steps) {
      const sec = byId.get(step.section_id);
      if (sec) out.push(sec);
    }
    if (out.length > 0) return out;
  }
  return song.sections;
}

/** Flatten the song's display sequence into individual lyric lines. */
export function flattenSongLyrics(song: Song): SongLine[] {
  const sequence = getSongSequence(song);
  const out: SongLine[] = [];
  sequence.forEach((sec, seqIdx) => {
    sec.lines.forEach((text, lineIdx) => {
      out.push({
        text,
        sectionId: sec.id ?? "",
        sectionLabel: sec.label,
        sequenceIndex: seqIdx,
        lineIndex: lineIdx,
      });
    });
  });
  return out;
}

/** Build a full-screen Song DisplayItem for the given sequence slide index. */
export function buildSongDisplayItem(
  song: Song,
  index: number,
  mode?: SongStyle,
): DisplayItem {
  const sequence = getSongSequence(song);
  const item = sequence[index] ?? sequence[0];
  return {
    type: "Song",
    data: {
      song_id: song.id,
      title: song.title,
      author: song.author,
      section_label: item?.label ?? "",
      lines: item?.lines ?? [],
      slide_index: index,
      total_slides: sequence.length,
      style: mode ?? song.style,
      font: song.font,
      font_size: song.font_size,
      font_weight: song.font_weight,
      color: song.color,
    },
  };
}

/** Next sequence index, or null at the end. */
export function getNextSongIndex(song: Song, index: number): number | null {
  const len = getSongSequence(song).length;
  if (len === 0) return null;
  return index + 1 < len ? index + 1 : null;
}

/** Previous sequence index, or null at the start. */
export function getPreviousSongIndex(song: Song, index: number): number | null {
  if (index <= 0) return null;
  const len = getSongSequence(song).length;
  if (len === 0) return null;
  return index - 1;
}

/** Lower-cased searchable text for one song: title, author, copyright, CCLI,
 *  key, every section label, and every lyric line. Used by the shared library
 *  search so a volunteer can find a song by any field (Phase 4). */
export function songSearchText(song: Song): string {
  const parts: string[] = [song.title];
  if (song.author) parts.push(song.author);
  if (song.copyright) parts.push(song.copyright);
  if (song.ccli) parts.push(song.ccli);
  if (song.key) parts.push(song.key);
  for (const sec of song.sections) {
    parts.push(sec.label);
    for (const line of sec.lines) parts.push(line);
  }
  return parts.join(" ").toLowerCase();
}

/** Case-insensitive free-text filter across title, author, lyrics, key, CCLI,
 *  and section labels. An empty/whitespace query returns the collection
 *  unchanged so the "no query" path never allocates a new list. */
export function searchSongs(songs: Song[], query: string): Song[] {
  const q = query.trim().toLowerCase();
  if (!q) return songs;
  return songs.filter((s) => songSearchText(s).includes(q));
}

/** Readiness: a song "needs metadata" when one of the documented fields
 *  (author, copyright, CCLI) is missing. Key is deliberately excluded so a
 *  song without a known key is not treated as incomplete. */
export function songNeedsMetadata(song: Song): boolean {
  return !song.author || !song.copyright || !song.ccli;
}

/** Phase 5: convert a multiline textarea value into the canonical lyric-lines
 *  array. One line per row, preserving internal blank lines (intentional verse
 *  spacing); only trailing blank rows are trimmed. This keeps line order
 *  predictable while a stray Enter at the end does not silently create an
 *  extra empty lyric. */
export function splitLyricLines(value: string): string[] {
  const lines = String(value ?? "").split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

/** Phase 5: build an id-based arrangement that plays the given sections in
 *  natural order. New sections are referenced by their existing id; sections
 *  lacking an id are skipped (a section without an id cannot be referenced
 *  safely and is normalized on save). */
export function buildArrangementStepsFromSections(sections: LyricSection[]): SongArrangementStep[] {
  const out: SongArrangementStep[] = [];
  for (const s of sections) {
    if (s.id) out.push({ section_id: s.id });
  }
  return out;
}

/**
 * Keep an arrangement in sync with structural section edits.
 *
 * Returns the arrangement with steps for deleted sections removed and newly
 * added sections appended at the end, so a song always plays every verse.
 * Pure lyric/label edits (same id set) return the arrangement unchanged,
 * meaning the operator's deliberate custom order is never clobbered by typing
 * in a textarea.
 */
export function syncArrangementForSections(
  current: SongArrangementStep[] | undefined,
  oldSections: LyricSection[],
  newSections: LyricSection[],
): SongArrangementStep[] {
  const oldIds = new Set(oldSections.filter((s) => s.id).map((s) => s.id!));
  const newIds = new Set(newSections.filter((s) => s.id).map((s) => s.id!));
  const structuralChange =
    oldIds.size !== newIds.size || [...oldIds].some((id) => !newIds.has(id));
  if (!structuralChange) return current ?? [];
  const kept = (current ?? []).filter((s) => newIds.has(s.section_id));
  const inSteps = new Set(kept.map((s) => s.section_id));
  const added = newSections
    .filter((s) => s.id && !inSteps.has(s.id))
    .map((s) => ({ section_id: s.id! }));
  return [...kept, ...added];
}

/** Validation result for the song editor (`SongEditorModal`). */
export interface SongValidation {
  ok: boolean;
  errors: string[];
}

/** Phase 5: validate a song draft before saving. A song needs a non-empty
 *  title and at least one non-empty lyric line, otherwise `Save` stays
 *  disabled and the editor surfaces the failure inline. */
export function songValidate(song: Song): SongValidation {
  const errors: string[] = [];
  if (!song.title.trim()) errors.push("A song needs a title.");
  if (song.sections.length === 0) {
    errors.push("Add at least one section.");
  } else if (!song.sections.some((s) => s.lines.some((l) => l.trim()))) {
    errors.push("Add at least one lyric line.");
  }
  return { ok: errors.length === 0, errors };
}

/** Counts for card display / card metadata. */
export function getSongCounts(song: Song): { sections: number; sequence: number; lines: number } {
  const sections = song.sections.length;
  const sequence = getSongSequence(song).length;
  const lines = song.sections.reduce((a, s) => a + s.lines.length, 0);
  return { sections, sequence, lines };
}

/**
 * Flatten the song sequence into lower-third line entries
 * (`{ text, sectionLabel }`), the shape consumed by `ltBuildLyricsPayload`.
 * This replaces the triplicated `ltFlatLines` useMemo in App.tsx,
 * LowerThirdTab.tsx, and LtDesignerTab.tsx.
 */
export function flattenSongForLowerThird(
  song: Song | null | undefined,
): { text: string; sectionLabel: string }[] {
  if (!song) return [];
  const lines = flattenSongLyrics(song);
  return lines.map(l => ({ text: l.text, sectionLabel: l.sectionLabel }));
}