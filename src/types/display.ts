import type { Verse } from "./verse";
import type { MediaItem } from "./media";
import type { CustomSlideDisplayData } from "./slides";
import type { TimerData } from "./timer";
import type { SongSlideData } from "./song";
import type { CameraBackground } from "./settings";
import type { SceneCompositionData } from "./scene";

export type DisplayItem =
  | { type: "Verse"; data: Verse }
  | { type: "Media"; data: MediaItem }
  | { type: "Camera"; data: CameraBackground }
  | { type: "CustomSlide"; data: CustomSlideDisplayData }
  | { type: "Timer"; data: TimerData }
  | { type: "Song"; data: SongSlideData }
  | { type: "SceneComposition"; data: SceneCompositionData };

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
