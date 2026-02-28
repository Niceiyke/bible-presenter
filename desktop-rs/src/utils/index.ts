import type {
  DisplayItem,
  CustomSlide,
  BackgroundSetting,
  VideoBackground,
  PresentationSettings,
  LowerThirdData,
  LowerThirdTemplate,
  ThemeColors,
  LayerContent
} from "../types";
import { THEMES } from "../types";
import { convertFileSrc } from "@tauri-apps/api/core";

export function stableId(): string {
  return crypto.randomUUID();
}

export function displayItemLabel(item: DisplayItem): string {
  if (item.type === "Verse") {
    return `${item.data.book} ${item.data.chapter}:${item.data.verse}`;
  }
  if (item.type === "PresentationSlide") {
    return `${item.data.presentation_name} – Slide ${item.data.slide_index + 1}`;
  }
  if (item.type === "CustomSlide") {
    return `${item.data.presentation_name} – Slide ${item.data.slide_index + 1}`;
  }
  if (item.type === "CameraFeed") {
    return `Camera: ${item.data.label || item.data.device_id}`;
  }
  if (item.type === "Scene") {
    return `Scene: ${item.data.name}`;
  }
  if (item.type === "Timer") {
    return `Timer: ${item.data.timer_type}`;
  }
  if (item.type === "Song") {
    return `Song: ${item.data.title} (${item.data.section_label})`;
  }
  return (item as any).data?.name || "Item";
}

export function describeDisplayItem(item: DisplayItem): string {
  if (item.type === "Verse") return `${item.data.book} ${item.data.chapter}:${item.data.verse}`;
  if (item.type === "Media") return item.data.name;
  if (item.type === "PresentationSlide") return `${item.data.presentation_name} (S${item.data.slide_index + 1})`;
  if (item.type === "CustomSlide") return `${item.data.presentation_name} (S${item.data.slide_index + 1})`;
  if (item.type === "CameraFeed") return item.data.device_name ?? item.data.label;
  if (item.type === "Scene") return `Scene: ${item.data.name}`;
  if (item.type === "Timer") return `Timer: ${item.data.timer_type}`;
  if (item.type === "Song") return `${item.data.title} (${item.data.section_label})`;
  return "Unknown";
}

export function describeLayerContent(c: LayerContent): string {
  if (c.kind === "empty") return "Empty";
  if (c.kind === "lower-third") return `Lower Third (${c.ltData.kind})`;
  if (c.kind === "static-color") return `Color: ${c.color}`;
  if (c.kind === "static-image") return `Image: ${c.path.split(/[\\/]/).pop() ?? c.path}`;
  if (c.kind === "source") {
    const s = c.source;
    if (s.type === "live-output") return "SOURCE: Live Output";
    if (s.type === "lower-third") return "SOURCE: Lower Third";
    if (s.type === "camera-lan") return `SOURCE: ${s.device_name} (LAN)`;
    if (s.type === "camera-local") return `SOURCE: ${s.label} (Local)`;
  }
  return describeDisplayItem((c as any).item);
}

export function hexToRgba(hex: string, opacity: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${(opacity / 100).toFixed(2)})`;
}

export function resolvePath(path: string | undefined, baseDir: string | null): string {
  if (!path) return "";
  if (!baseDir) return path;
  // If it's already absolute (starts with / or C:\ etc), return as is
  if (path.startsWith("/") || /^[a-zA-Z]:\\/.test(path)) return path;
  // Otherwise, join with baseDir/media
  const separator = baseDir.includes("\\") ? "\\" : "/";
  return `${baseDir}${separator}media${separator}${path}`;
}

export function relativizePath(path: string | undefined, baseDir: string | null): string {
  if (!path) return "";
  if (!baseDir) return path;
  const mediaDir = `${baseDir}${baseDir.includes("\\") ? "\\" : "/"}media`;
  if (path.startsWith(mediaDir)) {
    return path.slice(mediaDir.length + 1);
  }
  return path;
}

export function newDefaultSlide(): CustomSlide {
  return {
    id: stableId(),
    backgroundColor: "#1a1a2e",
    elements: [
      {
        id: stableId(),
        kind: "text",
        x: 10, y: 10, w: 80, h: 20, z_index: 1,
        content: "Header Text",
        font_size: 48, font_family: "Arial", color: "#ffffff", align: "center", v_align: "middle", bold: true, italic: false
      },
      {
        id: stableId(),
        kind: "text",
        x: 10, y: 35, w: 80, h: 50, z_index: 2,
        content: "Body Content Goes Here",
        font_size: 32, font_family: "Arial", color: "#ffffff", align: "center", v_align: "middle", bold: false, italic: false
      }
    ]
  };
}

export function newTitleSlide(): CustomSlide {
  return {
    id: stableId(),
    backgroundColor: "#1a1a2e",
    elements: [
      {
        id: stableId(),
        kind: "text",
        x: 10, y: 35, w: 80, h: 30, z_index: 1,
        content: "Presentation Title",
        font_size: 72, font_family: "Georgia", color: "#ffffff", align: "center", v_align: "middle", bold: true, italic: false
      }
    ]
  };
}

export function newBlankSlide(): CustomSlide {
  return {
    id: stableId(),
    backgroundColor: "#1a1a2e",
    elements: []
  };
}

export function ltBuildLyricsPayload(
  ltFlatLines: { text: string; sectionLabel: string }[],
  lineIndex: number,
  linesPerDisplay: 1 | 2,
): LowerThirdData | null {
  if (ltFlatLines.length === 0) return null;
  const line1 = ltFlatLines[lineIndex];
  if (!line1) return null;
  const line2Entry = linesPerDisplay === 2 ? ltFlatLines[lineIndex + 1] : undefined;
  return {
    kind: "Lyrics",
    data: { line1: line1.text, line2: line2Entry?.text, section_label: line1.sectionLabel },
  };
}

export function buildCustomSlideItem(
  presItem: { id: string; name: string; slide_count: number },
  slides: CustomSlide[],
  slideIdx: number
): DisplayItem {
  const slide = slides[slideIdx];
  return {
    type: "CustomSlide",
    data: {
      presentation_id: presItem.id,
      presentation_name: presItem.name,
      slide_index: slideIdx,
      slide_count: slides.length,
      background_color: slide.backgroundColor,
      background_image: slide.backgroundImage,
      elements: slide.elements,
      // Legacy fields
      header_enabled: slide.headerEnabled ?? true,
      header_height_pct: slide.headerHeightPct ?? 35,
      header: slide.header ? { 
        text: slide.header.text, 
        font_size: slide.header.fontSize, 
        font_family: slide.header.fontFamily, 
        color: slide.header.color, 
        bold: slide.header.bold, 
        italic: slide.header.italic, 
        align: slide.header.align 
      } : undefined,
      body: slide.body ? { 
        text: slide.body.text,   
        font_size: slide.body.fontSize,   
        font_family: slide.body.fontFamily,   
        color: slide.body.color,   
        bold: slide.body.bold,   
        italic: slide.body.italic,   
        align: slide.body.align 
      } : undefined,
    },
  };
}

export function computeOutputBackground(
  settings: PresentationSettings,
  colors: ThemeColors
): React.CSSProperties {
  if (settings.background.type === "Color") {
    return { backgroundColor: settings.background.value };
  }
  if (settings.background.type === "Image") {
    const imgPath = settings.background.value;
    if (imgPath) {
      return {
        backgroundImage: `url(${convertFileSrc(imgPath)})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      };
    }
  }
  // Video backgrounds are rendered as a separate <video> element
  if (settings.background.type === "Video") {
    return {};
  }
  return { backgroundColor: colors.background };
}

export function computePreviewBackground(settings: PresentationSettings, themeColor: string): React.CSSProperties {
  if (settings.background.type === "Color") {
    return { backgroundColor: settings.background.value };
  }
  if (settings.background.type === "Image") {
    const imgPath = settings.background.value;
    if (imgPath) {
      return {
        backgroundImage: `url(${convertFileSrc(imgPath)})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      };
    }
  }
  return { backgroundColor: themeColor };
}

export function getCameraBackgroundDeviceId(
  settings: PresentationSettings,
  item: DisplayItem | null
): string | null {
  let bg: BackgroundSetting | undefined;
  if (item?.type === "Verse") bg = settings.bible_background;
  else if (item?.type === "Media") bg = settings.media_background;
  else if (item?.type === "PresentationSlide" || item?.type === "CustomSlide")
    bg = settings.presentation_background;
  const effective = (bg && bg.type !== "None") ? bg : settings.background;
  if (effective?.type === "Camera") return effective.value;
  return null;
}

/** Returns the VideoBackground config if the effective background for the current item is a video, otherwise null. */
export function getVideoBackground(
  settings: PresentationSettings,
  item: DisplayItem | null
): VideoBackground | null {
  let bg: BackgroundSetting | undefined;
  if (item?.type === "Verse") bg = settings.bible_background;
  else if (item?.type === "Media") bg = settings.media_background;
  else if (item?.type === "PresentationSlide" || item?.type === "CustomSlide")
    bg = settings.presentation_background;
  const effective = (bg && bg.type !== "None") ? bg : settings.background;
  if (effective?.type === "Video" && effective.value.path) return effective.value;
  return null;
}

export function getEffectiveBackground(
  settings: PresentationSettings,
  item: DisplayItem | null,
  colors: ThemeColors
): React.CSSProperties {
  const pick = (bg: BackgroundSetting | undefined) => {
    if (!bg || bg.type === "None") return null;
    return computeOutputBackground({ ...settings, background: bg }, colors);
  };
  if (item?.type === "Verse") {
    const s = pick(settings.bible_background);
    if (s) return s;
  }
  if (item?.type === "PresentationSlide") {
    const s = pick(settings.presentation_background);
    if (s) return s;
  }
  if (item?.type === "Media") {
    const s = pick(settings.media_background);
    if (s) return s;
  }
  return computeOutputBackground(settings, colors);
}

export function getTransitionVariants(type: string, duration: number) {
  const d = { duration };
  switch (type) {
    case "slide-up":
      return {
        initial: { opacity: 0, y: 40 },
        animate: { opacity: 1, y: 0 },
        exit:    { opacity: 0, y: 40 },
        transition: d,
      };
    case "slide-left":
      return {
        initial: { opacity: 0, x: 60 },
        animate: { opacity: 1, x: 0 },
        exit:    { opacity: 0, x: 60 },
        transition: d,
      };
    case "zoom":
      return {
        initial: { opacity: 0, scale: 0.92 },
        animate: { opacity: 1, scale: 1 },
        exit:    { opacity: 0, scale: 0.92 },
        transition: d,
      };
    case "none":
      return {
        initial: { opacity: 1 },
        animate: { opacity: 1 },
        exit:    { opacity: 1 },
        transition: { duration: 0 },
      };
    default: // "fade"
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit:    { opacity: 0 },
        transition: d,
      };
  }
}

export const FONTS = [
  "Arial", "Georgia", "Times New Roman", "Verdana", "Courier New", "Montserrat", "Oswald", "Playfair Display", "Roboto", "Open Sans"
];
