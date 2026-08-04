import type { MediaFitMode } from "./media";

export interface ThemeColors {
  background: string;
  verseText: string;
  referenceText: string;
  waitingText: string;
}

export type VideoBackground = {
  path: string; loopVideo: boolean; muted: boolean;
  objectFit: "cover" | "contain" | "fill";
  opacity: number; playbackRate: number;
};

export type CameraBackground = {
  deviceId: string; opacity: number;
  objectFit: "cover" | "contain" | "fill";
  mirrored: boolean;
};

export type BackgroundSetting =
  | { type: "None"; value?: string }
  | { type: "Color"; value: string }
  | { type: "Image"; value: string }
  | { type: "Video"; value: VideoBackground }
  | { type: "Camera"; value: CameraBackground };

export interface PresentationSettings {
  theme: string;
  reference_position: "top" | "bottom";
  background: BackgroundSetting;
  bible_background?: BackgroundSetting;
  media_background?: BackgroundSetting;
  logo_path?: string;
  background_logo_path?: string;
  background_logo_fit?: MediaFitMode;
  show_background_logo?: boolean;
  is_blanked: boolean;
  font_size: number;
  slide_transition?: string;
  slide_transition_duration?: number;
  verse_font_family?: string;
  reference_font_size?: number;
  reference_color?: string;
  reference_font_family?: string;
  chapter_verse_font_size?: number;
  chapter_verse_font_family?: string;
  chapter_verse_color?: string;
  disabled_bible_versions: string[];
  version_font_family?: string;
  version_font_size?: number;
  version_color?: string;
  auto_split_verses: boolean;
  verse_split_threshold: number;
  preferred_monitor?: string;
  custom_theme_colors?: Partial<ThemeColors>;
  highlight_divine_words?: boolean;
  highlight_color?: string;
}

export interface MonitorInfo {
  name: string; width: number; height: number;
  x: number; y: number; is_primary: boolean;
}

export const FONTS = [
  "Arial", "Georgia", "Times New Roman", "Verdana", "Courier New", "Montserrat", "Oswald", "Playfair Display", "Roboto", "Open Sans"
];

export const DEFAULT_SETTINGS: PresentationSettings = {
  theme: "dark", reference_position: "bottom", background: { type: "None" },
  show_background_logo: false, is_blanked: false, font_size: 72,
  slide_transition: "fade", slide_transition_duration: 0.4,
  verse_font_family: "Georgia, serif", reference_font_size: 36,
  reference_color: "", reference_font_family: "Arial, sans-serif",
  chapter_verse_font_size: undefined, chapter_verse_font_family: undefined, chapter_verse_color: undefined,
  disabled_bible_versions: [], auto_split_verses: true, verse_split_threshold: 200,
};

export const THEMES: Record<string, { label: string; colors: ThemeColors }> = {
  dark:    { label: "Classic Dark", colors: { background: "#000000", verseText: "#ffffff", referenceText: "#f59e0b", waitingText: "#3f3f46" } },
  light:   { label: "Light",        colors: { background: "#f8fafc", verseText: "#0f172a", referenceText: "#b45309", waitingText: "#94a3b8" } },
  navy:    { label: "Navy",         colors: { background: "#0a1628", verseText: "#e2e8f0", referenceText: "#60a5fa", waitingText: "#334155" } },
  maroon:  { label: "Maroon",       colors: { background: "#1a0505", verseText: "#fef2f2", referenceText: "#f87171", waitingText: "#7f1d1d" } },
  forest:  { label: "Forest",       colors: { background: "#051a0a", verseText: "#f0fdf4", referenceText: "#4ade80", waitingText: "#14532d" } },
  slate:   { label: "Slate",        colors: { background: "#1e2a3a", verseText: "#cbd5e1", referenceText: "#94a3b8", waitingText: "#334155" } },
};
