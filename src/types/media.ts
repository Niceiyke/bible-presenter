export type MediaItemType = "Image" | "Video";
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
}
