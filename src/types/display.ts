import type { Verse } from "./verse";
import type { MediaItem } from "./media";
import type { CustomSlideDisplayData } from "./slides";
import type { TimerData } from "./timer";
import type { SongSlideData } from "./song";
import type { CameraBackground, PresentationSettings } from "./settings";
import type { SceneCompositionData } from "./scene";
import type { PropItem } from "./props";

export type DisplayItem =
  | { type: "Verse"; data: Verse }
  | { type: "Media"; data: MediaItem }
  | { type: "Camera"; data: CameraBackground }
  | { type: "CustomSlide"; data: CustomSlideDisplayData }
  | { type: "Timer"; data: TimerData }
  | { type: "Song"; data: SongSlideData }
  | { type: "SceneComposition"; data: SceneCompositionData };

/**
 * Schema version of the presentation snapshot document. Consumers must reject a
 * snapshot whose `schema_version` they do not understand instead of guessing at
 * fields (Phase 0 contract freeze). Matches
 * `PRESENTATION_SCHEMA_VERSION` in `src-tauri/src/engine/presentation.rs`.
 */
export const PRESENTATION_SCHEMA_VERSION = 1;

/**
 * Authoritative presentation snapshot returned by the `presentation_snapshot`
 * backend command. Windows register their listeners first, fetch this, then
 * replay any buffered events on top so hydration converges to current state
 * and a racing backend update is never lost or overwritten.
 */
export interface PresentationSnapshot {
  schema_version: number;
  live: DisplayItem | null;
  staged: DisplayItem | null;
  settings: PresentationSettings;
  lower_third: unknown | null;
  props: PropItem[];
  revision: number;
}

export interface ScheduleEntry {
  id: string;
  item: DisplayItem;
}

export interface Schedule {
  id: string;
  name: string;
  items: ScheduleEntry[];
}

export interface ServiceMeta {
  id: string;
  name: string;
  item_count: number;
  updated_at: number;
}
