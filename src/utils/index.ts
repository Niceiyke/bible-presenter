import type {
  DisplayItem,
  CustomSlide,
  SlideElement,
  TextElement,
  BackgroundSetting,
  VideoBackground,
  CameraBackground,
  AudioBackground,
  ImageBackground,
  PresentationSettings,
  LowerThirdData,
  LowerThirdTemplate,
  ThemeColors,
  SlideTemplate,
  PresentationExport,
  SlideBackground,
  ProseMirrorJSON,
  SlideTheme,
  SongSlideData,
} from "../types";
import { THEMES } from "../types";
import { convertFileSrc } from "@tauri-apps/api/core";

export function stableId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const fallback = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
  return fallback.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Build a minimal ProseMirror JSON doc wrapping plain text. Used by the
 * element factories (`newTextElement`, `newTitleSlide`, …) so a freshly
 * inserted element already ships as a JSON document (Phase 2.2) and the
 * renderer never has to take the legacy-HTML-string sanitization path
 * for newly authored content. Multi-line text becomes multiple paragraphs.
 */
export function textToDoc(text: string): ProseMirrorJSON {
  const lines = String(text ?? "").split(/\r?\n/);
  const paragraphs = lines.map((line) =>
    line
      ? { type: "paragraph", content: [{ type: "text", text: line }] }
      : { type: "paragraph" },
  );
  return { type: "doc", content: paragraphs.length ? paragraphs : [{ type: "paragraph" }] } as ProseMirrorJSON;
}

export function getItemUid(item: DisplayItem | null): string {
  if (!item) return "empty";
  if (item.type === "Verse") {
    return `verse-${item.data.book}-${item.data.chapter}-${item.data.verse}-${item.data.version}-${item.data.text.slice(0, 16)}`;
  }
  if (item.type === "CustomSlide") {
    return `custom-${item.data.presentation_id}-${item.data.slide_index}`;
  }
  if (item.type === "Media") {
    return `media-${item.data.id}`;
  }
  if (item.type === "Timer") {
    return `timer-${item.data.timer_type}-${item.data.started_at ?? "idle"}`;
  }
  if (item.type === "Song") {
    return `song-${item.data.song_id}-${item.data.slide_index}`;
  }
  if (item.type === "Camera") {
    return `camera-${item.data.deviceId}`;
  }
  return "unknown";
}

export function displayItemLabel(item: DisplayItem): string {
  if (item.type === "Verse") {
    return `${item.data.book} ${item.data.chapter}:${item.data.verse}`;
  }
  if (item.type === "Camera") {
    return item.data.deviceId.startsWith("phone-camera-") ? "Phone Camera" : `Camera Feed: ${item.data.deviceId.slice(0, 8)}...`;
  }
  if (item.type === "CustomSlide") {
    return `${item.data.presentation_name} – Slide ${item.data.slide_index + 1}`;
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
  if (item.type === "Camera") return "Live Camera";
  if (item.type === "CustomSlide") return `${item.data.presentation_name} (S${item.data.slide_index + 1})`;
  if (item.type === "Timer") return `Timer: ${item.data.timer_type}`;
  if (item.type === "Song") return `${item.data.title} (${item.data.section_label})`;
  return "Unknown";
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
  if (path.startsWith("/") || /^[a-zA-Z]:\\/.test(path)) return path;
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
    background: { type: "color", value: "#1a1a2e" },
    elements: [
      {
        id: stableId(),
        kind: "text",
        x: 10, y: 10, w: 80, h: 20, z_index: 1,
        content: textToDoc("Header Text"),
        font_size: 48, font_family: "Arial", color: "#ffffff", align: "center", v_align: "middle", bold: true, italic: false,
      },
      {
        id: stableId(),
        kind: "text",
        x: 10, y: 35, w: 80, h: 50, z_index: 2,
        content: textToDoc("Body Content Goes Here"),
        font_size: 32, font_family: "Arial", color: "#ffffff", align: "center", v_align: "middle", bold: false, italic: false,
      },
    ],
  };
}

export function newTitleSlide(): CustomSlide {
  return {
    id: stableId(),
    background: { type: "color", value: "#1a1a2e" },
    elements: [
      {
        id: stableId(),
        kind: "text",
        x: 10, y: 35, w: 80, h: 30, z_index: 1,
        content: textToDoc("Presentation Title"),
        font_size: 72, font_family: "Georgia", color: "#ffffff", align: "center", v_align: "middle", bold: true, italic: false,
      },
    ],
  };
}

export function newBlankSlide(): CustomSlide {
  return {
    id: stableId(),
    background: { type: "color", value: "#1a1a2e" },
    elements: [],
  };
}

// ─── Slide-layout factories (SLIDE_EDITOR_MODERNIZATION_PLAN §5.3) ──────────
// The "+ Add slide" menu offers a small set of opinionated starter layouts in
// addition to the classic Title / Title-and-content / Blank trio. Each builds
// a plain `CustomSlide` with the same defaults as the existing factories so
// the editor, renderer, and templates all treat them identically.

export function newQuoteSlide(): CustomSlide {
  return {
    id: stableId(),
    background: { type: "color", value: "#1a1a2e" },
    elements: [
      {
        id: stableId(),
        kind: "text",
        x: 12, y: 20, w: 76, h: 40, z_index: 1,
        content: textToDoc('"An inspiring quote goes here."'),
        font_size: 52, font_family: "Georgia", color: "#ffffff", align: "center", v_align: "middle", bold: false, italic: true, shadow: true, shadow_color: "#000000",
      },
      {
        id: stableId(),
        kind: "text",
        x: 12, y: 62, w: 76, h: 12, z_index: 2,
        content: textToDoc("— Attribution"),
        font_size: 30, font_family: "Arial", color: "#f4b740", align: "center", v_align: "middle", bold: true, italic: false,
      },
    ],
  };
}

export function newAnnouncementSlide(): CustomSlide {
  return {
    id: stableId(),
    background: { type: "color", value: "#1a1a2e" },
    elements: [
      {
        id: stableId(),
        kind: "text",
        x: 10, y: 28, w: 80, h: 24, z_index: 1,
        content: textToDoc("Announcement Title"),
        font_size: 56, font_family: "Arial", color: "#ffffff", align: "center", v_align: "middle", bold: true, italic: false,
      },
      {
        id: stableId(),
        kind: "text",
        x: 15, y: 56, w: 70, h: 20, z_index: 2,
        content: textToDoc("Details go here — date, time, place."),
        font_size: 32, font_family: "Arial", color: "#c9d4de", align: "center", v_align: "middle", bold: false, italic: false,
      },
    ],
  };
}

export function newImageCaptionSlide(): CustomSlide {
  return {
    id: stableId(),
    background: { type: "color", value: "#1a1a2e" },
    elements: [
      {
        id: stableId(),
        kind: "text",
        x: 15, y: 15, w: 70, h: 52, z_index: 1,
        content: textToDoc("Image goes here"),
        font_size: 34, font_family: "Arial", color: "#7d8d9d", align: "center", v_align: "middle", bold: false, italic: true,
      },
      {
        id: stableId(),
        kind: "text",
        x: 15, y: 70, w: 70, h: 14, z_index: 2,
        content: textToDoc("Caption"),
        font_size: 26, font_family: "Arial", color: "#ffffff", align: "center", v_align: "middle", bold: false, italic: false,
      },
    ],
  };
}

/** P5 (SLIDE_EDITOR_MODERNIZATION_PLAN §5.3): a Scripture starter layout —
 *  a centered reference line and a body that inherits the theme so the
 *  operator can drop a verse straight in. */
export function newScriptureSlide(): CustomSlide {
  return {
    id: stableId(),
    background: { type: "color", value: "#1a1a2e" },
    elements: [
      {
        id: stableId(),
        kind: "text",
        x: 10, y: 14, w: 80, h: 14, z_index: 1,
        content: textToDoc("John 3:16"),
        font_size: 40, font_family: "Georgia", color: "#f4b740", align: "center", v_align: "middle", bold: true, italic: false,
      },
      {
        id: stableId(),
        kind: "text",
        x: 12, y: 32, w: 76, h: 50, z_index: 2,
        content: textToDoc("For God so loved the world, that he gave his only begotten Son…"),
        font_size: 36, font_family: "Georgia", color: "#ffffff", align: "center", v_align: "middle", bold: false, italic: true, shadow: true, shadow_color: "#000000",
      },
    ],
  };
}

export function deepCloneSlide(slide: CustomSlide): CustomSlide {
  return JSON.parse(JSON.stringify(slide));
}

export function cloneSlideAsTemplate(slide: CustomSlide): CustomSlide {
  const cloned = deepCloneSlide(slide);
  cloned.id = stableId();
  cloned.elements.forEach(e => (e.id = stableId()));
  return cloned;
}

// ─── Text-element factories ──────────────────────────────────────────────────
// Centralizing these means future callers (Bible picker, image picker, video
// picker, "duplicate", etc.) build a SlideElement that satisfies the
// discriminated-union contract instead of a loose bag of optional fields.

export function newTextElement(opts: Partial<Omit<TextElement, "id" | "kind">> = {}): TextElement {
  return {
    id: stableId(),
    kind: "text",
    x: 20, y: 35, w: 60, h: 30, z_index: 1,
    content: textToDoc("Double-click to edit"),
    font_size: 48, font_family: "Arial", color: "#ffffff",
    align: "center", v_align: "middle",
    bold: false, italic: false, shadow: true, shadow_color: "#000000",
    autoSize: "fixed",
    ...opts,
    // Allow callers to pass a *string* prototype (verse text, header
    // text) and have it normalized to a JSON doc automatically.
    ...(opts.content && typeof opts.content === "string" ? { content: textToDoc(opts.content as string) } : {}),
  };
}

export function newImageElement(opts: Partial<Omit<Extract<SlideElement, { kind: "image" }>, "id" | "kind">> = {}): Extract<SlideElement, { kind: "image" }> {
  return {
    id: stableId(),
    kind: "image",
    x: 20, y: 15, w: 60, h: 70, z_index: 1,
    content: "",
    objectFit: "contain",
    objectPosition: "center",
    filter: "none",
    filterValue: 0,
    ...opts,
  };
}

export function newVideoElement(opts: Partial<Omit<Extract<SlideElement, { kind: "video" }>, "id" | "kind">> = {}): Extract<SlideElement, { kind: "video" }> {
  return {
    id: stableId(),
    kind: "video",
    x: 15, y: 10, w: 70, h: 80, z_index: 1,
    content: "",
    loop: true, muted: true,
    ...opts,
  };
}

export function newShapeElement(opts: Partial<Omit<Extract<SlideElement, { kind: "shape" }>, "id" | "kind">> = {}): Extract<SlideElement, { kind: "shape" }> {
  return {
    id: stableId(),
    kind: "shape",
    x: 25, y: 25, w: 50, h: 50, z_index: 1,
    shape: "rect",
    fillColor: "#6366f1", opacity: 0.85,
    ...opts,
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
  slideIdx: number,
  /** Optional `SlideTheme` (P2.4 cascade). Emitted on the on-wire
   *  payload so the output / stage windows can resolve element styles
   *  carrying the `"inherit"` sentinel without an extra presentation
   *  lookup. Callers that already hold the presentation pass it
   *  through; bare registry lookups fall back to `undefined` and the
   *  renderer applies its hardcoded defaults. */
  theme?: SlideTheme,
): DisplayItem {
  const slide = slides[slideIdx];
  return {
    type: "CustomSlide",
    data: {
      presentation_id: presItem.id,
      presentation_name: presItem.name,
      slide_index: slideIdx,
      slide_count: slides.length,
      background: slide.background,
      elements: slide.elements,
      notes: slide.notes,
      theme,
    },
  };
}

export function computeOutputBackground(
  settings: PresentationSettings,
  colors: ThemeColors,
  appDataDir?: string | null
): React.CSSProperties {
  const effectiveColors = settings.custom_theme_colors
    ? { ...colors, ...settings.custom_theme_colors }
    : colors;

  if (settings.background.type === "Color") {
    return { backgroundColor: settings.background.value };
  }
  if (settings.background.type === "Image") {
    const img = settings.background.value;
    if (img?.path) {
      return {
        backgroundImage: `url(${convertFileSrc(resolvePath(img.path, appDataDir ?? null))})`,
        backgroundSize: img.objectFit === "contain" ? "contain" : img.objectFit === "fill" ? "100% 100%" : "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      };
    }
  }
  if (settings.background.type === "Video") {
    return {};
  }
  return { backgroundColor: effectiveColors.background };
}

export function computePreviewBackground(settings: PresentationSettings, themeColor: string, appDataDir?: string | null): React.CSSProperties {
  const color = settings.custom_theme_colors?.background || themeColor;

  if (settings.background.type === "Color") {
    return { backgroundColor: settings.background.value };
  }
  if (settings.background.type === "Image") {
    const img = settings.background.value;
    if (img?.path) {
      return {
        backgroundImage: `url(${convertFileSrc(resolvePath(img.path, appDataDir ?? null))})`,
        backgroundSize: img.objectFit === "contain" ? "contain" : img.objectFit === "fill" ? "100% 100%" : "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      };
    }
  }
  return { backgroundColor: color };
}

/**
 * For a Song item, prefer the per-song background override carried on
 * `SongSlideData.background` (Option B); otherwise fall back to the
 * Settings → Backgrounds "Songs" content override (Option A). `None`
 * on the per-item field means "inherit the content override / global"
 * — same convention the Bible/Media content overrides use.
 *
 * Callers still run the union through their `(bg && bg.type !== "None")
 * ? bg : settings.background` fallback, so returning `undefined` here
 * yields the global output background in that last step.
 */
function songPerItemOrOverride(
  data: SongSlideData,
  settings: PresentationSettings,
): BackgroundSetting | undefined {
  const per = data.background;
  if (per && per.type !== "None") return per;
  return settings.song_background;
}

export function getVideoBackground(
  settings: PresentationSettings,
  item: DisplayItem | null
): VideoBackground | null {
  let bg: BackgroundSetting | undefined;
  if (item?.type === "Verse") bg = settings.bible_background;
  else if (item?.type === "Media") bg = settings.media_background;
  else if (item?.type === "Song") bg = songPerItemOrOverride(item.data, settings);
  else if (item?.type === "CustomSlide")
    bg = settings.background;
  const effective = (bg && bg.type !== "None") ? bg : settings.background;
  if (effective?.type === "Video" && effective.value.path) return effective.value;
  return null;
}

export function getCameraBackground(
  settings: PresentationSettings,
  item: DisplayItem | null
): CameraBackground | null {
  let bg: BackgroundSetting | undefined;
  if (item?.type === "Verse") bg = settings.bible_background;
  else if (item?.type === "Media") bg = settings.media_background;
  else if (item?.type === "Song") bg = songPerItemOrOverride(item.data, settings);
  else if (item?.type === "CustomSlide")
    bg = settings.background;
  const effective = (bg && bg.type !== "None") ? bg : settings.background;
  if (effective?.type === "Camera" && effective.value.deviceId) return effective.value;
  return null;
}

export function getAudioBackground(
  settings: PresentationSettings,
  item: DisplayItem | null
): AudioBackground | null {
  let bg: BackgroundSetting | undefined;
  if (item?.type === "Verse") bg = settings.bible_background;
  else if (item?.type === "Media") bg = settings.media_background;
  else if (item?.type === "Song") bg = songPerItemOrOverride(item.data, settings);
  else if (item?.type === "CustomSlide")
    bg = settings.background;
  const effective = (bg && bg.type !== "None") ? bg : settings.background;
  if (effective?.type === "Audio" && effective.value.path) return effective.value;
  return null;
}

export function getImageBackground(
  settings: PresentationSettings,
  item: DisplayItem | null
): ImageBackground | null {
  let bg: BackgroundSetting | undefined;
  if (item?.type === "Verse") bg = settings.bible_background;
  else if (item?.type === "Media") bg = settings.media_background;
  else if (item?.type === "Song") bg = songPerItemOrOverride(item.data, settings);
  else if (item?.type === "CustomSlide")
    bg = settings.background;
  const effective = (bg && bg.type !== "None") ? bg : settings.background;
  if (effective?.type === "Image" && effective.value?.path) return effective.value;
  return null;
}

export function getEffectiveBackground(
  settings: PresentationSettings,
  item: DisplayItem | null,
  colors: ThemeColors,
  appDataDir?: string | null
): React.CSSProperties {
  const pick = (bg: BackgroundSetting | undefined) => {
    if (!bg || bg.type === "None") return null;
    return computeOutputBackground({ ...settings, background: bg }, colors, appDataDir);
  };
  if (item?.type === "Verse") {
    const s = pick(settings.bible_background);
    if (s) return s;
  }
  if (item?.type === "Media") {
    const s = pick(settings.media_background);
    if (s) return s;
  }
  if (item?.type === "Song") {
    // Per-song override wins over the Settings → Backgrounds "Songs" override,
    // which in turn wins over the global output background (the caller's
    // final fallback at the bottom of this function).
    const perItem = pick(item.data.background);
    if (perItem) return perItem;
    const s = pick(settings.song_background);
    if (s) return s;
  }
  return computeOutputBackground(settings, colors, appDataDir);
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
    default:
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit:    { opacity: 0 },
        transition: d,
      };
  }
}

export function exportPresentation(pres: { presentation: any }): PresentationExport {
  return {
    version: 2,
    presentation: pres.presentation,
    exported_at: Date.now(),
  };
}

export function importPresentation(data: unknown): { success: boolean; presentation?: any; error?: string } {
  try {
    const exp = data as PresentationExport;
    if (!exp.presentation || !exp.presentation.id || !exp.presentation.slides) {
      return { success: false, error: "Invalid presentation file: missing required fields" };
    }
    return { success: true, presentation: exp.presentation };
  } catch (e) {
    return { success: false, error: "Failed to parse presentation file" };
  }
}

export const FONTS = [
  "Arial", "Georgia", "Times New Roman", "Verdana", "Courier New", "Montserrat", "Oswald", "Playfair Display", "Roboto", "Open Sans"
];

// ─── P4.1: built-in starter templates ───────────────────────────────────────
// Deterministic deck templates offered in the gallery alongside user-saved
// single-slide templates. Each factory returns a fresh deck with new ids on
// every call, and the caller re-keys slides/elements on insert anyway
// (`handleInsertTemplate`), so id stability here is not required.
function textEl(text: string, extra: Partial<SlideElement> = {}): SlideElement {
  return newTextElement({
    x: 10, y: 35, w: 80, h: 30,
    font_size: 48, font_family: "Arial", color: "#ffffff",
    align: "center", v_align: "middle", bold: false,
    ...extra,
    content: text,
  } as any);
}

/** P4.1: named built-in deck templates the gallery always offers. */
export const BUILTIN_DECKS: { name: string; category: string; slides: () => CustomSlide[] }[] = [
  {
    name: "Sermon Series (3 slides)",
    category: "Starter",
    slides: () => [
      { id: stableId(), background: { type: "color", value: "#1a1a2e" }, elements: [
        textEl("Sermon Series", { y: 30, h: 25, font_size: 88 }),
        textEl("Title Goes Here", { y: 60, h: 15, font_size: 40, bold: false }),
      ]},
      { id: stableId(), background: { type: "color", value: "#0f2438" }, elements: [
        textEl("Main Point", { y: 25, h: 20, font_size: 64 }),
        textEl("Supporting passage / notes", { y: 55, h: 30, font_size: 36, bold: false }),
      ]},
      { id: stableId(), background: { type: "color", value: "#2a0f0f" }, elements: [
        textEl("Closing & Call to Action", { y: 35, h: 25, font_size: 52 }),
        textEl("Repeated line", { y: 65, h: 15, font_size: 32, bold: false }),
      ]},
    ],
  },
  {
    name: "Worship Set (4 slides)",
    category: "Starter",
    slides: () => [
      { id: stableId(), background: { type: "color", value: "#132a13" }, elements: [
        textEl("Song Title", { y: 30, h: 25, font_size: 72 }),
        textEl("Key · Tempo info", { y: 62, h: 12, font_size: 28, bold: false }),
      ]},
      { id: stableId(), background: { type: "color", value: "#132a13" }, elements: [
        textEl("Verse 1", { y: 20, h: 15, font_size: 40 }),
        textEl("Lines of the first verse", { y: 40, h: 45, font_size: 34, bold: false }),
      ]},
      { id: stableId(), background: { type: "color", value: "#132a13" }, elements: [
        textEl("Verse 2", { y: 20, h: 15, font_size: 40 }),
        textEl("Lines of the second verse", { y: 40, h: 45, font_size: 34, bold: false }),
      ]},
      { id: stableId(), background: { type: "color", value: "#132a13" }, elements: [
        textEl("Bridge / Outro", { y: 30, h: 30, font_size: 52 }),
      ]},
    ],
  },
  {
    name: "Announcement Loop (2 slides)",
    category: "Starter",
    slides: () => [
      { id: stableId(), background: { type: "color", value: "#1a1a2e" }, elements: [
        textEl("Upcoming Event", { y: 25, h: 20, font_size: 56 }),
        textEl("Date · Time · Location", { y: 55, h: 30, font_size: 34, bold: false }),
      ]},
      { id: stableId(), background: { type: "color", value: "#241a2e" }, elements: [
        textEl("Ministry Spotlight", { y: 30, h: 25, font_size: 48 }),
        textEl("How to get involved", { y: 62, h: 20, font_size: 30, bold: false }),
      ]},
    ],
  },
];
