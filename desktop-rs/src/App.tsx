import React, { useEffect, useState, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { loadPptxZip, parseSingleSlide, getSlideCount } from "./pptxParser";
import type { ParsedSlide } from "./pptxParser";

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
}

export type DisplayItem =
  | { type: "Verse"; data: Verse }
  | { type: "Media"; data: MediaItem }
  | { type: "PresentationSlide"; data: PresentationSlideData }
  | { type: "CustomSlide"; data: CustomSlideDisplayData }
  | { type: "CameraFeed"; data: CameraFeedData };

export interface ScheduleEntry {
  id: string;
  item: DisplayItem;
}

export interface Schedule {
  id: string;
  name: string;
  items: ScheduleEntry[];
}

// Background is a serde-tagged enum: { type: "None" } | { type: "Color"; value: string } | { type: "Image"; value: string }
export type BackgroundSetting =
  | { type: "None" }
  | { type: "Color"; value: string }
  | { type: "Image"; value: string };

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
  return { backgroundColor: colors.background };
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
}: {
  label: string;
  value: BackgroundSetting | undefined;
  onChange: (bg: BackgroundSetting) => void;
  mediaImages?: MediaItem[];
  onUploadMedia?: () => Promise<void>;
}) {
  const [showPicker, setShowPicker] = React.useState(false);
  const current: BackgroundSetting = value ?? { type: "None" };

  return (
    <>
      <div>
        {label && <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mb-1.5">{label}</p>}
        <div className="flex gap-1.5 mb-1.5">
          {(["None", "Color", "Image"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                if (mode === "None") onChange({ type: "None" });
                else if (mode === "Color") onChange({ type: "Color", value: current.type === "Color" ? (current as any).value : "#000000" });
                else onChange({ type: "Image", value: current.type === "Image" ? (current as any).value : "" });
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

// ─── Output Window ────────────────────────────────────────────────────────────

function OutputWindow() {
  const [liveItem, setLiveItem] = useState<DisplayItem | null>(null);
  const [settings, setSettings] = useState<PresentationSettings>({
    theme: "dark",
    reference_position: "bottom",
    background: { type: "None" },
    is_blanked: false,
    font_size: 72,
  });
  const [currentSlide, setCurrentSlide] = useState<ParsedSlide | null>(null);
  const outputZipsRef = useRef<Record<string, any>>({});

  useEffect(() => {
    invoke("get_current_item")
      .then((v: any) => { if (v) setLiveItem(v); })
      .catch(() => {});

    invoke("get_settings")
      .then((s: any) => { if (s) setSettings(s); })
      .catch(() => {});

    const unlisten = listen("transcription-update", (event: any) => {
      if (event.payload.detected_item) {
        setLiveItem(event.payload.detected_item);
      }
    });

    const unlistenSettings = listen("settings-changed", (event: any) => {
      setSettings(event.payload as PresentationSettings);
    });

    return () => {
      unlisten.then((f) => f());
      unlistenSettings.then((f) => f());
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

  if (settings.is_blanked) {
    return <div className="h-screen w-screen bg-black" />;
  }

  const { colors } = THEMES[settings.theme] ?? THEMES.dark;
  const isTop = settings.reference_position === "top";
  const bgStyle = getEffectiveBackground(settings, liveItem, colors);

  const ReferenceTag = liveItem?.type === "Verse" ? (
    <p
      className="text-4xl uppercase tracking-widest font-bold shrink-0"
      style={{ color: colors.referenceText }}
    >
      {liveItem.data.book} {liveItem.data.chapter}:{liveItem.data.verse}
    </p>
  ) : null;

  return (
    <div
      className="h-screen w-screen overflow-hidden relative"
      style={{ ...bgStyle, color: colors.verseText }}
    >
      {settings.logo_path && (
        <img
          src={convertFileSrc(settings.logo_path)}
          className="absolute bottom-8 right-8 w-24 h-24 object-contain opacity-50 z-50"
          alt="Logo"
        />
      )}

      {liveItem ? (
        <>
          {liveItem.type === "Verse" ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-16 text-center animate-in fade-in duration-700">
              <div className="max-w-5xl flex flex-col items-center gap-8">
                {isTop && ReferenceTag}
                <h1
                  className="font-serif leading-tight drop-shadow-2xl"
                  style={{ color: colors.verseText, fontSize: `${settings.font_size}pt` }}
                >
                  {liveItem.data.text}
                </h1>
                {!isTop && ReferenceTag}
              </div>
            </div>
          ) : liveItem.type === "PresentationSlide" ? (
            <div className="absolute inset-0 animate-in fade-in duration-500">
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
            <div className="absolute inset-0 animate-in fade-in duration-500">
              <CustomSlideRenderer slide={liveItem.data} />
            </div>
          ) : liveItem.type === "CameraFeed" ? (
            <div className="absolute inset-0 animate-in fade-in duration-500">
              <CameraFeedRenderer deviceId={liveItem.data.device_id} />
            </div>
          ) : liveItem.type === "Media" ? (
            <div className="absolute inset-0 flex items-center justify-center animate-in fade-in duration-700">
              {liveItem.data.media_type === "Image" ? (
                <img
                  src={convertFileSrc(liveItem.data.path)}
                  className="max-w-full max-h-full object-contain"
                  alt={liveItem.data.name}
                />
              ) : (
                <video
                  src={convertFileSrc(liveItem.data.path)}
                  className="max-w-full max-h-full object-contain"
                  autoPlay
                  loop
                  muted
                />
              )}
            </div>
          ) : null}
        </>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-serif text-2xl italic select-none" style={{ color: colors.waitingText }}>
            Waiting for projection...
          </span>
        </div>
      )}
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
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex justify-between items-center mb-3 shrink-0">
        <h2 className={`text-xs font-bold uppercase tracking-widest ${accent}`}>{label}</h2>
        {badge}
      </div>
      <div className="flex-1 flex flex-col items-center justify-center bg-black/40 rounded-2xl border border-slate-800 p-6 text-center min-h-0">
        {item ? (
          <div className="animate-in fade-in zoom-in-95 duration-300 w-full h-full flex flex-col items-center justify-center gap-3">
            {item.type === "Verse" ? (
              <>
                <p className="text-xl font-serif text-slate-300 leading-snug line-clamp-5">
                  {item.data.text}
                </p>
                <p className="text-amber-500 font-bold uppercase tracking-widest text-sm shrink-0">
                  {item.data.book} {item.data.chapter}:{item.data.verse}
                </p>
              </>
            ) : item.type === "PresentationSlide" ? (
              <>
                <div className="text-orange-400 text-xs font-black uppercase bg-orange-400/10 px-2 py-0.5 rounded">
                  SLIDE {item.data.slide_index + 1} / {item.data.slide_count || "?"}
                </div>
                <p className="text-slate-400 text-xs font-bold truncate max-w-full">
                  {item.data.presentation_name}
                </p>
              </>
            ) : item.type === "CustomSlide" ? (
              <div className="w-full" style={{ aspectRatio: "16/9" }}>
                <CustomSlideRenderer slide={item.data} scale={0.25} />
              </div>
            ) : item.type === "CameraFeed" ? (
              <>
                <div className="w-full rounded overflow-hidden border border-slate-700" style={{ aspectRatio: "16/9", maxHeight: "8rem" }}>
                  <CameraFeedRenderer deviceId={item.data.device_id} />
                </div>
                <p className="text-teal-400 text-xs font-bold uppercase truncate max-w-full">
                  {item.data.label || item.data.device_id.slice(0, 16)}
                </p>
              </>
            ) : (
              <>
                {item.data.media_type === "Image" ? (
                  <img
                    src={convertFileSrc(item.data.path)}
                    className="max-w-full max-h-32 object-contain rounded shadow-xl"
                    alt={item.data.name}
                  />
                ) : (
                  <video
                    src={convertFileSrc(item.data.path)}
                    className="max-w-full max-h-32 object-contain rounded"
                    muted
                    preload="metadata"
                  />
                )}
                <p className="text-slate-400 text-xs font-bold uppercase truncate max-w-full">
                  {item.data.name}
                </p>
              </>
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
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="bg-slate-700 text-white text-xs font-bold px-4 py-2 rounded-full shadow-xl border border-slate-600">
        {message}
      </div>
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
  const [nextVerse, setNextVerse] = useState<Verse | null>(null);

  // Settings
  const [settings, setSettings] = useState<PresentationSettings>({
    theme: "dark",
    reference_position: "bottom",
    background: { type: "None" },
    is_blanked: false,
    font_size: 72,
  });

  // Studio
  const [studioList, setStudioList] = useState<{ id: string; name: string; slide_count: number }[]>([]);
  const [editorPresId, setEditorPresId] = useState<string | null>(null);
  const [editorPres, setEditorPres] = useState<CustomPresentation | null>(null);
  const [expandedStudioPresId, setExpandedStudioPresId] = useState<string | null>(null);
  const [studioSlides, setStudioSlides] = useState<Record<string, CustomSlide[]>>({});

  // UI
  const [activeTab, setActiveTab] = useState<"bible" | "media" | "presentations" | "studio" | "schedule" | "settings">("bible");
  const [toast, setToast] = useState<string | null>(null);

  // Auto-updater
  const [updateInfo, setUpdateInfo] = useState<{ version: string; update: any } | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);

  // Schedule
  const [scheduleEntries, setScheduleEntries] = useState<ScheduleEntry[]>([]);
  const scheduleRef = useRef<ScheduleEntry[]>([]);
  const [activeScheduleIdx, setActiveScheduleIdx] = useState<number | null>(null);

  // Media
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [mediaFilter, setMediaFilter] = useState<"image" | "video" | "camera">("image");
  const [showLogoPicker, setShowLogoPicker] = useState(false);
  const [showGlobalBgPicker, setShowGlobalBgPicker] = useState(false);

  // Presentations
  const [presentations, setPresentations] = useState<PresentationFile[]>([]);
  const [selectedPresId, setSelectedPresId] = useState<string | null>(null);
  const [loadedSlides, setLoadedSlides] = useState<Record<string, ParsedSlide[]>>({});
  const presZipsRef = useRef<Record<string, any>>({});

  // Session / audio
  const [transcript, setTranscript] = useState("");
  const [devices, setDevices] = useState<[string, string][]>([]);
  const [selectedDevice, setSelectedDevice] = useState("");
  const [vadThreshold, setVadThreshold] = useState(0.005);
  const [sessionState, setSessionState] = useState<"idle" | "loading" | "running">("idle");
  const [audioError, setAudioError] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);

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

  scheduleRef.current = scheduleEntries;

  // ── Loaders ─────────────────────────────────────────────────────────────────

  const loadAudioDevices = () => {
    setDeviceError(null);
    invoke("get_audio_devices")
      .then((devs: any) => {
        setDevices(devs);
        if (devs.length > 0) setSelectedDevice((prev) => prev || devs[0][0]);
        else setDeviceError("No input devices found");
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

  // ── Initialisation ──────────────────────────────────────────────────────────

  useEffect(() => {
    const windowLabel = getCurrentWindow().label;
    setLabel(windowLabel);
    if (windowLabel === "output") return;

    // Check for updates silently in the background
    check().then((update) => {
      if (update?.available) {
        setUpdateInfo({ version: update.version, update });
      }
    }).catch(() => {});

    loadAudioDevices();
    loadMedia();
    navigator.mediaDevices?.enumerateDevices()
      .then((devs) => setCameras(devs.filter((d) => d.kind === "videoinput")))
      .catch(() => {});
    loadPresentations();
    loadStudioList();
    loadSchedule();

    invoke("get_bible_versions")
      .then((versions: any) => {
        if (versions && versions.length > 0) {
          setAvailableVersions(versions);
          setBibleVersion(versions[0]);
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
      const { text, detected_item, source } = event.payload;
      setTranscript(text);
      if (detected_item) {
        if (source === "manual") {
          setLiveItem(detected_item);
        } else {
          setSuggestedItem(detected_item);
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

    return () => {
      unlisten.then((f) => f());
      unlistenStaged.then((f) => f());
      unlistenStatus.then((f) => f());
      unlistenAudioErr.then((f) => f());
      unlistenSettings.then((f) => f());
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

  // When version changes: notify Rust, reload books list
  useEffect(() => {
    invoke("set_bible_version", { version: bibleVersion }).catch(() => {});
    invoke("get_books", { version: bibleVersion })
      .then((b: any) => {
        setBooks(b);
        if (b.length > 0) setSelectedBook(b[0]);
      })
      .catch((err: any) => setAudioError(`Failed to load books: ${err}`));
  }, [bibleVersion]);

  useEffect(() => {
    if (!selectedBook) return;
    invoke("get_chapters", { book: selectedBook, version: bibleVersion })
      .then((c: any) => {
        setChapters(c);
        if (c.length > 0) setSelectedChapter(c[0]);
      })
      .catch((err: any) => setAudioError(`Failed to load chapters: ${err}`));
  }, [selectedBook, bibleVersion]);

  useEffect(() => {
    if (!selectedBook || !selectedChapter) return;
    invoke("get_verses_count", { book: selectedBook, chapter: selectedChapter, version: bibleVersion })
      .then((v: any) => {
        setVerses(v);
        if (v.length > 0) setSelectedVerse(v[0]);
      })
      .catch((err: any) => setAudioError(`Failed to load verses: ${err}`));
  }, [selectedBook, selectedChapter, bibleVersion]);

  // ── Presentation actions ─────────────────────────────────────────────────────

  const stageItem = async (item: DisplayItem) => {
    setStagedItem(item);
    await invoke("stage_item", { item });
  };

  const goLive = async () => {
    await invoke("go_live");
  };

  const sendLive = async (item: DisplayItem) => {
    await stageItem(item);
    await new Promise((r) => setTimeout(r, 50));
    await goLive();
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

  // ── Search ──────────────────────────────────────────────────────────────────

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    try {
      const results: any = await invoke("search_manual", { query: searchQuery, version: bibleVersion });
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
      const schedule: Schedule = { id: "default", name: "Default Schedule", items: entries };
      await invoke("save_schedule", { schedule });
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

  // ── Audio controls ───────────────────────────────────────────────────────────

  const handleDeviceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const device = e.target.value;
    setSelectedDevice(device);
    invoke("set_audio_device", { deviceName: device });
  };

  const updateVad = (val: string) => {
    const threshold = parseFloat(val);
    setVadThreshold(threshold);
    invoke("set_vad_threshold", { threshold });
  };

  // ── Output window short-circuit ──────────────────────────────────────────────

  if (label === "output") return <OutputWindow />;

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
      {/* Update banner */}
      {updateInfo && !updateDismissed && (
        <div style={{ background: "#1e40af", color: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 20px", fontSize: "13px", flexShrink: 0 }}>
          <span>Update v{updateInfo.version} available</span>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              disabled={updateInstalling}
              onClick={async () => {
                setUpdateInstalling(true);
                try {
                  await updateInfo.update.downloadAndInstall();
                  await relaunch();
                } catch {
                  setUpdateInstalling(false);
                }
              }}
              style={{ background: "#fff", color: "#1e40af", border: "none", borderRadius: "4px", padding: "3px 12px", cursor: "pointer", fontWeight: 600 }}
            >
              {updateInstalling ? "Installing…" : "Install & Restart"}
            </button>
            <button
              onClick={() => setUpdateDismissed(true)}
              style={{ background: "transparent", color: "#93c5fd", border: "1px solid #3b82f6", borderRadius: "4px", padding: "3px 10px", cursor: "pointer" }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
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
              ↺
            </button>
          </div>

          <button
            onClick={() => updateSettings({ ...settings, is_blanked: !settings.is_blanked })}
            className={`font-bold py-2 px-4 rounded border transition-all text-sm ${
              settings.is_blanked
                ? "bg-red-500 border-red-500 text-white"
                : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white"
            }`}
          >
            {settings.is_blanked ? "UNBLANK" : "BLANK"}
          </button>

          <button
            onClick={() => invoke("toggle_output_window")}
            className="bg-slate-800 hover:bg-slate-700 text-white font-bold py-2 px-4 rounded border border-slate-700 transition-all text-sm"
          >
            TOGGLE OUTPUT
          </button>

          <button
            onClick={() => {
              if (sessionState === "running") {
                invoke("stop_session");
              } else {
                setAudioError(null);
                invoke("start_session").catch((err: any) => {
                  setAudioError(String(err));
                  setSessionState("idle");
                });
              }
            }}
            disabled={sessionState === "loading"}
            className={`font-bold py-2 px-6 rounded-full transition-all disabled:opacity-50 ${
              sessionState === "running"
                ? "bg-red-500 hover:bg-red-600 text-white"
                : "bg-amber-500 hover:bg-amber-600 text-black"
            }`}
          >
            {sessionState === "loading" ? "LOADING..." : sessionState === "running" ? "STOP" : "START LIVE"}
          </button>
        </div>
      </header>

      {audioError && (
        <div className="bg-red-950 border-b border-red-800 text-red-300 text-xs px-6 py-2 flex items-center gap-2 shrink-0">
          <span className="font-bold text-red-400 uppercase tracking-widest">Error</span>
          <span className="flex-1">{audioError}</span>
          <button onClick={() => setAudioError(null)} className="text-red-500 hover:text-red-200 font-bold">✕</button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">

        {/* ── Left Sidebar ── */}
        <aside className="w-80 bg-slate-900/30 border-r border-slate-800 flex flex-col overflow-hidden shrink-0">
          {/* Tab nav */}
          <div className="flex border-b border-slate-800 bg-slate-900/50 shrink-0 overflow-x-auto">
            {(["bible", "media", "presentations", "studio", "schedule", "settings"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-3 text-[9px] font-bold uppercase tracking-widest transition-all relative whitespace-nowrap px-1 ${
                  activeTab === tab
                    ? "bg-slate-800 text-amber-500 border-b-2 border-amber-500"
                    : "text-slate-500 hover:text-slate-300 hover:bg-slate-800/50"
                }`}
              >
                {tab === "settings" ? "⚙" : tab === "presentations" ? "PPTX" : tab === "studio" ? "Studio" : tab}
                {tab === "schedule" && scheduleEntries.length > 0 && (
                  <span className="ml-1 text-[8px] bg-amber-500 text-black rounded-full px-1 font-black">
                    {scheduleEntries.length}
                  </span>
                )}
                {tab === "presentations" && presentations.length > 0 && (
                  <span className="ml-1 text-[8px] bg-orange-500 text-black rounded-full px-1 font-black">
                    {presentations.length}
                  </span>
                )}
                {tab === "studio" && studioList.length > 0 && (
                  <span className="ml-1 text-[8px] bg-purple-500 text-white rounded-full px-1 font-black">
                    {studioList.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">

            {/* ── Bible Tab ── */}
            {activeTab === "bible" && (
              <>
                {/* Version selector */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {availableVersions.map((v) => (
                    <button
                      key={v}
                      onClick={() => setBibleVersion(v)}
                      className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all ${
                        bibleVersion === v
                          ? "bg-amber-500 text-black"
                          : "bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-700"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>

                <hr className="border-slate-800" />

                {/* Quick keyboard entry */}
                <div>
                  <h2 className="text-xs font-bold text-slate-500 uppercase mb-2 tracking-widest">
                    Quick Entry
                  </h2>
                  <QuickBiblePicker
                    books={books}
                    version={bibleVersion}
                    onStage={stageItem}
                    onLive={sendLive}
                  />
                </div>

                <hr className="border-slate-800" />

                <div>
                  <h2 className="text-xs font-bold text-slate-500 uppercase mb-3 tracking-widest">
                    Manual Selection
                  </h2>
                  <div className="flex flex-col gap-2">
                    <select
                      value={selectedBook}
                      onChange={(e) => setSelectedBook(e.target.value)}
                      className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    >
                      <option value="">Select Book</option>
                      {books.map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>

                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={selectedChapter}
                        onChange={(e) => setSelectedChapter(parseInt(e.target.value))}
                        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      >
                        {chapters.map((c) => <option key={c} value={c}>Chap {c}</option>)}
                      </select>
                      <select
                        value={selectedVerse}
                        onChange={(e) => setSelectedVerse(parseInt(e.target.value))}
                        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      >
                        {verses.map((v) => <option key={v} value={v}>Verse {v}</option>)}
                      </select>
                    </div>

                    <div className="grid grid-cols-3 gap-1.5">
                      <button
                        onClick={handleDisplaySelection}
                        disabled={!selectedBook}
                        className="bg-slate-700 hover:bg-slate-600 text-white font-bold py-2 rounded-lg transition-all text-xs disabled:opacity-30"
                      >
                        STAGE
                      </button>
                      <button
                        onClick={handleSendLivePicker}
                        disabled={!selectedBook}
                        className="bg-amber-500 hover:bg-amber-400 text-black font-bold py-2 rounded-lg transition-all text-xs disabled:opacity-30"
                      >
                        DISPLAY
                      </button>
                      <button
                        onClick={async () => {
                          if (!selectedBook) return;
                          const v: any = await invoke("get_verse", {
                            book: selectedBook, chapter: selectedChapter, verse: selectedVerse, version: bibleVersion,
                          });
                          if (v) addToSchedule({ type: "Verse", data: v });
                        }}
                        disabled={!selectedBook}
                        className="bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 border border-amber-500/30 font-bold py-2 rounded-lg transition-all text-xs disabled:opacity-30"
                      >
                        + QUEUE
                      </button>
                    </div>
                  </div>
                </div>

                <hr className="border-slate-800" />

                <div className="flex flex-col min-h-0">
                  <h2 className="text-xs font-bold text-slate-500 uppercase mb-3 tracking-widest">
                    Keyword Search
                  </h2>
                  <form onSubmit={handleSearch} className="mb-3 flex gap-2">
                    <input
                      type="text"
                      placeholder="Search scripture..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                    <button type="submit" className="bg-amber-500 hover:bg-amber-600 text-black font-bold px-3 py-2 rounded-lg text-sm transition-all">
                      Go
                    </button>
                  </form>

                  <div className="space-y-2 overflow-y-auto">
                    {searchResults.length === 0 && searchQuery && (
                      <p className="text-slate-600 text-xs italic text-center pt-4">No results found</p>
                    )}
                    {searchResults.map((v, i) => (
                      <div key={i} className="p-3 rounded-lg bg-slate-800/50 border border-transparent hover:border-slate-700 transition-all group">
                        <p className="text-amber-500 text-xs font-bold mb-1 uppercase">{v.book} {v.chapter}:{v.verse} <span className="text-slate-500 font-normal normal-case">{v.version}</span></p>
                        <p className="text-slate-300 text-xs mb-2 line-clamp-2">{v.text}</p>
                        <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-all">
                          <button onClick={() => stageItem({ type: "Verse", data: v })} className="flex-1 bg-slate-600 hover:bg-slate-500 text-white text-[10px] font-bold py-1 rounded transition-all">STAGE</button>
                          <button onClick={() => sendLive({ type: "Verse", data: v })} className="flex-1 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-bold py-1 rounded transition-all">DISPLAY</button>
                          <button onClick={() => addToSchedule({ type: "Verse", data: v })} className="px-2 bg-slate-700 hover:bg-slate-600 text-amber-500 text-[10px] font-bold py-1 rounded transition-all" title="Add to schedule">+</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* ── Media Tab ── */}
            {activeTab === "media" && (
              <div className="flex flex-col gap-3">
                {/* Header + upload */}
                <div className="flex justify-between items-center">
                  <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Media Library</h2>
                  {mediaFilter !== "camera" && (
                    <button onClick={handleFileUpload} className="text-[10px] bg-amber-500 hover:bg-amber-600 text-black font-bold px-3 py-1.5 rounded transition-all">
                      + UPLOAD
                    </button>
                  )}
                </div>

                {/* Filter tabs */}
                <div className="flex gap-0.5 bg-slate-900/60 rounded-lg p-0.5 border border-slate-800">
                  {(["image", "video", "camera"] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setMediaFilter(f)}
                      className={`flex-1 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide transition-all ${
                        mediaFilter === f
                          ? "bg-amber-500 text-black shadow"
                          : "text-slate-500 hover:text-slate-300"
                      }`}
                    >
                      {f === "image"
                        ? `Images (${media.filter((m) => m.media_type === "Image").length})`
                        : f === "video"
                        ? `Videos (${media.filter((m) => m.media_type === "Video").length})`
                        : `Cameras (${cameras.length})`}
                    </button>
                  ))}
                </div>

                {/* Images grid */}
                {mediaFilter === "image" && (
                  media.filter((m) => m.media_type === "Image").length === 0 ? (
                    <p className="text-slate-700 text-xs italic text-center pt-8">No images. Click + UPLOAD to add.</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {media.filter((m) => m.media_type === "Image").map((item) => (
                        <div key={item.id} className="flex flex-col bg-slate-800/50 rounded-lg overflow-hidden border border-slate-700 hover:border-slate-600 transition-all">
                          <div className="aspect-video overflow-hidden bg-slate-900 shrink-0">
                            <img src={convertFileSrc(item.path)} className="w-full h-full object-cover" alt={item.name} />
                          </div>
                          <div className="px-1.5 py-1.5">
                            <p className="text-[8px] text-slate-400 truncate mb-1.5">{item.name}</p>
                            <div className="grid grid-cols-4 gap-0.5">
                              <button onClick={() => stageItem({ type: "Media", data: item })} className="bg-slate-700 hover:bg-slate-600 text-white text-[8px] font-bold py-1 rounded transition-all" title="Stage">STG</button>
                              <button onClick={() => sendLive({ type: "Media", data: item })} className="bg-amber-500 hover:bg-amber-400 text-black text-[8px] font-bold py-1 rounded transition-all" title="Display Live">LIVE</button>
                              <button onClick={() => addToSchedule({ type: "Media", data: item })} className="bg-slate-700 hover:bg-slate-600 text-amber-400 text-[8px] font-bold py-1 rounded transition-all" title="Add to Queue">+Q</button>
                              <button onClick={() => handleDeleteMedia(item.id)} className="bg-red-900/50 hover:bg-red-800 text-red-300 text-[8px] font-bold py-1 rounded transition-all" title="Delete">DEL</button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                )}

                {/* Videos grid */}
                {mediaFilter === "video" && (
                  media.filter((m) => m.media_type === "Video").length === 0 ? (
                    <p className="text-slate-700 text-xs italic text-center pt-8">No videos. Click + UPLOAD to add.</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {media.filter((m) => m.media_type === "Video").map((item) => (
                        <div key={item.id} className="flex flex-col bg-slate-800/50 rounded-lg overflow-hidden border border-slate-700 hover:border-slate-600 transition-all">
                          <div className="aspect-video overflow-hidden bg-slate-900 relative shrink-0">
                            <video src={convertFileSrc(item.path)} className="w-full h-full object-cover" muted preload="metadata" />
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                              <span className="text-white/50 text-xl">▶</span>
                            </div>
                          </div>
                          <div className="px-1.5 py-1.5">
                            <p className="text-[8px] text-slate-400 truncate mb-1.5">{item.name}</p>
                            <div className="grid grid-cols-4 gap-0.5">
                              <button onClick={() => stageItem({ type: "Media", data: item })} className="bg-slate-700 hover:bg-slate-600 text-white text-[8px] font-bold py-1 rounded transition-all" title="Stage">STG</button>
                              <button onClick={() => sendLive({ type: "Media", data: item })} className="bg-amber-500 hover:bg-amber-400 text-black text-[8px] font-bold py-1 rounded transition-all" title="Display Live">LIVE</button>
                              <button onClick={() => addToSchedule({ type: "Media", data: item })} className="bg-slate-700 hover:bg-slate-600 text-amber-400 text-[8px] font-bold py-1 rounded transition-all" title="Add to Queue">+Q</button>
                              <button onClick={() => handleDeleteMedia(item.id)} className="bg-red-900/50 hover:bg-red-800 text-red-300 text-[8px] font-bold py-1 rounded transition-all" title="Delete">DEL</button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                )}

                {/* Camera feed tab */}
                {mediaFilter === "camera" && (
                  <>
                    <button
                      onClick={() =>
                        navigator.mediaDevices?.enumerateDevices()
                          .then((devs) => setCameras(devs.filter((d) => d.kind === "videoinput")))
                          .catch(() => {})
                      }
                      className="text-[9px] bg-slate-700 hover:bg-slate-600 text-slate-300 font-bold px-3 py-1.5 rounded transition-all self-start border border-slate-600"
                    >
                      ↺ Refresh Cameras
                    </button>
                    {cameras.length === 0 ? (
                      <p className="text-slate-700 text-xs italic text-center pt-8">No cameras found. Allow camera access and click Refresh.</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        {cameras.map((cam) => (
                          <div key={cam.deviceId} className="flex flex-col bg-slate-800/50 rounded-lg overflow-hidden border border-slate-700 hover:border-slate-600 transition-all">
                            <div className="aspect-video overflow-hidden bg-slate-900 shrink-0">
                              <CameraFeedRenderer deviceId={cam.deviceId} />
                            </div>
                            <div className="px-1.5 py-1.5">
                              <p className="text-[8px] text-slate-400 truncate mb-1.5">{cam.label || `Camera ${cam.deviceId.slice(0, 8)}`}</p>
                              <div className="grid grid-cols-3 gap-0.5">
                                <button
                                  onClick={() => stageItem({ type: "CameraFeed", data: { device_id: cam.deviceId, label: cam.label } })}
                                  className="bg-slate-700 hover:bg-slate-600 text-white text-[8px] font-bold py-1 rounded transition-all"
                                >STAGE</button>
                                <button
                                  onClick={() => sendLive({ type: "CameraFeed", data: { device_id: cam.deviceId, label: cam.label } })}
                                  className="bg-amber-500 hover:bg-amber-400 text-black text-[8px] font-bold py-1 rounded transition-all"
                                >LIVE</button>
                                <button
                                  onClick={() => addToSchedule({ type: "CameraFeed", data: { device_id: cam.deviceId, label: cam.label } })}
                                  className="bg-slate-700 hover:bg-slate-600 text-amber-400 text-[8px] font-bold py-1 rounded transition-all"
                                >+Q</button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── Presentations Tab ── */}
            {activeTab === "presentations" && (
              <div className="flex flex-col gap-4">
                <div className="flex justify-between items-center">
                  <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Presentations</h2>
                  <button onClick={handleImportPresentation} className="text-[10px] bg-amber-500 hover:bg-amber-600 text-black font-bold px-3 py-1.5 rounded transition-all">
                    + IMPORT
                  </button>
                </div>

                {presentations.length === 0 ? (
                  <p className="text-slate-700 text-xs italic text-center pt-8">
                    No presentations. Click + IMPORT to add a .pptx file.
                  </p>
                ) : (
                  <>
                    {/* Presentation file list */}
                    <div className="flex flex-col gap-1">
                      {presentations.map((pres) => (
                        <button
                          key={pres.id}
                          onClick={() => setSelectedPresId(pres.id)}
                          className={`flex items-center gap-2 p-2 rounded-lg border text-left text-xs transition-all ${
                            selectedPresId === pres.id
                              ? "border-amber-500/50 bg-amber-500/10 text-amber-400"
                              : "border-slate-700/50 bg-slate-800/40 text-slate-300 hover:bg-slate-800 hover:border-slate-600"
                          }`}
                        >
                          <span className="text-orange-400 font-black text-[9px] bg-orange-400/10 px-1.5 py-0.5 rounded shrink-0">
                            PPTX
                          </span>
                          <span className="flex-1 truncate text-left">{pres.name}</span>
                          {pres.slide_count > 0 && (
                            <span className="text-slate-500 text-[9px] shrink-0">
                              {pres.slide_count} slides
                            </span>
                          )}
                          <span
                            role="button"
                            onClick={(e) => { e.stopPropagation(); handleDeletePresentation(pres.id); }}
                            className="shrink-0 text-red-500/50 hover:text-red-400 text-xs px-1 cursor-pointer"
                            title="Delete"
                          >
                            ✕
                          </span>
                        </button>
                      ))}
                    </div>

                    {/* Slide grid for the selected presentation */}
                    {selectedPresId && (
                      <div>
                        <p className="text-[9px] text-slate-600 uppercase font-bold mb-2 tracking-widest">
                          Slides
                        </p>
                        {!loadedSlides[selectedPresId] ? (
                          <p className="text-slate-600 text-xs italic text-center py-4">
                            Parsing slides...
                          </p>
                        ) : (
                          <div className="grid grid-cols-2 gap-2">
                            {loadedSlides[selectedPresId].map((slide, idx) => {
                              const pres = presentations.find((p) => p.id === selectedPresId)!;
                              return (
                                <SlideThumbnail
                                  key={idx}
                                  slide={slide}
                                  index={idx}
                                  onStage={() => stagePresentationSlide(pres, idx)}
                                  onLive={() => sendPresentationSlide(pres, idx)}
                                />
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── Studio Tab ── */}
            {activeTab === "studio" && (
              <div className="flex flex-col gap-4">
                <div className="flex justify-between items-center">
                  <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Studio</h2>
                  <button
                    onClick={handleNewStudioPresentation}
                    className="text-[10px] bg-purple-600 hover:bg-purple-500 text-white font-bold px-3 py-1.5 rounded transition-all"
                  >
                    + NEW
                  </button>
                </div>

                {studioList.length === 0 ? (
                  <p className="text-slate-700 text-xs italic text-center pt-8">
                    No presentations. Click + NEW to create one.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {studioList.map((item) => (
                      <div key={item.id} className="flex flex-col gap-1 p-2.5 rounded-lg border border-slate-700/50 bg-slate-800/40">
                        <div className="flex items-center gap-2">
                          <span className="text-purple-400 font-black text-[9px] bg-purple-400/10 px-1.5 py-0.5 rounded shrink-0">STUDIO</span>
                          <span className="flex-1 text-xs text-slate-300 truncate">{item.name}</span>
                          <span className="text-slate-600 text-[9px] shrink-0">{item.slide_count} slides</span>
                        </div>
                        <div className="flex gap-1">
                          <button
                            onClick={() => handleOpenStudioEditor(item.id)}
                            className="flex-1 py-1 bg-slate-700 hover:bg-slate-600 text-white text-[10px] font-bold rounded transition-all"
                          >
                            EDIT
                          </button>
                          <button
                            onClick={() => handlePresentStudio(item.id)}
                            className={`flex-1 py-1 text-[10px] font-bold rounded transition-all ${
                              expandedStudioPresId === item.id
                                ? "bg-purple-600 text-white"
                                : "bg-purple-600/30 hover:bg-purple-600/50 text-purple-300"
                            }`}
                          >
                            {expandedStudioPresId === item.id ? "HIDE" : "PRESENT"}
                          </button>
                          <button
                            onClick={() => handleDeleteStudioPresentation(item.id)}
                            className="px-2 py-1 bg-red-900/40 hover:bg-red-900 text-red-400 text-[10px] font-bold rounded transition-all"
                          >
                            ✕
                          </button>
                        </div>

                        {/* Slide thumbnails when expanded */}
                        {expandedStudioPresId === item.id && studioSlides[item.id] && (
                          <div className="grid grid-cols-2 gap-1.5 mt-1">
                            {studioSlides[item.id].map((slide, idx) => (
                              <div
                                key={slide.id}
                                className="group relative aspect-video rounded overflow-hidden border border-slate-700 hover:border-purple-500/50 transition-all cursor-pointer"
                              >
                                <CustomSlideRenderer slide={slide} scale={0.07} />
                                <div className="absolute bottom-0 left-0 px-1 py-0.5 bg-black/50">
                                  <span className="text-[7px] text-white/70">{idx + 1}</span>
                                </div>
                                <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-all flex flex-col items-center justify-center gap-1 p-1">
                                  <button
                                    onClick={() => stageCustomSlide(item, studioSlides[item.id], idx)}
                                    className="w-full bg-slate-600 hover:bg-slate-500 text-white text-[9px] font-bold py-1 rounded"
                                  >
                                    STAGE
                                  </button>
                                  <button
                                    onClick={() => sendCustomSlide(item, studioSlides[item.id], idx)}
                                    className="w-full bg-purple-600 hover:bg-purple-500 text-white text-[9px] font-bold py-1 rounded"
                                  >
                                    DISPLAY
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Schedule Tab ── */}
            {activeTab === "schedule" && (
              <div className="flex flex-col gap-3">
                <div className="flex justify-between items-center">
                  <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Live Schedule</h2>
                  {scheduleEntries.length > 0 && (
                    <div className="flex gap-1">
                      <button
                        onClick={handlePrevScheduleItem}
                        disabled={activeScheduleIdx === 0 || scheduleEntries.length === 0}
                        className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded border border-slate-700 disabled:opacity-30 transition-all"
                      >
                        ← Prev
                      </button>
                      <button
                        onClick={handleNextScheduleItem}
                        disabled={scheduleEntries.length === 0 || activeScheduleIdx === scheduleEntries.length - 1}
                        className="px-2 py-1 bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold rounded disabled:opacity-30 transition-all"
                      >
                        Next →
                      </button>
                    </div>
                  )}
                </div>

                {scheduleEntries.length === 0 ? (
                  <p className="text-slate-700 text-xs italic text-center pt-8">Schedule is empty. Add verses or media with + QUEUE.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {scheduleEntries.map((entry, idx) => {
                      const isActive = activeScheduleIdx === idx;
                      return (
                        <div
                          key={entry.id}
                          className={`flex items-center gap-2 p-2.5 rounded-lg border transition-all group ${
                            isActive
                              ? "bg-amber-500/10 border-amber-500/40"
                              : "bg-slate-800/40 border-slate-700/40 hover:bg-slate-800 hover:border-slate-700"
                          }`}
                        >
                          <div className={`w-5 h-5 flex items-center justify-center rounded text-[9px] font-black shrink-0 ${isActive ? "bg-amber-500 text-black" : "bg-slate-700 text-slate-400"}`}>
                            {idx + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            {entry.item.type === "Verse" ? (
                              <>
                                <p className="text-amber-500 text-[10px] font-bold uppercase truncate">{entry.item.data.book} {entry.item.data.chapter}:{entry.item.data.verse}</p>
                                <p className="text-slate-400 text-[10px] truncate">{entry.item.data.text}</p>
                              </>
                            ) : entry.item.type === "PresentationSlide" ? (
                              <p className="text-orange-400 text-[10px] font-bold uppercase truncate">
                                PPTX: {entry.item.data.presentation_name} — Slide {entry.item.data.slide_index + 1}
                              </p>
                            ) : entry.item.type === "CustomSlide" ? (
                              <p className="text-purple-400 text-[10px] font-bold uppercase truncate">
                                STUDIO: {entry.item.data.presentation_name} — Slide {entry.item.data.slide_index + 1}
                              </p>
                            ) : entry.item.type === "CameraFeed" ? (
                              <p className="text-teal-400 text-[10px] font-bold uppercase truncate">CAM: {entry.item.data.label || entry.item.data.device_id.slice(0, 12)}</p>
                            ) : (
                              <p className="text-blue-400 text-[10px] font-bold uppercase truncate">{entry.item.data.media_type}: {entry.item.data.name}</p>
                            )}
                          </div>
                          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                            <button onClick={() => handleScheduleItemSend(entry, idx)} title="Send live" className="p-1 bg-amber-500 hover:bg-amber-400 text-black rounded text-[10px] font-bold">▶</button>
                            <button onClick={() => removeFromSchedule(entry.id)} title="Remove" className="p-1 bg-red-900/50 text-red-400 rounded hover:bg-red-900 hover:text-white">✕</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ── Settings Tab ── */}
            {activeTab === "settings" && (
              <div className="flex flex-col gap-6">
                <div className="flex justify-between items-center">
                  <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Output Settings</h2>
                  <button
                    onClick={() => updateSettings({ ...settings, is_blanked: !settings.is_blanked })}
                    className={`px-4 py-2 rounded-lg text-xs font-black transition-all border ${
                      settings.is_blanked
                        ? "bg-red-500 border-red-500 text-white"
                        : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"
                    }`}
                  >
                    {settings.is_blanked ? "SCREEN BLANKED" : "BLANK SCREEN"}
                  </button>
                </div>

                {/* Font Size */}
                <div>
                  <div className="flex justify-between items-center mb-3">
                    <p className="text-xs text-slate-400 font-bold uppercase">Verse Font Size</p>
                    <span className="text-xs font-mono text-amber-500">{settings.font_size}pt</span>
                  </div>
                  <input
                    type="range"
                    min="24"
                    max="144"
                    step="2"
                    value={settings.font_size}
                    onChange={(e) => updateSettings({ ...settings, font_size: parseInt(e.target.value) })}
                    className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
                  />
                </div>

                {/* Theme selector */}
                <div>
                  <p className="text-xs text-slate-400 font-bold uppercase mb-3">Theme</p>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(THEMES).map(([key, { label, colors }]) => (
                      <button
                        key={key}
                        onClick={() => updateSettings({ ...settings, theme: key })}
                        className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs font-bold text-left transition-all ${
                          settings.theme === key
                            ? "border-amber-500 bg-amber-500/10 text-amber-400"
                            : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:bg-slate-800"
                        }`}
                      >
                        <span
                          className="w-5 h-5 rounded-sm shrink-0 border border-white/10"
                          style={{ backgroundColor: colors.background }}
                        />
                        <span className="truncate">{label}</span>
                        {settings.theme === key && (
                          <span className="ml-auto text-amber-500">✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Logo Setting */}
                <div>
                  <p className="text-xs text-slate-400 font-bold uppercase mb-3">Corner Logo</p>
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => {
                        if (media.filter((m) => m.media_type === "Image").length > 0) {
                          setShowLogoPicker(true);
                        } else {
                          handlePickLogo();
                        }
                      }}
                      className="w-full py-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-all"
                    >
                      {settings.logo_path ? "Change Logo..." : "Choose Logo..."}
                    </button>
                    {settings.logo_path && (
                      <div className="flex items-center justify-between bg-slate-900/50 p-2 rounded border border-slate-800">
                        <span className="text-[9px] text-slate-500 truncate max-w-[180px]">
                          {settings.logo_path.split(/[/\\]/).pop()}
                        </span>
                        <button
                          onClick={() => updateSettings({ ...settings, logo_path: undefined })}
                          className="text-red-500/70 hover:text-red-400 text-[10px] font-bold"
                        >
                          Clear
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                {showLogoPicker && (
                  <MediaPickerModal
                    images={media.filter((m) => m.media_type === "Image")}
                    onSelect={(path) => updateSettings({ ...settings, logo_path: path })}
                    onClose={() => setShowLogoPicker(false)}
                    onUpload={handleFileUpload}
                  />
                )}

                {/* Reference position */}
                <div>
                  <p className="text-xs text-slate-400 font-bold uppercase mb-3">Scripture Reference</p>
                  <div className="flex gap-2">
                    {(["top", "bottom"] as const).map((pos) => (
                      <button
                        key={pos}
                        onClick={() => updateSettings({ ...settings, reference_position: pos })}
                        className={`flex-1 py-3 rounded-lg border text-xs font-bold transition-all ${
                          settings.reference_position === pos
                            ? "border-amber-500 bg-amber-500/10 text-amber-400"
                            : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:bg-slate-800"
                        }`}
                      >
                        {pos === "top" ? "▲  Top" : "▼  Bottom"}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-600 italic mt-2">
                    Position of Book Chapter:Verse on the output screen.
                  </p>
                </div>

                {/* Output Background */}
                <div>
                  <p className="text-xs text-slate-400 font-bold uppercase mb-3">Output Background</p>

                  {/* Mode buttons */}
                  <div className="flex gap-2 mb-3">
                    {(["None", "Color", "Image"] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => {
                          let bg: BackgroundSetting;
                          if (mode === "None") {
                            bg = { type: "None" };
                          } else if (mode === "Color") {
                            bg = { type: "Color", value: settings.background.type === "Color" ? (settings.background as any).value : "#1a1a2e" };
                          } else {
                            bg = { type: "Image", value: settings.background.type === "Image" ? (settings.background as any).value : "" };
                          }
                          updateSettings({ ...settings, background: bg });
                        }}
                        className={`flex-1 py-2 rounded-lg border text-xs font-bold transition-all ${
                          settings.background.type === mode
                            ? "border-amber-500 bg-amber-500/10 text-amber-400"
                            : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:bg-slate-800"
                        }`}
                      >
                        {mode === "None" ? "Theme" : mode}
                      </button>
                    ))}
                  </div>

                  {/* Color picker */}
                  {settings.background.type === "Color" && (
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={(settings.background as { type: "Color"; value: string }).value}
                        onChange={(e) =>
                          updateSettings({ ...settings, background: { type: "Color", value: e.target.value } })
                        }
                        className="w-10 h-10 rounded cursor-pointer border border-slate-700 bg-transparent"
                      />
                      <span className="text-xs text-slate-400 font-mono">
                        {(settings.background as { type: "Color"; value: string }).value}
                      </span>
                    </div>
                  )}

                  {/* Image picker */}
                  {settings.background.type === "Image" && (
                    <div className="flex flex-col gap-2">
                      <button
                        onClick={() => {
                          if (media.filter((m) => m.media_type === "Image").length > 0) {
                            setShowGlobalBgPicker(true);
                          } else {
                            handlePickBackgroundImage();
                          }
                        }}
                        className="w-full py-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-all"
                      >
                        {(settings.background as { type: "Image"; value: string }).value ? "Change from Library..." : "Choose from Library..."}
                      </button>
                      {(settings.background as { type: "Image"; value: string }).value && (
                        <p className="text-[9px] text-slate-500 truncate">
                          {(settings.background as { type: "Image"; value: string }).value.split(/[/\\]/).pop()}
                        </p>
                      )}
                    </div>
                  )}
                  {showGlobalBgPicker && (
                    <MediaPickerModal
                      images={media.filter((m) => m.media_type === "Image")}
                      onSelect={(path) => updateSettings({ ...settings, background: { type: "Image", value: path } })}
                      onClose={() => setShowGlobalBgPicker(false)}
                      onUpload={handleFileUpload}
                    />
                  )}
                </div>

                {/* Per-content-type backgrounds */}
                <div>
                  <p className="text-xs text-slate-400 font-bold uppercase mb-1">Content Backgrounds</p>
                  <p className="text-[9px] text-slate-600 italic mb-3">Override the global background for each content type. "Inherit" uses the setting above.</p>
                  <div className="flex flex-col gap-3 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
                    <BackgroundEditor
                      label="Bible Verses"
                      value={settings.bible_background}
                      onChange={(bg) => updateSettings({ ...settings, bible_background: bg })}
                      mediaImages={media.filter((m) => m.media_type === "Image")}
                      onUploadMedia={handleFileUpload}
                    />
                    <div className="border-t border-slate-800" />
                    <BackgroundEditor
                      label="Presentations (PPTX)"
                      value={settings.presentation_background}
                      onChange={(bg) => updateSettings({ ...settings, presentation_background: bg })}
                      mediaImages={media.filter((m) => m.media_type === "Image")}
                      onUploadMedia={handleFileUpload}
                    />
                    <div className="border-t border-slate-800" />
                    <BackgroundEditor
                      label="Media (Image / Video)"
                      value={settings.media_background}
                      onChange={(bg) => updateSettings({ ...settings, media_background: bg })}
                      mediaImages={media.filter((m) => m.media_type === "Image")}
                      onUploadMedia={handleFileUpload}
                    />
                  </div>
                </div>

                {/* Live preview */}
                <div>
                  <p className="text-xs text-slate-400 font-bold uppercase mb-3">Preview</p>
                  <div
                    className="rounded-xl p-5 flex flex-col items-center text-center gap-3 border border-slate-800"
                    style={computePreviewBackground(settings, THEMES[settings.theme]?.colors.background ?? "#000")}
                  >
                    {settings.reference_position === "top" && (
                      <p className="text-sm font-bold uppercase tracking-widest" style={{ color: THEMES[settings.theme]?.colors.referenceText }}>
                        John 3:16
                      </p>
                    )}
                    <p className="text-base font-serif leading-snug" style={{ color: THEMES[settings.theme]?.colors.verseText }}>
                      For God so loved the world that he gave his one and only Son...
                    </p>
                    {settings.reference_position === "bottom" && (
                      <p className="text-sm font-bold uppercase tracking-widest" style={{ color: THEMES[settings.theme]?.colors.referenceText }}>
                        John 3:16
                      </p>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-600 italic mt-2">
                    Changes apply instantly to the output window.
                  </p>
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* ── Main Content ── */}
        <main className="flex-1 grid grid-rows-[1fr_2fr] gap-px bg-slate-800 overflow-hidden">

          {/* Transcription + Suggested */}
          <section className="bg-slate-950 p-5 flex flex-col overflow-hidden gap-3">
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest shrink-0">Live Transcription</h2>
            <div className="flex-1 overflow-y-auto text-xl font-light leading-snug text-slate-400 min-h-0">
              {transcript || <span className="text-slate-800 italic">Listening for audio feed...</span>}
            </div>

            {suggestedItem && (
              <div className="shrink-0 flex items-center gap-3 bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-slate-500 uppercase font-bold mb-0.5">Auto-detected</p>
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
                  <button onClick={() => setSuggestedItem(null)} className="text-[10px] text-slate-500 hover:text-slate-300 px-1 transition-all">✕</button>
                </div>
              </div>
            )}
          </section>

          {/* Dual Preview Area */}
          <section className="bg-slate-900 grid grid-cols-2 gap-px overflow-hidden relative">

            {/* Stage Preview */}
            <div className="bg-slate-950 p-5 flex flex-col overflow-hidden">
              <PreviewCard
                item={stagedItem}
                label="Stage Preview"
                accent="text-amber-500/50"
                badge={<span className="text-[10px] bg-amber-500/10 text-amber-500 px-2 py-0.5 rounded border border-amber-500/20">NEXT</span>}
                empty="Stage is empty"
              />
            </div>

            {/* GO LIVE button */}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20">
              <button
                onClick={goLive}
                disabled={!stagedItem}
                className="group relative w-20 h-20 bg-amber-500 hover:bg-amber-400 text-black rounded-full shadow-[0_0_30px_rgba(245,158,11,0.25)] flex flex-col items-center justify-center transition-all active:scale-95 disabled:grayscale disabled:opacity-40"
              >
                <span className="text-xl font-black">GO</span>
                <span className="text-[10px] font-bold">LIVE</span>
                {stagedItem && <div className="absolute inset-0 rounded-full animate-ping bg-amber-500 opacity-20 pointer-events-none" />}
              </button>
            </div>

            {/* Live Output + Next Verse strip */}
            <div className="bg-slate-950 p-5 flex flex-col overflow-hidden gap-2">
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
                    className="shrink-0 text-[9px] font-bold px-2 py-1 bg-amber-500/20 hover:bg-amber-500/40 text-amber-400 border border-amber-500/30 rounded transition-all whitespace-nowrap"
                  >
                    NEXT ▶
                  </button>
                </div>
              )}
            </div>
          </section>
        </main>
      </div>

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
