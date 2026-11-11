import type { BackgroundSetting } from "./settings";

export interface LyricSection {
  /** P1: stable section identity for arrangement references. Optional so
   *  legacy JSON without ids still deserializes; `normalizeSong` backfills
   *  one before the next save. */
  id?: string;
  label: string;
  lines: string[];
}

export type SongStyle = "FullSlide" | "LowerThird";

/** P1: a step in the canonical (id-based) arrangement. */
export interface SongArrangementStep {
  section_id: string;
}

/** P1: a flattened lyric line with its sequence/section context. */
export interface SongLine {
  text: string;
  sectionId: string;
  sectionLabel: string;
  sequenceIndex: number;
  lineIndex: number;
}

/**
 * One audience-facing lyric page. A page is what the operator stages and
 * advances; a section is the authored Verse/Chorus. Full-screen pages split
 * long sections, and lower-third pages never cross a section boundary.
 */
export interface SongPage {
  /** Stable key within this song/mode: sequence occurrence + page-in-section. */
  key: string;
  sectionId: string;
  sectionLabel: string;
  /** Occurrence in the arrangement (repeated choruses have distinct values). */
  sequenceIndex: number;
  /** Index into the flattened lower-third line list (overlay mode). */
  lineStart: number;
  lines: string[];
}

export interface Song {
  id: string;
  title: string;
  author?: string;
  copyright?: string;
  ccli?: string;
  /** P1: musical key (e.g. "G"). Optional; survives import + save. */
  key?: string;
  sections: LyricSection[];

  /** Legacy field. Read during migration and written during the
   *  compatibility window so old consumers remain loadable. New code uses
   *  `arrangement_steps` instead. */
  arrangement?: string[];

  /** P1: canonical arrangement as ordered section-id references. Optional
   *  until migration completes; `normalizeSong` derives it from the legacy
   *  label array when absent. */
  arrangement_steps?: SongArrangementStep[];

  /** Optional schema marker for future migrations. */
  schema_version?: number;

  // Existing display defaults. Keep for compatibility.
  style?: SongStyle;
  font?: string;
  font_size?: number;
  font_weight?: string;
  color?: string;
  /** Optional per-song background override. When present (and not `None`)
   *  wins over the Settings → Backgrounds "Songs" override, which in turn
   *  wins over the global output background. Mirrors how `CustomSlide`
   *  carries its own `background` field. Uses the settings-side
   *  `BackgroundSetting` union (None/Color/Image/Video/Camera/Audio),
   *  the same shape `BackgroundEditor` edits. */
  background?: BackgroundSetting;
  /** Optional per-song lower-third template override. When present and found
   *  in the saved templates, the song uses it for its lyrics overlay instead
   *  of the operator's currently selected `ltTemplate`. Absent = inherit the
   *  operator's active template. */
  lt_template_id?: string;
}

export interface SongSlideData {
  song_id: string;
  title: string;
  author?: string;
  section_label: string;
  /** Source section id, so repeated sections and page navigation stay stable. */
  section_id?: string;
  lines: string[];
  /** Page index (not section index) for page-built song items. */
  slide_index: number;
  total_slides: number;
  /** First line of this page in the flattened lower-third list. */
  line_start?: number;
  style?: SongStyle;
  font?: string;
  font_size?: number;
  font_weight?: string;
  color?: string;
  /** Per-song background override (see `Song.background`). Copied into the
   *  on-wire slide payload by `buildSongDisplayItem` so the output and stage
   *  windows resolve the same background as the editor preview. */
  background?: BackgroundSetting;
  /** Per-song lower-third template override (see `Song.lt_template_id`).
   *  Copied into the on-wire slide payload by `buildSongDisplayItem` so the
   *  overlay sends with the song's chosen template rather than the operator's
   *  current selection. */
  lt_template_id?: string;
}