export interface SlideZone {
  text: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
}

export type TextZone = SlideZone;

export type SlideElementKind = "text" | "image" | "shape" | "video";

export interface SlideElement {
  id: string;
  kind: SlideElementKind;
  groupId?: string;
  x: number; y: number; w: number; h: number; z_index: number;
  content: string;
  font_size?: number; font_family?: string; color?: string;
  align?: "left" | "center" | "right"; v_align?: "top" | "middle" | "bottom";
  bold?: boolean; italic?: boolean; opacity?: number;
  locked?: boolean; shadow?: boolean; shadow_color?: string;
  loop?: boolean; muted?: boolean;
}

export interface CustomSlide {
  id: string;
  backgroundColor: string;
  backgroundImage?: string;
  backgroundVideo?: string;
  backgroundVideoLoop?: boolean;
  backgroundVideoMuted?: boolean;
  elements: SlideElement[];
  notes?: string;
  headerEnabled?: boolean; headerHeightPct?: number;
  header?: SlideZone; body?: SlideZone;
}

export interface CustomPresentation {
  id: string;
  name: string;
  slides: CustomSlide[];
  version?: number;
}

export interface PresentationSummary {
  id: string;
  name: string;
  slide_count: number;
  version: number;
  updated_at: number;
}

export interface SlideTemplate {
  id: string;
  name: string;
  category: string;
  slide: CustomSlide;
  created_at: number;
}

export interface PresentationExport {
  version: number;
  presentation: CustomPresentation;
  exported_at: number;
}

export interface CustomSlideDisplayData {
  presentation_id: string; presentation_name: string;
  slide_index: number; slide_count: number;
  background_color: string; background_image?: string;
  background_video?: string;
  background_video_loop?: boolean;
  background_video_muted?: boolean;
  elements?: SlideElement[];
  notes?: string;
  header_enabled?: boolean; header_height_pct?: number;
  header?: { text: string; font_size: number; font_family: string; color: string; bold: boolean; italic: boolean; align: string };
  body?: { text: string; font_size: number; font_family: string; color: string; bold: boolean; italic: boolean; align: string };
}
