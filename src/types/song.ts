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
}

export interface SongSlideData {
  song_id: string;
  title: string;
  author?: string;
  section_label: string;
  lines: string[];
  slide_index: number;
  total_slides: number;
  style?: SongStyle;
  font?: string;
  font_size?: number;
  font_weight?: string;
  color?: string;
}