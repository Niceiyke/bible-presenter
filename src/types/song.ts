export interface LyricSection { label: string; lines: string[]; }
export type SongStyle = "FullSlide" | "LowerThird";

export interface Song {
  id: string; title: string; author?: string;
  sections: LyricSection[];
  arrangement?: string[];
  style?: SongStyle;
  font?: string; font_size?: number; font_weight?: string; color?: string;
}

export interface SongSlideData {
  song_id: string; title: string; author?: string;
  section_label: string; lines: string[];
  slide_index: number; total_slides: number;
  style?: SongStyle;
  font?: string; font_size?: number; font_weight?: string; color?: string;
}
