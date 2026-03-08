// ─── Shared domain types (mirrors Rust serde structs) ────────────────────────

export interface Verse {
  book: string;
  chapter: number;
  verse: number;
  text: string;
  version: string;
  score?: number;
}

export interface MediaItem {
  id: string;
  name: string;
  path: string;
  media_type: 'Image' | 'Video';
  thumbnail_path?: string;
  fit_mode: string;
  tags: string[];
  description?: string;
  category?: string;
}

export interface TimerData {
  timer_type: 'countdown' | 'countup' | 'clock';
  duration_secs?: number;
  label?: string;
  started_at?: number;
}

export interface SongSlideData {
  song_id: string;
  title: string;
  author?: string;
  section_label: string;
  lines: string[];
  slide_index: number;
  total_slides: number;
}

export interface LyricSection {
  label: string;
  lines: string[];
}

export interface Song {
  id: string;
  title: string;
  author?: string;
  sections: LyricSection[];
  arrangement: string[];
}

export type DisplayItem =
  | { type: 'Verse';       data: Verse }
  | { type: 'Media';       data: MediaItem }
  | { type: 'Timer';       data: TimerData }
  | { type: 'Song';        data: SongSlideData }
  | { type: 'CustomSlide'; data: { presentation_name: string; slide_index: number } }
  | { type: 'Scene';       data: unknown }
  | { type: 'CameraFeed';  data: { label: string } };

export interface ScheduleEntry {
  id: string;
  item: DisplayItem;
}

export interface Schedule {
  entries: ScheduleEntry[];
}

export interface LowerThirdNameplate { name: string; title?: string }
export interface LowerThirdLyrics { line1: string; line2?: string; section_label?: string }
export interface LowerThirdFreeText { text: string; scroll_mode?: string; speed?: number }

export type LowerThirdData =
  | { kind: 'Nameplate'; data: LowerThirdNameplate }
  | { kind: 'Lyrics';    data: LowerThirdLyrics }
  | { kind: 'FreeText';  data: LowerThirdFreeText };

export interface LtTemplate {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

/** Saved Lower Third content preset (Nameplate or FreeText) */
export interface LtPreset {
  id: string;
  label: string;
  template_id?: string;
  data: LowerThirdData;
}

// ─── API response shapes ──────────────────────────────────────────────────────

export interface AppState {
  live_item: DisplayItem | null;
  staged_item: DisplayItem | null;
  lt: unknown | null;
  is_blanked: boolean;
}

export interface RemoteOperator {
  key: string;
  name: string;
  role: string;
}

export interface RemoteProposal {
  operator_key: string;
  operator_name: string;
  item: DisplayItem;
  staged_at_ms: number;
}

export interface RemoteInfo {
  url: string;
  pin: string;
  port: number;
}

// ─── WebSocket event shapes ───────────────────────────────────────────────────

export type WsEvent =
  | { type: 'auth_ok'; token: string }
  | { type: 'auth_fail' }
  | { type: 'state'; live_item: DisplayItem | null; staged_item?: DisplayItem | null; lt: unknown | null; is_blanked?: boolean; changed_by?: string; remote_proposals?: RemoteProposal[] }
  | { type: 'staged'; staged_item: DisplayItem | null; changed_by?: string }
  | { type: 'operators'; operators: RemoteOperator[] }
  | { type: 'remote_proposals'; proposals: RemoteProposal[] }
  | { type: 'transcription'; text: string }
  | { type: 'lt_update'; payload: unknown | null }
  | { type: 'settings_update'; is_blanked: boolean; changed_by?: string }
  | { type: 'settings_full'; settings: { is_blanked: boolean; [key: string]: unknown } }
  | { type: 'verse_text'; verse: Verse; nav?: 'next' | 'prev' }
  | { type: 'search_results'; results: Verse[]; method?: string }
  | { type: 'books'; version: string; books: string[] }
  | { type: 'chapters'; book: string; chapters: number[] }
  | { type: 'verses'; book: string; chapter: number; verses: number[] }
  | { type: 'versions'; versions: string[] }
  | { type: 'songs'; songs: Song[] }
  | { type: 'media_list'; media_items: MediaItem[] }
  | { type: 'schedule'; schedule: Schedule }
  | { type: 'lt_templates'; templates: LtTemplate[] }
  | { type: 'lt_presets'; presets: LtPreset[] }
  | { type: 'error'; message: string };
