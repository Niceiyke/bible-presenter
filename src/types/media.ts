export type MediaItemType = "Image" | "Video" | "Audio";
export type MediaFitMode = "contain" | "cover" | "fill";

export interface MediaItem {
  id: string;
  name: string;
  path: string;
  media_type: MediaItemType;
  thumbnail_path?: string;
  fit_mode?: MediaFitMode;
  tags: string[];
  description?: string;
  category?: string;
  /** P4.8: probe metadata + playback config persisted per item. */
  duration?: number;
  width?: number;
  height?: number;
  content_hash?: string;
  loop_playback?: boolean;
  playback_rate?: number;
  volume?: number;
}
