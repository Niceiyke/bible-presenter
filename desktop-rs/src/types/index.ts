export type MediaItemType = "Image" | "Video";

export interface Verse {
  book: string;
  chapter: number;
  verse: number;
  text: string;
  version: string;
}

export interface MediaItem {
  id: string;
  name: string;
  path: string;
  media_type: MediaItemType;
  thumbnail_path?: string;
}

export interface PresentationFile {
  id: string;
  name: string;
  path: string;
  slide_count: number;
}

export interface PresentationSlideData {
  presentation_id: string;
  presentation_name: string;
  presentation_path: string;
  slide_index: number;
  slide_count: number;
}

export interface SlideZone {
  text: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
}

export type TextZone = SlideZone; // Alias for backward compatibility if needed

export interface CustomSlide {
  id: string;
  backgroundColor: string;
  backgroundImage?: string;
  headerEnabled: boolean;
  headerHeightPct: number;
  header: SlideZone;
  body: SlideZone;
}

export interface CustomPresentation {
  id: string;
  name: string;
  slides: CustomSlide[];
}

export interface CustomSlideDisplayData {
  presentation_id: string;
  presentation_name: string;
  slide_index: number;
  slide_count: number;
  background_color: string;
  background_image?: string;
  header_enabled?: boolean;
  header_height_pct?: number;
  header: { text: string; font_size: number; font_family: string; color: string; bold: boolean; italic: boolean; align: string };
  body: { text: string; font_size: number; font_family: string; color: string; bold: boolean; italic: boolean; align: string };
}

export interface CameraFeedData {
  device_id: string;
  label: string;
  lan?: boolean;
  device_name?: string;
}

export interface CameraSource {
  device_id: string;
  device_name: string;
  previewStream: MediaStream | null;
  previewPc: RTCPeerConnection | null;
  status: 'connecting' | 'connected' | 'disconnected';
  connectedAt: number;
  enabled: boolean;
}

export type LowerThirdData =
  | { kind: "Nameplate"; data: { name: string; title?: string } }
  | { kind: "Lyrics"; data: { line1: string; line2?: string; section_label?: string } }
  | { kind: "FreeText"; data: { text: string } };

export interface LowerThirdTemplate {
  id: string; name: string;
  bgType: "solid" | "gradient" | "transparent" | "image";
  bgColor: string; bgOpacity: number; bgGradientEnd: string; bgBlur: boolean;
  bgImagePath?: string;
  accentEnabled: boolean; accentColor: string;
  accentSide: "left" | "right" | "top" | "bottom"; accentWidth: number;
  hAlign: "left" | "center" | "right"; vAlign: "top" | "middle" | "bottom";
  offsetX: number; offsetY: number;
  widthPct: number; paddingX: number; paddingY: number; borderRadius: number;
  primaryFont: string; primarySize: number; primaryColor: string;
  primaryBold: boolean; primaryItalic: boolean; primaryUppercase: boolean;
  secondaryFont: string; secondarySize: number; secondaryColor: string;
  secondaryBold: boolean; secondaryItalic: boolean; secondaryUppercase: boolean;
  labelVisible: boolean; labelColor: string; labelSize: number; labelUppercase: boolean;
  animation: "fade" | "slide-up" | "slide-left" | "none";
  variant: "classic" | "modern" | "banner";
  scrollEnabled: boolean;
  scrollDirection: "ltr" | "rtl";
  scrollSpeed: number;
}

export type BackgroundSetting =
  | { type: "None"; value?: string }
  | { type: "Color"; value: string }
  | { type: "Image"; value: string }
  | { type: "Camera"; value: string };

export type LayerContent =
  | { kind: "empty" }
  | { kind: "item"; item: DisplayItem }
  | { kind: "lower-third"; ltData: LowerThirdData; template: LowerThirdTemplate };

export interface SceneLayer {
  id: string;
  name: string;
  content: LayerContent;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  visible: boolean;
}

export interface SceneData {
  id: string;
  name: string;
  layers: SceneLayer[];
  background?: BackgroundSetting;
}

export interface TimerData {
  timer_type: "countdown" | "countup" | "clock";
  duration_secs?: number;
  label?: string;
  started_at?: number;
}

export type DisplayItem =
  | { type: "Verse"; data: Verse }
  | { type: "Media"; data: MediaItem }
  | { type: "PresentationSlide"; data: PresentationSlideData }
  | { type: "CustomSlide"; data: CustomSlideDisplayData }
  | { type: "CameraFeed"; data: CameraFeedData }
  | { type: "Scene"; data: SceneData }
  | { type: "Timer"; data: TimerData };

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

export interface LyricSection {
  label: string;
  lines: string[];
}

export interface Song {
  id: string;
  title: string;
  author?: string;
  sections: LyricSection[];
  arrangement?: string[];
}

export interface PropItem {
  id: string;
  kind: "image" | "clock";
  path?: string;
  text?: string;
  color?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  visible: boolean;
}

export interface ThemeColors {
  background: string;
  verseText: string;
  referenceText: string;
  waitingText: string;
}

export interface PresentationSettings {
  theme: string;
  reference_position: "top" | "bottom";
  background: BackgroundSetting;
  bible_background?: BackgroundSetting;
  presentation_background?: BackgroundSetting;
  media_background?: BackgroundSetting;
  logo_path?: string;
  is_blanked: boolean;
  font_size: number;
  slide_transition?: string;
  slide_transition_duration?: number;
}

export interface ParsedSlide {
  backgroundColor?: string | null;
  images: Array<{
    dataUrl: string;
    rect: { x: number; y: number; width: number; height: number };
  }>;
  textBoxes: Array<{
    text: string;
    color?: string | null;
    fontSize?: number | null;
    bold?: boolean;
    rect: { x: number; y: number; width: number; height: number };
  }>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const FONTS = [
  "Arial", "Georgia", "Times New Roman", "Verdana", "Courier New", "Montserrat", "Oswald", "Playfair Display", "Roboto", "Open Sans"
];

export const DEFAULT_LT_TEMPLATE: LowerThirdTemplate = {
  id: "default", name: "Default",
  bgType: "solid", bgColor: "#000000", bgOpacity: 85, bgGradientEnd: "#141428", bgBlur: false,
  accentEnabled: true, accentColor: "#f59e0b", accentSide: "left", accentWidth: 4,
  hAlign: "left", vAlign: "bottom", offsetX: 48, offsetY: 40,
  widthPct: 60, paddingX: 24, paddingY: 16, borderRadius: 12,
  primaryFont: "Georgia", primarySize: 36, primaryColor: "#ffffff",
  primaryBold: true, primaryItalic: false, primaryUppercase: false,
  secondaryFont: "Arial", secondarySize: 22, secondaryColor: "#f59e0b",
  secondaryBold: false, secondaryItalic: false, secondaryUppercase: false,
  labelVisible: true, labelColor: "#f59e0b", labelSize: 13, labelUppercase: true,
  animation: "slide-up",
  variant: "classic",
  scrollEnabled: false, scrollDirection: "ltr", scrollSpeed: 5,
};

export const DEFAULT_SETTINGS: PresentationSettings = {
  theme: "dark",
  reference_position: "bottom",
  background: { type: "None" },
  is_blanked: false,
  font_size: 72,
  slide_transition: "fade",
  slide_transition_duration: 0.4,
};

export const THEMES: Record<string, { label: string; colors: ThemeColors }> = {
  dark: {
    label: "Classic Dark",
    colors: { background: "#000000", verseText: "#ffffff", referenceText: "#f59e0b", waitingText: "#3f3f46" },
  },
  light: {
    label: "Light",
    colors: { background: "#f8fafc", verseText: "#0f172a", referenceText: "#b45309", waitingText: "#94a3b8" },
  },
  navy: {
    label: "Navy",
    colors: { background: "#0a1628", verseText: "#e2e8f0", referenceText: "#60a5fa", waitingText: "#334155" },
  },
  maroon: {
    label: "Maroon",
    colors: { background: "#1a0505", verseText: "#fef2f2", referenceText: "#f87171", waitingText: "#7f1d1d" },
  },
  forest: {
    label: "Forest",
    colors: { background: "#051a0a", verseText: "#f0fdf4", referenceText: "#4ade80", waitingText: "#14532d" },
  },
  slate: {
    label: "Slate",
    colors: { background: "#1e2a3a", verseText: "#cbd5e1", referenceText: "#94a3b8", waitingText: "#334155" },
  },
};
