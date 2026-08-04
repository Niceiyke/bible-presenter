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

export interface SlideElement {
  id: string;
  kind: "text" | "image" | "shape";
  x: number; y: number; w: number; h: number; z_index: number;
  content: string;
  font_size?: number; font_family?: string; color?: string;
  align?: "left" | "center" | "right"; v_align?: "top" | "middle" | "bottom";
  bold?: boolean; italic?: boolean; opacity?: number;
  locked?: boolean; shadow?: boolean; shadow_color?: string;
}

export interface CustomSlide {
  id: string;
  backgroundColor: string;
  backgroundImage?: string;
  elements: SlideElement[];
  headerEnabled?: boolean; headerHeightPct?: number;
  header?: SlideZone; body?: SlideZone;
}

export interface CustomPresentation {
  id: string;
  name: string;
  slides: CustomSlide[];
  version?: number;
}

export interface CustomSlideDisplayData {
  presentation_id: string; presentation_name: string;
  slide_index: number; slide_count: number;
  background_color: string; background_image?: string;
  elements?: SlideElement[];
  header_enabled?: boolean; header_height_pct?: number;
  header?: { text: string; font_size: number; font_family: string; color: string; bold: boolean; italic: boolean; align: string };
  body?: { text: string; font_size: number; font_family: string; color: string; bold: boolean; italic: boolean; align: string };
}
