import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, emit } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { loadPptxZip, parseSingleSlide, getSlideCount } from "./pptxParser";
import type { ParsedSlide } from "./pptxParser";
import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen, Image, Presentation, Layers, CalendarDays, Type, Music, Settings,
  RefreshCw, X, ChevronUp, ChevronDown, ChevronRight, ChevronLeft,
  Eye, EyeOff, Monitor, Mic, MicOff, Upload, Plus, Clock, Zap,
  Edit2, Trash2,
} from "lucide-react";
import { useAppStore } from "./store";
import { BibleTab } from "./components/BibleTab";
import { MediaTab } from "./components/MediaTab";
import PresentationsTab from "./components/PresentationsTab";
import ScheduleTab from "./components/ScheduleTab";
import SongsTab from "./components/SongsTab";
import PropsTab from "./components/PropsTab";
import LowerThirdTab from "./components/LowerThirdTab";
import SettingsTab from "./components/SettingsTab";

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Custom Studio types ──────────────────────────────────────────────────────

export interface SlideZone {
  text: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
}

export interface CustomSlide {
  id: string;
  backgroundColor: string;
  backgroundImage?: string;
  /** Whether the header/title zone is displayed (default true). */
  headerEnabled: boolean;
  /** Height of the header zone as a percentage (10–60, default 35). */
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
  body:   { text: string; font_size: number; font_family: string; color: string; bold: boolean; italic: boolean; align: string };
}

export const FONTS = [
  "Arial", "Verdana", "Helvetica", "Trebuchet MS",
  "Georgia", "Times New Roman", "Palatino",
  "Impact", "Arial Black", "Courier New",
];

export interface CameraFeedData {
  device_id: string;
  label: string;
  /** true = LAN WebRTC stream from a mobile device over the signaling server */
  lan?: boolean;
  /** Human-readable name for LAN sources */
  device_name?: string;
}

/** A connected LAN mobile camera source (live WebRTC preview). */
export interface CameraSource {
  device_id: string;
  device_name: string;
  previewStream: MediaStream | null;
  previewPc: RTCPeerConnection | null;
  status: 'connecting' | 'connected' | 'disconnected';
  connectedAt: number;
  enabled: boolean;  // whether preview WebRTC is active
}

// LayerContent union — what a layer can show
export type LayerContent =
  | { kind: "empty" }
  | { kind: "item"; item: DisplayItem }
  | { kind: "lower-third"; ltData: LowerThirdData; template: LowerThirdTemplate };

// SceneLayer — a single composited layer (replaces SceneSlot)
export interface SceneLayer {
  id: string;
  name: string;
  content: LayerContent;
  x: number;      // left edge, 0–100 % of canvas width
  y: number;      // top edge, 0–100 % of canvas height
  w: number;      // width, 0–100 %
  h: number;      // height, 0–100 %
  opacity: number; // 0–1
  visible: boolean;
}

export interface SceneData {
  id: string;
  name: string;
  layers: SceneLayer[];           // index 0 = bottom, last = top
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

// ─── Song types ───────────────────────────────────────────────────────────────

export interface LyricSection {
  label: string;
  lines: string[];
}

export interface Song {
  id: string;
  title: string;
  author?: string;
  sections: LyricSection[];
  /** Ordered section labels for playback (may repeat). Empty = use sections order. */
  arrangement?: string[];
}

// ─── Lower third types ────────────────────────────────────────────────────────

export type LowerThirdData =
  | { kind: "Nameplate"; data: { name: string; title?: string } }
  | { kind: "Lyrics";    data: { line1: string; line2?: string; section_label?: string } }
  | { kind: "FreeText";  data: { text: string } };

export interface LowerThirdTemplate {
  id: string; name: string;
  // Background
  bgType: "solid" | "gradient" | "transparent" | "image";
  bgColor: string; bgOpacity: number; bgGradientEnd: string; bgBlur: boolean;
  bgImagePath?: string;
  // Accent bar
  accentEnabled: boolean; accentColor: string;
  accentSide: "left" | "right" | "top" | "bottom"; accentWidth: number;
  // Position
  hAlign: "left" | "center" | "right"; vAlign: "top" | "middle" | "bottom";
  offsetX: number; offsetY: number;
  // Size
  widthPct: number; paddingX: number; paddingY: number; borderRadius: number;
  // Primary text (name / line1 / free text)
  primaryFont: string; primarySize: number; primaryColor: string;
  primaryBold: boolean; primaryItalic: boolean; primaryUppercase: boolean;
  // Secondary text (title / line2)
  secondaryFont: string; secondarySize: number; secondaryColor: string;
  secondaryBold: boolean; secondaryItalic: boolean; secondaryUppercase: boolean;
  // Section label
  labelVisible: boolean; labelColor: string; labelSize: number; labelUppercase: boolean;
  // Animation
  animation: "fade" | "slide-up" | "slide-left" | "none";
  // Design variant
  variant: "classic" | "modern" | "banner";
  // FreeText scroll
  scrollEnabled: boolean;
  scrollDirection: "ltr" | "rtl";
  scrollSpeed: number;
}

const DEFAULT_LT_TEMPLATE: LowerThirdTemplate = {
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

// Background is a serde-tagged enum: { type: "None" } | { type: "Color"; value: string } | { type: "Image"; value: string } | { type: "Camera"; value: string }
export type BackgroundSetting =
  | { type: "None" }
  | { type: "Color"; value: string }
  | { type: "Image"; value: string }
  | { type: "Camera"; value: string };

export interface PresentationSettings {
  theme: string;
  reference_position: "top" | "bottom";
  background: BackgroundSetting;
  /** Override background specifically for Bible verse display. */
  bible_background?: BackgroundSetting;
  /** Override background specifically for PPTX/presentation slides. */
  presentation_background?: BackgroundSetting;
  /** Override background specifically for media (image/video). */
  media_background?: BackgroundSetting;
  logo_path?: string;
  is_blanked: boolean;
  font_size: number;
  /** Slide transition type: "fade" | "slide-up" | "slide-left" | "zoom" | "none" */
  slide_transition?: string;
  /** Transition duration in seconds (0.1–2.0). */
  slide_transition_duration?: number;
}

// ─── Themes ───────────────────────────────────────────────────────────────────
// Defined as plain objects (not Tailwind classes) to avoid content purging.

export interface ThemeColors {
  background: string;
  verseText: string;
  referenceText: string;
  waitingText: string;
}

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stableId(): string {
  return crypto.randomUUID();
}

function displayItemLabel(item: DisplayItem): string {
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
  return item.data.name;
}

function newDefaultSlide(): CustomSlide {
  return {
    id: stableId(),
    backgroundColor: "#0a1628",
    backgroundImage: undefined,
    headerEnabled: true,
    headerHeightPct: 35,
    header: { text: "Title", fontSize: 56, fontFamily: "Georgia", color: "#ffffff", bold: true, italic: false, align: "center" },
    body:   { text: "Body text here", fontSize: 34, fontFamily: "Arial", color: "#e2e8f0", bold: false, italic: false, align: "center" },
  };
}

/** Computes the background style for the output window, respecting background override. */
function computeOutputBackground(
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
  // Camera backgrounds are rendered as a separate video layer — no CSS needed here
  if (settings.background.type === "Camera") {
    return {};
  }
  return { backgroundColor: colors.background };
}

/** Returns the deviceId if the effective background for the current item is a camera, else null. */
function getCameraBackgroundDeviceId(
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

/** Computes background style for the settings preview panel. */
function computePreviewBackground(
  settings: PresentationSettings,
  themeColor: string
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
  return { backgroundColor: themeColor };
}

/** Returns the effective background for the output window based on item type. */
function getEffectiveBackground(
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

// ─── Slide Renderer ───────────────────────────────────────────────────────────
// Renders a ParsedSlide as a full-size div with background, images and text boxes.

function SlideRenderer({ slide }: { slide: any }) {
  const bgStyle: React.CSSProperties = slide.backgroundColor
    ? { backgroundColor: slide.backgroundColor }
    : { backgroundColor: "#1a1a2e" };

  return (
    <div className="w-full h-full relative overflow-hidden" style={bgStyle}>
      {slide.images.map((img: any, i: number) => (
        <img
          key={i}
          src={img.dataUrl}
          className="absolute"
          alt=""
          style={{
            zIndex: i,
            left: `${img.rect.x}%`,
            top: `${img.rect.y}%`,
            width: `${img.rect.width}%`,
            height: `${img.rect.height}%`,
            objectFit: "contain",
          }}
        />
      ))}
      {slide.textBoxes.map((tb: any, i: number) => (
        <div
          key={i}
          className="absolute flex items-center justify-center"
          style={{
            zIndex: slide.images.length + i,
            left: `${tb.rect.x}%`,
            top: `${tb.rect.y}%`,
            width: `${tb.rect.width}%`,
            height: `${tb.rect.height}%`,
          }}
        >
          <p
            className="text-center leading-tight drop-shadow-2xl whitespace-pre-wrap"
            style={{
              color: tb.color ?? "#ffffff",
              fontSize: tb.fontSize ? `${tb.fontSize}pt` : "3rem",
              fontWeight: tb.bold ? "bold" : "normal",
            }}
          >
            {tb.text}
          </p>
        </div>
      ))}
    </div>
  );
}

// ─── Custom Slide Renderer ───────────────────────────────────────────────────
// Shared by output window, editor canvas preview, Studio thumbnails, and PreviewCard.
// Accepts either a `CustomSlide` (camelCase) or `CustomSlideDisplayData` (snake_case).

function CustomSlideRenderer({
  slide,
  scale = 1,
}: {
  slide: CustomSlide | CustomSlideDisplayData;
  scale?: number;
}) {
  const header = (slide as any).header;
  const body   = (slide as any).body;
  const bgColor = "backgroundColor" in slide ? (slide as CustomSlide).backgroundColor : (slide as CustomSlideDisplayData).background_color;
  const bgImage = "backgroundImage" in slide ? (slide as CustomSlide).backgroundImage : (slide as CustomSlideDisplayData).background_image;

  // Support both camelCase (editor) and snake_case (display data), with defaults for old slides
  const headerEnabled = "headerEnabled" in slide
    ? (slide as CustomSlide).headerEnabled !== false
    : (slide as CustomSlideDisplayData).header_enabled !== false;
  const headerHeightPct = ("headerHeightPct" in slide
    ? (slide as CustomSlide).headerHeightPct
    : (slide as CustomSlideDisplayData).header_height_pct) ?? 35;

  const bgStyle: React.CSSProperties = bgImage
    ? { backgroundImage: `url(${convertFileSrc(bgImage)})`, backgroundSize: "cover", backgroundPosition: "center" }
    : { backgroundColor: bgColor };

  const zoneStyle = (z: any): React.CSSProperties => ({
    fontFamily: z.fontFamily ?? z.font_family ?? "Arial",
    fontSize: `${(z.fontSize ?? z.font_size ?? 32) * scale}pt`,
    color: z.color ?? "#ffffff",
    fontWeight: z.bold ? "bold" : "normal",
    fontStyle: z.italic ? "italic" : "normal",
    textAlign: (z.align ?? "center") as React.CSSProperties["textAlign"],
    textShadow: "0 2px 8px rgba(0,0,0,0.6)",
    whiteSpace: "pre-wrap",
    lineHeight: 1.3,
    margin: 0,
  });

  if (!headerEnabled) {
    return (
      <div className="w-full h-full relative overflow-hidden flex flex-col" style={bgStyle}>
        <div className="flex items-center justify-center flex-1" style={{ padding: `${14 * scale}px ${24 * scale}px` }}>
          <p style={zoneStyle(body)}>{body.text}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative overflow-hidden flex flex-col" style={bgStyle}>
      {/* Header zone — configurable height */}
      <div className="flex items-center justify-center" style={{ flex: `0 0 ${headerHeightPct}%`, padding: `${14 * scale}px ${24 * scale}px` }}>
        <p style={zoneStyle(header)}>{header.text}</p>
      </div>
      {/* Divider line */}
      <div style={{ height: `${Math.max(1, scale)}px`, backgroundColor: "rgba(255,255,255,0.15)", margin: `0 ${24 * scale}px` }} />
      {/* Body zone — remaining space */}
      <div className="flex items-center justify-center flex-1" style={{ padding: `${14 * scale}px ${24 * scale}px` }}>
        <p style={zoneStyle(body)}>{body.text}</p>
      </div>
    </div>
  );
}

function SmallItemPreview({ item }: { item: DisplayItem }) {
  switch (item.type) {
    case "Verse":
      return (
        <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center bg-slate-900/50">
          <p className="text-xs font-serif line-clamp-3 mb-1 opacity-80">{item.data.text}</p>
          <p className="text-[8px] font-black text-amber-500 uppercase">{item.data.book} {item.data.chapter}:{item.data.verse}</p>
        </div>
      );
    case "Media":
      return item.data.media_type === "Image" ? (
        <img src={convertFileSrc(item.data.path)} className="w-full h-full object-cover" />
      ) : (
        <video src={convertFileSrc(item.data.path)} className="w-full h-full object-cover" muted />
      );
    case "CameraFeed":
      // LAN sources: device_id is a mobile UUID, not a browser deviceId — don't call getUserMedia
      if (item.data.lan) {
        return (
          <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900/60 gap-1">
            <span className="text-2xl">📷</span>
            <p className="text-[8px] font-bold text-teal-400 uppercase text-center px-1 truncate max-w-full">
              {item.data.device_name || item.data.label || "LAN Cam"}
            </p>
          </div>
        );
      }
      return <CameraFeedRenderer deviceId={item.data.device_id} />;
    case "CustomSlide":
      return <CustomSlideRenderer slide={item.data} scale={0.1} />;
    case "PresentationSlide":
      return <div className="w-full h-full bg-orange-900/20 flex items-center justify-center text-[10px] font-bold text-orange-500">PPTX SLIDE</div>;
    case "Scene":
      return <SceneRenderer scene={item.data} />;
    default:
      return null;
  }
}

// ─── Layer Content Renderer ───────────────────────────────────────────────────
// Renders a single layer's content inside its absolutely-positioned div.

function LayerContentRenderer({ content, outputMode = false }: { content: LayerContent; outputMode?: boolean }) {
  if (content.kind === "empty") {
    if (outputMode) return null;
    return (
      <div className="w-full h-full flex items-center justify-center"
        style={{ background: "repeating-conic-gradient(#1e293b 0% 25%, #0f172a 0% 50%) 0 0 / 16px 16px" }}>
        <Plus size={16} className="text-slate-600" />
      </div>
    );
  }
  if (content.kind === "lower-third") {
    return (
      <div className="absolute inset-0">
        <LowerThirdOverlay data={content.ltData} template={content.template} />
      </div>
    );
  }
  // kind === "item"
  const { item } = content;
  switch (item.type) {
    case "Verse":
      return (
        <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center">
          <p className={outputMode ? "font-serif text-5xl text-white leading-snug drop-shadow-2xl" : "text-xs font-serif line-clamp-3 mb-1 opacity-80"}>
            {item.data.text}
          </p>
          <p className={outputMode ? "text-2xl font-black text-amber-400 mt-4" : "text-[8px] font-black text-amber-500 uppercase"}>
            {item.data.book} {item.data.chapter}:{item.data.verse}
          </p>
        </div>
      );
    case "Media":
      return item.data.media_type === "Image" ? (
        <img src={convertFileSrc(item.data.path)} className="w-full h-full object-cover" alt={item.data.name} />
      ) : (
        <video
          src={convertFileSrc(item.data.path)}
          className="w-full h-full object-cover"
          autoPlay={outputMode}
          loop={outputMode}
          muted={!outputMode}
        />
      );
    case "CameraFeed":
      if (item.data.lan) {
        return (
          <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900/60 gap-1">
            <span className="text-2xl">📷</span>
            <p className="text-[8px] font-bold text-teal-400 uppercase text-center px-1 truncate max-w-full">
              {item.data.device_name || item.data.label || "LAN Cam"}
            </p>
          </div>
        );
      }
      return <CameraFeedRenderer deviceId={item.data.device_id} />;
    case "CustomSlide":
      return <CustomSlideRenderer slide={item.data} scale={outputMode ? 1 : 0.1} />;
    case "PresentationSlide":
      return (
        <div className="w-full h-full bg-orange-900/20 flex items-center justify-center text-[10px] font-bold text-orange-500">
          PPTX SLIDE
        </div>
      );
    case "Scene":
      return <SceneRenderer scene={item.data} outputMode={outputMode} />;
    default:
      return null;
  }
}

function SceneRenderer({
  scene,
  scale = 1,
  activeLayerId,
  onLayerClick,
  outputMode = false,
}: {
  scene: SceneData;
  scale?: number;
  activeLayerId?: string | null;
  onLayerClick?: (id: string) => void;
  outputMode?: boolean;
}) {
  const bg = scene.background;
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        transform: scale !== 1 ? `scale(${scale})` : undefined,
        transformOrigin: "top left",
        width: scale !== 1 ? `${100 / scale}%` : "100%",
        height: scale !== 1 ? `${100 / scale}%` : "100%",
        backgroundColor: bg?.type === "Color" ? bg.value : "#000000",
        backgroundImage: bg?.type === "Image" ? `url(${convertFileSrc(bg.value)})` : undefined,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {(scene.layers ?? []).filter(l => l.visible).map((layer, i) => (
        <div
          key={layer.id}
          onClick={(e) => { e.stopPropagation(); onLayerClick?.(layer.id); }}
          style={{
            position: "absolute",
            left: `${layer.x}%`,
            top: `${layer.y}%`,
            width: `${layer.w}%`,
            height: `${layer.h}%`,
            opacity: layer.opacity,
            zIndex: i,
            outline: (!outputMode && activeLayerId === layer.id) ? "2px solid #3b82f6" : "none",
            cursor: outputMode ? undefined : "pointer",
            overflow: "hidden",
          }}
        >
          <LayerContentRenderer content={layer.content} outputMode={outputMode} />
          {!outputMode && activeLayerId === layer.id && (
            <div className="absolute top-1 right-1 bg-blue-500 text-white text-[8px] font-black px-1 rounded shadow-lg pointer-events-none">ACTIVE</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Zone Editor ─────────────────────────────────────────────────────────────
// Editing controls for a single SlideZone (header or body).

function ZoneEditor({
  label,
  zone,
  onChange,
}: {
  label: string;
  zone: SlideZone;
  onChange: (z: SlideZone) => void;
}) {
  return (
    <div className="flex flex-col gap-2 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p>
      <textarea
        value={zone.text}
        onChange={(e) => onChange({ ...zone, text: e.target.value })}
        rows={3}
        className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-200 resize-none focus:outline-none focus:ring-1 focus:ring-amber-500"
      />
      <div className="flex gap-1.5 items-center flex-wrap">
        <select
          value={zone.fontFamily}
          onChange={(e) => onChange({ ...zone, fontFamily: e.target.value })}
          className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none"
        >
          {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <input
          type="number"
          min={8}
          max={200}
          value={zone.fontSize}
          onChange={(e) => onChange({ ...zone, fontSize: Number(e.target.value) })}
          className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none"
        />
        <button
          onClick={() => onChange({ ...zone, bold: !zone.bold })}
          className={`px-2 py-1 rounded text-xs font-black border transition-all ${zone.bold ? "bg-amber-500 border-amber-500 text-black" : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"}`}
        >B</button>
        <button
          onClick={() => onChange({ ...zone, italic: !zone.italic })}
          className={`px-2 py-1 rounded text-xs italic border transition-all ${zone.italic ? "bg-amber-500 border-amber-500 text-black" : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"}`}
        >I</button>
        <input
          type="color"
          value={zone.color}
          onChange={(e) => onChange({ ...zone, color: e.target.value })}
          className="w-7 h-7 rounded cursor-pointer border border-slate-700 bg-transparent"
          title="Text color"
        />
      </div>
      <div className="flex gap-1">
        {(["left", "center", "right"] as const).map((a) => (
          <button
            key={a}
            onClick={() => onChange({ ...zone, align: a })}
            className={`flex-1 py-1 rounded text-xs border transition-all ${zone.align === a ? "bg-amber-500/20 border-amber-500 text-amber-400" : "bg-slate-800 border-slate-700 text-slate-500 hover:border-slate-600"}`}
          >
            {a === "left" ? "◀" : a === "center" ? "▪" : "▶"}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Slide Editor Modal ───────────────────────────────────────────────────────

function SlideEditor({
  initialPres,
  onClose,
  mediaImages = [],
}: {
  initialPres: CustomPresentation;
  onClose: (saved: boolean) => void;
  mediaImages?: MediaItem[];
}) {
  const [pres, setPres] = React.useState<CustomPresentation>(initialPres);
  const [currentSlideIdx, setCurrentSlideIdx] = React.useState(0);
  const [saving, setSaving] = React.useState(false);
  const [showBgImagePicker, setShowBgImagePicker] = React.useState(false);

  const slide = pres.slides[currentSlideIdx] ?? pres.slides[0];

  const updateSlide = (updated: CustomSlide) => {
    setPres((p) => ({
      ...p,
      slides: p.slides.map((s, i) => (i === currentSlideIdx ? updated : s)),
    }));
  };

  const addSlide = () => {
    const newSlide = newDefaultSlide();
    const newSlides = [...pres.slides, newSlide];
    setPres((p) => ({ ...p, slides: newSlides }));
    setCurrentSlideIdx(newSlides.length - 1);
  };

  const deleteSlide = (idx: number) => {
    if (pres.slides.length <= 1) return;
    const newSlides = pres.slides.filter((_, i) => i !== idx);
    setPres((p) => ({ ...p, slides: newSlides }));
    setCurrentSlideIdx(Math.min(idx, newSlides.length - 1));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await invoke("save_studio_presentation", { presentation: pres });
      onClose(true);
    } catch (err) {
      console.error("Failed to save presentation", err);
    } finally {
      setSaving(false);
    }
  };

  const handlePickBgImage = async () => {
    if (mediaImages.length > 0) {
      setShowBgImagePicker(true);
    } else {
      try {
        const selected = await openDialog({
          multiple: false,
          filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
        });
        if (!selected) return;
        updateSlide({ ...slide, backgroundImage: selected as string });
      } catch (err) {
        console.error("Failed to pick background image", err);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/80 shrink-0">
        <button onClick={() => onClose(false)} className="text-slate-400 hover:text-white text-sm font-bold px-2 py-1 rounded transition-all">
          ← Back
        </button>
        <input
          type="text"
          value={pres.name}
          onChange={(e) => setPres((p) => ({ ...p, name: e.target.value }))}
          className="flex-1 bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500 max-w-xs"
          placeholder="Presentation name"
        />
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-xs text-slate-500">
            Slide {currentSlideIdx + 1} / {pres.slides.length}
          </span>
          <button
            onClick={() => setCurrentSlideIdx(Math.max(0, currentSlideIdx - 1))}
            disabled={currentSlideIdx === 0}
            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 disabled:opacity-30 transition-all"
          >◀</button>
          <button
            onClick={() => setCurrentSlideIdx(Math.min(pres.slides.length - 1, currentSlideIdx + 1))}
            disabled={currentSlideIdx >= pres.slides.length - 1}
            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 disabled:opacity-30 transition-all"
          >▶</button>
          <button
            onClick={addSlide}
            className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold rounded border border-slate-600 transition-all"
          >
            + Slide
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold rounded transition-all disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save & Close"}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Slide strip */}
        <div className="w-36 border-r border-slate-800 bg-slate-900/30 flex flex-col overflow-hidden shrink-0">
          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
            {pres.slides.map((s, i) => (
              <div
                key={s.id}
                onClick={() => setCurrentSlideIdx(i)}
                className={`relative group aspect-video rounded overflow-hidden border cursor-pointer transition-all ${
                  i === currentSlideIdx ? "border-amber-500" : "border-slate-700 hover:border-slate-500"
                }`}
              >
                <CustomSlideRenderer slide={s} scale={0.07} />
                <div className="absolute bottom-0 left-0 right-0 text-center text-[7px] text-white/60 bg-black/40 py-0.5">
                  {i + 1}
                </div>
                {pres.slides.length > 1 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteSlide(i); }}
                    className="absolute top-0.5 right-0.5 w-4 h-4 bg-red-800/80 hover:bg-red-600 text-white text-[8px] rounded opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center"
                  >✕</button>
                )}
              </div>
            ))}
          </div>
          <div className="p-2 border-t border-slate-800 shrink-0">
            <button
              onClick={addSlide}
              className="w-full py-2 text-[10px] font-bold text-slate-400 hover:text-white border border-dashed border-slate-700 hover:border-slate-500 rounded transition-all"
            >
              + Add Slide
            </button>
          </div>
        </div>

        {/* Center: Canvas preview + Formatting panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 16:9 canvas preview */}
          <div className="flex-1 flex items-center justify-center bg-slate-950 p-6 overflow-hidden">
            <div
              className="rounded-lg overflow-hidden shadow-2xl border border-slate-700"
              style={{ aspectRatio: "16/9", maxHeight: "100%", maxWidth: "100%", width: "min(100%, calc(100vh * 16/9 * 0.7))" }}
            >
              <CustomSlideRenderer slide={slide} scale={1} />
            </div>
          </div>

          {/* Formatting panel */}
          <div className="border-t border-slate-800 bg-slate-900/50 overflow-y-auto" style={{ maxHeight: "45%" }}>
            <div className="p-4 flex flex-col gap-3">
              {/* Header section with enable toggle */}
              <div className="flex flex-col gap-2 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Header / Title</p>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-slate-500">Show</span>
                    <button
                      onClick={() => updateSlide({ ...slide, headerEnabled: !(slide.headerEnabled ?? true) })}
                      className={`relative w-9 h-5 rounded-full transition-all ${(slide.headerEnabled ?? true) ? "bg-amber-500" : "bg-slate-700"}`}
                    >
                      <span className={`absolute top-0.5 bottom-0.5 w-4 rounded-full bg-white transition-all shadow ${(slide.headerEnabled ?? true) ? "right-0.5" : "left-0.5"}`} />
                    </button>
                  </div>
                </div>
                {(slide.headerEnabled ?? true) && (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] text-slate-500 shrink-0">Height: {slide.headerHeightPct ?? 35}%</span>
                      <input
                        type="range" min={10} max={60} step={5}
                        value={slide.headerHeightPct ?? 35}
                        onChange={(e) => updateSlide({ ...slide, headerHeightPct: parseInt(e.target.value) })}
                        className="flex-1 accent-amber-500"
                      />
                    </div>
                    <ZoneEditor
                      label="Header text"
                      zone={slide.header}
                      onChange={(z) => updateSlide({ ...slide, header: z })}
                    />
                  </>
                )}
              </div>
              <ZoneEditor
                label="Body"
                zone={slide.body}
                onChange={(z) => updateSlide({ ...slide, body: z })}
              />
              {/* Background */}
              <div className="flex flex-col gap-2 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Background</p>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={slide.backgroundColor}
                      onChange={(e) => updateSlide({ ...slide, backgroundColor: e.target.value, backgroundImage: undefined })}
                      className="w-8 h-8 rounded cursor-pointer border border-slate-700 bg-transparent"
                      title="Background color"
                    />
                    <span className="text-xs text-slate-500 font-mono">{slide.backgroundColor}</span>
                  </div>
                  <span className="text-slate-600 text-xs">or</span>
                  <button
                    onClick={handlePickBgImage}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-bold rounded border border-slate-600 transition-all"
                  >
                    Choose Image...
                  </button>
                  {slide.backgroundImage && (
                    <>
                      <span className="text-[9px] text-slate-500 truncate max-w-[100px]" title={slide.backgroundImage}>
                        {slide.backgroundImage.split(/[/\\]/).pop()}
                      </span>
                      <button
                        onClick={() => updateSlide({ ...slide, backgroundImage: undefined })}
                        className="text-red-500/70 hover:text-red-400 text-[10px] font-bold"
                      >
                        Clear
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {showBgImagePicker && (
        <MediaPickerModal
          images={mediaImages}
          onSelect={(path) => updateSlide({ ...slide, backgroundImage: path })}
          onClose={() => setShowBgImagePicker(false)}
          onUpload={async () => {
            try {
              const selected = await openDialog({
                multiple: false,
                filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
              });
              if (!selected) return;
              await invoke("add_media", { path: selected });
            } catch (err) {
              console.error("Upload failed", err);
            }
          }}
        />
      )}
    </div>
  );
}

// ─── Quick Bible Picker ───────────────────────────────────────────────────────
// Keyboard-driven book+chapter+verse entry. Type book → autocomplete → Space/Tab
// to confirm, then type "chapter verse" (or "chapter:verse"), Enter to stage,
// Enter×2 within 800 ms to go live.

function QuickBiblePicker({
  books,
  version,
  onStage,
  onLive,
}: {
  books: string[];
  version: string;
  onStage: (item: DisplayItem) => Promise<void>;
  onLive: (item: DisplayItem) => Promise<void>;
}) {
  const [bookQuery, setBookQuery] = React.useState("");
  const [lockedBook, setLockedBook] = React.useState<string | null>(null);
  const [cvText, setCvText] = React.useState("");
  const [suggestions, setSuggestions] = React.useState<string[]>([]);
  const [activeSuggIdx, setActiveSuggIdx] = React.useState(0);
  const lastEnterRef = React.useRef<number>(0);
  const bookInputRef = React.useRef<HTMLInputElement>(null);
  const cvInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!bookQuery.trim()) { setSuggestions([]); return; }
    const q = bookQuery.toLowerCase();
    setSuggestions(books.filter((b) => b.toLowerCase().includes(q)).slice(0, 7));
    setActiveSuggIdx(0);
  }, [bookQuery, books]);

  const confirmBook = (book: string) => {
    setLockedBook(book);
    setBookQuery("");
    setSuggestions([]);
    setTimeout(() => cvInputRef.current?.focus(), 40);
  };

  const clearBook = () => {
    setLockedBook(null);
    setCvText("");
    setSuggestions([]);
    setTimeout(() => bookInputRef.current?.focus(), 40);
  };

  const handleBookKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveSuggIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveSuggIdx((i) => Math.max(i - 1, 0)); }
    else if ((e.key === " " || e.key === "Tab" || e.key === "Enter") && suggestions.length > 0) {
      e.preventDefault();
      confirmBook(suggestions[activeSuggIdx]);
    } else if (e.key === "Escape") { setSuggestions([]); setBookQuery(""); }
  };

  const handleCvKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { clearBook(); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!lockedBook) return;
    const parts = cvText.trim().split(/[\s:.]+/);
    const chapter = parseInt(parts[0] || "1");
    const verse = parseInt(parts[1] || "1");
    if (isNaN(chapter) || isNaN(verse)) return;
    const now = Date.now();
    const isDouble = now - lastEnterRef.current < 800;
    lastEnterRef.current = now;
    try {
      const v: any = await invoke("get_verse", { book: lockedBook, chapter, verse, version });
      if (!v) return;
      const item: DisplayItem = { type: "Verse", data: v };
      if (isDouble) {
        await onLive(item);
      } else {
        await onStage(item);
      }
    } catch (err) {
      console.error("QuickBiblePicker:", err);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <div className={`flex items-center gap-1.5 bg-slate-800 border rounded-lg px-2 py-1.5 focus-within:ring-1 focus-within:ring-amber-500 transition-all ${suggestions.length > 0 ? "border-amber-500/50" : "border-slate-700"}`}>
          {lockedBook ? (
            <>
              <span className="flex items-center gap-1 bg-amber-500/20 text-amber-400 text-xs font-bold px-2 py-0.5 rounded shrink-0">
                {lockedBook}
                <button onClick={clearBook} tabIndex={-1} className="ml-1 text-amber-600 hover:text-amber-300 leading-none text-sm">×</button>
              </span>
              <input
                ref={cvInputRef}
                value={cvText}
                onChange={(e) => setCvText(e.target.value)}
                onKeyDown={handleCvKeyDown}
                placeholder="3 16  or  3:16"
                className="flex-1 bg-transparent text-slate-200 text-sm focus:outline-none min-w-0"
              />
            </>
          ) : (
            <input
              ref={bookInputRef}
              value={bookQuery}
              onChange={(e) => setBookQuery(e.target.value)}
              onKeyDown={handleBookKeyDown}
              placeholder="Type a book name..."
              className="flex-1 bg-transparent text-slate-200 text-sm focus:outline-none"
            />
          )}
        </div>
        {suggestions.length > 0 && !lockedBook && (
          <div className="absolute top-full left-0 right-0 mt-0.5 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl z-30 overflow-hidden">
            {suggestions.map((book, i) => (
              <button
                key={book}
                onMouseDown={(e) => { e.preventDefault(); confirmBook(book); }}
                className={`w-full text-left px-3 py-2 text-xs transition-all ${i === activeSuggIdx ? "bg-amber-500/20 text-amber-400 font-bold" : "text-slate-300 hover:bg-slate-700"}`}
              >
                {book}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="text-[9px] text-slate-600 leading-tight">
        {lockedBook
          ? "Type chapter+verse (e.g. 3 16) · Enter = stage · Enter×2 = live · Esc = clear"
          : "↑↓ arrows · Space/Tab/Enter = select book"}
      </p>
    </div>
  );
}

// ─── Media Picker Modal ───────────────────────────────────────────────────────
// Modal for picking an image from the centralized media library.

function MediaPickerModal({
  images,
  onSelect,
  onClose,
  onUpload,
}: {
  images: MediaItem[];
  onSelect: (path: string) => void;
  onClose: () => void;
  onUpload: () => Promise<void>;
}) {
  const [uploading, setUploading] = React.useState(false);

  const handleUpload = async () => {
    setUploading(true);
    try { await onUpload(); } finally { setUploading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-8" style={{ backgroundColor: "rgba(0,0,0,0.75)" }}>
      <div className="bg-slate-900 rounded-xl border border-slate-700 flex flex-col w-full max-w-2xl" style={{ maxHeight: "80vh" }}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 shrink-0">
          <span className="text-sm font-bold text-slate-200">Media Library — Pick Image</span>
          <div className="flex gap-2">
            <button
              onClick={handleUpload}
              disabled={uploading}
              className="text-[10px] bg-amber-500 hover:bg-amber-400 text-black font-bold px-3 py-1.5 rounded transition-all disabled:opacity-50"
            >
              {uploading ? "Uploading..." : "+ Upload New"}
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none px-1">×</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {images.length === 0 ? (
            <p className="text-slate-600 text-xs italic text-center py-12">
              No images in library yet. Click "+ Upload New" to add images.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {images.map((img) => (
                <button
                  key={img.id}
                  onClick={() => { onSelect(img.path); onClose(); }}
                  className="aspect-video rounded-lg overflow-hidden border border-slate-700 hover:border-amber-500 transition-all group relative"
                >
                  <img src={convertFileSrc(img.path)} className="w-full h-full object-cover" alt={img.name} />
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center">
                    <span className="text-white text-[10px] font-bold">SELECT</span>
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
                    <p className="text-[8px] text-white truncate">{img.name}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Background Editor ────────────────────────────────────────────────────────
// Reusable component for choosing None / Color / Image backgrounds.
// Image mode uses the centralized media library via MediaPickerModal.

function BackgroundEditor({
  label,
  value,
  onChange,
  mediaImages = [],
  onUploadMedia = async () => {},
  cameras = [],
}: {
  label: string;
  value: BackgroundSetting | undefined;
  onChange: (bg: BackgroundSetting) => void;
  mediaImages?: MediaItem[];
  onUploadMedia?: () => Promise<void>;
  cameras?: MediaDeviceInfo[];
}) {
  const [showPicker, setShowPicker] = React.useState(false);
  const current: BackgroundSetting = value ?? { type: "None" };

  return (
    <>
      <div>
        {label && <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mb-1.5">{label}</p>}
        <div className="flex gap-1.5 mb-1.5">
          {(["None", "Color", "Image", "Camera"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                if (mode === "None") onChange({ type: "None" });
                else if (mode === "Color") onChange({ type: "Color", value: current.type === "Color" ? (current as any).value : "#000000" });
                else if (mode === "Image") onChange({ type: "Image", value: current.type === "Image" ? (current as any).value : "" });
                else onChange({ type: "Camera", value: cameras[0]?.deviceId ?? "" });
              }}
              className={`flex-1 py-1 rounded text-[9px] font-bold border transition-all ${
                current.type === mode ? "border-amber-500 bg-amber-500/10 text-amber-400" : "border-slate-700 bg-slate-800/50 text-slate-500 hover:border-slate-600"
              }`}
            >
              {mode === "None" ? "Inherit" : mode}
            </button>
          ))}
        </div>
        {current.type === "Color" && (
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={(current as { type: "Color"; value: string }).value}
              onChange={(e) => onChange({ type: "Color", value: e.target.value })}
              className="w-8 h-8 rounded cursor-pointer border border-slate-700 bg-transparent"
            />
            <span className="text-[9px] font-mono text-slate-500">{(current as { type: "Color"; value: string }).value}</span>
          </div>
        )}
        {current.type === "Image" && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowPicker(true)}
              className="flex-1 py-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-[9px] font-bold text-slate-300 transition-all"
            >
              {(current as { type: "Image"; value: string }).value ? "Change from Library..." : "Pick from Library..."}
            </button>
            {(current as { type: "Image"; value: string }).value && (
              <button
                onClick={() => onChange({ type: "Image", value: "" })}
                className="text-red-500/70 hover:text-red-400 text-[10px] font-bold shrink-0"
                title="Clear image"
              >✕</button>
            )}
          </div>
        )}
        {current.type === "Image" && (current as { type: "Image"; value: string }).value && (
          <p className="text-[8px] text-slate-600 truncate mt-1">
            {(current as { type: "Image"; value: string }).value.split(/[/\\]/).pop()}
          </p>
        )}
        {current.type === "Camera" && (
          cameras.length === 0 ? (
            <p className="text-[9px] text-slate-600 italic mt-1">No cameras detected. Visit the Cameras tab to grant access.</p>
          ) : (
            <select
              value={(current as { type: "Camera"; value: string }).value}
              onChange={(e) => onChange({ type: "Camera", value: e.target.value })}
              className="w-full mt-1 bg-slate-800 text-white border border-slate-700 rounded px-2 py-1 text-[9px] focus:outline-none focus:ring-1 focus:ring-amber-500"
            >
              {cameras.map((cam) => (
                <option key={cam.deviceId} value={cam.deviceId}>
                  {cam.label || `Camera ${cam.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          )
        )}
      </div>
      {showPicker && (
        <MediaPickerModal
          images={mediaImages}
          onSelect={(path) => { onChange({ type: "Image", value: path }); }}
          onClose={() => setShowPicker(false)}
          onUpload={onUploadMedia}
        />
      )}
    </>
  );
}

// ─── Camera Feed Renderer ─────────────────────────────────────────────────────
// Used in the output window to show a live camera stream.

function CameraFeedRenderer({ deviceId }: { deviceId: string }) {
  const videoRef = React.useRef<HTMLVideoElement>(null);

  React.useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } })
      .then((s) => {
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch((err) => console.error("CameraFeedRenderer: camera access failed", err));
    return () => {
      stream?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [deviceId]);

  return <video ref={videoRef} className="w-full h-full object-cover" autoPlay muted playsInline />;
}

// ─── Slide Thumbnail ──────────────────────────────────────────────────────────

function SlideThumbnail({
  slide,
  index,
  onStage,
  onLive,
}: {
  slide: ParsedSlide;
  index: number;
  onStage: () => void;
  onLive: () => void;
}) {
  const bgStyle: React.CSSProperties = slide.backgroundColor
    ? { backgroundColor: slide.backgroundColor }
    : { backgroundColor: "#1a1a2e" };

  return (
    <div
      className="group relative aspect-video rounded overflow-hidden border border-slate-700 hover:border-amber-500/50 transition-all cursor-pointer"
      style={bgStyle}
    >
      {slide.images[0] && (
        <img src={slide.images[0].dataUrl} className="absolute inset-0 w-full h-full object-cover" alt="" />
      )}
      {slide.textBoxes[0] && (
        <div className="absolute inset-0 flex items-center justify-center p-1">
          <p
            className="text-center font-bold leading-tight"
            style={{
              fontSize: "8px",
              color: slide.textBoxes[0].color ?? "#ffffff",
              textShadow: "0 1px 3px rgba(0,0,0,0.8)",
            }}
          >
            {slide.textBoxes[0].text.slice(0, 60)}
          </p>
        </div>
      )}
      <div className="absolute bottom-0 left-0 px-1 py-0.5 bg-black/50">
        <span className="text-[7px] text-white/70">{index + 1}</span>
      </div>
      <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-all flex flex-col items-center justify-center gap-1 p-1">
        <button
          onClick={onStage}
          className="w-full bg-slate-600 hover:bg-slate-500 text-white text-[9px] font-bold py-1 rounded"
        >
          STAGE
        </button>
        <button
          onClick={onLive}
          className="w-full bg-amber-500 hover:bg-amber-400 text-black text-[9px] font-bold py-1 rounded"
        >
          DISPLAY
        </button>
      </div>
    </div>
  );
}

// ─── Lower Third helpers ──────────────────────────────────────────────────────

function hexToRgba(hex: string, opacity: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${(opacity / 100).toFixed(2)})`;
}

function buildLtPositionStyle(t: LowerThirdTemplate): React.CSSProperties {
  const style: React.CSSProperties = { position: "absolute", zIndex: 50, width: `${t.widthPct}%` };
  let tx = "";
  let ty = "";
  if (t.hAlign === "left") { style.left = t.offsetX; }
  else if (t.hAlign === "right") { style.right = t.offsetX; }
  else { style.left = "50%"; tx = "-50%"; }
  if (t.vAlign === "top") { style.top = t.offsetY; }
  else if (t.vAlign === "bottom") { style.bottom = t.offsetY; }
  else { style.top = "50%"; ty = "-50%"; }
  if (tx || ty) style.transform = `translate(${tx || "0"}, ${ty || "0"})`;
  return style;
}

function buildLtContainerStyle(t: LowerThirdTemplate): React.CSSProperties {
  const style: React.CSSProperties = {
    paddingLeft: t.paddingX, paddingRight: t.paddingX,
    paddingTop: t.paddingY, paddingBottom: t.paddingY,
    borderRadius: t.borderRadius, overflow: "hidden",
    backdropFilter: t.bgBlur ? "blur(8px)" : undefined,
  };
  if (t.bgType === "solid") {
    style.background = hexToRgba(t.bgColor, t.bgOpacity);
  } else if (t.bgType === "gradient") {
    style.background = `linear-gradient(135deg, ${hexToRgba(t.bgColor, t.bgOpacity)} 0%, ${hexToRgba(t.bgGradientEnd, t.bgOpacity)} 100%)`;
  } else if (t.bgType === "image" && t.bgImagePath) {
    style.backgroundImage = `url("${convertFileSrc(t.bgImagePath)}")`;
    style.backgroundSize = "cover";
    style.backgroundPosition = "center";
    style.backgroundRepeat = "no-repeat";
  } else {
    style.background = "transparent";
  }
  if (t.accentEnabled) {
    const border = `${t.accentWidth}px solid ${t.accentColor}`;
    if (t.accentSide === "left") style.borderLeft = border;
    else if (t.accentSide === "right") style.borderRight = border;
    else if (t.accentSide === "top") style.borderTop = border;
    else style.borderBottom = border;
  }
  return style;
}

function buildLtTextStyle(
  font: string, size: number, color: string,
  bold: boolean, italic: boolean, uppercase: boolean
): React.CSSProperties {
  return {
    fontFamily: font, fontSize: size, color,
    fontWeight: bold ? "bold" : "normal",
    fontStyle: italic ? "italic" : "normal",
    textTransform: uppercase ? "uppercase" : undefined,
    lineHeight: 1.25, margin: 0,
  };
}

function buildLtLabelStyle(t: LowerThirdTemplate): React.CSSProperties {
  return {
    ...buildLtTextStyle(t.secondaryFont, t.labelSize, t.labelColor, true, false, t.labelUppercase),
    letterSpacing: "0.1em", marginBottom: 4,
  };
}

// ─── Lower Third Helpers ──────────────────────────────────────────────────────

/** Builds a Lyrics LowerThirdData payload with safe bounds on line2. */
function ltBuildLyricsPayload(
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

// ─── Lower Third Overlay ──────────────────────────────────────────────────────

function LowerThirdOverlay({ data, template: t }: { data: LowerThirdData; template: LowerThirdTemplate }) {
  const containerStyle = buildLtContainerStyle(t);

  const getVariants = () => {
    switch (t.animation) {
      case "fade":
        return { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };
      case "slide-up":
        return { initial: { opacity: 0, y: 30 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: 30 } };
      case "slide-left":
        return { initial: { opacity: 0, x: 50 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: 50 } };
      default:
        return { initial: { opacity: 1 }, animate: { opacity: 1 }, exit: { opacity: 1 } };
    }
  };

  const variants = getVariants();

  return (
    <motion.div
      style={buildLtPositionStyle(t)}
      initial={variants.initial}
      animate={variants.animate}
      exit={variants.exit}
      transition={{ duration: 0.5, ease: "easeOut" }}
    >
      <div style={containerStyle}>
        {data.kind === "Nameplate" && (
          <div className="w-full">
            {t.variant === "modern" ? (
              <div className="flex flex-col items-center text-center">
                <p style={buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase)}>
                  {data.data.name}
                </p>
                {data.data.title && (
                  <>
                    <div className="w-1/4 h-px my-2 opacity-30" style={{ backgroundColor: t.secondaryColor }} />
                    <p style={buildLtTextStyle(t.secondaryFont, t.secondarySize, t.secondaryColor, t.secondaryBold, t.secondaryItalic, t.secondaryUppercase)}>
                      {data.data.title}
                    </p>
                  </>
                )}
              </div>
            ) : t.variant === "banner" ? (
              <div className="flex items-center gap-4">
                <div className="shrink-0 py-1 px-4 rounded" style={{ background: t.accentColor, color: t.bgColor }}>
                   <p className="font-black text-xl uppercase tracking-tighter">LIVE</p>
                </div>
                <div className="flex-1 min-w-0">
                  <p style={buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase)}>
                    {data.data.name}
                  </p>
                  {data.data.title && (
                    <p style={buildLtTextStyle(t.secondaryFont, t.secondarySize, t.secondaryColor, t.secondaryBold, t.secondaryItalic, t.secondaryUppercase)}>
                      {data.data.title}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              /* Classic */
              <>
                <p style={buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase)}>
                  {data.data.name}
                </p>
                {data.data.title && (
                  <p style={{ ...buildLtTextStyle(t.secondaryFont, t.secondarySize, t.secondaryColor, t.secondaryBold, t.secondaryItalic, t.secondaryUppercase), marginTop: 4 }}>
                    {data.data.title}
                  </p>
                )}
              </>
            )}
          </div>
        )}
        {data.kind === "Lyrics" && (
          <>
            {data.data.section_label && t.labelVisible && (
              <p style={buildLtLabelStyle(t)}>{data.data.section_label}</p>
            )}
            <p style={buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase)}>
              {data.data.line1}
            </p>
            {data.data.line2 && (
              <p style={{ ...buildLtTextStyle(t.secondaryFont, t.secondarySize, t.secondaryColor, t.secondaryBold, t.secondaryItalic, t.secondaryUppercase), marginTop: 4 }}>
                {data.data.line2}
              </p>
            )}
          </>
        )}
        {data.kind === "FreeText" && (
          t.scrollEnabled ? (
            <div style={{ overflow: "hidden", whiteSpace: "nowrap" }}>
              <span style={{
                ...buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase),
                display: "inline-block",
                // paddingLeft: 100% pushes the text off-screen; the keyframe direction determines which way it scrolls
                paddingLeft: "100%",
                paddingRight: "0",
                animation: `lt-scroll-${t.scrollDirection} ${(11 - t.scrollSpeed) * 4}s linear infinite`,
                willChange: "transform",
              }}>
                {data.data.text}
              </span>
            </div>
          ) : (
            <p style={buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase)}>
              {data.data.text}
            </p>
          )
        )}
      </div>
    </motion.div>
  );
}

// ─── Transition variants ──────────────────────────────────────────────────────

function getTransitionVariants(type: string, duration: number) {
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

// ─── Timer renderer (used in both OutputWindow and StageWindow) ───────────────

function TimerRenderer({ data }: { data: TimerData }) {
  const [display, setDisplay] = useState("--:--:--");
  const [isExpired, setIsExpired] = useState(false);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      let totalSecs = 0;
      let expired = false;

      if (data.timer_type === "clock") {
        const d = new Date();
        const h = d.getHours().toString().padStart(2, "0");
        const m = d.getMinutes().toString().padStart(2, "0");
        const s = d.getSeconds().toString().padStart(2, "0");
        setDisplay(`${h}:${m}:${s}`);
        return;
      }

      if (data.started_at == null) {
        if (data.timer_type === "countdown" && data.duration_secs != null) {
          totalSecs = data.duration_secs;
        } else {
          totalSecs = 0;
        }
      } else {
        const elapsed = Math.floor((now - data.started_at) / 1000);
        if (data.timer_type === "countdown") {
          const remaining = (data.duration_secs ?? 0) - elapsed;
          totalSecs = Math.max(0, remaining);
          expired = remaining <= 0;
        } else {
          totalSecs = elapsed;
        }
      }

      const h = Math.floor(totalSecs / 3600);
      const m = Math.floor((totalSecs % 3600) / 60);
      const s = totalSecs % 60;
      const parts = h > 0
        ? `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
        : `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
      setDisplay(parts);
      setIsExpired(expired);
    };

    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [data]);

  const isLastMinute = data.timer_type === "countdown" && !isExpired && (() => {
    if (data.started_at == null) return (data.duration_secs ?? 0) <= 60;
    const elapsed = Math.floor((Date.now() - data.started_at) / 1000);
    return (data.duration_secs ?? 0) - elapsed <= 60;
  })();

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-6">
      <div
        className="font-mono font-black tracking-widest select-none"
        style={{
          fontSize: "clamp(80px, 15vw, 200px)",
          color: isExpired ? "#ef4444" : isLastMinute ? "#f59e0b" : "#ffffff",
          textShadow: "0 4px 32px rgba(0,0,0,0.5)",
        }}
      >
        {display}
      </div>
      {data.label && (
        <p className="text-4xl font-bold uppercase tracking-widest text-white/70">
          {data.label}
        </p>
      )}
    </div>
  );
}

// ─── Stage Display Window ──────────────────────────────────────────────────────

function StageWindow() {
  const [liveItem, setLiveItem]   = useState<DisplayItem | null>(null);
  const [stagedItem, setStagedItem] = useState<DisplayItem | null>(null);
  const [clock, setClock] = useState("");

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const h = d.getHours().toString().padStart(2, "0");
      const m = d.getMinutes().toString().padStart(2, "0");
      const s = d.getSeconds().toString().padStart(2, "0");
      setClock(`${h}:${m}:${s}`);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const unlisten1 = listen<{ text: string; detected_item: DisplayItem | null; source: string }>(
      "transcription-update",
      (ev) => {
        if (ev.payload.source === "manual" && ev.payload.detected_item) {
          setLiveItem(ev.payload.detected_item);
        } else if (ev.payload.source === "manual" && !ev.payload.detected_item) {
          setLiveItem(null);
        }
      }
    );
    const unlisten2 = listen<DisplayItem | null>("stage-update", (ev) => {
      setStagedItem(ev.payload ?? null);
    });
    return () => { unlisten1.then((f) => f()); unlisten2.then((f) => f()); };
  }, []);

  function itemSummary(item: DisplayItem | null): string {
    if (!item) return "—";
    return displayItemLabel(item);
  }

  function itemDetail(item: DisplayItem | null): string {
    if (!item) return "";
    if (item.type === "Verse") return item.data.text;
    if (item.type === "Timer") return `${item.data.timer_type}${item.data.duration_secs ? ` · ${Math.floor(item.data.duration_secs / 60)}:${String(item.data.duration_secs % 60).padStart(2,"0")}` : ""}`;
    return "";
  }

  return (
    <div className="h-screen w-screen bg-slate-950 text-white flex flex-col overflow-hidden select-none">
      {/* Clock bar */}
      <div className="flex items-center justify-between px-8 py-3 bg-slate-900 border-b border-slate-800 shrink-0">
        <span className="text-slate-500 text-sm font-bold uppercase tracking-widest">Stage Display</span>
        <span className="font-mono text-4xl font-black text-white tracking-widest">{clock}</span>
        <span className="text-slate-500 text-sm font-bold uppercase tracking-widest">Bible Presenter</span>
      </div>

      {/* Content area */}
      <div className="flex-1 grid grid-cols-2 gap-0 overflow-hidden">
        {/* NOW LIVE panel */}
        <div className="flex flex-col p-8 border-r border-slate-800 overflow-hidden">
          <div className="flex items-center gap-3 mb-4 shrink-0">
            <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs font-black uppercase tracking-widest text-red-400">Now Live</span>
          </div>
          <p className="text-xl font-bold text-slate-300 mb-3 shrink-0">{itemSummary(liveItem)}</p>
          <p className="text-4xl font-serif leading-snug text-white flex-1 overflow-hidden line-clamp-[8]">
            {itemDetail(liveItem)}
          </p>
        </div>

        {/* UP NEXT panel */}
        <div className="flex flex-col p-8 border-2 border-amber-500/40 bg-amber-950/10 overflow-hidden">
          <div className="flex items-center gap-3 mb-4 shrink-0">
            <span className="text-xs font-black uppercase tracking-widest text-amber-400">Up Next ▶</span>
          </div>
          <p className="text-xl font-bold text-amber-300 mb-3 shrink-0">{itemSummary(stagedItem)}</p>
          <p className="text-4xl font-serif leading-snug text-amber-100 flex-1 overflow-hidden line-clamp-[8]">
            {itemDetail(stagedItem)}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Output Window ────────────────────────────────────────────────────────────

// ─── Props layer (persistent graphics above slides) ────────────────────────────

function PropClockRenderer({ color, format }: { color?: string; format?: string }) {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const fmt = format ?? "HH:mm:ss";
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = pad(time.getHours());
  const h12 = pad(time.getHours() % 12 || 12);
  const m = pad(time.getMinutes());
  const s = pad(time.getSeconds());
  const ampm = time.getHours() < 12 ? "AM" : "PM";
  const display = fmt
    .replace("HH", h)
    .replace("hh", h12)
    .replace("mm", m)
    .replace("ss", s)
    .replace("a", ampm);

  return (
    <div className="w-full h-full flex items-center justify-center">
      <span className="font-mono font-black text-4xl drop-shadow-lg" style={{ color: color ?? "#ffffff" }}>
        {display}
      </span>
    </div>
  );
}

function PropsRenderer({ items }: { items: PropItem[] }) {
  return (
    <div className="absolute inset-0 z-30 pointer-events-none">
      {items.filter((p) => p.visible).map((p) => (
        <div
          key={p.id}
          style={{
            position: "absolute",
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: `${p.w}%`,
            height: `${p.h}%`,
            opacity: p.opacity,
          }}
        >
          {p.kind === "image" && p.path && (
            <img src={convertFileSrc(p.path)} className="w-full h-full object-contain" alt="" />
          )}
          {p.kind === "clock" && (
            <PropClockRenderer color={p.color} format={p.text} />
          )}
        </div>
      ))}
    </div>
  );
}

function OutputWindow() {
  const [liveItem, setLiveItem] = useState<DisplayItem | null>(null);
  const [lowerThird, setLowerThird] = useState<{ data: LowerThirdData; template: LowerThirdTemplate } | null>(null);
  const [propItems, setPropItems] = useState<PropItem[]>([]);
  const [settings, setSettings] = useState<PresentationSettings>({
    theme: "dark",
    reference_position: "bottom",
    background: { type: "None" },
    is_blanked: false,
    font_size: 72,
  });
  const [currentSlide, setCurrentSlide] = useState<ParsedSlide | null>(null);
  const outputZipsRef = useRef<Record<string, any>>({});
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraMuted, setCameraMuted] = useState(false);

  // ── LAN camera program stream (WebRTC) ───────────────────────────────────────
  const programVideoRef = useRef<HTMLVideoElement>(null);
  const programPcRef    = useRef<RTCPeerConnection | null>(null);
  const programDeviceId = useRef<string | null>(null);
  const outputWsRef     = useRef<WebSocket | null>(null);
  const OUTPUT_STUN: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

  function sendOutputWs(obj: object) {
    if (outputWsRef.current?.readyState === WebSocket.OPEN) {
      outputWsRef.current.send(JSON.stringify(obj));
    }
  }

  function closeProgramPc() {
    if (programPcRef.current) { programPcRef.current.close(); programPcRef.current = null; }
    if (programVideoRef.current) programVideoRef.current.srcObject = null;
    if (programDeviceId.current) {
      sendOutputWs({ cmd: "camera_disconnect_program", device_id: programDeviceId.current });
    }
    programDeviceId.current = null;
  }

  async function handleProgramOffer(msg: { device_id: string; sdp: string }) {
    const { device_id, sdp } = msg;
    const pc = new RTCPeerConnection(OUTPUT_STUN);
    programPcRef.current = pc;

    pc.ontrack = (ev: RTCTrackEvent) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      if (programVideoRef.current) programVideoRef.current.srcObject = stream;
    };

    pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (ev.candidate) {
        sendOutputWs({ cmd: "camera_ice", device_id, target: `mobile:${device_id}`, candidate: ev.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
        // Auto-cut to black on dropout
        if (programVideoRef.current) programVideoRef.current.srcObject = null;
      }
    };

    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendOutputWs({ cmd: "camera_answer", device_id, target: `mobile:${device_id}`, sdp: answer.sdp });
  }

  function connectOutputWs(pin: string) {
    const ws = new WebSocket("ws://127.0.0.1:7420/ws");
    outputWsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ cmd: "auth", pin, client_type: "window:output" }));
    };

    ws.onmessage = async (e: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "auth_ok") return;

      // Program offer from mobile
      if (msg.cmd === "camera_offer" && (msg.target === "output" || msg.target === "window:output")) {
        await handleProgramOffer(msg);
        return;
      }
      // ICE for program PC
      if (msg.cmd === "camera_ice" && (msg.target === "output" || msg.target === "window:output")) {
        if (programPcRef.current && msg.candidate) {
          try { await programPcRef.current.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
        }
        return;
      }
    };

    ws.onclose = () => {
      setTimeout(() => { if (outputWsRef.current?.readyState === WebSocket.CLOSED) connectOutputWs(pin); }, 5000);
    };
  }

  useEffect(() => {
    invoke("get_current_item")
      .then((v: any) => { if (v) setLiveItem(v); })
      .catch(() => {});

    invoke("get_settings")
      .then((s: any) => { if (s) setSettings(s); })
      .catch(() => {});

    // Connect output window WS for program camera stream signaling
    invoke("get_remote_info")
      .then((info: any) => { if (info?.pin) connectOutputWs(info.pin); })
      .catch(() => {});

    const unlisten = listen("transcription-update", (event: any) => {
      if (event.payload.detected_item) {
        setLiveItem(event.payload.detected_item);
        setCameraMuted(false); // Reset mute on item change
      } else {
        setLiveItem(null);
      }
    });

    const unlistenSettings = listen("settings-changed", (event: any) => {
      setSettings(event.payload as PresentationSettings);
    });

    const unlistenLt = listen("lower-third-update", (event: any) => {
      if (event.payload) {
        setLowerThird({ data: event.payload.data as LowerThirdData, template: event.payload.template as LowerThirdTemplate });
      } else {
        setLowerThird(null);
      }
    });

    const unlistenMedia = listen("media-control", (event: any) => {
      const { action } = event.payload as { action: string };
      console.log("OutputWindow: received media-control", action);

      if (action === "video-play-pause") {
        if (videoRef.current) {
          if (videoRef.current.paused) videoRef.current.play();
          else videoRef.current.pause();
        }
      } else if (action === "video-restart") {
        if (videoRef.current) {
          videoRef.current.currentTime = 0;
          videoRef.current.play();
        }
      } else if (action === "video-mute-toggle") {
        if (videoRef.current) {
          videoRef.current.muted = !videoRef.current.muted;
        }
      } else if (action === "camera-mute-toggle") {
        setCameraMuted((m) => !m);
      }
    });

    const unlistenProps = listen("props-update", (event: any) => {
      setPropItems((event.payload as PropItem[]) ?? []);
    });

    // Load initial props
    invoke<PropItem[]>("get_props").then(setPropItems).catch(() => {});

    return () => {
      unlisten.then((f) => f());
      unlistenSettings.then((f) => f());
      unlistenLt.then((f) => f());
      unlistenMedia.then((f) => f());
      unlistenProps.then((f) => f());
    };
  }, []);

  // Parse PPTX slide when a PresentationSlide item goes live
  useEffect(() => {
    if (liveItem?.type !== "PresentationSlide") {
      setCurrentSlide(null);
      return;
    }
    const { presentation_id, presentation_path, slide_index } = liveItem.data;
    (async () => {
      try {
        let zip = outputZipsRef.current[presentation_id];
        if (!zip) {
          zip = await loadPptxZip(presentation_path);
          outputZipsRef.current[presentation_id] = zip;
        }
        const slide = await parseSingleSlide(zip, slide_index);
        setCurrentSlide(slide);
      } catch (err) {
        console.error("OutputWindow: failed to render slide", err);
        setCurrentSlide(null);
      }
    })();
  }, [liveItem]);

  // ── Manage LAN program camera PC lifecycle when liveItem changes ──────────────
  useEffect(() => {
    const isLanCamera = liveItem?.type === "CameraFeed" && liveItem.data.lan;

    if (isLanCamera) {
      const newDeviceId = liveItem!.data.device_id;
      if (programDeviceId.current === newDeviceId) return; // already connected to this device

      // Disconnect old program feed first
      if (programDeviceId.current) {
        if (programPcRef.current) { programPcRef.current.close(); programPcRef.current = null; }
        sendOutputWs({ cmd: "camera_disconnect_program", device_id: programDeviceId.current });
      }

      // Request program stream from new device
      programDeviceId.current = newDeviceId;
      sendOutputWs({ cmd: "camera_connect_program", device_id: newDeviceId });
    } else if (programDeviceId.current) {
      // Switched away from LAN camera — disconnect
      closeProgramPc();
    }
  }, [liveItem]);

  if (settings.is_blanked) {
    return <div className="h-screen w-screen bg-black" />;
  }

  const { colors } = THEMES[settings.theme] ?? THEMES.dark;
  const isTop = settings.reference_position === "top";
  const bgStyle = getEffectiveBackground(settings, liveItem, colors);
  const cameraBgId = getCameraBackgroundDeviceId(settings, liveItem);

  const ReferenceTag = liveItem?.type === "Verse" ? (
    <p
      className="text-4xl uppercase tracking-widest font-bold shrink-0"
      style={{ color: colors.referenceText }}
    >
      {liveItem.data.book} {liveItem.data.chapter}:{liveItem.data.verse}
      {liveItem.data.version && (
        <span className="text-2xl font-normal opacity-60 ml-2">({liveItem.data.version})</span>
      )}
    </p>
  ) : null;

  const isLanCameraLive = liveItem?.type === "CameraFeed" && !!liveItem.data.lan;

  return (
    <div
      className="h-screen w-screen overflow-hidden relative"
      style={
        cameraBgId || isLanCameraLive
          ? { color: colors.verseText }           // transparent — let video at z-0 show through
          : { ...bgStyle, color: colors.verseText }
      }
    >
      {/* Layer 0 — LAN WebRTC program stream (always mounted, never removed from DOM) */}
      <video
        ref={programVideoRef}
        className="absolute inset-0 w-full h-full object-cover"
        style={{ zIndex: 0, visibility: (isLanCameraLive && !cameraMuted) ? "visible" : "hidden" }}
        autoPlay
        playsInline
      />

      {/* Dark scrim at z-9 — improves text legibility over video without hiding it */}
      {isLanCameraLive && (
        <div className="absolute inset-0 bg-black/25 pointer-events-none" style={{ zIndex: 9 }} />
      )}

      {cameraBgId && (
        <div className="absolute inset-0 z-0">
          <CameraFeedRenderer deviceId={cameraBgId} />
        </div>
      )}
      {settings.logo_path && (
        <img
          src={convertFileSrc(settings.logo_path)}
          className="absolute bottom-8 right-8 w-24 h-24 object-contain opacity-50 z-50"
          alt="Logo"
        />
      )}

      <AnimatePresence mode="wait">
        {liveItem ? (
          <motion.div
            key={displayItemLabel(liveItem)}
            className="absolute inset-0 z-10"
            {...getTransitionVariants(
              settings.slide_transition ?? "fade",
              settings.slide_transition_duration ?? 0.4
            )}
          >
            {liveItem.type === "Verse" ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-16 text-center">
                <motion.div
                  className="w-full flex flex-col items-center gap-8"
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.6, delay: 0.1 }}
                >
                  {isTop && ReferenceTag}
                  <h1
                    className="font-serif leading-tight drop-shadow-2xl"
                    style={{ color: colors.verseText, fontSize: `${settings.font_size}pt` }}
                  >
                    {liveItem.data.text}
                  </h1>
                  {!isTop && ReferenceTag}
                </motion.div>
              </div>
            ) : liveItem.type === "PresentationSlide" ? (
              <div className="absolute inset-0">
                {currentSlide ? (
                  <SlideRenderer slide={currentSlide} />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <span className="font-serif text-2xl italic" style={{ color: colors.waitingText }}>
                      Loading slide...
                    </span>
                  </div>
                )}
              </div>
            ) : liveItem.type === "CustomSlide" ? (
              <div className="absolute inset-0">
                <CustomSlideRenderer slide={liveItem.data} />
              </div>
            ) : liveItem.type === "CameraFeed" ? (
              liveItem.data.lan ? (
                // LAN stream rendered by persistent programVideoRef at z-0 — nothing needed here
                <div className="absolute inset-0" />
              ) : (
                // Local getUserMedia camera
                <div className="absolute inset-0" style={{ visibility: cameraMuted ? "hidden" : "visible" }}>
                  <CameraFeedRenderer deviceId={liveItem.data.device_id} />
                </div>
              )
            ) : liveItem.type === "Media" ? (
              <div className="absolute inset-0 flex items-center justify-center">
                {liveItem.data.media_type === "Image" ? (
                  <img
                    src={convertFileSrc(liveItem.data.path)}
                    className="max-w-full max-h-full object-contain"
                    alt={liveItem.data.name}
                  />
                ) : (
                  <video
                    ref={videoRef}
                    src={convertFileSrc(liveItem.data.path)}
                    className="max-w-full max-h-full object-contain"
                    autoPlay
                    loop
                  />
                )}
              </div>
            ) : liveItem.type === "Scene" ? (
              <div className="absolute inset-0">
                <SceneRenderer scene={liveItem.data} outputMode={true} />
              </div>
            ) : liveItem.type === "Timer" ? (
              <TimerRenderer data={liveItem.data} />
            ) : null}
          </motion.div>
        ) : (
          <motion.div
            key="waiting"
            className="absolute inset-0 flex items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
          >
            <span className="font-serif text-2xl italic select-none" style={{ color: colors.waitingText }}>
              Waiting for projection...
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Props layer — persistent graphics above slides but below lower third */}
      <PropsRenderer items={propItems} />

      {/* Lower Third Overlay — always on top, independent of liveItem */}
      <AnimatePresence>
        {lowerThird && (
          <motion.div
            key="lower-third"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.35 }}
            className="absolute inset-0 pointer-events-none z-50"
          >
            <LowerThirdOverlay data={lowerThird.data} template={lowerThird.template} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Preview Card ─────────────────────────────────────────────────────────────

function PreviewCard({
  item,
  label,
  accent,
  badge,
  empty,
}: {
  item: DisplayItem | null;
  label: string;
  accent: string;
  badge: React.ReactNode;
  empty: string;
}) {
  const isVideo = item?.type === "Media" && item.data.media_type === "Video";
  const isCamera = item?.type === "CameraFeed";
  const showControls = isVideo || isCamera;

  const sendMediaControl = (action: string, value?: any) => {
    // We emit a global event that the OutputWindow (and other listeners) can catch
    const payload = { action, value };
    console.log("Emitting media-control:", payload);
    emit("media-control", payload);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex justify-between items-center mb-3 shrink-0">
        <h2 className={`text-xs font-bold uppercase tracking-widest ${accent}`}>{label}</h2>
        {badge}
      </div>
      <div className={`flex-1 flex flex-col items-center justify-center bg-black/40 rounded-2xl border border-slate-800 text-center min-h-0 relative group ${item?.type === "Media" || item?.type === "CameraFeed" ? "p-0 overflow-hidden" : "p-6"}`}>
        {item ? (
          <div className="animate-in fade-in zoom-in-95 duration-300 w-full h-full flex flex-col items-center justify-center relative">
            {item.type === "Verse" ? (
              <div className="flex flex-col items-center justify-center gap-3">
                <p className="text-xl font-serif text-slate-300 leading-snug line-clamp-5">
                  {item.data.text}
                </p>
                <p className="text-amber-500 font-bold uppercase tracking-widest text-sm shrink-0">
                  {item.data.book} {item.data.chapter}:{item.data.verse}
                </p>
              </div>
            ) : item.type === "PresentationSlide" ? (
              <div className="flex flex-col items-center justify-center gap-3">
                <div className="text-orange-400 text-xs font-black uppercase bg-orange-400/10 px-2 py-0.5 rounded">
                  SLIDE {item.data.slide_index + 1} / {item.data.slide_count || "?"}
                </div>
                <p className="text-slate-400 text-xs font-bold truncate max-w-full">
                  {item.data.presentation_name}
                </p>
              </div>
            ) : item.type === "CustomSlide" ? (
              <div className="w-full" style={{ aspectRatio: "16/9" }}>
                <CustomSlideRenderer slide={item.data} scale={0.25} />
              </div>
            ) : item.type === "CameraFeed" ? (
              <div className="w-full h-full rounded overflow-hidden relative">
                {item.data.lan ? (
                  // LAN source — device_id is a mobile UUID, getUserMedia would fail
                  <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900/60 gap-2">
                    <span className="text-3xl">📷</span>
                    <p className="text-teal-400 text-[10px] font-bold uppercase text-center px-2">
                      {item.data.device_name || item.data.label || "LAN Camera"}
                    </p>
                    <span className="text-[8px] text-green-400 font-bold bg-green-500/10 px-2 py-0.5 rounded">● LAN</span>
                  </div>
                ) : (
                  <CameraFeedRenderer deviceId={item.data.device_id} />
                )}
                <p className="text-teal-400 text-[10px] font-bold uppercase truncate max-w-full absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 px-2 py-0.5 rounded backdrop-blur-sm">
                  {item.data.device_name || item.data.label || item.data.device_id.slice(0, 16)}
                </p>
              </div>
            ) : item.type === "Scene" ? (
              <div className="w-full h-full relative border border-slate-800 rounded-lg overflow-hidden">
                <SceneRenderer scene={item.data} scale={0.25} />
              </div>
            ) : item.type === "Timer" ? (
              <div className="flex flex-col items-center justify-center gap-2">
                <span className="text-4xl font-mono font-black text-cyan-400">⏱</span>
                <p className="text-cyan-400 text-xs font-bold uppercase">{item.data.timer_type}</p>
                {item.data.label && <p className="text-slate-400 text-[10px]">{item.data.label}</p>}
                {item.data.timer_type === "countdown" && item.data.duration_secs != null && (
                  <p className="text-slate-500 text-[10px] font-mono">
                    {Math.floor(item.data.duration_secs / 60).toString().padStart(2,"0")}:{String(item.data.duration_secs % 60).padStart(2,"0")}
                  </p>
                )}
              </div>
            ) : (
              <div className="w-full h-full overflow-hidden flex flex-col items-center justify-center relative">
                {(item.data as MediaItem).media_type === "Image" ? (
                  <img
                    src={convertFileSrc((item.data as MediaItem).path)}
                    className="w-full h-full object-contain rounded shadow-xl"
                    alt={(item.data as MediaItem).name}
                  />
                ) : (
                  <video
                    src={convertFileSrc((item.data as MediaItem).path)}
                    className="w-full h-full object-contain rounded"
                    muted
                    preload="metadata"
                  />
                )}
                <p className="text-slate-400 text-[10px] font-bold uppercase truncate max-w-full absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 px-2 py-0.5 rounded backdrop-blur-sm">
                  {(item.data as MediaItem).name}
                </p>
              </div>
            )}

            {/* Floating Media Controls (Show on both Stage and Live) */}
            {showControls && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-slate-900/90 backdrop-blur-md border border-slate-700 p-1.5 rounded-full shadow-2xl transition-all z-20">
                {isVideo && (
                  <>
                    <button
                      onClick={() => sendMediaControl("video-play-pause")}
                      className="w-8 h-8 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full transition-colors"
                      title="Play / Pause"
                    >
                      <RefreshCw size={14} />
                    </button>
                    <button
                      onClick={() => sendMediaControl("video-restart")}
                      className="w-8 h-8 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full transition-colors"
                      title="Restart"
                    >
                      <Clock size={14} />
                    </button>
                    <button
                      onClick={() => sendMediaControl("video-mute-toggle")}
                      className="w-8 h-8 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full transition-colors"
                      title="Mute / Unmute"
                    >
                      <MicOff size={14} />
                    </button>
                  </>
                )}
                {isCamera && (
                   <button
                   onClick={() => sendMediaControl("camera-mute-toggle")}
                   className="w-8 h-8 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full transition-colors"
                   title="Hide / Show Camera"
                 >
                   <EyeOff size={14} />
                 </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-slate-800 font-serif italic text-sm">{empty}</p>
        )}
      </div>
    </div>
  );
}


// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2000);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <motion.div
      className="fixed bottom-6 left-1/2 z-50"
      style={{ translateX: "-50%" }}
      initial={{ opacity: 0, y: 8, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.95 }}
      transition={{ duration: 0.18 }}
    >
      <div className="bg-slate-700 text-white text-xs font-bold px-4 py-2 rounded-full shadow-xl border border-slate-600">
        {message}
      </div>
    </motion.div>
  );
}

// ─── Design Hub Window ────────────────────────────────────────────────────────
// Separate Tauri window for all heavy design/config work. Shares helper functions
// defined above (CustomSlideRenderer, LowerThirdOverlay, SceneRenderer, SlideEditor, etc.)

function DesignHub() {
  const [hubTab, setHubTab] = React.useState<"studio" | "lt-designer" | "scene" | "props" | "settings">("studio");

  // Studio state
  const [studioList, setStudioList] = React.useState<{ id: string; name: string; slide_count: number }[]>([]);
  const [editorPresId, setEditorPresId] = React.useState<string | null>(null);
  const [editorPres, setEditorPres] = React.useState<CustomPresentation | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [studioSlides, setStudioSlides] = React.useState<Record<string, CustomSlide[]>>({});
  const [mediaImages, setMediaImages] = React.useState<MediaItem[]>([]);

  // LT Designer state
  const [ltTemplate, setLtTemplate] = React.useState<LowerThirdTemplate>(DEFAULT_LT_TEMPLATE);
  const [ltSavedTemplates, setLtSavedTemplates] = React.useState<LowerThirdTemplate[]>([DEFAULT_LT_TEMPLATE]);
  const [ltMode, setLtMode] = React.useState<"nameplate" | "lyrics" | "freetext">("nameplate");
  const [ltName, setLtName] = React.useState("Full Name");
  const [ltTitle, setLtTitle] = React.useState("Title Here");
  const [ltFreeText, setLtFreeText] = React.useState("Your message here...");
  const [ltVisible, setLtVisible] = React.useState(false);
  const [ltTemplateName, setLtTemplateName] = React.useState("");

  // Scene state
  const [workingScene, setWorkingScene] = React.useState<SceneData>({ id: stableId(), name: "New Scene", layers: [] });
  const [activeLayerId, setActiveLayerId] = React.useState<string | null>(null);
  const [savedScenes, setSavedScenes] = React.useState<SceneData[]>([]);

  // Props state
  const [propItems, setPropItems] = React.useState<PropItem[]>([]);

  // Settings state
  const [settings, setSettings] = React.useState<PresentationSettings>({
    theme: "dark", reference_position: "bottom", background: { type: "None" }, is_blanked: false, font_size: 72,
    slide_transition: "fade", slide_transition_duration: 0.4,
  });
  const [cameras, setCameras] = React.useState<MediaDeviceInfo[]>([]);

  const [toast, setToast] = React.useState<string | null>(null);

  // Load data on mount
  React.useEffect(() => {
    invoke<{ id: string; name: string; slide_count: number }[]>("list_studio_presentations")
      .then(setStudioList).catch(() => {});
    invoke<MediaItem[]>("get_media").then((m) => setMediaImages(m.filter(i => i.media_type === "Image"))).catch(() => {});
    invoke<LowerThirdTemplate[]>("load_lt_templates").then((ts) => {
      if (ts?.length) { setLtSavedTemplates(ts); setLtTemplate(ts[0]); }
    }).catch(() => {});
    invoke<PropItem[]>("get_props").then(setPropItems).catch(() => {});
    invoke<SceneData[]>("list_scenes").then(setSavedScenes).catch(() => {});
    invoke<PresentationSettings>("get_settings").then((s) => { if (s) setSettings(s); }).catch(() => {});
    navigator.mediaDevices?.enumerateDevices()
      .then((devs) => setCameras(devs.filter((d) => d.kind === "videoinput")))
      .catch(() => {});
  }, []);

  const loadStudioList = async () => {
    const list = await invoke<{ id: string; name: string; slide_count: number }[]>("list_studio_presentations");
    setStudioList(list);
  };

  const handleNewPresentation = async () => {
    const pres: CustomPresentation = { id: stableId(), name: "Untitled Presentation", slides: [newDefaultSlide()] };
    await invoke("save_studio_presentation", { presentation: pres });
    await loadStudioList();
    setEditorPres(pres);
    setEditorPresId(pres.id);
  };

  const handleOpenEditor = async (id: string) => {
    const data: any = await invoke("load_studio_presentation", { id });
    setEditorPres(data as CustomPresentation);
    setEditorPresId(id);
  };

  const handleDeletePresentation = async (id: string) => {
    await invoke("delete_studio_presentation", { id });
    setStudioList((prev) => prev.filter((p) => p.id !== id));
    setStudioSlides((prev) => { const n = { ...prev }; delete n[id]; return n; });
    if (expandedId === id) setExpandedId(null);
  };

  const handleExpandPresentation = async (id: string) => {
    if (expandedId === id) { setExpandedId(null); return; }
    if (!studioSlides[id]) {
      const data: any = await invoke("load_studio_presentation", { id });
      const pres = data as CustomPresentation;
      setStudioSlides((prev) => ({ ...prev, [id]: pres.slides }));
    }
    setExpandedId(id);
  };

  const saveScene = async () => {
    await invoke("save_scene", { scene: workingScene });
    const scenes = await invoke<SceneData[]>("list_scenes");
    setSavedScenes(scenes);
    setToast("Scene saved");
  };

  const saveLtTemplates = async (templates: LowerThirdTemplate[]) => {
    await invoke("save_lt_templates", { templates });
  };

  const updateSettings = async (next: PresentationSettings) => {
    setSettings(next);
    await invoke("save_settings", { settings: next });
  };

  const updateProps = async (items: PropItem[]) => {
    setPropItems(items);
    await invoke("set_props", { props: items });
  };

  // If editor is open, show it full screen
  if (editorPresId && editorPres) {
    return (
      <SlideEditor
        initialPres={editorPres}
        mediaImages={mediaImages}
        onClose={async (saved) => {
          setEditorPresId(null);
          setEditorPres(null);
          if (saved) {
            await loadStudioList();
            setStudioSlides((prev) => { const n = { ...prev }; delete n[editorPresId]; return n; });
          }
        }}
      />
    );
  }

  return (
    <div className="h-screen bg-slate-950 text-slate-200 flex flex-col font-sans overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/60 shrink-0">
        <span className="text-[10px] font-black uppercase tracking-widest text-purple-400">Design Hub</span>
        <div className="h-4 w-px bg-slate-700" />
        {/* Tab bar */}
        <div className="flex gap-1">
          {([
            { id: "studio", label: "Studio" },
            { id: "lt-designer", label: "LT Designer" },
            { id: "scene", label: "Scene Builder" },
            { id: "props", label: "Props" },
            { id: "settings", label: "Preferences" },
          ] as const).map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setHubTab(id)}
              className={`px-3 py-1 rounded text-xs font-bold transition-all ${
                hubTab === id
                  ? "bg-purple-600 text-white"
                  : "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto text-[9px] text-slate-600">Opens from Operator → DESIGN HUB</div>
      </header>

      <div className="flex-1 overflow-hidden">

        {/* ── Studio Tab ── */}
        {hubTab === "studio" && (
          <div className="h-full flex flex-col overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 shrink-0">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Custom Presentations</span>
              <button
                onClick={handleNewPresentation}
                className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold rounded transition-all"
              >
                <Plus size={12} /> New Presentation
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {studioList.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-center gap-3">
                  <Layers size={32} className="text-slate-800" />
                  <p className="text-xs text-slate-600 italic">No presentations yet. Click "New Presentation" to get started.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {studioList.map((pres) => (
                    <div key={pres.id} className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden">
                      <div className="flex items-center gap-3 px-4 py-3">
                        <Layers size={16} className="text-purple-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-slate-200 truncate">{pres.name}</p>
                          <p className="text-[9px] text-slate-600">{pres.slide_count} slide{pres.slide_count !== 1 ? "s" : ""}</p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleExpandPresentation(pres.id)}
                            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-[9px] font-bold rounded transition-all"
                          >
                            {expandedId === pres.id ? "▲ COLLAPSE" : "▼ SLIDES"}
                          </button>
                          <button
                            onClick={() => handleOpenEditor(pres.id)}
                            className="px-2 py-1 bg-purple-600/20 hover:bg-purple-600 text-purple-400 hover:text-white text-[9px] font-bold rounded border border-purple-600/30 transition-all"
                          >
                            EDIT
                          </button>
                          <button
                            onClick={() => handleDeletePresentation(pres.id)}
                            className="px-2 py-1 bg-red-900/20 hover:bg-red-600 text-red-400 hover:text-white text-[9px] font-bold rounded border border-red-900/30 transition-all"
                          >
                            DELETE
                          </button>
                        </div>
                      </div>
                      {expandedId === pres.id && studioSlides[pres.id] && (
                        <div className="px-4 pb-4 border-t border-slate-800/60">
                          <div className="grid grid-cols-4 gap-2 mt-3">
                            {studioSlides[pres.id].map((slide, idx) => (
                              <div
                                key={slide.id}
                                className="relative group aspect-video rounded overflow-hidden border border-slate-700 hover:border-purple-500/60 transition-all"
                              >
                                <CustomSlideRenderer slide={slide} scale={0.07} />
                                <div className="absolute bottom-0 left-0 right-0 text-center text-[7px] text-white/60 bg-black/40 py-0.5">
                                  {idx + 1}
                                </div>
                                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-all flex flex-col items-center justify-center gap-1 p-1">
                                  <button
                                    onClick={() => invoke("stage_item", {
                                      item: {
                                        type: "CustomSlide",
                                        data: {
                                          presentation_id: pres.id,
                                          presentation_name: pres.name,
                                          slide_index: idx,
                                          slide_count: studioSlides[pres.id].length,
                                          background_color: slide.backgroundColor,
                                          background_image: slide.backgroundImage,
                                          header_enabled: slide.headerEnabled ?? true,
                                          header_height_pct: slide.headerHeightPct ?? 35,
                                          header: { text: slide.header.text, font_size: slide.header.fontSize, font_family: slide.header.fontFamily, color: slide.header.color, bold: slide.header.bold, italic: slide.header.italic, align: slide.header.align },
                                          body: { text: slide.body.text, font_size: slide.body.fontSize, font_family: slide.body.fontFamily, color: slide.body.color, bold: slide.body.bold, italic: slide.body.italic, align: slide.body.align },
                                        },
                                      }
                                    })}
                                    className="w-full bg-slate-600 hover:bg-slate-500 text-white text-[8px] font-bold py-0.5 rounded"
                                  >STAGE</button>
                                  <button
                                    onClick={async () => {
                                      await invoke("stage_item", {
                                        item: {
                                          type: "CustomSlide",
                                          data: {
                                            presentation_id: pres.id,
                                            presentation_name: pres.name,
                                            slide_index: idx,
                                            slide_count: studioSlides[pres.id].length,
                                            background_color: slide.backgroundColor,
                                            background_image: slide.backgroundImage,
                                            header_enabled: slide.headerEnabled ?? true,
                                            header_height_pct: slide.headerHeightPct ?? 35,
                                            header: { text: slide.header.text, font_size: slide.header.fontSize, font_family: slide.header.fontFamily, color: slide.header.color, bold: slide.header.bold, italic: slide.header.italic, align: slide.header.align },
                                            body: { text: slide.body.text, font_size: slide.body.fontSize, font_family: slide.body.fontFamily, color: slide.body.color, bold: slide.body.bold, italic: slide.body.italic, align: slide.body.align },
                                          },
                                        }
                                      });
                                      await invoke("go_live");
                                    }}
                                    className="w-full bg-amber-500 hover:bg-amber-400 text-black text-[8px] font-bold py-0.5 rounded"
                                  >LIVE</button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── LT Designer Tab ── */}
        {hubTab === "lt-designer" && (
          <div className="h-full flex overflow-hidden">
            {/* Left: Controls */}
            <div className="w-80 border-r border-slate-800 flex flex-col overflow-hidden shrink-0">
              {/* Template management */}
              <div className="p-4 border-b border-slate-800 flex flex-col gap-2 shrink-0">
                <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Templates</p>
                <div className="flex gap-2">
                  <select
                    value={ltTemplate.id}
                    onChange={(e) => {
                      const t = ltSavedTemplates.find((t) => t.id === e.target.value);
                      if (t) setLtTemplate(t);
                    }}
                    className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none"
                  >
                    {ltSavedTemplates.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={async () => {
                      const name = ltTemplateName.trim() || `Template ${ltSavedTemplates.length + 1}`;
                      const newT = { ...ltTemplate, id: stableId(), name };
                      const updated = [...ltSavedTemplates, newT];
                      setLtSavedTemplates(updated);
                      setLtTemplate(newT);
                      setLtTemplateName("");
                      await saveLtTemplates(updated);
                    }}
                    className="px-2 py-1 bg-purple-600 hover:bg-purple-500 text-white text-[9px] font-bold rounded transition-all"
                  >+ Save</button>
                </div>
                <input
                  value={ltTemplateName}
                  onChange={(e) => setLtTemplateName(e.target.value)}
                  placeholder="New template name..."
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
              </div>
              {/* Design controls */}
              <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
                {/* Background */}
                <div className="flex flex-col gap-2 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
                  <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Background</p>
                  <div className="flex gap-1">
                    {(["solid", "gradient", "transparent", "image"] as const).map((type) => (
                      <button key={type} onClick={() => setLtTemplate((t) => ({ ...t, bgType: type }))}
                        className={`flex-1 py-0.5 text-[8px] font-bold rounded border transition-all ${ltTemplate.bgType === type ? "bg-purple-600/20 border-purple-500 text-purple-400" : "border-slate-700 text-slate-500 hover:border-slate-600"}`}>
                        {type}
                      </button>
                    ))}
                  </div>
                  {ltTemplate.bgType !== "transparent" && ltTemplate.bgType !== "image" && (
                    <div className="flex items-center gap-3">
                      <input type="color" value={ltTemplate.bgColor} onChange={(e) => setLtTemplate((t) => ({ ...t, bgColor: e.target.value }))}
                        className="w-8 h-8 rounded cursor-pointer border border-slate-700 bg-transparent" />
                      <div className="flex-1 flex flex-col gap-0.5">
                        <span className="text-[8px] text-slate-600">Opacity: {ltTemplate.bgOpacity}%</span>
                        <input type="range" min={0} max={100} value={ltTemplate.bgOpacity} onChange={(e) => setLtTemplate((t) => ({ ...t, bgOpacity: parseInt(e.target.value) }))}
                          className="w-full accent-purple-500" />
                      </div>
                    </div>
                  )}
                  {ltTemplate.bgType === "gradient" && (
                    <div className="flex items-center gap-2">
                      <span className="text-[8px] text-slate-600">End:</span>
                      <input type="color" value={ltTemplate.bgGradientEnd} onChange={(e) => setLtTemplate((t) => ({ ...t, bgGradientEnd: e.target.value }))}
                        className="w-8 h-8 rounded cursor-pointer border border-slate-700 bg-transparent" />
                    </div>
                  )}
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={ltTemplate.bgBlur} onChange={(e) => setLtTemplate((t) => ({ ...t, bgBlur: e.target.checked }))} className="accent-purple-500" />
                    <span className="text-[9px] text-slate-400">Backdrop blur</span>
                  </label>
                </div>

                {/* Accent bar */}
                <div className="flex flex-col gap-2 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
                  <div className="flex items-center justify-between">
                    <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Accent Bar</p>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={ltTemplate.accentEnabled} onChange={(e) => setLtTemplate((t) => ({ ...t, accentEnabled: e.target.checked }))} className="accent-purple-500" />
                      <span className="text-[9px] text-slate-400">Enabled</span>
                    </label>
                  </div>
                  {ltTemplate.accentEnabled && (
                    <div className="flex gap-2 items-center flex-wrap">
                      <input type="color" value={ltTemplate.accentColor} onChange={(e) => setLtTemplate((t) => ({ ...t, accentColor: e.target.value }))}
                        className="w-7 h-7 rounded cursor-pointer border border-slate-700 bg-transparent" />
                      <div className="flex gap-1">
                        {(["left", "right", "top", "bottom"] as const).map((s) => (
                          <button key={s} onClick={() => setLtTemplate((t) => ({ ...t, accentSide: s }))}
                            className={`px-1.5 py-0.5 text-[8px] font-bold rounded border transition-all ${ltTemplate.accentSide === s ? "bg-purple-600/20 border-purple-500 text-purple-400" : "border-slate-700 text-slate-500"}`}>
                            {s[0].toUpperCase()}
                          </button>
                        ))}
                      </div>
                      <div className="flex-1 flex flex-col gap-0.5">
                        <span className="text-[8px] text-slate-600">Width: {ltTemplate.accentWidth}px</span>
                        <input type="range" min={2} max={16} value={ltTemplate.accentWidth} onChange={(e) => setLtTemplate((t) => ({ ...t, accentWidth: parseInt(e.target.value) }))}
                          className="w-full accent-purple-500" />
                      </div>
                    </div>
                  )}
                </div>

                {/* Position */}
                <div className="flex flex-col gap-2 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
                  <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Position & Size</p>
                  <div className="grid grid-cols-3 gap-1">
                    {(["left", "center", "right"] as const).map((h) => (
                      <button key={h} onClick={() => setLtTemplate((t) => ({ ...t, hAlign: h }))}
                        className={`py-0.5 text-[8px] font-bold rounded border transition-all ${ltTemplate.hAlign === h ? "bg-purple-600/20 border-purple-500 text-purple-400" : "border-slate-700 text-slate-500"}`}>
                        {h}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {(["top", "middle", "bottom"] as const).map((v) => (
                      <button key={v} onClick={() => setLtTemplate((t) => ({ ...t, vAlign: v }))}
                        className={`py-0.5 text-[8px] font-bold rounded border transition-all ${ltTemplate.vAlign === v ? "bg-purple-600/20 border-purple-500 text-purple-400" : "border-slate-700 text-slate-500"}`}>
                        {v}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[8px] text-slate-500">
                    <div>
                      <p>Width: {ltTemplate.widthPct}%</p>
                      <input type="range" min={20} max={100} value={ltTemplate.widthPct} onChange={(e) => setLtTemplate((t) => ({ ...t, widthPct: parseInt(e.target.value) }))} className="w-full accent-purple-500" />
                    </div>
                    <div>
                      <p>Border radius: {ltTemplate.borderRadius}</p>
                      <input type="range" min={0} max={32} value={ltTemplate.borderRadius} onChange={(e) => setLtTemplate((t) => ({ ...t, borderRadius: parseInt(e.target.value) }))} className="w-full accent-purple-500" />
                    </div>
                  </div>
                </div>

                {/* Typography */}
                <div className="flex flex-col gap-2 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
                  <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Primary Text</p>
                  <div className="flex gap-2">
                    <select value={ltTemplate.primaryFont} onChange={(e) => setLtTemplate((t) => ({ ...t, primaryFont: e.target.value }))}
                      className="flex-1 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-200 focus:outline-none">
                      {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                    <input type="number" min={12} max={120} value={ltTemplate.primarySize}
                      onChange={(e) => setLtTemplate((t) => ({ ...t, primarySize: parseInt(e.target.value) }))}
                      className="w-14 bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-200 focus:outline-none" />
                    <input type="color" value={ltTemplate.primaryColor} onChange={(e) => setLtTemplate((t) => ({ ...t, primaryColor: e.target.value }))}
                      className="w-7 h-7 rounded cursor-pointer border border-slate-700" />
                  </div>
                </div>

                {/* Animation */}
                <div className="flex flex-col gap-2 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
                  <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Animation</p>
                  <div className="flex gap-1">
                    {(["fade", "slide-up", "slide-left", "none"] as const).map((a) => (
                      <button key={a} onClick={() => setLtTemplate((t) => ({ ...t, animation: a }))}
                        className={`flex-1 py-0.5 text-[8px] font-bold rounded border transition-all ${ltTemplate.animation === a ? "bg-purple-600/20 border-purple-500 text-purple-400" : "border-slate-700 text-slate-500"}`}>
                        {a}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Fire Controls */}
                <div className="flex flex-col gap-2 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
                  <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Fire Controls</p>
                  <div className="flex gap-2">
                    {(["nameplate", "lyrics", "freetext"] as const).map((m) => (
                      <button key={m} onClick={() => setLtMode(m)}
                        className={`flex-1 py-1 text-[9px] font-bold rounded border transition-all ${ltMode === m ? "bg-amber-500/20 border-amber-500 text-amber-400" : "border-slate-700 text-slate-500 hover:border-slate-600"}`}>
                        {m}
                      </button>
                    ))}
                  </div>
                  {ltMode === "nameplate" && (
                    <div className="flex flex-col gap-1">
                      <input value={ltName} onChange={(e) => setLtName(e.target.value)} placeholder="Name..." className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500" />
                      <input value={ltTitle} onChange={(e) => setLtTitle(e.target.value)} placeholder="Title..." className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500" />
                    </div>
                  )}
                  {ltMode === "freetext" && (
                    <textarea value={ltFreeText} onChange={(e) => setLtFreeText(e.target.value)} rows={2}
                      className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 resize-none focus:outline-none focus:ring-1 focus:ring-amber-500" />
                  )}
                  <button
                    onClick={async () => {
                      let data: LowerThirdData;
                      if (ltMode === "nameplate") data = { kind: "Nameplate", data: { name: ltName, title: ltTitle || undefined } };
                      else if (ltMode === "freetext") data = { kind: "FreeText", data: { text: ltFreeText } };
                      else data = { kind: "FreeText", data: { text: "Lyrics mode: use Operator LT tab" } };
                      if (ltVisible) {
                        await invoke("hide_lower_third");
                        setLtVisible(false);
                      } else {
                        await invoke("show_lower_third", { data, template: ltTemplate });
                        setLtVisible(true);
                      }
                    }}
                    className={`py-2 text-xs font-black uppercase rounded-lg transition-all ${ltVisible ? "bg-red-600 text-white" : "bg-green-600 text-white"}`}
                  >
                    {ltVisible ? "HIDE LOWER THIRD" : "SHOW LOWER THIRD"}
                  </button>
                </div>
              </div>
            </div>

            {/* Right: 16:9 live preview */}
            <div className="flex-1 flex items-center justify-center bg-black p-8 overflow-hidden">
              <div className="relative w-full" style={{ aspectRatio: "16/9", maxHeight: "100%" }}>
                <div className="w-full h-full bg-slate-900 rounded-xl overflow-hidden shadow-2xl border border-slate-700 relative" style={{ aspectRatio: "16/9" }}>
                  {/* Simulated background */}
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="font-serif text-2xl italic text-slate-800">Preview Background</span>
                  </div>
                  {/* LT overlay preview */}
                  <div className="absolute inset-0" style={{ width: 1920, height: 1080, transform: `scale(${Math.min(1, 1)})`, transformOrigin: "top left" }}>
                    <div style={{ position: "absolute", inset: 0, transform: "scale(0.5)", transformOrigin: "top left", width: "200%", height: "200%" }}>
                      <LowerThirdOverlay
                        template={ltTemplate}
                        data={
                          ltMode === "nameplate" ? { kind: "Nameplate", data: { name: ltName || "Full Name", title: ltTitle || "Title Here" } } :
                          ltMode === "freetext" ? { kind: "FreeText", data: { text: ltFreeText || "Your message here..." } } :
                          { kind: "Lyrics", data: { line1: "Lyric Line 1", line2: "Lyric Line 2", section_label: "Verse 1" } }
                        }
                      />
                    </div>
                  </div>
                </div>
                <p className="text-center text-[9px] text-slate-600 mt-2">Live preview — 16:9 • 1920×1080</p>
              </div>
            </div>
          </div>
        )}

        {/* ── Scene Builder Tab ── */}
        {hubTab === "scene" && (
          <div className="h-full flex overflow-hidden">
            {/* Left: Layer panel */}
            <div className="w-72 border-r border-slate-800 flex flex-col overflow-hidden shrink-0">
              <div className="p-3 border-b border-slate-800 flex items-center justify-between shrink-0">
                <span className="text-[9px] font-black uppercase text-slate-500">Scene Layers</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      const layer: SceneLayer = {
                        id: stableId(), name: `Layer ${workingScene.layers.length + 1}`,
                        content: { kind: "empty" }, x: 0, y: 0, w: 100, h: 100, opacity: 1, visible: true,
                      };
                      setWorkingScene((s) => ({ ...s, layers: [...s.layers, layer] }));
                    }}
                    className="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 text-white text-[9px] font-bold rounded transition-all"
                  >
                    + Layer
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
                {workingScene.layers.length === 0 ? (
                  <p className="text-[10px] text-slate-600 text-center italic mt-8">Add layers to build your scene.</p>
                ) : (
                  [...workingScene.layers].reverse().map((layer) => (
                    <div
                      key={layer.id}
                      onClick={() => setActiveLayerId(layer.id)}
                      className={`flex items-center gap-2 px-2 py-2 rounded-lg border cursor-pointer transition-all ${
                        activeLayerId === layer.id
                          ? "bg-blue-600/10 border-blue-500/40 text-blue-400"
                          : "bg-slate-900/40 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-300"
                      }`}
                    >
                      <span className="text-[9px] font-bold truncate flex-1">{layer.name}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setWorkingScene((s) => ({
                            ...s,
                            layers: s.layers.map((l) => l.id === layer.id ? { ...l, visible: !l.visible } : l),
                          }));
                        }}
                        className="text-slate-500 hover:text-slate-300"
                      >
                        {layer.visible ? <Eye size={11} /> : <EyeOff size={11} />}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setWorkingScene((s) => ({ ...s, layers: s.layers.filter((l) => l.id !== layer.id) }));
                          if (activeLayerId === layer.id) setActiveLayerId(null);
                        }}
                        className="text-red-600 hover:text-red-400"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="p-3 border-t border-slate-800 flex flex-col gap-2 shrink-0">
                <input
                  value={workingScene.name}
                  onChange={(e) => setWorkingScene((s) => ({ ...s, name: e.target.value }))}
                  className="w-full bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="Scene name..."
                />
                <button onClick={saveScene} className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white text-[9px] font-black uppercase rounded transition-all">
                  Save Scene
                </button>
                {savedScenes.length > 0 && (
                  <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                    {savedScenes.map((scene) => (
                      <button
                        key={scene.id}
                        onClick={() => { setWorkingScene(scene); setActiveLayerId(null); }}
                        className="text-left px-2 py-1 bg-slate-900/40 hover:bg-slate-800 text-slate-400 text-[9px] rounded border border-slate-800 transition-all"
                      >
                        {scene.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Center: Scene canvas preview */}
            <div className="flex-1 flex items-center justify-center bg-black/60 overflow-hidden p-6">
              <div
                className="relative rounded-lg overflow-hidden ring-2 ring-slate-700 shadow-2xl"
                style={{ aspectRatio: "16/9", width: "100%", maxHeight: "100%" }}
              >
                <SceneRenderer scene={workingScene} activeLayerId={activeLayerId} onLayerClick={setActiveLayerId} />
              </div>
            </div>
          </div>
        )}

        {/* ── Props Tab ── */}
        {hubTab === "props" && (
          <div className="h-full overflow-y-auto">
            <div className="p-4 flex flex-col gap-4">
              <div className="flex items-center justify-between shrink-0">
                <span className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Persistent Props Layer</span>
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      const selected = await invoke<string | null>("open_file_dialog", {}).catch(() => null);
                      if (!selected) return;
                      const newProp: PropItem = {
                        id: stableId(), kind: "image", path: selected,
                        x: 10, y: 10, w: 30, h: 20, opacity: 1, visible: true,
                      };
                      await updateProps([...propItems, newProp]);
                    }}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold rounded transition-all flex items-center gap-1"
                  >
                    <Plus size={12} /> Image
                  </button>
                  <button
                    onClick={async () => {
                      const newProp: PropItem = {
                        id: stableId(), kind: "clock",
                        text: "HH:mm:ss", color: "#ffffff",
                        x: 75, y: 5, w: 20, h: 10, opacity: 1, visible: true,
                      };
                      await updateProps([...propItems, newProp]);
                    }}
                    className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-bold rounded transition-all flex items-center gap-1"
                  >
                    <Clock size={12} /> Clock
                  </button>
                  {propItems.length > 0 && (
                    <button
                      onClick={() => updateProps([])}
                      className="px-3 py-1.5 bg-red-900/40 hover:bg-red-600 text-red-300 text-xs font-bold rounded transition-all"
                    >
                      Clear All
                    </button>
                  )}
                </div>
              </div>

              {propItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 gap-3 text-center">
                  <Monitor size={32} className="text-slate-800" />
                  <p className="text-xs text-slate-600 italic">No props yet. Add images or clocks that stay visible on the output window.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {propItems.map((prop) => (
                    <div key={prop.id} className="bg-slate-900/50 border border-slate-800 rounded-xl p-3 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {prop.kind === "clock" ? <Clock size={14} className="text-amber-400" /> : <Image size={14} className="text-blue-400" />}
                          <span className="text-xs font-bold text-slate-300 capitalize">{prop.kind}</span>
                          {prop.kind === "image" && prop.path && (
                            <span className="text-[9px] text-slate-600 truncate max-w-[160px]">{prop.path.split(/[/\\]/).pop()}</span>
                          )}
                          {prop.kind === "clock" && (
                            <span className="text-[9px] text-slate-500 font-mono">{prop.text}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => updateProps(propItems.map((p) => p.id === prop.id ? { ...p, visible: !p.visible } : p))}
                            className={`p-1 rounded transition-all ${prop.visible ? "text-green-400" : "text-slate-600"}`}
                          >
                            {prop.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                          </button>
                          <button
                            onClick={() => updateProps(propItems.filter((p) => p.id !== prop.id))}
                            className="p-1 text-red-600 hover:text-red-400 rounded transition-all"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[8px] text-slate-500">
                        <div>
                          <p>Opacity: {Math.round(prop.opacity * 100)}%</p>
                          <input type="range" min={0} max={1} step={0.05} value={prop.opacity}
                            onChange={(e) => updateProps(propItems.map((p) => p.id === prop.id ? { ...p, opacity: parseFloat(e.target.value) } : p))}
                            className="w-full accent-amber-500" />
                        </div>
                        <div className="grid grid-cols-2 gap-1">
                          {([["x", "X"], ["y", "Y"], ["w", "W%"], ["h", "H%"]] as [keyof PropItem, string][]).map(([k, lbl]) => (
                            <div key={k}>
                              <span>{lbl}: {Math.round(prop[k] as number)}</span>
                              <input type="range" min={0} max={100}
                                value={prop[k] as number}
                                onChange={(e) => updateProps(propItems.map((p) => p.id === prop.id ? { ...p, [k]: parseFloat(e.target.value) } : p))}
                                className="w-full accent-amber-500" />
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Preferences Tab ── */}
        {hubTab === "settings" && (
          <div className="h-full overflow-y-auto p-4">
            <SettingsTab
              onUpdateSettings={updateSettings}
              onUpdateTranscriptionWindow={(sec) => invoke("set_transcription_window", { samples: Math.round(sec * 16000) })}
              onUploadMedia={async () => {}}
            />
          </div>
        )}
      </div>

      <AnimatePresence>
        {toast && <Toast key={toast} message={toast} onDone={() => setToast(null)} />}
      </AnimatePresence>
    </div>
  );
}

// ─── Main Operator Window ─────────────────────────────────────────────────────

export default function App() {
  const [label, setLabel] = useState("");

  // Presentation state
  const [liveItem, setLiveItem] = useState<DisplayItem | null>(null);
  const [stagedItem, setStagedItem] = useState<DisplayItem | null>(null);
  const [suggestedItem, setSuggestedItem] = useState<DisplayItem | null>(null);
  const [suggestedConfidence, setSuggestedConfidence] = useState<number>(0);
  const [nextVerse, setNextVerse] = useState<Verse | null>(null);
  // History of recently projected items (most recent first, max 10)
  const [verseHistory, setVerseHistory] = useState<DisplayItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  
  // Layout states
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [isTranscriptionCollapsed, setIsTranscriptionCollapsed] = useState(false);
  const [isSchedulePersistent, setIsSchedulePersistent] = useState(true);
  const [bottomDeckOpen, setBottomDeckOpen] = useState(false);
  const [bottomDeckMode, setBottomDeckMode] = useState<"live-lt" | "studio-slides" | "studio-lt" | "scene-composer" | "timer">("live-lt");

  // Timer state
  const [timerType, setTimerType] = useState<"countdown" | "countup" | "clock">("countdown");
  const [timerHours, setTimerHours] = useState(0);
  const [timerMinutes, setTimerMinutes] = useState(5);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [timerLabel, setTimerLabel] = useState("");
  const [timerRunning, setTimerRunning] = useState(false);
  const [isBlackout, setIsBlackout] = useState(false);

  // Scene Composer states
  const [workingScene, setWorkingScene] = useState<SceneData>({
    id: stableId(),
    name: "New Scene",
    layers: [],
  });
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [savedScenes, setSavedScenes] = useState<SceneData[]>([]);

  // Settings
  const [settings, setSettings] = useState<PresentationSettings>({
    theme: "dark",
    reference_position: "bottom",
    background: { type: "None" },
    is_blanked: false,
    font_size: 72,
    slide_transition: "fade",
    slide_transition_duration: 0.4,
  });

  // Studio
  const [studioList, setStudioList] = useState<{ id: string; name: string; slide_count: number }[]>([]);
  const [editorPresId, setEditorPresId] = useState<string | null>(null);
  const [editorPres, setEditorPres] = useState<CustomPresentation | null>(null);
  const [expandedStudioPresId, setExpandedStudioPresId] = useState<string | null>(null);
  const [studioSlides, setStudioSlides] = useState<Record<string, CustomSlide[]>>({});

  // UI
  const [activeTab, setActiveTab] = useState<"bible" | "media" | "presentations" | "songs" | "lower-third" | "timers" | "studio" | "schedule" | "settings" | "props">("bible");
  const [toast, setToast] = useState<string | null>(null);

  // Songs library
  const [songs, setSongs] = useState<Song[]>([]);

  // Lower third
  type LtMode = "nameplate" | "lyrics" | "freetext";
  const [ltMode, setLtMode] = useState<LtMode>("nameplate");
  const [ltVisible, setLtVisible] = useState(false);
  const [ltTemplate, setLtTemplate] = useState<LowerThirdTemplate>(DEFAULT_LT_TEMPLATE);
  const [ltSavedTemplates, setLtSavedTemplates] = useState<LowerThirdTemplate[]>([DEFAULT_LT_TEMPLATE]);
  const [ltDesignOpen, setLtDesignOpen] = useState(false);
  const [showLtImgPicker, setShowLtImgPicker] = useState(false);
  // Nameplate mode
  const [ltName, setLtName] = useState("");
  const [ltTitle, setLtTitle] = useState("");
  // Free text mode
  const [ltFreeText, setLtFreeText] = useState("");
  // Lyrics mode
  const [ltSongId, setLtSongId] = useState<string | null>(null);
  const [ltLineIndex, setLtLineIndex] = useState(0);
  const [ltLinesPerDisplay, setLtLinesPerDisplay] = useState<1 | 2>(2);
  const [ltAutoAdvance, setLtAutoAdvance] = useState(false);
  const [ltAutoSeconds, setLtAutoSeconds] = useState(4);
  const [ltAtEnd, setLtAtEnd] = useState(false);
  const ltAutoRef = useRef<ReturnType<typeof setInterval> | null>(null);


  // Schedule
  const [scheduleEntries, setScheduleEntries] = useState<ScheduleEntry[]>([]);
  const scheduleRef = useRef<ScheduleEntry[]>([]);
  const [activeScheduleIdx, setActiveScheduleIdx] = useState<number | null>(null);

  // Service workflow
  const [services, setServices] = useState<ServiceMeta[]>([]);
  const [activeServiceId, setActiveServiceId] = useState("default");
  const [serviceManagerOpen, setServiceManagerOpen] = useState(false);
  const [newServiceName, setNewServiceName] = useState("");

  // Props layer
  const [propItems, setPropItems] = useState<PropItem[]>([]);

  // Media
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [enabledLocalCameras, setEnabledLocalCameras] = useState<Set<string>>(new Set());
  const [mediaFilter, setMediaFilter] = useState<"image" | "video" | "camera">("image");

  // LAN camera mixer
  const [cameraSources, setCameraSources] = useState<Map<string, CameraSource>>(new Map());
  const [pauseWhisper, setPauseWhisper] = useState(() => localStorage.getItem("pref_pauseWhisper") === "true");
  const operatorWsRef = useRef<WebSocket | null>(null);
  // Per-source preview RTCPeerConnections (keyed by device_id)
  const previewPcMapRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // Per-source preview <video> elements (keyed by device_id)
  const previewVideoMapRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  // Per-source IntersectionObservers for decode pause/resume
  const previewObserverMapRef = useRef<Map<string, IntersectionObserver>>(new Map());
  // Buffered WebRTC offers for sources that aren't yet enabled
  const pendingOffersRef = useRef<Map<string, { device_id: string; device_name?: string; sdp: string }>>(new Map());
  // Buffered ICE candidates that arrive before the preview PC is created (e.g. while preview is disabled)
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  // Tracks which device_ids have preview enabled (ref avoids stale closure in WS handler)
  const cameraEnabledRef = useRef<Set<string>>(new Set());

  // Presentations
  const [presentations, setPresentations] = useState<PresentationFile[]>([]);
  const [selectedPresId, setSelectedPresId] = useState<string | null>(null);
  const [loadedSlides, setLoadedSlides] = useState<Record<string, ParsedSlide[]>>({});
  const presZipsRef = useRef<Record<string, any>>({});

  // Session / audio
  const [transcript, setTranscript] = useState("");
  const [devices, setDevices] = useState<[string, string][]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [vadThreshold, setVadThreshold] = useState(() =>
    parseFloat(localStorage.getItem("pref_vadThreshold") ?? "0.002")
  );
  // Transcription window in seconds (0.5–3.0). Larger = lower CPU, more latency.
  const [transcriptionWindowSec, setTranscriptionWindowSec] = useState(() =>
    parseFloat(localStorage.getItem("pref_transcriptionWindowSec") ?? "1.0")
  );
  const [sessionState, setSessionState] = useState<"idle" | "loading" | "running">("idle");
  const [audioError, setAudioError] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0);

  // Remote control
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remotePin, setRemotePin] = useState("");
  const [tailscaleUrl, setTailscaleUrl] = useState<string | null>(null);

  // Bible version
  const [availableVersions, setAvailableVersions] = useState<string[]>(["KJV"]);
  const [bibleVersion, setBibleVersion] = useState("KJV");

  // Manual bible picker
  const [books, setBooks] = useState<string[]>([]);
  const [chapters, setChapters] = useState<number[]>([]);
  const [verses, setVerses] = useState<number[]>([]);
  const [selectedBook, setSelectedBook] = useState("");
  const [selectedChapter, setSelectedChapter] = useState(0);
  const [selectedVerse, setSelectedVerse] = useState(0);

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Verse[]>([]);

  // Collapsible Bible tab sections
  const [bibleOpen, setBibleOpen] = useState({ quickEntry: true, manualSelection: true, keywordSearch: true });

  // Adjustable main panel heights (top transcription panel as % of main area)
  const [topPanelPct, setTopPanelPct] = useState(() =>
    parseInt(localStorage.getItem("pref_topPanelPct") ?? "33", 10)
  );
  // Adjustable stage/live split (stage panel as % of bottom area)
  const [stagePct, setStagePct] = useState(() =>
    parseInt(localStorage.getItem("pref_stagePct") ?? "50", 10)
  );
  const mainPanelRef = useRef<HTMLDivElement>(null);
  const bottomPanelRef = useRef<HTMLDivElement>(null);
  const vertDragRef = useRef<{ active: boolean; startY: number; startPct: number }>({ active: false, startY: 0, startPct: 33 });
  const horizDragRef = useRef<{ active: boolean; startX: number; startPct: number }>({ active: false, startX: 0, startPct: 50 });

  scheduleRef.current = scheduleEntries;

  // ── Whisper pause sync: when cameraSources has feeds and pauseWhisper is on, pause Whisper ──
  useEffect(() => {
    const shouldPause = pauseWhisper && cameraSources.size > 0;
    localStorage.setItem("pref_pauseWhisper", String(pauseWhisper));
    invoke("set_transcription_paused", { paused: shouldPause }).catch(() => {});
  }, [pauseWhisper, cameraSources.size]);

  // ── LAN Camera Mixer — Operator WebSocket + WebRTC ───────────────────────────

  const STUN_CONFIG: RTCConfiguration = { 
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" }
    ], 
    iceCandidatePoolSize: 10 
  };

  function connectOperatorWs(pin: string) {
    const ws = new WebSocket(`ws://127.0.0.1:7420/ws`);
    operatorWsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ cmd: "auth", pin, client_type: "window:main" }));
    };

    ws.onmessage = async (e: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }

      // Auth ack
      if (msg.type === "auth_ok") return;

      // Mobile connected — add to camera sources (preview off by default)
      if (msg.type === "camera_source_connected") {
        const { device_id, device_name } = msg;
        setCameraSources(prev => {
          const next = new Map(prev);
          const existing = prev.get(device_id);
          next.set(device_id, { device_id, device_name, previewStream: null, previewPc: null, status: "disconnected", connectedAt: Date.now(), enabled: existing?.enabled ?? false });
          return next;
        });
        return;
      }

      // Mobile disconnected — clean up
      if (msg.type === "camera_source_disconnected") {
        const { device_id } = msg;
        const pc = previewPcMapRef.current.get(device_id);
        if (pc) { pc.close(); previewPcMapRef.current.delete(device_id); }
        const videoEl = previewVideoMapRef.current.get(device_id);
        if (videoEl) { videoEl.srcObject = null; previewVideoMapRef.current.delete(device_id); }
        const obs = previewObserverMapRef.current.get(device_id);
        if (obs) { obs.disconnect(); previewObserverMapRef.current.delete(device_id); }
        pendingOffersRef.current.delete(device_id);
        pendingIceRef.current.delete(device_id);
        setCameraSources(prev => {
          const next = new Map(prev);
          next.delete(device_id);
          return next;
        });
        return;
      }

      // WebRTC offer from mobile → operator (preview stream)
      if (msg.cmd === "camera_offer" && (msg.target === "operator" || msg.target === "window:main")) {
        // Always buffer the latest offer in case the source is toggled on later
        pendingOffersRef.current.set(msg.device_id, msg);
        // Only process immediately if this source has preview enabled
        if (cameraEnabledRef.current.has(msg.device_id)) {
          await handlePreviewOffer(msg);
        }
        return;
      }

      // ICE candidate for preview PC
      if (msg.cmd === "camera_ice" && (msg.target === "operator" || msg.target === "window:main")) {
        const pc = previewPcMapRef.current.get(msg.device_id);
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
        } else if (msg.candidate) {
          // PC not created yet (preview disabled) — buffer for when it's enabled
          const buf = pendingIceRef.current.get(msg.device_id) ?? [];
          buf.push(msg.candidate);
          pendingIceRef.current.set(msg.device_id, buf);
        }
        return;
      }
    };

    ws.onclose = () => {
      // Reconnect after 5 s if we have a PIN
      setTimeout(() => { if (operatorWsRef.current?.readyState === WebSocket.CLOSED) connectOperatorWs(pin); }, 5000);
    };
  }

  async function handlePreviewOffer(msg: { device_id: string; device_name?: string; sdp: string }) {
    const { device_id, device_name = "", sdp } = msg;

    // Close stale PC for this device if any
    const oldPc = previewPcMapRef.current.get(device_id);
    if (oldPc) { oldPc.close(); }

    const pc = new RTCPeerConnection(STUN_CONFIG);
    previewPcMapRef.current.set(device_id, pc);

    // Receive track → set srcObject on corresponding preview video element
    pc.ontrack = (ev: RTCTrackEvent) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      setCameraSources(prev => {
        const next = new Map(prev);
        const src = next.get(device_id);
        if (src) next.set(device_id, { ...src, previewStream: stream, previewPc: pc, status: "connected" });
        return next;
      });
      const videoEl = previewVideoMapRef.current.get(device_id);
      if (videoEl) videoEl.srcObject = stream;
    };

    // ICE → send to mobile
    pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (ev.candidate) {
        operatorWsRef.current?.send(JSON.stringify({
          cmd: "camera_ice",
          device_id,
          target: `mobile:${device_id}`,
          candidate: ev.candidate,
        }));
      }
    };

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      setCameraSources(prev => {
        const next = new Map(prev);
        const src = next.get(device_id);
        if (!src) return prev;
        const status = (s === "connected" || s === "completed") ? "connected"
          : (s === "failed" || s === "disconnected" || s === "closed") ? "disconnected"
          : "connecting";
        next.set(device_id, { ...src, status });
        return next;
      });
    };

    await pc.setRemoteDescription({ type: "offer", sdp });

    // Apply any ICE candidates that arrived while the PC didn't exist yet
    const buffered = pendingIceRef.current.get(device_id) ?? [];
    pendingIceRef.current.delete(device_id);
    for (const candidate of buffered) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    operatorWsRef.current?.send(JSON.stringify({
      cmd: "camera_answer",
      device_id,
      target: `mobile:${device_id}`,
      sdp: answer.sdp,
    }));
  }

  async function enableCameraPreview(device_id: string) {
    cameraEnabledRef.current.add(device_id);
    setCameraSources(prev => {
      const next = new Map(prev);
      const src = next.get(device_id);
      if (src) next.set(device_id, { ...src, enabled: true, status: "connecting" });
      return next;
    });
    const pending = pendingOffersRef.current.get(device_id);
    if (pending) await handlePreviewOffer(pending);
  }

  function disableCameraPreview(device_id: string) {
    cameraEnabledRef.current.delete(device_id);
    const pc = previewPcMapRef.current.get(device_id);
    if (pc) { pc.close(); previewPcMapRef.current.delete(device_id); }
    const videoEl = previewVideoMapRef.current.get(device_id);
    if (videoEl) videoEl.srcObject = null;
    setCameraSources(prev => {
      const next = new Map(prev);
      const src = next.get(device_id);
      if (src) next.set(device_id, { ...src, enabled: false, previewStream: null, previewPc: null, status: "disconnected" });
      return next;
    });
  }

  function removeCameraSource(device_id: string) {
    cameraEnabledRef.current.delete(device_id);
    pendingOffersRef.current.delete(device_id);
    pendingIceRef.current.delete(device_id);
    const pc = previewPcMapRef.current.get(device_id);
    if (pc) { pc.close(); previewPcMapRef.current.delete(device_id); }
    const videoEl = previewVideoMapRef.current.get(device_id);
    if (videoEl) { videoEl.srcObject = null; previewVideoMapRef.current.delete(device_id); }
    const obs = previewObserverMapRef.current.get(device_id);
    if (obs) { obs.disconnect(); previewObserverMapRef.current.delete(device_id); }
    setCameraSources(prev => {
      const next = new Map(prev);
      next.delete(device_id);
      return next;
    });
  }

  // ── Loaders ─────────────────────────────────────────────────────────────────

  const loadAudioDevices = () => {
    setDeviceError(null);
    invoke("get_audio_devices")
      .then((devs: any) => {
        setDevices(devs);
        if (devs.length > 0) {
          const saved = localStorage.getItem("pref_selectedDevice");
          const match = saved ? devs.find(([name]: [string, string]) => name === saved) : null;
          setSelectedDevice(match ? match[0] : devs[0][0]);
        } else {
          setDeviceError("No input devices found");
        }
      })
      .catch((err: any) => setDeviceError(String(err)));
  };

  const loadMedia = useCallback(async () => {
    try {
      const result: MediaItem[] = await invoke("list_media");
      setMedia(result);
    } catch (err) {
      console.error("Failed to load media:", err);
    }
  }, []);

  const loadPresentations = useCallback(async () => {
    try {
      const result: PresentationFile[] = await invoke("list_presentations");
      setPresentations(result);
    } catch (err) {
      console.error("Failed to load presentations:", err);
    }
  }, []);

  const loadStudioList = useCallback(async () => {
    try {
      const result = await invoke("list_studio_presentations");
      setStudioList(result as { id: string; name: string; slide_count: number }[]);
    } catch (err) {
      console.error("Failed to load studio presentations:", err);
    }
  }, []);

  const loadSchedule = useCallback(async () => {
    try {
      const result: Schedule = await invoke("load_schedule");
      const entries: ScheduleEntry[] = result.items.map((e: any) => ({
        id: e.id || stableId(),
        item: e.item ?? e,
      }));
      setScheduleEntries(entries);
    } catch (err) {
      console.error("Failed to load schedule:", err);
    }
  }, []);

  const loadSongs = useCallback(async () => {
    try {
      const result = await invoke<Song[]>("list_songs");
      setSongs(result);
    } catch (err) {
      console.error("Failed to load songs:", err);
    }
  }, []);

  const loadLtTemplates = useCallback(async () => {
    try {
      const raw = await invoke<unknown[]>("load_lt_templates");
      if (!Array.isArray(raw) || raw.length === 0) return;
      // Basic validation: only keep entries that have the required fields
      const valid = raw.filter(
        (t): t is LowerThirdTemplate =>
          typeof t === "object" &&
          t !== null &&
          typeof (t as any).id === "string" &&
          typeof (t as any).name === "string" &&
          typeof (t as any).bgType === "string" &&
          typeof (t as any).primaryFont === "string",
      );
      if (valid.length === 0) return;
      setLtSavedTemplates(valid);
      const savedId = localStorage.getItem("activeLtTemplateId");
      const active = savedId ? valid.find((t) => t.id === savedId) : null;
      setLtTemplate(active ?? valid[0]);
    } catch (err) {
      console.error("Failed to load lt templates:", err);
    }
  }, []);

  // ── Lower Third helpers ──────────────────────────────────────────────────────

  /** Memoized selected song — only changes when the selected song itself changes. */
  const ltSelectedSong = useMemo(
    () => songs.find((s) => s.id === ltSongId) ?? null,
    [songs, ltSongId],
  );

  /** Flattened list of all lines across all sections, respecting arrangement order. */
  const ltFlatLines = useMemo((): { text: string; sectionLabel: string }[] => {
    if (!ltSelectedSong) return [];
    const flat: { text: string; sectionLabel: string }[] = [];
    const arr = ltSelectedSong.arrangement;
    const sections = ltSelectedSong.sections;
    if (arr && arr.length > 0) {
      // Use arrangement: may repeat sections (e.g. chorus after each verse)
      for (const label of arr) {
        const sec = sections.find((s) => s.label === label);
        if (sec) {
          for (const line of sec.lines) {
            flat.push({ text: line, sectionLabel: sec.label });
          }
        }
      }
    } else {
      // No arrangement — use sections in their natural order
      for (const section of sections) {
        for (const line of section.lines) {
          flat.push({ text: line, sectionLabel: section.label });
        }
      }
    }
    return flat;
  }, [ltSelectedSong]);

  const ltSendCurrent = useCallback(async (index: number) => {
    if (ltFlatLines.length === 0) return;
    const clampedIndex = Math.max(0, Math.min(index, ltFlatLines.length - 1));
    const payload = ltBuildLyricsPayload(ltFlatLines, clampedIndex, ltLinesPerDisplay);
    if (!payload) return;
    await invoke("show_lower_third", { data: payload, template: ltTemplate });
  }, [ltFlatLines, ltLinesPerDisplay, ltTemplate]);

  const ltAdvance = useCallback(async (dir: 1 | -1) => {
    if (ltFlatLines.length === 0) return;
    const next = Math.max(0, Math.min(ltLineIndex + dir * ltLinesPerDisplay, ltFlatLines.length - 1));
    setLtLineIndex(next);
    setLtAtEnd(next >= ltFlatLines.length - 1);
    if (ltVisible) await ltSendCurrent(next);
  }, [ltFlatLines, ltLinesPerDisplay, ltLineIndex, ltVisible, ltSendCurrent]);

  // Keyboard shortcuts for lyrics control (Space/→ = next, ← = prev, H = show/hide)
  useEffect(() => {
    if (activeTab !== "lower-third" || ltMode !== "lyrics") return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " " || e.key === "ArrowRight") { e.preventDefault(); ltAdvance(1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); ltAdvance(-1); }
      if (e.key === "h" || e.key === "H") {
        if (ltVisible) {
          invoke("hide_lower_third")
            .then(() => setLtVisible(false))
            .catch((err) => console.error("hide_lower_third failed:", err));
        } else {
          if (!ltSongId || ltFlatLines.length === 0) return;
          const payload = ltBuildLyricsPayload(ltFlatLines, ltLineIndex, ltLinesPerDisplay);
          if (!payload) return;
          invoke("show_lower_third", { data: payload, template: ltTemplate })
            .then(() => setLtVisible(true))
            .catch((err) => console.error("show_lower_third failed:", err));
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab, ltMode, ltAdvance, ltVisible, ltSongId, ltFlatLines, ltLineIndex, ltLinesPerDisplay, ltTemplate]);

  // Auto-advance interval — stops at the last line instead of looping forever
  useEffect(() => {
    if (ltAutoRef.current) clearInterval(ltAutoRef.current);
    if (ltAutoAdvance && ltVisible && ltMode === "lyrics") {
      ltAutoRef.current = setInterval(() => {
        setLtLineIndex((prev) => {
          const maxIdx = ltFlatLines.length - 1;
          if (prev >= maxIdx) {
            // Reached the end — stop the interval and mark as finished
            if (ltAutoRef.current) clearInterval(ltAutoRef.current);
            setLtAtEnd(true);
            return prev;
          }
          const next = Math.min(prev + ltLinesPerDisplay, maxIdx);
          // Schedule the async invoke outside the state updater
          Promise.resolve().then(() => ltSendCurrent(next)).catch(console.error);
          if (next >= maxIdx) setLtAtEnd(true);
          return next;
        });
      }, ltAutoSeconds * 1000);
    }
    return () => { if (ltAutoRef.current) clearInterval(ltAutoRef.current); };
  }, [ltAutoAdvance, ltVisible, ltMode, ltAutoSeconds, ltLinesPerDisplay, ltFlatLines, ltSendCurrent]);

  // ── Initialisation ──────────────────────────────────────────────────────────

  useEffect(() => {
    const windowLabel = getCurrentWindow().label;
    setLabel(windowLabel);
    if (windowLabel === "output") return;

    loadAudioDevices();
    loadMedia();
    navigator.mediaDevices?.enumerateDevices()
      .then((devs) => setCameras(devs.filter((d) => d.kind === "videoinput")))
      .catch(() => {});
    loadPresentations();
    loadStudioList();
    loadSchedule();
    loadSongs();
    loadLtTemplates();

    // Load services list and create default if needed
    invoke<ServiceMeta[]>("list_services").then(async (list) => {
      if (list.length === 0) {
        // Create a default service from the current schedule entries
        const defaultSvc: Schedule = { id: "default", name: "Sunday Service", items: [] };
        await invoke("save_service", { schedule: defaultSvc }).catch(() => {});
        setServices([{ id: "default", name: "Sunday Service", item_count: 0, updated_at: Date.now() }]);
      } else {
        setServices(list);
        // Load the most-recently-used service if stored
        const saved = localStorage.getItem("activeServiceId");
        const found = saved ? list.find((s) => s.id === saved) : null;
        if (found) {
          setActiveServiceId(found.id);
        } else {
          setActiveServiceId(list[0].id);
        }
      }
    }).catch(() => {});

    // Load persisted props
    invoke<PropItem[]>("get_props").then(setPropItems).catch(() => {})
    invoke<SceneData[]>("list_scenes").then(setSavedScenes).catch(() => {});

    // Sync persisted transcription window to backend
    invoke("set_transcription_window", { samples: Math.round(transcriptionWindowSec * 16000) }).catch(() => {});

    invoke("get_remote_info")
      .then((info: any) => {
        if (info) {
          setRemoteUrl(info.url);
          setRemotePin(info.pin);
          setTailscaleUrl(info.tailscale_url ?? null);

          // ── Operator WebSocket + WebRTC signaling ──────────────────────────
          connectOperatorWs(info.pin);
        }
      })
      .catch(() => {});

    invoke("get_bible_versions")
      .then((versions: any) => {
        if (versions && versions.length > 0) {
          setAvailableVersions(versions);
          const saved = localStorage.getItem("pref_bibleVersion");
          const valid = saved && versions.includes(saved) ? saved : versions[0];
          setBibleVersion(valid);
        }
      })
      .catch(() => {});

    invoke("get_current_item")
      .then((v: any) => { if (v) setLiveItem(v); })
      .catch(() => {});

    invoke("get_settings")
      .then((s: any) => { if (s) setSettings(s); })
      .catch(() => {});

    const unlisten = listen("transcription-update", (event: any) => {
      const { text, detected_item, confidence, source } = event.payload;
      setTranscript(text);
      if (detected_item) {
        if (source === "manual") {
          setLiveItem(detected_item);
        } else {
          setSuggestedItem(detected_item);
          setSuggestedConfidence(confidence ?? 0);
        }
      }
    });

    const unlistenStaged = listen("item-staged", (event: any) => {
      setStagedItem(event.payload as DisplayItem);
    });

    const unlistenStatus = listen("session-status", (event: any) => {
      const { status } = event.payload as { status: string; message: string };
      if (status === "running") setSessionState("running");
      else if (status === "loading") setSessionState("loading");
      else setSessionState("idle");
    });

    const unlistenAudioErr = listen("audio-error", (event: any) => {
      setAudioError(String(event.payload));
      setSessionState("idle");
    });

    const unlistenSettings = listen("settings-changed", (event: any) => {
      setSettings(event.payload as PresentationSettings);
    });

    const unlistenLevel = listen("audio-level", (event: any) => {
      const energy = event.payload as number;
      // Convert RMS energy to 0–1 display range (loud speech ~0.05–0.1 energy)
      setMicLevel(Math.min(1, Math.sqrt(energy) / 0.35));
    });

    // Exponential decay so the bar smoothly returns to zero when mic is quiet
    const decayInterval = setInterval(() => {
      setMicLevel((prev) => (prev > 0.01 ? prev * 0.85 : 0));
    }, 50);

    return () => {
      unlisten.then((f) => f());
      unlistenStaged.then((f) => f());
      unlistenStatus.then((f) => f());
      unlistenAudioErr.then((f) => f());
      unlistenSettings.then((f) => f());
      unlistenLevel.then((f) => f());
      clearInterval(decayInterval);
    };
  }, []);

  // ── Fetch next verse when liveItem changes to a Verse ─────────────────────

  useEffect(() => {
    if (liveItem?.type === "Verse") {
      const v = liveItem.data;
      invoke("get_next_verse", { book: v.book, chapter: v.chapter, verse: v.verse, version: v.version || bibleVersion })
        .then((result: any) => setNextVerse(result ?? null))
        .catch(() => setNextVerse(null));
    } else {
      setNextVerse(null);
    }
  }, [liveItem]);

  // ── Parse PPTX when a presentation is selected ───────────────────────────

  useEffect(() => {
    if (!selectedPresId) return;
    if (loadedSlides[selectedPresId]) return; // already cached

    const pres = presentations.find((p) => p.id === selectedPresId);
    if (!pres) return;

    (async () => {
      try {
        let zip = presZipsRef.current[selectedPresId];
        if (!zip) {
          zip = await loadPptxZip(pres.path);
          presZipsRef.current[selectedPresId] = zip;
        }
        const count = await getSlideCount(zip);
        const slides: ParsedSlide[] = [];
        for (let i = 0; i < count; i++) {
          slides.push(await parseSingleSlide(zip, i));
        }
        setLoadedSlides((prev) => ({ ...prev, [selectedPresId]: slides }));
        // Update slide count on the presentation record
        setPresentations((prev) =>
          prev.map((p) => (p.id === selectedPresId ? { ...p, slide_count: count } : p))
        );
      } catch (err) {
        console.error("Failed to parse PPTX:", err);
        setAudioError(`Failed to parse presentation: ${err}`);
      }
    })();
  }, [selectedPresId, presentations]);

  // ── Bible picker cascades ────────────────────────────────────────────────────

  // When version changes: notify Rust, reload books list, preserve selection if possible
  // Guard on label === "main" so this only runs in the operator window, and only after
  // the window label has been confirmed (giving Rust setup time to finish managing state).
  useEffect(() => {
    if (label !== "main") return;
    invoke("set_bible_version", { version: bibleVersion }).catch(() => {});
    invoke("get_books", { version: bibleVersion })
      .then((b: any) => {
        setBooks(b);
        // Keep existing selected book if it exists in the new version; else default to first
        setSelectedBook((prev) => (b.includes(prev) ? prev : (b.length > 0 ? b[0] : "")));
      })
      .catch((err: any) => setAudioError(`Failed to load books: ${err}`));
  }, [bibleVersion, label]);

  useEffect(() => {
    if (label !== "main" || !selectedBook) return;
    invoke("get_chapters", { book: selectedBook, version: bibleVersion })
      .then((c: any) => {
        setChapters(c);
        // Keep existing selected chapter if it exists; else default to first
        setSelectedChapter((prev) => (c.includes(prev) ? prev : (c.length > 0 ? c[0] : 0)));
      })
      .catch((err: any) => setAudioError(`Failed to load chapters: ${err}`));
  }, [selectedBook, bibleVersion, label]);

  useEffect(() => {
    if (label !== "main" || !selectedBook || !selectedChapter) return;
    invoke("get_verses_count", { book: selectedBook, chapter: selectedChapter, version: bibleVersion })
      .then((v: any) => {
        setVerses(v);
        // Keep existing selected verse if it exists; else default to first
        setSelectedVerse((prev) => (v.includes(prev) ? prev : (v.length > 0 ? v[0] : 0)));
      })
      .catch((err: any) => setAudioError(`Failed to load verses: ${err}`));
  }, [selectedBook, selectedChapter, bibleVersion, label]);

  // ── Presentation actions ─────────────────────────────────────────────────────

  const stageItem = async (item: DisplayItem) => {
    // If we are in scene composer and have an active layer, assign the item there
    if (bottomDeckOpen && bottomDeckMode === "scene-composer" && activeLayerId) {
       setWorkingScene(s => ({
          ...s,
          layers: s.layers.map(l => l.id === activeLayerId
            ? { ...l, content: { kind: "item", item } }
            : l)
       }));
       setToast(`Added to layer`);
       return;
    }

    setStagedItem(item);
    await invoke("stage_item", { item });
  };

  const describeLayerContent = (c: LayerContent): string => {
    if (c.kind === "empty") return "Empty";
    if (c.kind === "lower-third") return `Lower Third (${c.ltData.kind})`;
    return describeDisplayItem(c.item);
  };

  const describeDisplayItem = (item: DisplayItem): string => {
    if (item.type === "Verse") return `${item.data.book} ${item.data.chapter}:${item.data.verse} (${item.data.version})`;
    if (item.type === "Media") return item.data.name;
    if (item.type === "PresentationSlide") return `${item.data.presentation_name} — Slide ${item.data.slide_index + 1}`;
    if (item.type === "CustomSlide") return `${item.data.presentation_name} — Slide ${item.data.slide_index + 1}`;
    if (item.type === "CameraFeed") return item.data.device_name ?? item.data.label;
    if (item.type === "Scene") return `Scene: ${item.data.name}`;
    return "Unknown";
  };

  const goLive = async () => {
    await invoke("go_live");
  };

  const sendLive = async (item: DisplayItem) => {
    // If in scene composer and a layer is active, assign item to that layer
    if (bottomDeckOpen && bottomDeckMode === "scene-composer" && activeLayerId) {
       stageItem(item);
       return;
    }

    await stageItem(item);
    await new Promise((r) => setTimeout(r, 50));
    await goLive();
    // Track history (max 10, deduped by label)
    setVerseHistory((prev) => {
      const label = displayItemLabel(item);
      const filtered = prev.filter((h) => displayItemLabel(h) !== label);
      return [item, ...filtered].slice(0, 10);
    });
  };

  const deleteScheduleEntry = (id: string) => {
    setScheduleEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const moveScheduleEntry = (idx: number, dir: number) => {
    const newEntries = [...scheduleEntries];
    const target = idx + dir;
    if (target < 0 || target >= newEntries.length) return;
    const temp = newEntries[idx];
    newEntries[idx] = newEntries[target];
    newEntries[target] = temp;
    setScheduleEntries(newEntries);
  };

  const stageSuggested = () => {
    if (suggestedItem) {
      stageItem(suggestedItem);
      setSuggestedItem(null);
    }
  };

  // ── Settings ─────────────────────────────────────────────────────────────────

  const updateSettings = async (next: PresentationSettings) => {
    setSettings(next);
    await invoke("save_settings", { settings: next });
  };

  // ── Manual picker ────────────────────────────────────────────────────────────

  const handleDisplaySelection = async () => {
    if (!selectedBook) return;
    try {
      const verse: any = await invoke("get_verse", {
        book: selectedBook,
        chapter: selectedChapter,
        verse: selectedVerse,
        version: bibleVersion,
      });
      if (verse) await stageItem({ type: "Verse", data: verse });
      else setAudioError(`Verse not found: ${selectedBook} ${selectedChapter}:${selectedVerse}`);
    } catch (err: any) {
      setAudioError(String(err));
    }
  };

  const handleSendLivePicker = async () => {
    if (!selectedBook) return;
    try {
      const verse: any = await invoke("get_verse", {
        book: selectedBook,
        chapter: selectedChapter,
        verse: selectedVerse,
        version: bibleVersion,
      });
      if (verse) await sendLive({ type: "Verse", data: verse });
      else setAudioError(`Verse not found: ${selectedBook} ${selectedChapter}:${selectedVerse}`);
    } catch (err: any) {
      setAudioError(String(err));
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts if user is typing in an input/textarea
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        // Special case: ESC always clears live output
        if (e.key === "Escape") invoke("clear_live");
        return;
      }

      switch (e.key) {
        // General Controls
        case "Escape":
          invoke("clear_live");
          break;
        case "Enter":
          if (stagedItem) goLive();
          break;
        case "o":
          if (e.ctrlKey) invoke("toggle_output_window");
          break;
        case "b":
          if (e.ctrlKey) {
             e.preventDefault();
             const newBlank = !settings.is_blanked;
             const newSettings = { ...settings, is_blanked: newBlank };
             invoke("save_settings", { settings: newSettings });
             setSettings(newSettings);
             setIsBlackout(newBlank);
          }
          break;
        case "t":
          if (e.ctrlKey) { e.preventDefault(); setBottomDeckOpen(!bottomDeckOpen); }
          break;
        case "s":
          if (e.ctrlKey) { e.preventDefault(); setActiveTab("settings"); }
          break;

        // Tab Switching
        case "F1": setActiveTab("bible"); break;
        case "F2": setActiveTab("songs"); break;
        case "F3": setActiveTab("media"); break;
        case "F4": setActiveTab("presentations"); break;
        case "F5": { setBottomDeckOpen(true); setBottomDeckMode("studio-slides"); break; }

        // Bible / Verse Navigation
        case "n":
          if (nextVerse) {
            const item: DisplayItem = { type: "Verse", data: nextVerse };
            if (e.ctrlKey) sendLive(item);
            else stageItem(item);
          }
          break;

        // Presentations / Media
        case "ArrowRight":
          if (liveItem?.type === "PresentationSlide") {
            const { slide_index, slide_count } = liveItem.data;
            if (slide_index < (slide_count || 0) - 1) {
              const next: DisplayItem = { ...liveItem, data: { ...liveItem.data, slide_index: slide_index + 1 } };
              sendLive(next);
            }
          } else if (liveItem?.type === "CustomSlide") {
             const slides = studioSlides[liveItem.data.presentation_id];
             if (slides && liveItem.data.slide_index < slides.length - 1) {
                const nextIdx = liveItem.data.slide_index + 1;
                const slide = slides[nextIdx];
                const nextData: CustomSlideDisplayData = { 
                  ...liveItem.data, 
                  slide_index: nextIdx,
                  header: { ...slide.header, font_size: slide.header.fontSize, font_family: slide.header.fontFamily },
                  body: { ...slide.body, font_size: slide.body.fontSize, font_family: slide.body.fontFamily }
                } as any;
                sendLive({ type: "CustomSlide", data: nextData });
             }
          }
          break;
        case "ArrowLeft":
          if (liveItem?.type === "PresentationSlide") {
            const { slide_index } = liveItem.data;
            if (slide_index > 0) {
              const prev: DisplayItem = { ...liveItem, data: { ...liveItem.data, slide_index: slide_index - 1 } };
              sendLive(prev);
            }
          } else if (liveItem?.type === "CustomSlide") {
             const slides = studioSlides[liveItem.data.presentation_id];
             if (slides && liveItem.data.slide_index > 0) {
                const prevIdx = liveItem.data.slide_index - 1;
                const slide = slides[prevIdx];
                const prevData: CustomSlideDisplayData = { 
                  ...liveItem.data, 
                  slide_index: prevIdx,
                  header: { ...slide.header, font_size: slide.header.fontSize, font_family: slide.header.fontFamily },
                  body: { ...slide.body, font_size: slide.body.fontSize, font_family: slide.body.fontFamily }
                } as any;
                sendLive({ type: "CustomSlide", data: prevData });
             }
          }
          break;

        // Lower Thirds
        case " ":
          if (e.ctrlKey) {
            e.preventDefault();
            if (ltVisible) {
              invoke("hide_lower_third")
                .then(() => setLtVisible(false))
                .catch((err) => console.error("hide_lower_third failed:", err));
            } else {
              let payload: LowerThirdData | null = null;
              if (ltMode === "nameplate") {
                payload = { kind: "Nameplate", data: { name: ltName, title: ltTitle || undefined } };
              } else if (ltMode === "freetext") {
                payload = { kind: "FreeText", data: { text: ltFreeText } };
              } else {
                payload = ltBuildLyricsPayload(ltFlatLines, ltLineIndex, ltLinesPerDisplay);
              }
              if (!payload) break;
              invoke("show_lower_third", { data: payload, template: ltTemplate })
                .then(() => setLtVisible(true))
                .catch((err) => console.error("show_lower_third failed:", err));
            }
          }
          break;
        case "PageDown":
          // Allow navigation even when hidden (pre-cueing)
          if (ltMode === "lyrics") ltAdvance(1);
          break;
        case "PageUp":
          if (ltMode === "lyrics") ltAdvance(-1);
          break;

        // Media Controls (Output)
        case "k": emit("media-control", { action: "video-play-pause" }); break;
        case "r": emit("media-control", { action: "video-restart" }); break;
        case "m": emit("media-control", { action: "video-mute-toggle" }); break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [stagedItem, goLive, liveItem, studioSlides, nextVerse, ltVisible, ltMode, ltName, ltTitle, ltFreeText, ltSongId, ltFlatLines, ltLineIndex, ltLinesPerDisplay, ltTemplate, ltAdvance, settings, setIsBlackout, stageItem, sendLive, bottomDeckOpen, bottomDeckMode]);

  // ── Search ──────────────────────────────────────────────────────────────────

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    try {
      // Semantic search across all versions (falls back to keyword if engine unavailable)
      const results: any = await invoke("search_semantic_query", { query: searchQuery });
      setSearchResults(results);
    } catch (err) {
      console.error("Search failed:", err);
    }
  };

  // ── Media ───────────────────────────────────────────────────────────────────

  const handleFileUpload = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [
          { name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] },
          { name: "Videos", extensions: ["mp4", "webm", "mov", "mkv", "avi"] },
        ],
      });
      if (!selected) return;
      await invoke("add_media", { path: selected });
      await loadMedia();
      setToast("Media added to library");
    } catch (err: any) {
      setAudioError(`Upload failed: ${err}`);
    }
  };

  const handleDeleteMedia = async (id: string) => {
    try {
      await invoke("delete_media", { id });
      setMedia((prev) => prev.filter((m) => m.id !== id));
    } catch (err: any) {
      setAudioError(`Delete failed: ${err}`);
    }
  };

  // ── Presentations ────────────────────────────────────────────────────────────

  const handleImportPresentation = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "PowerPoint", extensions: ["pptx"] }],
      });
      if (!selected) return;
      const pres: PresentationFile = await invoke("add_presentation", { path: selected });
      setPresentations((prev) => [...prev, pres]);
      setSelectedPresId(pres.id);
      setToast(`Imported: ${pres.name}`);
    } catch (err: any) {
      setAudioError(`Import failed: ${err}`);
    }
  };

  const handleDeletePresentation = async (id: string) => {
    try {
      await invoke("delete_presentation", { id });
      setPresentations((prev) => prev.filter((p) => p.id !== id));
      setLoadedSlides((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      delete presZipsRef.current[id];
      if (selectedPresId === id) setSelectedPresId(null);
    } catch (err: any) {
      setAudioError(`Delete failed: ${err}`);
    }
  };

  const stagePresentationSlide = async (pres: PresentationFile, slideIndex: number) => {
    const item: DisplayItem = {
      type: "PresentationSlide",
      data: {
        presentation_id: pres.id,
        presentation_name: pres.name,
        presentation_path: pres.path,
        slide_index: slideIndex,
        slide_count: pres.slide_count,
      },
    };
    await stageItem(item);
  };

  const sendPresentationSlide = async (pres: PresentationFile, slideIndex: number) => {
    const item: DisplayItem = {
      type: "PresentationSlide",
      data: {
        presentation_id: pres.id,
        presentation_name: pres.name,
        presentation_path: pres.path,
        slide_index: slideIndex,
        slide_count: pres.slide_count,
      },
    };
    await sendLive(item);
  };

  // ── Studio ──────────────────────────────────────────────────────────────────

  const handleNewStudioPresentation = async () => {
    const pres: CustomPresentation = {
      id: stableId(),
      name: "Untitled Presentation",
      slides: [newDefaultSlide()],
    };
    try {
      await invoke("save_studio_presentation", { presentation: pres });
      await loadStudioList();
      setEditorPres(pres);
      setEditorPresId(pres.id);
    } catch (err: any) {
      setAudioError(`Failed to create presentation: ${err}`);
    }
  };

  const handleOpenStudioEditor = async (id: string) => {
    try {
      const data: any = await invoke("load_studio_presentation", { id });
      setEditorPres(data as CustomPresentation);
      setEditorPresId(id);
    } catch (err: any) {
      setAudioError(`Failed to load presentation: ${err}`);
    }
  };

  const handleDeleteStudioPresentation = async (id: string) => {
    try {
      await invoke("delete_studio_presentation", { id });
      setStudioList((prev) => prev.filter((p) => p.id !== id));
      setStudioSlides((prev) => { const n = { ...prev }; delete n[id]; return n; });
      if (expandedStudioPresId === id) setExpandedStudioPresId(null);
    } catch (err: any) {
      setAudioError(`Delete failed: ${err}`);
    }
  };

  const handlePresentStudio = async (id: string) => {
    if (expandedStudioPresId === id) {
      setExpandedStudioPresId(null);
      return;
    }
    if (!studioSlides[id]) {
      try {
        const data: any = await invoke("load_studio_presentation", { id });
        const pres = data as CustomPresentation;
        setStudioSlides((prev) => ({ ...prev, [id]: pres.slides }));
      } catch (err: any) {
        setAudioError(`Failed to load slides: ${err}`);
        return;
      }
    }
    setExpandedStudioPresId(id);
  };

  const buildCustomSlideItem = (presItem: { id: string; name: string; slide_count: number }, slides: CustomSlide[], slideIdx: number): DisplayItem => {
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
        header_enabled: slide.headerEnabled ?? true,
        header_height_pct: slide.headerHeightPct ?? 35,
        header: { text: slide.header.text, font_size: slide.header.fontSize, font_family: slide.header.fontFamily, color: slide.header.color, bold: slide.header.bold, italic: slide.header.italic, align: slide.header.align },
        body:   { text: slide.body.text,   font_size: slide.body.fontSize,   font_family: slide.body.fontFamily,   color: slide.body.color,   bold: slide.body.bold,   italic: slide.body.italic,   align: slide.body.align },
      },
    };
  };

  const stageCustomSlide = async (presItem: { id: string; name: string; slide_count: number }, slides: CustomSlide[], slideIdx: number) => {
    await stageItem(buildCustomSlideItem(presItem, slides, slideIdx));
  };

  const sendCustomSlide = async (presItem: { id: string; name: string; slide_count: number }, slides: CustomSlide[], slideIdx: number) => {
    await sendLive(buildCustomSlideItem(presItem, slides, slideIdx));
  };

  // ── Background image picker ──────────────────────────────────────────────────

  const handlePickBackgroundImage = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
      });
      if (!selected) return;
      await updateSettings({ ...settings, background: { type: "Image", value: selected as string } });
      setToast("Background image set");
    } catch (err: any) {
      setAudioError(`Failed to set background image: ${err}`);
    }
  };

  const handlePickLogo = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
      });
      if (!selected) return;
      await updateSettings({ ...settings, logo_path: selected as string });
      setToast("Logo set");
    } catch (err: any) {
      setAudioError(`Failed to set logo: ${err}`);
    }
  };

  // ── Schedule ─────────────────────────────────────────────────────────────────

  const persistSchedule = async (entries: ScheduleEntry[]) => {
    try {
      const svcName = services.find((s) => s.id === activeServiceId)?.name ?? "Default Schedule";
      const schedule: Schedule = { id: activeServiceId, name: svcName, items: entries };
      await invoke("save_schedule", { schedule });
      // Also persist to the named service file
      await invoke("save_service", { schedule });
      // Refresh service list to update item_count
      invoke<ServiceMeta[]>("list_services").then(setServices).catch(() => {});
    } catch (err) {
      console.error("Failed to save schedule:", err);
    }
  };

  const addToSchedule = async (item: DisplayItem) => {
    const entry: ScheduleEntry = { id: stableId(), item };
    const next = [...scheduleRef.current, entry];
    setScheduleEntries(next);
    await persistSchedule(next);
    setToast(`Added: ${displayItemLabel(item)}`);
  };

  const removeFromSchedule = async (id: string) => {
    const next = scheduleRef.current.filter((e) => e.id !== id);
    setScheduleEntries(next);
    setActiveScheduleIdx((prev) => {
      if (prev === null) return null;
      const newLen = next.length;
      return prev >= newLen ? (newLen > 0 ? newLen - 1 : null) : prev;
    });
    await persistSchedule(next);
  };

  const handleScheduleItemSend = async (entry: ScheduleEntry, idx: number) => {
    setActiveScheduleIdx(idx);
    await sendLive(entry.item);
  };

  const handleNextScheduleItem = async () => {
    const entries = scheduleRef.current;
    if (entries.length === 0) return;
    const nextIdx = activeScheduleIdx === null ? 0 : Math.min(activeScheduleIdx + 1, entries.length - 1);
    setActiveScheduleIdx(nextIdx);
    await sendLive(entries[nextIdx].item);
  };

  const handlePrevScheduleItem = async () => {
    const entries = scheduleRef.current;
    if (entries.length === 0) return;
    const prevIdx = activeScheduleIdx === null ? 0 : Math.max(activeScheduleIdx - 1, 0);
    setActiveScheduleIdx(prevIdx);
    await sendLive(entries[prevIdx].item);
  };

  // ── Panel resize handlers ────────────────────────────────────────────────────

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (vertDragRef.current.active && mainPanelRef.current) {
        const h = mainPanelRef.current.clientHeight;
        const delta = e.clientY - vertDragRef.current.startY;
        const newPct = Math.max(15, Math.min(70, vertDragRef.current.startPct + (delta / h) * 100));
        setTopPanelPct(newPct);
      }
      if (horizDragRef.current.active && bottomPanelRef.current) {
        const w = bottomPanelRef.current.clientWidth;
        const delta = e.clientX - horizDragRef.current.startX;
        const newPct = Math.max(25, Math.min(75, horizDragRef.current.startPct + (delta / w) * 100));
        setStagePct(newPct);
      }
    };
    const onMouseUp = () => {
      vertDragRef.current.active = false;
      horizDragRef.current.active = false;
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Persist panel sizes to localStorage when they change
  useEffect(() => {
    localStorage.setItem("pref_topPanelPct", String(Math.round(topPanelPct)));
  }, [topPanelPct]);
  useEffect(() => {
    localStorage.setItem("pref_stagePct", String(Math.round(stagePct)));
  }, [stagePct]);

  // ── Audio controls ───────────────────────────────────────────────────────────

  const handleDeviceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const device = e.target.value;
    setSelectedDevice(device);
    localStorage.setItem("pref_selectedDevice", device);
    invoke("set_audio_device", { deviceName: device });
  };

  const updateVad = (val: string) => {
    const threshold = parseFloat(val);
    setVadThreshold(threshold);
    localStorage.setItem("pref_vadThreshold", val);
    invoke("set_vad_threshold", { threshold });
  };

  const updateTranscriptionWindow = (sec: number) => {
    setTranscriptionWindowSec(sec);
    localStorage.setItem("pref_transcriptionWindowSec", String(sec));
    invoke("set_transcription_window", { samples: Math.round(sec * 16000) });
  };

  // ── Output window short-circuit ──────────────────────────────────────────────

  if (label === "output") return <OutputWindow />;
  if (label === "stage") return <StageWindow />;
  if (label === "design") return <DesignHub />;

  // ── Studio editor modal ──────────────────────────────────────────────────────

  if (editorPresId !== null && editorPres !== null) {
    return (
      <SlideEditor
        initialPres={editorPres}
        mediaImages={media.filter((m) => m.media_type === "Image")}
        onClose={async (saved) => {
          setEditorPresId(null);
          setEditorPres(null);
          if (saved) {
            await loadStudioList();
            // Invalidate cached slides for this presentation
            setStudioSlides((prev) => { const n = { ...prev }; delete n[editorPresId]; return n; });
          }
        }}
      />
    );
  }

  // ── Operator UI ──────────────────────────────────────────────────────────────

  return (
    <div className="h-screen bg-slate-950 text-slate-200 flex flex-col font-sans overflow-hidden">
      {/* Header */}
      <header className="flex justify-between items-center px-6 py-4 border-b border-slate-800 bg-slate-900/50 shrink-0">
        <h1 className="text-xl font-bold tracking-tight text-white">
          BIBLE PRESENTER{" "}
          <span className="text-xs bg-amber-500 text-black px-2 py-0.5 rounded ml-2">PRO</span>
        </h1>

        <div className="flex items-center gap-3">
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-slate-500 uppercase font-bold mb-1">Sensitivity</span>
            <input
              type="range" min="0.0001" max="0.05" step="0.0005"
              value={vadThreshold}
              onChange={(e) => updateVad(e.target.value)}
              className="w-28 accent-amber-500"
            />
          </div>

          <div className="flex items-center gap-1">
            {deviceError ? (
              <span className="text-red-400 text-xs max-w-[140px] truncate" title={deviceError}>
                No mic found
              </span>
            ) : (
              <select
                value={selectedDevice}
                onChange={handleDeviceChange}
                className="bg-slate-800 text-white border border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
              >
                {devices.length === 0 && <option value="">Loading...</option>}
                {devices.map(([name, id]) => (
                  <option key={id} value={name}>{name}</option>
                ))}
              </select>
            )}
            <button
              onClick={loadAudioDevices}
              title="Refresh microphone list"
              className="bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded px-2 py-2 text-xs text-slate-400 hover:text-white transition-all"
            >
              <RefreshCw size={13} />
            </button>
          </div>

          <button
            onClick={() => updateSettings({ ...settings, is_blanked: !settings.is_blanked })}
            className={`font-bold py-2 px-3 rounded border transition-all text-sm flex items-center gap-1.5 ${
              settings.is_blanked
                ? "bg-red-500 border-red-500 text-white"
                : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white"
            }`}
          >
            {settings.is_blanked ? <Eye size={14} /> : <EyeOff size={14} />}
            {settings.is_blanked ? "UNBLANK" : "BLANK"}
          </button>

          <button
            onClick={() => invoke("toggle_design_window")}
            className="bg-slate-800 hover:bg-slate-700 text-purple-400 font-bold py-2 px-3 rounded border border-purple-700/40 transition-all text-sm flex items-center gap-1.5"
            title="Open Design Hub (Studio, LT Designer, Scene Builder, Props, Preferences)"
          >
            <Layers size={14} />
            DESIGN HUB
          </button>

          <button
            onClick={() => invoke("toggle_output_window")}
            className="bg-slate-800 hover:bg-slate-700 text-white font-bold py-2 px-3 rounded border border-slate-700 transition-all text-sm flex items-center gap-1.5"
          >
            <Monitor size={14} />
            OUTPUT
          </button>

          {/* VU Meter — only visible when a session is running */}
          {sessionState === "running" && (
            <div className="flex items-center gap-2 min-w-[110px]">
              <span className="text-[9px] text-slate-500 font-bold uppercase shrink-0">MIC</span>
              <div className="relative flex-1 h-2 bg-slate-800 rounded-full overflow-hidden border border-slate-700">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${micLevel * 100}%`,
                    transition: "width 75ms linear",
                    backgroundColor:
                      micLevel > 0.8 ? "#ef4444"
                      : micLevel > 0.5 ? "#f59e0b"
                      : "#22c55e",
                  }}
                />
              </div>
            </div>
          )}

          <button
            onClick={() => {
              if (sessionState === "running") {
                invoke("stop_session");
              } else {
                setAudioError(null);
                // getUserMedia triggers the Windows OS microphone permission dialog.
                // WASAPI (used by CPAL) bypasses the dialog and just fails with
                // 0x80070005 without this step.
                navigator.mediaDevices.getUserMedia({ audio: true })
                  .then((stream) => {
                    // Permission granted — stop the probe stream; Rust WASAPI opens its own.
                    stream.getTracks().forEach((t) => t.stop());
                    invoke("start_session").catch((err: any) => {
                      setAudioError(String(err));
                      setSessionState("idle");
                    });
                  })
                  .catch((err: any) => {
                    const msg = err.name === "NotAllowedError"
                      ? "Microphone access denied. Allow microphone access in Windows Settings → Privacy & Security → Microphone, then try again."
                      : `Microphone error: ${err.message}`;
                    setAudioError(msg);
                    setSessionState("idle");
                  });
              }
            }}
            disabled={sessionState === "loading"}
            className={`font-bold py-2 px-5 rounded-full transition-all disabled:opacity-50 flex items-center gap-2 ${
              sessionState === "running"
                ? "bg-red-500 hover:bg-red-600 text-white"
                : "bg-amber-500 hover:bg-amber-600 text-black"
            }`}
          >
            {sessionState === "loading" ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : sessionState === "running" ? (
              <MicOff size={14} />
            ) : (
              <Mic size={14} />
            )}
            {sessionState === "loading" ? "LOADING..." : sessionState === "running" ? "STOP" : "START LIVE"}
          </button>
        </div>
      </header>

      {audioError && (
        <div className="bg-red-950 border-b border-red-800 text-red-300 text-xs px-6 py-2 flex items-center gap-2 shrink-0">
          <span className="font-bold text-red-400 uppercase tracking-widest">Error</span>
          <span className="flex-1">{audioError}</span>
          <button onClick={() => setAudioError(null)} className="text-red-500 hover:text-red-200">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">

        {/* ── 1. Content Browser Sidebar ── */}
        <aside 
          className="bg-slate-900/30 border-r border-slate-800 flex flex-col overflow-hidden shrink-0"
          style={{ width: sidebarWidth }}
        >
          {/* Tab nav */}
          <div className="flex border-b border-slate-800 bg-slate-900/50 shrink-0 overflow-x-auto">
            {(
              [
                { id: "bible",         icon: <BookOpen size={13} />,      label: "Bible" },
                { id: "media",         icon: <Image size={13} />,         label: "Media" },
                { id: "presentations", icon: <Presentation size={13} />,  label: "PPTX" },
                { id: "songs",         icon: <Music size={13} />,         label: "Songs" },
                { id: "lower-third",   icon: <Type size={13} />,          label: "Lower 3rd" },
                { id: "timers",        icon: <Clock size={13} />,         label: "Timers" },
              ] as const
            ).map(({ id, icon, label }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id as any)}
                className={`flex-1 py-2.5 flex flex-col items-center gap-0.5 transition-all relative whitespace-nowrap px-1 ${
                  activeTab === id
                    ? "bg-slate-800 text-amber-500 border-b-2 border-amber-500"
                    : "text-slate-500 hover:text-slate-300 hover:bg-slate-800/50"
                }`}
              >
                {icon}
                <span className="text-[8px] font-bold uppercase tracking-wider">{label}</span>
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
            {/* Tab contents (omitted for brevity in replacement, but logically here) */}

            {/* ── Bible Tab ── */}
            {activeTab === "bible" && (
              <BibleTab onStage={stageItem} onLive={sendLive} onAddToSchedule={addToSchedule} />
            )}

            {/* ── Media Tab ── */}
            {activeTab === "media" && (
              <MediaTab
                onStage={stageItem}
                onLive={sendLive}
                onAddToSchedule={addToSchedule}
                onLoadMedia={loadMedia}
                onDeleteMedia={handleDeleteMedia}
                remoteUrl={remoteUrl}
                remotePin={remotePin}
                cameraSources={cameraSources}
                onEnableCameraPreview={enableCameraPreview}
                onDisableCameraPreview={disableCameraPreview}
                onRemoveCameraSource={removeCameraSource}
                previewVideoMapRef={previewVideoMapRef}
                previewObserverMapRef={previewObserverMapRef}
              />
            )}



            {/* ── Presentations Tab ── */}
            {activeTab === "presentations" && (
              <PresentationsTab onStage={stageItem} onLive={sendLive} onAddToSchedule={addToSchedule} />
            )}

            {/* ── Studio Tab ── */}
            {/* Studio Tab moved to Bottom Deck */}

            {/* ── Schedule Tab ── */}
            {activeTab === "schedule" && (
              <ScheduleTab
                onSendItem={(item, idx) => { setActiveScheduleIdx(idx); sendLive(item); }}
                onPersist={() => persistSchedule(scheduleRef.current)}
              />
            )}

            {/* ── Props Tab ── */}
            {activeTab === "props" && (
              <PropsTab onUpdateProps={(items) => { emit("props-update", items); }} />
            )}

            {/* ── Settings Tab ── */}
            {activeTab === "settings" && (
              <SettingsTab
                onUpdateSettings={updateSettings}
                onUpdateTranscriptionWindow={(sec) => invoke("set_transcription_window", { samples: Math.round(sec * 16000) })}
                onUploadMedia={handleFileUpload}
              />
            )}

            {/* ── Songs Tab ── */}
            {activeTab === "songs" && (
              <SongsTab
                onOpenLyricsMode={(songId) => { setLtSongId(songId); setLtMode("lyrics"); setActiveTab("lower-third"); }}
              />
            )}

            {/* ── Lower Third Tab ── */}
            {activeTab === "lower-third" && (
              <LowerThirdTab onLoadMedia={loadMedia} onSetToast={setToast} />
            )}

            {/* ── Timers Tab ── */}
            {(activeTab as string) === "timers" && (
              <div className="flex flex-col gap-4">
                <div>
                  <p className="text-[9px] font-black uppercase text-slate-500 mb-2">Timer Type</p>
                  <div className="flex gap-2">
                    {(["countdown", "countup", "clock"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setTimerType(t)}
                        className={`flex-1 py-1.5 text-[9px] font-black uppercase rounded-lg border transition-all ${timerType === t ? "bg-cyan-600 border-cyan-500 text-white" : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"}`}
                      >{t}</button>
                    ))}
                  </div>
                </div>
                {timerType === "countdown" && (
                  <div>
                    <p className="text-[9px] font-black uppercase text-slate-500 mb-2">Duration</p>
                    <div className="flex gap-2 items-center">
                      {([["Hours", timerHours, setTimerHours, 23], ["Mins", timerMinutes, setTimerMinutes, 59], ["Secs", timerSeconds, setTimerSeconds, 59]] as [string, number, (n: number) => void, number][]).map(([lbl, val, setter, max]) => (
                        <div key={lbl} className="flex flex-col items-center gap-0.5 flex-1">
                          <span className="text-[8px] text-slate-600 uppercase">{lbl}</span>
                          <input type="number" min={0} max={max} value={val}
                            onChange={(e) => setter(parseInt(e.target.value) || 0)}
                            className="w-full bg-slate-800 text-slate-200 text-center text-sm rounded border border-slate-700 py-1" />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <p className="text-[9px] font-black uppercase text-slate-500 mb-1">Label (optional)</p>
                  <input
                    value={timerLabel}
                    onChange={(e) => setTimerLabel(e.target.value)}
                    placeholder="e.g. BREAK ENDS IN"
                    className="w-full bg-slate-800 text-slate-200 text-xs rounded border border-slate-700 px-2 py-1.5"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={async () => {
                      const durSecs = timerType === "countdown" ? timerHours * 3600 + timerMinutes * 60 + timerSeconds : undefined;
                      await invoke("stage_item", { item: { type: "Timer", data: { timer_type: timerType, duration_secs: durSecs, label: timerLabel || undefined, started_at: undefined } } });
                    }}
                    className="py-2 text-xs font-black uppercase bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg transition-all"
                  >Stage</button>
                  <button
                    onClick={async () => {
                      const durSecs = timerType === "countdown" ? timerHours * 3600 + timerMinutes * 60 + timerSeconds : undefined;
                      await invoke("stage_item", { item: { type: "Timer", data: { timer_type: timerType, duration_secs: durSecs, label: timerLabel || undefined, started_at: undefined } } });
                      await invoke("go_live");
                    }}
                    className="py-2 text-xs font-black uppercase bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-all"
                  >Stage + Live</button>
                  <div className="flex gap-2 pt-2 border-t border-slate-800">
                    <button
                      onClick={async () => { await invoke("update_timer", { startedAt: Date.now() }); setTimerRunning(true); }}
                      className="flex-1 py-1.5 text-[9px] font-black uppercase bg-green-800 hover:bg-green-700 text-green-200 rounded transition-all"
                    >▶ Start</button>
                    <button
                      onClick={async () => { await invoke("update_timer", { startedAt: null }); setTimerRunning(false); }}
                      className="flex-1 py-1.5 text-[9px] font-black uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-all"
                    >↺ Reset</button>
                  </div>
                </div>
              </div>
            )}

            {/* LT background image picker modal */}
            {showLtImgPicker && (
              <MediaPickerModal
                images={media.filter((m) => m.media_type === "Image")}
                onSelect={(path) => {
                  setLtTemplate((t) => ({ ...t, bgType: "image", bgImagePath: path }));
                }}
                onClose={() => setShowLtImgPicker(false)}
                onUpload={async () => {
                  const selected = await openDialog({ multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }] });
                  if (selected) {
                    await invoke("add_media", { path: selected });
                    await loadMedia();
                  }
                }}
              />
            )}
          </div>
        </aside>

        {/* ── 3. Sidebar Resize Handle ── */}
        <div 
          className="w-1 bg-slate-800 hover:bg-amber-500/40 cursor-col-resize transition-colors shrink-0 flex items-center justify-center group"
          onMouseDown={(e) => {
            const startX = e.clientX;
            const startWidth = sidebarWidth;
            const handleMouseMove = (em: MouseEvent) => {
              const newWidth = Math.max(200, Math.min(600, startWidth + (em.clientX - startX)));
              setSidebarWidth(newWidth);
            };
            const handleMouseUp = () => {
              document.removeEventListener("mousemove", handleMouseMove);
              document.removeEventListener("mouseup", handleMouseUp);
            };
            document.addEventListener("mousemove", handleMouseMove);
            document.addEventListener("mouseup", handleMouseUp);
            e.preventDefault();
          }}
        >
          <div className="h-8 w-px bg-slate-700 group-hover:bg-amber-500/60 transition-colors" />
        </div>

        {/* ── Main Content ── */}
        <main ref={mainPanelRef} className="flex-1 flex flex-col overflow-hidden relative">

          {/* Quick Action Bar (Top) */}
          <div className="h-12 bg-slate-900 border-b border-slate-800 px-4 flex items-center justify-between shrink-0 z-20">
            <div className="flex items-center gap-2">
              <button 
                onClick={async () => {
                   const newBlank = !settings.is_blanked;
                   const newSettings = { ...settings, is_blanked: newBlank };
                   await invoke("save_settings", { settings: newSettings });
                   setSettings(newSettings);
                   setIsBlackout(newBlank);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
                  settings.is_blanked ? "bg-red-600 text-white shadow-[0_0_15px_rgba(220,38,38,0.4)]" : "bg-slate-800 text-slate-400 hover:bg-slate-700"
                }`}
              >
                <EyeOff size={12} /> {settings.is_blanked ? "LIVE OFF" : "BLACKOUT"}
              </button>
              <button 
                onClick={async () => {
                   // Toggle logo visibility by saving settings
                   const newSettings = { ...settings, logo_path: settings.logo_path ? "" : "resources/logo.png" }; // Placeholder logic
                   // await invoke("save_settings", { settings: newSettings });
                   // setSettings(newSettings);
                   setToast("Logo toggle toggled");
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest bg-slate-800 text-slate-400 hover:bg-slate-700 transition-all"
              >
                <Monitor size={12} /> LOGO
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button 
                onClick={() => setIsTranscriptionCollapsed(!isTranscriptionCollapsed)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest bg-slate-800 text-slate-400 hover:bg-slate-700 transition-all"
              >
                <Mic size={12} /> {isTranscriptionCollapsed ? "SHOW MIC" : "HIDE MIC"}
              </button>
              <div className="h-4 w-px bg-slate-800 mx-2" />
              <button
                 onClick={() => setActiveTab("lower-third")}
                 className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
                    activeTab === "lower-third" ? "bg-amber-500 text-black shadow-[0_0_15px_rgba(245,158,11,0.4)]" : "bg-slate-800 text-slate-400 hover:bg-slate-700"
                 }`}
              >
                <Type size={12} /> LOWER THIRD
              </button>
              <button
                 onClick={() => setActiveTab("timers" as any)}
                 className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
                    (activeTab as string) === "timers" ? "bg-cyan-600 text-white" : "bg-slate-800 text-slate-400 hover:bg-slate-700"
                 }`}
              >
                <Clock size={12} /> TIMERS
              </button>
            </div>

            <div className="flex items-center gap-3">
               <button 
                  onClick={() => invoke("clear_live")}
                  className="px-4 py-1.5 bg-red-900/40 hover:bg-red-600 text-red-200 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all border border-red-900/50"
               >
                 CLEAR
               </button>
               <button 
                  onClick={goLive}
                  disabled={!stagedItem}
                  className="px-6 py-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-30 text-black text-[10px] font-black uppercase tracking-widest rounded-lg transition-all shadow-lg"
               >
                 GO LIVE
               </button>
            </div>
          </div>

          {/* Transcription + Suggested (Collapsible) */}
          {!isTranscriptionCollapsed && (
            <section
              className="bg-slate-950 p-5 flex flex-col overflow-hidden gap-3 shrink-0 border-b border-slate-900"
              style={{ height: `${topPanelPct}%` }}
            >
              <h2 className="text-[10px] font-black text-slate-600 uppercase tracking-widest shrink-0 flex items-center justify-between">
                <span>Live Transcription</span>
                <span className="text-[8px] opacity-50">AI HYBRID MODE</span>
              </h2>
              <div className="flex-1 overflow-y-auto text-xl font-light leading-snug text-slate-400 min-h-0">
                {transcript || <span className="text-slate-800 italic">Listening for audio feed...</span>}
              </div>

              <AnimatePresence>
                {suggestedItem && (
                  <motion.div
                    key={displayItemLabel(suggestedItem)}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    transition={{ duration: 0.2 }}
                    className="shrink-0 flex items-center gap-3 bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-[10px] text-slate-500 uppercase font-bold">Auto-detected</p>
                        <span
                          className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                            suggestedConfidence >= 1.0
                              ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                              : suggestedConfidence >= 0.7
                              ? "bg-green-500/20 text-green-400 border border-green-500/30"
                              : suggestedConfidence >= 0.55
                              ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30"
                              : "bg-orange-500/20 text-orange-400 border border-orange-500/30"
                          }`}
                        >
                          {suggestedConfidence >= 1.0 ? "REF" : `${Math.round(suggestedConfidence * 100)}%`}
                        </span>
                      </div>
                      {suggestedItem.type === "Verse" ? (
                        <p className="text-slate-300 text-sm truncate">
                          <span className="text-amber-500 font-bold">{suggestedItem.data.book} {suggestedItem.data.chapter}:{suggestedItem.data.verse}</span>
                          {" — "}
                          <span className="text-slate-400">{suggestedItem.data.text}</span>
                        </p>
                      ) : (
                        <p className="text-slate-300 text-sm truncate">{displayItemLabel(suggestedItem)}</p>
                      )}
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      <button onClick={stageSuggested} className="text-[10px] font-bold px-2 py-1 bg-slate-700 hover:bg-slate-600 text-white rounded transition-all">STAGE</button>
                      <button onClick={() => { if (suggestedItem) sendLive(suggestedItem); setSuggestedItem(null); }} className="text-[10px] font-bold px-2 py-1 bg-amber-500 hover:bg-amber-400 text-black rounded transition-all">DISPLAY</button>
                      <button onClick={() => setSuggestedItem(null)} className="text-slate-500 hover:text-slate-300 px-1 transition-all">
                        <X size={13} />
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          )}

          {/* Vertical drag handle (only if transcription not collapsed) */}
          {!isTranscriptionCollapsed && (
            <div
              className="h-1 bg-slate-900 hover:bg-amber-500/40 cursor-row-resize transition-colors shrink-0 flex items-center justify-center group"
              onMouseDown={(e) => {
                vertDragRef.current = { active: true, startY: e.clientY, startPct: topPanelPct };
                e.preventDefault();
              }}
            >
              <div className="w-8 h-px bg-slate-800 group-hover:bg-amber-500/60 rounded-full transition-colors" />
            </div>
          )}

          {/* Dual Preview Area */}
          <section ref={bottomPanelRef} className="flex-1 flex overflow-hidden relative">

            {/* Stage Preview */}
            <div className="bg-slate-950 p-5 flex flex-col overflow-hidden shrink-0" style={{ width: `${stagePct}%` }}>
              <PreviewCard
                item={stagedItem}
                label="Stage Preview"
                accent="text-amber-500/50"
                badge={<span className="text-[10px] bg-amber-500/10 text-amber-500 px-2 py-0.5 rounded border border-amber-500/20">NEXT</span>}
                empty="Stage is empty"
              />
            </div>

            {/* Horizontal drag handle */}
            <div
              className="w-1 bg-slate-800 hover:bg-amber-500/40 cursor-col-resize transition-colors shrink-0 flex items-center justify-center group relative"
              onMouseDown={(e) => {
                horizDragRef.current = { active: true, startX: e.clientX, startPct: stagePct };
                e.preventDefault();
              }}
            >
              <div className="h-8 w-px bg-slate-600 group-hover:bg-amber-500/60 rounded-full transition-colors" />
            </div>

            {/* Live Output + Next Verse strip */}
            <div className="flex-1 bg-slate-950 p-5 flex flex-col overflow-hidden gap-2">
              <PreviewCard
                item={liveItem}
                label="Live Output"
                accent="text-red-500/50"
                badge={
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-[10px] bg-red-500/10 text-red-500 px-2 py-0.5 rounded border border-red-500/20 uppercase font-bold">On Air</span>
                  </div>
                }
                empty="Output is empty"
              />

              {/* Next verse quick-send — only shown when a verse is live */}
              {nextVerse && (
                <div className="shrink-0 flex items-center gap-2 bg-slate-900 border border-slate-700/60 rounded-xl px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-[9px] text-slate-600 uppercase font-bold mb-0.5">Up next</p>
                    <p className="text-xs truncate">
                      <span className="text-amber-500/80 font-bold">{nextVerse.book} {nextVerse.chapter}:{nextVerse.verse}</span>
                      <span className="text-slate-500 ml-1">{nextVerse.text}</span>
                    </p>
                  </div>
                  <button
                    onClick={() => sendLive({ type: "Verse", data: nextVerse })}
                    className="shrink-0 text-[9px] font-bold px-2 py-1 bg-amber-500/20 hover:bg-amber-500/40 text-amber-400 border border-amber-500/30 rounded transition-all whitespace-nowrap flex items-center gap-1"
                  >
                    NEXT <ChevronRight size={11} />
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* ── 4. Unified Bottom Studio Deck ── */}
          {bottomDeckOpen && (
            <section className="h-[450px] bg-slate-900 border-t border-slate-800 flex flex-col shrink-0 z-30 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
              <div className="flex items-center justify-between px-4 py-2 bg-slate-800/50 border-b border-slate-800">
                <div className="flex items-center gap-6">
                  <div className="flex rounded-lg overflow-hidden border border-slate-700 bg-black/20">
                    <button 
                      onClick={() => setBottomDeckMode("live-lt")}
                      className={`px-4 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${bottomDeckMode === "live-lt" ? "bg-amber-500 text-black" : "text-slate-500 hover:text-slate-300"}`}
                    >
                      LIVE LT
                    </button>
                    <button 
                      onClick={() => setBottomDeckMode("studio-slides")}
                      className={`px-4 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${bottomDeckMode === "studio-slides" ? "bg-purple-600 text-white" : "text-slate-500 hover:text-slate-300"}`}
                    >
                      STUDIO SLIDES
                    </button>
                    <button 
                      onClick={() => setBottomDeckMode("studio-lt")}
                      className={`px-4 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${bottomDeckMode === "studio-lt" ? "bg-amber-600 text-white" : "text-slate-500 hover:text-slate-300"}`}
                    >
                      LT DESIGNER
                    </button>
                    <button
                      onClick={() => setBottomDeckMode("scene-composer")}
                      className={`px-4 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${bottomDeckMode === "scene-composer" ? "bg-blue-600 text-white" : "text-slate-500 hover:text-slate-300"}`}
                    >
                      SCENE COMPOSER
                    </button>
                    <button
                      onClick={() => setBottomDeckMode("timer")}
                      className={`px-4 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all ${bottomDeckMode === "timer" ? "bg-cyan-600 text-white" : "text-slate-500 hover:text-slate-300"}`}
                    >
                      TIMER
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {bottomDeckMode === "live-lt" && (
                    <button 
                      onClick={async () => {
                        if (ltVisible) {
                          await invoke("hide_lower_third");
                          setLtVisible(false);
                        } else {
                          let payload: LowerThirdData;
                          if (ltMode === "nameplate") payload = { kind: "Nameplate", data: { name: ltName, title: ltTitle || undefined } };
                          else if (ltMode === "freetext") payload = { kind: "FreeText", data: { text: ltFreeText } };
                          else {
                            if (!ltSongId || ltFlatLines.length === 0) return;
                            const line1 = ltFlatLines[ltLineIndex];
                            const line2 = ltLinesPerDisplay === 2 ? ltFlatLines[ltLineIndex + 1] : undefined;
                            payload = { kind: "Lyrics", data: { line1: line1.text, line2: line2?.text, section_label: line1.sectionLabel } };
                          }
                          await invoke("show_lower_third", { data: payload, template: ltTemplate });
                          setLtVisible(true);
                        }
                      }}
                      className={`px-6 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${ltVisible ? "bg-red-600 text-white" : "bg-green-600 text-white"}`}
                    >
                      {ltVisible ? "STOP OVERLAY" : "START OVERLAY"}
                    </button>
                  )}
                  <button onClick={() => setBottomDeckOpen(false)} className="text-slate-500 hover:text-white p-1">
                    <X size={16} />
                  </button>
                </div>
              </div>

              <div className="flex-1 flex overflow-hidden">
                
                {/* ── Mode: LIVE LOWER THIRD ── */}
                {bottomDeckMode === "live-lt" && (
                  <>
                    <div className="w-64 border-r border-slate-800 p-4 bg-slate-900/50 flex flex-col gap-4">
                       <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Operation Mode</p>
                       <div className="flex flex-col gap-1">
                          {(["nameplate", "lyrics", "freetext"] as const).map((m) => (
                            <button key={m} onClick={() => setLtMode(m)}
                              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-all ${ltMode === m ? "bg-amber-500/10 text-amber-500 border border-amber-500/30" : "text-slate-400 hover:bg-slate-800"}`}>
                              {m.toUpperCase()}
                            </button>
                          ))}
                       </div>
                    </div>
                    <div className="flex-1 p-4 overflow-y-auto">
                       {ltMode === "nameplate" && (
                         <div className="grid grid-cols-2 gap-4">
                            <div className="flex flex-col gap-1.5">
                               <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Primary Name</label>
                               <input value={ltName} onChange={(e) => setLtName(e.target.value)} className="bg-slate-950 text-slate-200 text-sm p-3 rounded-xl border border-slate-800" placeholder="e.g. Pastor John Doe" />
                            </div>
                            <div className="flex flex-col gap-1.5">
                               <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Title / Subtitle</label>
                               <input value={ltTitle} onChange={(e) => setLtTitle(e.target.value)} className="bg-slate-950 text-slate-200 text-sm p-3 rounded-xl border border-slate-800" placeholder="e.g. Senior Pastor" />
                            </div>
                         </div>
                       )}
                       {ltMode === "freetext" && (
                          <div className="flex flex-col gap-4">
                             <div className="flex flex-col gap-1.5">
                                <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Broadcast Message</label>
                                <textarea value={ltFreeText} onChange={(e) => setLtFreeText(e.target.value)} className="bg-slate-950 text-slate-200 text-sm p-3 rounded-xl border border-slate-800 h-32 resize-none" placeholder="Type message to scroll..." />
                             </div>
                             <div className="grid grid-cols-2 gap-6">
                                <div className="flex flex-col gap-2">
                                   <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Scroll Direction</label>
                                   <div className="flex rounded-lg overflow-hidden border border-slate-800">
                                      {([
                                        { label: "None", enabled: false, dir: "ltr" as const },
                                        { label: "LTR →", enabled: true, dir: "ltr" as const },
                                        { label: "← RTL", enabled: true, dir: "rtl" as const },
                                      ] as const).map((opt) => (
                                        <button 
                                          key={opt.label}
                                          onClick={() => setLtTemplate(p => ({ ...p, scrollEnabled: opt.enabled, scrollDirection: opt.dir }))}
                                          className={`flex-1 py-1.5 text-[9px] font-bold transition-all ${ltTemplate.scrollEnabled === opt.enabled && (opt.enabled ? ltTemplate.scrollDirection === opt.dir : true) ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-500"}`}
                                        >
                                          {opt.label}
                                        </button>
                                      ))}
                                   </div>
                                </div>
                                {ltTemplate.scrollEnabled && (
                                   <div className="flex flex-col gap-2">
                                      <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Scroll Speed ({ltTemplate.scrollSpeed})</label>
                                      <input type="range" min={1} max={10} value={ltTemplate.scrollSpeed} onChange={(e) => setLtTemplate(p => ({ ...p, scrollSpeed: parseInt(e.target.value) }))} className="w-full accent-amber-500" />
                                   </div>
                                )}
                             </div>
                          </div>
                       )}
                       {ltMode === "lyrics" && (
                          <div className="flex flex-col gap-3">
                             <div className="flex items-center justify-between gap-4">
                                <select value={ltSongId || ""} onChange={(e) => { setLtSongId(e.target.value || null); setLtLineIndex(0); }} className="flex-1 bg-slate-950 text-slate-200 text-xs p-2 rounded border border-slate-800">
                                   <option value="">— Choose Song —</option>
                                   {songs.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                                </select>
                                <div className="flex items-center gap-3 bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800 shrink-0">
                                   <div className="flex items-center gap-1.5">
                                      <span className="text-[8px] text-slate-500 font-black uppercase">Lines</span>
                                      {[1, 2].map(n => (
                                        <button key={n} onClick={() => setLtLinesPerDisplay(n as any)} className={`w-6 h-6 rounded text-[10px] font-bold ${ltLinesPerDisplay === n ? "bg-amber-500 text-black" : "bg-slate-800 text-slate-500"}`}>{n}</button>
                                      ))}
                                   </div>
                                   <div className="w-px h-4 bg-slate-800" />
                                   <div className="flex items-center gap-2">
                                      <button onClick={() => setLtAutoAdvance(!ltAutoAdvance)} className={`px-2 py-1 rounded text-[8px] font-black uppercase ${ltAutoAdvance ? "bg-green-600 text-white" : "bg-slate-800 text-slate-500"}`}>Auto</button>
                                      {ltAutoAdvance && (
                                        <input type="number" value={ltAutoSeconds} onChange={(e) => setLtAutoSeconds(parseInt(e.target.value))} className="w-10 bg-slate-950 text-slate-200 text-[10px] p-1 rounded border border-slate-800 text-center" />
                                      )}
                                   </div>
                                </div>
                             </div>
                             {ltSongId && (
                               <div className="grid grid-cols-3 gap-2 overflow-y-auto max-h-64 pr-2">
                                 {ltFlatLines.map((line, idx) => (
                                   <button 
                                     key={idx}
                                     onClick={() => { setLtLineIndex(idx); if (ltVisible) ltSendCurrent(idx); }}
                                     className={`p-3 rounded-xl border text-left transition-all ${ltLineIndex === idx ? "bg-amber-500 border-amber-400 text-black" : "bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-600"}`}
                                   >
                                     <p className="text-[8px] font-black uppercase mb-1 opacity-60">{line.sectionLabel}</p>
                                     <p className="text-xs font-bold leading-tight line-clamp-2">{line.text}</p>
                                   </button>
                                 ))}
                               </div>
                             )}
                          </div>
                       )}
                    </div>
                  </>
                )}

                {/* ── Mode: STUDIO SLIDES ── */}
                {bottomDeckMode === "studio-slides" && (
                  <>
                    <div className="w-64 border-r border-slate-800 p-4 bg-slate-900/50 flex flex-col gap-4 overflow-y-auto">
                       <div className="flex justify-between items-center">
                          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Presentations</p>
                          <button onClick={handleNewStudioPresentation} className="p-1 bg-purple-600 rounded text-white"><Plus size={12} /></button>
                       </div>
                       <div className="flex flex-col gap-1.5">
                          {studioList.map(item => (
                            <div key={item.id} className={`group p-2.5 rounded-lg border transition-all cursor-pointer ${expandedStudioPresId === item.id ? "bg-purple-600/10 border-purple-600/40" : "bg-slate-950 border-slate-800 hover:border-slate-700"}`} onClick={() => handlePresentStudio(item.id)}>
                               <div className="flex items-center justify-between gap-2">
                                  <p className="text-[11px] font-bold text-slate-200 truncate">{item.name}</p>
                                  <div className="flex gap-1 opacity-0 group-hover:opacity-100">
                                     <button onClick={(e) => { e.stopPropagation(); handleOpenStudioEditor(item.id); }} className="p-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded"><Settings size={10} /></button>
                                     <button onClick={(e) => { e.stopPropagation(); handleDeleteStudioPresentation(item.id); }} className="p-1 bg-red-900/40 hover:bg-red-600 text-red-200 rounded"><X size={10} /></button>
                                  </div>
                               </div>
                               <p className="text-[8px] text-slate-600 font-bold mt-0.5">{item.slide_count} SLIDES</p>
                            </div>
                          ))}
                       </div>
                    </div>
                    <div className="flex-1 p-4 overflow-y-auto">
                       {expandedStudioPresId && studioSlides[expandedStudioPresId] ? (
                         <div className="grid grid-cols-4 gap-3">
                            {studioSlides[expandedStudioPresId].map((slide, idx) => (
                              <div key={slide.id} className="group relative aspect-video rounded-xl overflow-hidden border border-slate-800 hover:border-purple-500 transition-all shadow-lg">
                                 <CustomSlideRenderer slide={slide} scale={0.12} />
                                 <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-2 transition-all">
                                    <button onClick={() => stageCustomSlide(studioList.find(p=>p.id===expandedStudioPresId)!, studioSlides[expandedStudioPresId], idx)} className="bg-slate-700 text-white text-[9px] font-bold px-2 py-1 rounded">STAGE</button>
                                    <button onClick={() => sendCustomSlide(studioList.find(p=>p.id===expandedStudioPresId)!, studioSlides[expandedStudioPresId], idx)} className="bg-purple-600 text-white text-[9px] font-bold px-2 py-1 rounded">LIVE</button>
                                 </div>
                                 <div className="absolute top-2 left-2 bg-black/40 px-1.5 py-0.5 rounded text-[8px] text-white/70 font-black">{idx + 1}</div>
                              </div>
                            ))}
                         </div>
                       ) : (
                         <div className="h-full flex flex-col items-center justify-center text-slate-700 italic">
                            <Layers size={48} className="mb-4 opacity-20" />
                            <p className="text-sm">Select a presentation to manage slides</p>
                         </div>
                       )}
                    </div>
                  </>
                )}

                {/* ── Mode: STUDIO LOWER THIRD (LT DESIGNER) ── */}
                {bottomDeckMode === "studio-lt" && (
                  <>
                    <div className="w-80 border-r border-slate-800 p-4 overflow-y-auto space-y-4 bg-slate-900/50">
                       <div className="space-y-3">
                          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Template Management</p>
                          <div className="flex gap-1.5">
                            <select
                              className="flex-1 bg-slate-950 text-slate-200 text-[10px] rounded p-1.5 border border-slate-800"
                              value={ltTemplate.id}
                              onChange={(e) => {
                                const found = ltSavedTemplates.find((t) => t.id === e.target.value);
                                if (found) { setLtTemplate(found); localStorage.setItem("activeLtTemplateId", found.id); }
                              }}
                            >
                              {ltSavedTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                            <button onClick={() => {
                              const newTpl: LowerThirdTemplate = {...ltTemplate, id: stableId(), name: "New Template"};
                              setLtTemplate(newTpl);
                              setLtSavedTemplates(prev => [...prev, newTpl]);
                              localStorage.setItem("activeLtTemplateId", newTpl.id);
                            }} className="p-1.5 bg-slate-800 rounded text-white"><Plus size={14} /></button>
                            <button onClick={async () => {
                                const updated = ltSavedTemplates.some((t) => t.id === ltTemplate.id) ? ltSavedTemplates.map((t) => t.id === ltTemplate.id ? ltTemplate : t) : [...ltSavedTemplates, ltTemplate];
                                setLtSavedTemplates(updated); localStorage.setItem("activeLtTemplateId", ltTemplate.id); await invoke("save_lt_templates", { templates: updated }); setToast("Template saved");
                            }} className="px-3 bg-amber-600 rounded text-white text-[9px] font-bold">SAVE</button>
                            <button onClick={async () => {
                                if (ltSavedTemplates.length <= 1) return;
                                const updated = ltSavedTemplates.filter((t) => t.id !== ltTemplate.id);
                                setLtSavedTemplates(updated); setLtTemplate(updated[0]); await invoke("save_lt_templates", { templates: updated }); setToast("Template deleted");
                            }} className="p-1.5 bg-red-900/40 hover:bg-red-600 rounded text-red-400 hover:text-white transition-all"><X size={14} /></button>
                          </div>
                          
                          <div className="border-t border-slate-800 my-4" />
                          
                          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Global Styles</p>
                          <div className="grid grid-cols-2 gap-2">
                             <div className="flex flex-col gap-1">
                                <span className="text-[8px] text-slate-600 uppercase font-bold">Variant</span>
                                <select value={ltTemplate.variant} onChange={(e) => setLtTemplate(t => ({...t, variant: e.target.value as any}))} className="bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800">
                                   <option value="classic">Classic</option>
                                   <option value="modern">Modern</option>
                                   <option value="banner">Banner</option>
                                </select>
                             </div>
                             <div className="flex flex-col gap-1">
                                <span className="text-[8px] text-slate-600 uppercase font-bold">Anim</span>
                                <select value={ltTemplate.animation} onChange={(e) => setLtTemplate(t => ({...t, animation: e.target.value as any}))} className="bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800">
                                   <option value="slide-up">Slide Up</option>
                                   <option value="slide-left">Slide Left</option>
                                   <option value="fade">Fade</option>
                                   <option value="none">None</option>
                                </select>
                             </div>
                          </div>
                          
                          <div className="flex flex-col gap-1">
                             <span className="text-[8px] text-slate-600 uppercase font-bold">Background</span>
                             <div className="grid grid-cols-4 gap-1">
                                {(["solid", "gradient", "image", "transparent"] as const).map(bt => (
                                  <button key={bt} onClick={() => setLtTemplate(t => ({...t, bgType: bt}))} className={`text-[8px] font-bold py-1 rounded border transition-all ${ltTemplate.bgType === bt ? "bg-slate-700 border-slate-500 text-white" : "bg-slate-950 border-slate-800 text-slate-600 hover:text-slate-400"}`}>
                                    {bt.toUpperCase()}
                                  </button>
                                ))}
                             </div>
                             {ltTemplate.bgType === "solid" && (
                                <div className="flex items-center gap-2 mt-2">
                                   <span className="text-[8px] text-slate-600 uppercase font-bold w-12">Color</span>
                                   <input type="color" value={ltTemplate.bgColor} onChange={(e) => setLtTemplate(t => ({...t, bgColor: e.target.value}))} className="flex-1 h-6 bg-transparent border-0 p-0 cursor-pointer" />
                                </div>
                             )}
                             {ltTemplate.bgType === "gradient" && (
                                <div className="space-y-2 mt-2">
                                   <div className="flex items-center gap-2">
                                      <span className="text-[8px] text-slate-600 uppercase font-bold w-12">Start</span>
                                      <input type="color" value={ltTemplate.bgColor} onChange={(e) => setLtTemplate(t => ({...t, bgColor: e.target.value}))} className="flex-1 h-6 bg-transparent border-0 p-0 cursor-pointer" />
                                   </div>
                                   <div className="flex items-center gap-2">
                                      <span className="text-[8px] text-slate-600 uppercase font-bold w-12">End</span>
                                      <input type="color" value={ltTemplate.bgGradientEnd} onChange={(e) => setLtTemplate(t => ({...t, bgGradientEnd: e.target.value}))} className="flex-1 h-6 bg-transparent border-0 p-0 cursor-pointer" />
                                   </div>
                                </div>
                             )}
                             {ltTemplate.bgType === "image" && (
                                <div className="mt-2">
                                   <button onClick={() => setShowLtImgPicker(true)} className="w-full py-1.5 px-2 bg-slate-950 border border-slate-800 rounded text-[9px] text-slate-400 hover:text-slate-200 truncate">
                                      {ltTemplate.bgImagePath ? ltTemplate.bgImagePath.split(/[/\\]/).pop() : "CHOOSE IMAGE..."}
                                   </button>
                                </div>
                             )}
                             <div className="flex items-center gap-2 mt-2">
                                <span className="text-[8px] text-slate-600 uppercase font-bold w-12">Opacity</span>
                                <input type="range" min={0} max={100} value={ltTemplate.bgOpacity} onChange={(e) => setLtTemplate(t => ({...t, bgOpacity: parseInt(e.target.value)}))} className="flex-1 accent-amber-500" />
                             </div>
                             <div className="flex items-center justify-between mt-1">
                                <span className="text-[8px] text-slate-600 uppercase font-bold">Blur Background</span>
                                <input type="checkbox" checked={ltTemplate.bgBlur} onChange={(e) => setLtTemplate(t => ({...t, bgBlur: e.target.checked}))} />
                             </div>
                          </div>

                          <div className="border-t border-slate-800 my-4" />

                          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Accent Bar</p>
                          <div className="space-y-3">
                             <div className="flex items-center justify-between">
                                <span className="text-[8px] text-slate-600 uppercase font-bold">Enabled</span>
                                <input type="checkbox" checked={ltTemplate.accentEnabled} onChange={(e) => setLtTemplate(t => ({...t, accentEnabled: e.target.checked}))} />
                             </div>
                             {ltTemplate.accentEnabled && (
                               <>
                                 <div className="flex items-center gap-2">
                                    <span className="text-[8px] text-slate-600 uppercase font-bold w-12">Color</span>
                                    <input type="color" value={ltTemplate.accentColor} onChange={(e) => setLtTemplate(t => ({...t, accentColor: e.target.value}))} className="flex-1 h-6 bg-transparent border-0 p-0 cursor-pointer" />
                                 </div>
                                 <div className="flex flex-col gap-1">
                                    <span className="text-[8px] text-slate-600 uppercase font-bold">Side</span>
                                    <div className="grid grid-cols-4 gap-1">
                                       {(["left", "right", "top", "bottom"] as const).map(s => (
                                         <button key={s} onClick={() => setLtTemplate(t => ({...t, accentSide: s}))} className={`text-[7px] font-bold py-1 rounded border transition-all ${ltTemplate.accentSide === s ? "bg-amber-600 border-amber-500 text-white" : "bg-slate-950 border-slate-800 text-slate-600"}`}>
                                           {s.toUpperCase()}
                                         </button>
                                       ))}
                                    </div>
                                 </div>
                                 <div className="flex items-center gap-2">
                                    <span className="text-[8px] text-slate-600 uppercase font-bold w-12">Width px</span>
                                    <input type="range" min={1} max={20} value={ltTemplate.accentWidth} onChange={(e) => setLtTemplate(t => ({...t, accentWidth: parseInt(e.target.value)}))} className="flex-1 accent-amber-500" />
                                 </div>
                               </>
                             )}
                          </div>
                       </div>
                    </div>
                    <div className="flex-1 p-4 overflow-y-auto">
                       <div className="grid grid-cols-2 gap-8">
                          <div className="space-y-6">
                             <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Typography & Colors</p>
                             <div className="space-y-4">
                                <div className="space-y-2">
                                   <span className="text-[8px] text-slate-600 uppercase font-bold">Primary (Name / Line 1)</span>
                                   <div className="flex gap-2 items-center">
                                      <select value={ltTemplate.primaryFont} onChange={(e) => setLtTemplate(t => ({...t, primaryFont: e.target.value}))} className="flex-1 bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800">
                                         {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
                                      </select>
                                      <input type="number" value={ltTemplate.primarySize} onChange={(e) => setLtTemplate(t => ({...t, primarySize: parseInt(e.target.value)}))} className="w-12 bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800" />
                                      <input type="color" value={ltTemplate.primaryColor} onChange={(e) => setLtTemplate(t => ({...t, primaryColor: e.target.value}))} className="w-8 h-8 rounded bg-transparent border-0 p-0 cursor-pointer" />
                                   </div>
                                   <div className="flex gap-1 mt-1">
                                      <button onClick={() => setLtTemplate(t => ({...t, primaryBold: !t.primaryBold}))} className={`flex-1 py-1 text-[9px] font-black rounded border transition-all ${ltTemplate.primaryBold ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-600"}`}>B</button>
                                      <button onClick={() => setLtTemplate(t => ({...t, primaryItalic: !t.primaryItalic}))} className={`flex-1 py-1 text-[9px] italic rounded border transition-all ${ltTemplate.primaryItalic ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-600"}`}>I</button>
                                      <button onClick={() => setLtTemplate(t => ({...t, primaryUppercase: !t.primaryUppercase}))} className={`flex-1 py-1 text-[9px] font-bold rounded border transition-all ${ltTemplate.primaryUppercase ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-600"}`}>AA</button>
                                   </div>
                                </div>
                                <div className="space-y-2">
                                   <span className="text-[8px] text-slate-600 uppercase font-bold">Secondary (Title / Line 2)</span>
                                   <div className="flex gap-2 items-center">
                                      <select value={ltTemplate.secondaryFont} onChange={(e) => setLtTemplate(t => ({...t, secondaryFont: e.target.value}))} className="flex-1 bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800">
                                         {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
                                      </select>
                                      <input type="number" value={ltTemplate.secondarySize} onChange={(e) => setLtTemplate(t => ({...t, secondarySize: parseInt(e.target.value)}))} className="w-12 bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800" />
                                      <input type="color" value={ltTemplate.secondaryColor} onChange={(e) => setLtTemplate(t => ({...t, secondaryColor: e.target.value}))} className="w-8 h-8 rounded bg-transparent border-0 p-0 cursor-pointer" />
                                   </div>
                                   <div className="flex gap-1 mt-1">
                                      <button onClick={() => setLtTemplate(t => ({...t, secondaryBold: !t.secondaryBold}))} className={`flex-1 py-1 text-[9px] font-black rounded border transition-all ${ltTemplate.secondaryBold ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-600"}`}>B</button>
                                      <button onClick={() => setLtTemplate(t => ({...t, secondaryItalic: !t.secondaryItalic}))} className={`flex-1 py-1 text-[9px] italic rounded border transition-all ${ltTemplate.secondaryItalic ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-600"}`}>I</button>
                                      <button onClick={() => setLtTemplate(t => ({...t, secondaryUppercase: !t.secondaryUppercase}))} className={`flex-1 py-1 text-[9px] font-bold rounded border transition-all ${ltTemplate.secondaryUppercase ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-600"}`}>AA</button>
                                   </div>
                                </div>
                                <div className="space-y-2 pt-2 border-t border-slate-800">
                                   <div className="flex items-center justify-between">
                                      <span className="text-[8px] text-slate-600 uppercase font-bold">Section Label</span>
                                      <input type="checkbox" checked={ltTemplate.labelVisible} onChange={(e) => setLtTemplate(t => ({...t, labelVisible: e.target.checked}))} />
                                   </div>
                                   {ltTemplate.labelVisible && (
                                      <div className="flex gap-2 items-center">
                                         <input type="number" value={ltTemplate.labelSize} onChange={(e) => setLtTemplate(t => ({...t, labelSize: parseInt(e.target.value)}))} className="w-12 bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800" />
                                         <input type="color" value={ltTemplate.labelColor} onChange={(e) => setLtTemplate(t => ({...t, labelColor: e.target.value}))} className="w-8 h-8 rounded bg-transparent border-0 p-0 cursor-pointer" />
                                         <button onClick={() => setLtTemplate(t => ({...t, labelUppercase: !t.labelUppercase}))} className={`flex-1 py-1 text-[9px] font-bold rounded border transition-all ${ltTemplate.labelUppercase ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-600"}`}>AA</button>
                                      </div>
                                   )}
                                </div>
                             </div>
                          </div>
                          <div className="space-y-6">
                             <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Layout & Positioning</p>
                             <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                                <div className="flex flex-col gap-1.5">
                                   <span className="text-[8px] text-slate-600 uppercase font-bold">H Alignment</span>
                                   <div className="flex rounded border border-slate-800 overflow-hidden">
                                      {(["left", "center", "right"] as const).map(h => (
                                        <button key={h} onClick={() => setLtTemplate(t => ({...t, hAlign: h}))} className={`flex-1 py-1 text-[8px] font-bold ${ltTemplate.hAlign === h ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-600"}`}>{h.toUpperCase()}</button>
                                      ))}
                                   </div>
                                </div>
                                <div className="flex flex-col gap-1.5">
                                   <span className="text-[8px] text-slate-600 uppercase font-bold">V Alignment</span>
                                   <div className="flex rounded border border-slate-800 overflow-hidden">
                                      {(["top", "middle", "bottom"] as const).map(v => (
                                        <button key={v} onClick={() => setLtTemplate(t => ({...t, vAlign: v}))} className={`flex-1 py-1 text-[8px] font-bold ${ltTemplate.vAlign === v ? "bg-slate-700 text-white" : "bg-slate-950 text-slate-600"}`}>{v.toUpperCase()}</button>
                                      ))}
                                   </div>
                                </div>
                                <div className="flex flex-col gap-1.5">
                                   <span className="text-[8px] text-slate-600 uppercase font-bold">Width %</span>
                                   <input type="range" min={10} max={100} value={ltTemplate.widthPct} onChange={(e) => setLtTemplate(t => ({...t, widthPct: parseInt(e.target.value)}))} className="w-full accent-amber-500" />
                                </div>
                                <div className="flex flex-col gap-1.5">
                                   <span className="text-[8px] text-slate-600 uppercase font-bold">Radius px</span>
                                   <input type="range" min={0} max={50} value={ltTemplate.borderRadius} onChange={(e) => setLtTemplate(t => ({...t, borderRadius: parseInt(e.target.value)}))} className="w-full accent-amber-500" />
                                </div>
                                <div className="flex flex-col gap-1.5">
                                   <span className="text-[8px] text-slate-600 uppercase font-bold">Offset X px</span>
                                   <input type="number" value={ltTemplate.offsetX} onChange={(e) => setLtTemplate(t => ({...t, offsetX: parseInt(e.target.value)}))} className="bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800" />
                                </div>
                                <div className="flex flex-col gap-1.5">
                                   <span className="text-[8px] text-slate-600 uppercase font-bold">Offset Y px</span>
                                   <input type="number" value={ltTemplate.offsetY} onChange={(e) => setLtTemplate(t => ({...t, offsetY: parseInt(e.target.value)}))} className="bg-slate-950 text-slate-300 text-[10px] p-1.5 rounded border border-slate-800" />
                                </div>
                                <div className="flex flex-col gap-1.5">
                                   <span className="text-[8px] text-slate-600 uppercase font-bold">Padding X px</span>
                                   <input type="range" min={0} max={100} value={ltTemplate.paddingX} onChange={(e) => setLtTemplate(t => ({...t, paddingX: parseInt(e.target.value)}))} className="w-full accent-amber-500" />
                                </div>
                                <div className="flex flex-col gap-1.5">
                                   <span className="text-[8px] text-slate-600 uppercase font-bold">Padding Y px</span>
                                   <input type="range" min={0} max={100} value={ltTemplate.paddingY} onChange={(e) => setLtTemplate(t => ({...t, paddingY: parseInt(e.target.value)}))} className="w-full accent-amber-500" />
                                </div>
                             </div>
                          </div>
                       </div>
                    </div>
                  </>
                )}

                {/* ── Mode: SCENE COMPOSER (LAYER STUDIO) ── */}
                {bottomDeckMode === "scene-composer" && (
                  <>
                    {/* LEFT: Layer Stack + Saved Scenes */}
                    <div className="w-72 border-r border-slate-800 flex flex-col overflow-hidden bg-slate-900/50 shrink-0">
                      <div className="flex-1 overflow-y-auto p-3 space-y-4">
                        {/* Saved Scenes */}
                        {savedScenes.length > 0 && (
                          <>
                            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Saved Scenes</p>
                            <div className="space-y-1">
                              {savedScenes.map(sc => (
                                <div key={sc.id} className="flex items-center gap-1 bg-slate-800/50 rounded px-2 py-1">
                                  <span className="flex-1 text-[10px] text-slate-300 truncate">{sc.name}</span>
                                  <button
                                    onClick={() => { setWorkingScene({ ...sc }); setActiveLayerId(null); }}
                                    className="text-[8px] font-black uppercase px-1.5 py-0.5 bg-blue-700 hover:bg-blue-600 text-white rounded"
                                  >LOAD</button>
                                  <button
                                    onClick={async () => {
                                      await invoke("delete_scene", { id: sc.id });
                                      const list = await invoke<SceneData[]>("list_scenes");
                                      setSavedScenes(list);
                                    }}
                                    className="text-[8px] font-black uppercase px-1.5 py-0.5 bg-red-900/50 hover:bg-red-600 text-red-300 hover:text-white rounded"
                                  >DEL</button>
                                </div>
                              ))}
                            </div>
                            <div className="border-t border-slate-800" />
                          </>
                        )}

                        {/* Layer Stack (top → bottom display, bottom-to-top z-order) */}
                        <div className="flex items-center justify-between">
                          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Layer Stack</p>
                          <span className="text-[8px] text-slate-600">top ↑ bottom</span>
                        </div>
                        {workingScene.layers.length === 0 ? (
                          <p className="text-[10px] text-slate-600 italic text-center py-2">No layers — add one below</p>
                        ) : (
                          <div className="space-y-1">
                            {[...workingScene.layers].reverse().map((layer, revIdx) => {
                              const realIdx = workingScene.layers.length - 1 - revIdx;
                              const isLt = layer.content.kind === "lower-third";
                              return (
                                <div
                                  key={layer.id}
                                  onClick={() => setActiveLayerId(layer.id)}
                                  className={`flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer transition-all ${
                                    activeLayerId === layer.id
                                      ? "bg-blue-600/20 border border-blue-500/50"
                                      : "bg-slate-800/40 border border-slate-700/30 hover:border-slate-600/50"
                                  }`}
                                >
                                  {/* Eye toggle */}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setWorkingScene(s => ({
                                        ...s,
                                        layers: s.layers.map(l => l.id === layer.id ? { ...l, visible: !l.visible } : l)
                                      }));
                                    }}
                                    className="text-slate-500 hover:text-white transition-colors shrink-0"
                                    title={layer.visible ? "Hide layer" : "Show layer"}
                                  >
                                    {layer.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                                  </button>
                                  {/* Type badge */}
                                  <span className={`text-[7px] font-black uppercase px-1 rounded shrink-0 ${
                                    isLt ? "bg-amber-600/40 text-amber-300" :
                                    layer.content.kind === "empty" ? "bg-slate-700/60 text-slate-400" :
                                    "bg-blue-700/40 text-blue-300"
                                  }`}>
                                    {isLt ? "LT" : layer.content.kind === "empty" ? "—" : layer.content.kind === "item" ? layer.content.item.type.slice(0,3).toUpperCase() : "?"}
                                  </span>
                                  {/* Name */}
                                  <span className="flex-1 text-[10px] text-slate-300 truncate">{layer.name}</span>
                                  {/* Reorder up */}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (realIdx >= workingScene.layers.length - 1) return;
                                      setWorkingScene(s => {
                                        const arr = [...s.layers];
                                        [arr[realIdx], arr[realIdx + 1]] = [arr[realIdx + 1], arr[realIdx]];
                                        return { ...s, layers: arr };
                                      });
                                    }}
                                    className="text-slate-600 hover:text-white transition-colors shrink-0 text-[10px]"
                                    title="Move up (higher z-order)"
                                  >↑</button>
                                  {/* Reorder down */}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (realIdx <= 0) return;
                                      setWorkingScene(s => {
                                        const arr = [...s.layers];
                                        [arr[realIdx], arr[realIdx - 1]] = [arr[realIdx - 1], arr[realIdx]];
                                        return { ...s, layers: arr };
                                      });
                                    }}
                                    className="text-slate-600 hover:text-white transition-colors shrink-0 text-[10px]"
                                    title="Move down (lower z-order)"
                                  >↓</button>
                                  {/* Delete */}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setWorkingScene(s => ({ ...s, layers: s.layers.filter(l => l.id !== layer.id) }));
                                      if (activeLayerId === layer.id) setActiveLayerId(null);
                                    }}
                                    className="text-slate-600 hover:text-red-400 transition-colors shrink-0 text-[10px]"
                                    title="Delete layer"
                                  >×</button>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        <div className="space-y-1.5 pt-1">
                          <button
                            onClick={() => {
                              const id = stableId();
                              const newLayer: SceneLayer = {
                                id, name: `Layer ${workingScene.layers.length + 1}`,
                                content: { kind: "empty" },
                                x: 0, y: 0, w: 100, h: 100,
                                opacity: 1, visible: true,
                              };
                              setWorkingScene(s => ({ ...s, layers: [...s.layers, newLayer] }));
                              setActiveLayerId(id);
                            }}
                            className="w-full py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-[9px] font-black uppercase rounded border border-slate-600"
                          >+ Add Empty Layer</button>
                          <button
                            onClick={() => {
                              const ltCurrent: LowerThirdData = ltMode === "nameplate"
                                ? { kind: "Nameplate", data: { name: ltName || "Full Name", title: ltTitle || undefined } }
                                : ltMode === "freetext"
                                ? { kind: "FreeText", data: { text: ltFreeText || "Text here" } }
                                : { kind: "Lyrics", data: { line1: ltFlatLines[ltLineIndex]?.text || "Line 1", line2: ltLinesPerDisplay === 2 ? ltFlatLines[ltLineIndex + 1]?.text : undefined } };
                              const id = stableId();
                              const newLayer: SceneLayer = {
                                id, name: "Lower Third",
                                content: { kind: "lower-third", ltData: ltCurrent, template: ltTemplate },
                                x: 0, y: 0, w: 100, h: 100,
                                opacity: 1, visible: true,
                              };
                              setWorkingScene(s => ({ ...s, layers: [...s.layers, newLayer] }));
                              setActiveLayerId(id);
                            }}
                            className="w-full py-1.5 bg-amber-700/50 hover:bg-amber-600/60 text-amber-200 text-[9px] font-black uppercase rounded border border-amber-700/40"
                          >+ Add Lower Third Layer</button>
                        </div>
                      </div>
                    </div>

                    {/* CENTER: Canvas + toolbar */}
                    <div className="flex-1 p-4 flex flex-col gap-3 overflow-hidden min-w-0">
                      <div className="flex-1 min-h-0 bg-black rounded-xl border border-slate-800 shadow-2xl relative overflow-hidden">
                        <SceneRenderer
                          scene={workingScene}
                          activeLayerId={activeLayerId}
                          onLayerClick={setActiveLayerId}
                        />
                      </div>
                      <div className="shrink-0 flex items-center gap-2">
                        <input
                          value={workingScene.name}
                          onChange={(e) => setWorkingScene(s => ({ ...s, name: e.target.value }))}
                          className="flex-1 min-w-0 bg-slate-950 text-slate-200 text-xs px-3 py-2 rounded-lg border border-slate-800"
                          placeholder="Scene Name..."
                        />
                        <button
                          onClick={async () => {
                            await invoke("save_scene", { scene: workingScene });
                            const list = await invoke<SceneData[]>("list_scenes");
                            setSavedScenes(list);
                            setToast("Scene saved");
                          }}
                          className="px-3 py-2 bg-green-700 hover:bg-green-600 text-white text-[10px] font-black uppercase rounded-lg shrink-0"
                        >SAVE</button>
                        <button
                          onClick={() => stageItem({ type: "Scene", data: workingScene })}
                          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-black uppercase rounded-lg shrink-0"
                        >STAGE SCENE</button>
                        <button
                          onClick={() => sendLive({ type: "Scene", data: workingScene })}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-black uppercase rounded-lg shadow-lg shrink-0"
                        >GO LIVE</button>
                      </div>
                    </div>

                    {/* RIGHT: Layer Config */}
                    <div className="w-80 border-l border-slate-800 p-3 overflow-y-auto bg-slate-950/50 shrink-0">
                      {activeLayerId && workingScene.layers.find(l => l.id === activeLayerId) ? (() => {
                        const layer = workingScene.layers.find(l => l.id === activeLayerId)!;
                        const isLt = layer.content.kind === "lower-third";
                        const updateLayer = (patch: Partial<SceneLayer>) =>
                          setWorkingScene(s => ({ ...s, layers: s.layers.map(l => l.id === activeLayerId ? { ...l, ...patch } : l) }));

                        return (
                          <div className="space-y-4">
                            <p className="text-[9px] font-black text-blue-400 uppercase tracking-widest">Layer Config</p>

                            {/* Name */}
                            <div className="flex flex-col gap-1">
                              <span className="text-[8px] text-slate-500 uppercase font-bold">Name</span>
                              <input
                                value={layer.name}
                                onChange={(e) => updateLayer({ name: e.target.value })}
                                className="bg-slate-900 text-slate-200 text-xs px-2 py-1.5 rounded border border-slate-700 focus:outline-none focus:border-blue-500"
                              />
                            </div>

                            {/* Content */}
                            <div className="flex flex-col gap-1.5">
                              <span className="text-[8px] text-slate-500 uppercase font-bold">Content</span>
                              <div className="bg-slate-900 rounded p-2 text-[10px] min-h-[28px] flex items-center border border-slate-700">
                                <span className={layer.content.kind === "empty" ? "text-slate-600 italic" : "text-amber-400 font-bold"}>
                                  {describeLayerContent(layer.content)}
                                </span>
                              </div>
                              {stagedItem && !isLt && (
                                <button
                                  onClick={() => updateLayer({ content: { kind: "item", item: stagedItem } })}
                                  className="w-full py-1.5 bg-blue-700 hover:bg-blue-600 text-white text-[9px] font-black uppercase rounded"
                                >
                                  ↙ Assign Staged: {describeDisplayItem(stagedItem)}
                                </button>
                              )}
                              {isLt && (
                                <button
                                  onClick={() => {
                                    const ltCurrent: LowerThirdData = ltMode === "nameplate"
                                      ? { kind: "Nameplate", data: { name: ltName || "Full Name", title: ltTitle || undefined } }
                                      : ltMode === "freetext"
                                      ? { kind: "FreeText", data: { text: ltFreeText || "Text here" } }
                                      : { kind: "Lyrics", data: { line1: ltFlatLines[ltLineIndex]?.text || "Line 1", line2: ltLinesPerDisplay === 2 ? ltFlatLines[ltLineIndex + 1]?.text : undefined } };
                                    updateLayer({ content: { kind: "lower-third", ltData: ltCurrent, template: ltTemplate } });
                                  }}
                                  className="w-full py-1.5 bg-amber-700/60 hover:bg-amber-600 text-amber-100 text-[9px] font-black uppercase rounded border border-amber-700/50"
                                >+ Assign Current LT</button>
                              )}
                              {!isLt && !stagedItem && (
                                <p className="text-[9px] text-slate-600 italic text-center py-1">
                                  Stage a verse, media, slide, or camera — then click Assign
                                </p>
                              )}
                              <button
                                onClick={() => updateLayer({ content: { kind: "empty" } })}
                                className="w-full py-1 bg-red-900/30 hover:bg-red-700/40 text-red-300 text-[9px] font-black uppercase rounded border border-red-900/40"
                              >✕ Clear</button>
                            </div>

                            {/* Position & Size — hidden for LT layers (always full-screen) */}
                            {!isLt && (
                              <>
                                <div className="border-t border-slate-800" />
                                <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Position &amp; Size</p>
                                <div className="space-y-2">
                                  {(["x", "y", "w", "h"] as const).map(key => (
                                    <div key={key} className="flex items-center gap-2">
                                      <span className="text-[9px] text-slate-500 uppercase w-4 shrink-0">{key.toUpperCase()}</span>
                                      <input
                                        type="range" min={0} max={100} step={1}
                                        value={layer[key]}
                                        onChange={(e) => updateLayer({ [key]: parseFloat(e.target.value) })}
                                        className="flex-1 accent-blue-500"
                                      />
                                      <span className="text-[9px] text-slate-400 w-8 text-right">{Math.round(layer[key])}%</span>
                                    </div>
                                  ))}
                                </div>

                                {/* Quick presets */}
                                <div className="border-t border-slate-800" />
                                <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Quick Presets</p>
                                <div className="grid grid-cols-2 gap-1">
                                  {[
                                    { label: "Full Screen",    vals: { x:0, y:0, w:100, h:100 } },
                                    { label: "Top Half",       vals: { x:0, y:0, w:100, h:50  } },
                                    { label: "Bottom Half",    vals: { x:0, y:50, w:100, h:50 } },
                                    { label: "Left Half",      vals: { x:0, y:0, w:50,  h:100 } },
                                    { label: "Right Half",     vals: { x:50, y:0, w:50, h:100 } },
                                    { label: "LT Strip",       vals: { x:0, y:75, w:100, h:25 } },
                                    { label: "Top-Left ¼",    vals: { x:0, y:0, w:50,  h:50  } },
                                    { label: "Center 50%",     vals: { x:25, y:25, w:50, h:50 } },
                                  ].map(({ label, vals }) => (
                                    <button
                                      key={label}
                                      onClick={() => updateLayer(vals)}
                                      className="py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-[8px] font-bold rounded border border-slate-700/50 transition-all"
                                    >{label}</button>
                                  ))}
                                </div>
                              </>
                            )}

                            {/* Opacity */}
                            <div className="border-t border-slate-800" />
                            <div className="flex items-center gap-2">
                              <span className="text-[8px] text-slate-500 uppercase shrink-0">Opacity</span>
                              <input
                                type="range" min={0} max={1} step={0.05}
                                value={layer.opacity}
                                onChange={(e) => updateLayer({ opacity: parseFloat(e.target.value) })}
                                className="flex-1 accent-blue-500"
                              />
                              <span className="text-[9px] text-slate-400 w-8 text-right">{Math.round(layer.opacity * 100)}%</span>
                            </div>
                          </div>
                        );
                      })() : (
                        <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-4">
                          <Layers size={24} className="text-slate-700" />
                          <p className="text-[10px] text-slate-600">Select a layer to configure it, or add a new layer from the left panel.</p>
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* ── Composition Preview (Always Right) ── */}
                <div className="w-96 border-l border-slate-800 p-4 bg-black/40 shrink-0">
                   <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3">Composition Preview</p>
                   <div className="relative aspect-video bg-black rounded-lg overflow-hidden ring-1 ring-slate-800">
                      <div className="absolute inset-0 flex items-center justify-center opacity-20">
                         <Monitor size={48} className="text-slate-800" />
                      </div>
                      <div style={{ position: "absolute", inset: 0, transform: "scale(0.19)", transformOrigin: "top left" }}>
                         <div style={{ width: 1920, height: 1080 }}>
                            {bottomDeckMode === "scene-composer" ? (
                               <SceneRenderer scene={workingScene} activeLayerId={activeLayerId} onLayerClick={setActiveLayerId} />
                            ) : (
                               <LowerThirdOverlay 
                                  template={ltTemplate}
                                  data={
                                    ltMode === "nameplate" ? { kind: "Nameplate", data: { name: ltName || "Full Name", title: ltTitle || "Title Info" } } :
                                    ltMode === "freetext" ? { kind: "FreeText", data: { text: ltFreeText || "Your message here..." } } :
                                    { kind: "Lyrics", data: { line1: ltFlatLines[ltLineIndex]?.text || "Lyric Line 1", line2: ltLinesPerDisplay === 2 ? ltFlatLines[ltLineIndex + 1]?.text : undefined, section_label: ltFlatLines[ltLineIndex]?.sectionLabel || "Verse 1" } }
                                  }
                               />
                            )}
                         </div>
                      </div>
                   </div>
                   <div className="mt-4 p-3 rounded-lg bg-slate-800/30 border border-slate-700/50">
                      <p className="text-[8px] text-slate-500 uppercase font-black mb-1">Shortcut Tip</p>
                      <p className="text-[10px] text-slate-400">Use <span className="text-amber-500 font-bold">Ctrl + Space</span> to toggle the overlay on the main output screen.</p>
                   </div>
                </div>
              </div>
            </section>
          )}

                {/* ── Mode: TIMER ── */}
                {bottomDeckMode === "timer" && (
                  <section className="flex gap-4 p-4 overflow-y-auto">
                    {/* Timer Config */}
                    <div className="flex flex-col gap-3 min-w-[220px]">
                      <div>
                        <p className="text-[9px] font-black uppercase text-slate-500 mb-2">Timer Type</p>
                        <div className="flex gap-2">
                          {(["countdown", "countup", "clock"] as const).map((t) => (
                            <button
                              key={t}
                              onClick={() => setTimerType(t)}
                              className={`flex-1 py-1.5 text-[9px] font-black uppercase rounded-lg border transition-all ${timerType === t ? "bg-cyan-600 border-cyan-500 text-white" : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"}`}
                            >{t}</button>
                          ))}
                        </div>
                      </div>
                      {timerType === "countdown" && (
                        <div>
                          <p className="text-[9px] font-black uppercase text-slate-500 mb-2">Duration</p>
                          <div className="flex gap-2 items-center">
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="text-[8px] text-slate-600 uppercase">H</span>
                              <input type="number" min={0} max={23} value={timerHours} onChange={(e) => setTimerHours(parseInt(e.target.value) || 0)}
                                className="w-14 bg-slate-800 text-slate-200 text-center text-sm rounded border border-slate-700 py-1" />
                            </div>
                            <span className="text-slate-500 font-bold">:</span>
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="text-[8px] text-slate-600 uppercase">M</span>
                              <input type="number" min={0} max={59} value={timerMinutes} onChange={(e) => setTimerMinutes(parseInt(e.target.value) || 0)}
                                className="w-14 bg-slate-800 text-slate-200 text-center text-sm rounded border border-slate-700 py-1" />
                            </div>
                            <span className="text-slate-500 font-bold">:</span>
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="text-[8px] text-slate-600 uppercase">S</span>
                              <input type="number" min={0} max={59} value={timerSeconds} onChange={(e) => setTimerSeconds(parseInt(e.target.value) || 0)}
                                className="w-14 bg-slate-800 text-slate-200 text-center text-sm rounded border border-slate-700 py-1" />
                            </div>
                          </div>
                        </div>
                      )}
                      <div>
                        <p className="text-[9px] font-black uppercase text-slate-500 mb-1">Label (optional)</p>
                        <input
                          value={timerLabel}
                          onChange={(e) => setTimerLabel(e.target.value)}
                          placeholder="e.g. BREAK ENDS IN"
                          className="w-full bg-slate-800 text-slate-200 text-xs rounded border border-slate-700 px-2 py-1.5"
                        />
                      </div>
                    </div>

                    {/* Timer Controls */}
                    <div className="flex flex-col gap-2 justify-center min-w-[160px]">
                      <button
                        onClick={async () => {
                          const durSecs = timerType === "countdown"
                            ? timerHours * 3600 + timerMinutes * 60 + timerSeconds
                            : undefined;
                          const timerItem: DisplayItem = {
                            type: "Timer",
                            data: { timer_type: timerType, duration_secs: durSecs, label: timerLabel || undefined, started_at: undefined },
                          };
                          await invoke("stage_item", { item: timerItem });
                        }}
                        className="py-2 text-xs font-black uppercase bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg"
                      >Stage</button>
                      <button
                        onClick={async () => {
                          const durSecs = timerType === "countdown"
                            ? timerHours * 3600 + timerMinutes * 60 + timerSeconds
                            : undefined;
                          const timerItem: DisplayItem = {
                            type: "Timer",
                            data: { timer_type: timerType, duration_secs: durSecs, label: timerLabel || undefined, started_at: undefined },
                          };
                          await invoke("stage_item", { item: timerItem });
                          await invoke("go_live");
                        }}
                        className="py-2 text-xs font-black uppercase bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg"
                      >Stage + Live</button>
                      <div className="border-t border-slate-800 pt-2 flex gap-2">
                        <button
                          onClick={async () => {
                            const now = Date.now();
                            await invoke("update_timer", { startedAt: now });
                            setTimerRunning(true);
                          }}
                          className="flex-1 py-1.5 text-[9px] font-black uppercase bg-green-800 hover:bg-green-700 text-green-200 rounded"
                        >Start</button>
                        <button
                          onClick={async () => {
                            await invoke("update_timer", { startedAt: null });
                            setTimerRunning(false);
                          }}
                          className="flex-1 py-1.5 text-[9px] font-black uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 rounded"
                        >Reset</button>
                      </div>
                    </div>
                  </section>
                )}
        </main>

        {/* ── Service Schedule (Right Column — ProPresenter style) ── */}
        <aside className="w-60 bg-slate-950 border-l border-slate-900 flex flex-col overflow-hidden shrink-0">
          <div className="p-3 border-b border-slate-900 bg-slate-900/20 flex items-center justify-between shrink-0">
            <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
              <CalendarDays size={12} className="text-amber-500" /> Setlist
            </h2>
            <button
              onClick={async () => {
                const s: Schedule = { id: stableId(), name: `Service ${new Date().toLocaleDateString()}`, items: scheduleEntries };
                await invoke("save_schedule", { schedule: s });
                setToast("Schedule saved");
              }}
              className="text-[9px] font-bold bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded transition-colors"
            >
              SAVE
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {scheduleEntries.length === 0 ? (
              <div className="h-32 flex flex-col items-center justify-center text-center p-4">
                <CalendarDays size={24} className="text-slate-800 mb-2" />
                <p className="text-[10px] text-slate-600 font-medium leading-tight italic">Add items from Bible, Media or Songs.</p>
              </div>
            ) : (
              scheduleEntries.map((entry, idx) => (
                <div
                  key={entry.id}
                  className={`group relative flex items-center gap-2 p-2 rounded-lg border transition-all cursor-pointer ${
                    stagedItem && displayItemLabel(stagedItem) === displayItemLabel(entry.item)
                      ? "bg-amber-500/10 border-amber-500/30 ring-1 ring-amber-500/20"
                      : liveItem && displayItemLabel(liveItem) === displayItemLabel(entry.item)
                      ? "bg-red-900/20 border-red-900/40"
                      : "bg-slate-900/40 border-slate-800/50 hover:bg-slate-800/60 hover:border-slate-700"
                  }`}
                  onClick={() => stageItem(entry.item)}
                >
                  <span className="text-[8px] font-black text-slate-700 tabular-nums shrink-0 w-4">{idx + 1}</span>
                  <div className="shrink-0 text-slate-600 group-hover:text-amber-500 transition-colors">
                    {entry.item.type === "Verse" ? <BookOpen size={11} /> :
                     entry.item.type === "Media" ? <Image size={11} /> :
                     entry.item.type === "PresentationSlide" ? <Presentation size={11} /> :
                     entry.item.type === "CustomSlide" ? <Layers size={11} /> :
                     entry.item.type === "Timer" ? <Clock size={11} /> : <Mic size={11} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-bold text-slate-300 truncate">{displayItemLabel(entry.item)}</p>
                    <p className="text-[8px] text-slate-600 uppercase tracking-tighter font-bold">{entry.item.type}</p>
                  </div>
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); sendLive(entry.item); }}
                      className="bg-amber-600 hover:bg-amber-500 text-black p-0.5 rounded"
                      title="Quick Live"
                    >
                      <Zap size={9} fill="currentColor" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteScheduleEntry(entry.id); }}
                      className="bg-red-900/40 hover:bg-red-600 text-red-200 p-0.5 rounded"
                    >
                      <X size={9} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>

      <AnimatePresence>
        {toast && <Toast key={toast} message={toast} onDone={() => setToast(null)} />}
      </AnimatePresence>
    </div>
  );
}
