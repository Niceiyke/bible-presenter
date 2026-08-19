import type {
  DisplayItem,
  PresentationSettings,
  ThemeColors,
  PropItem,
  SceneCompositionData,
  BackgroundSetting,
  LowerThirdPayload,
} from "../../types";
import { resolvePath } from "../../utils";
import type { ProgramFrame, LogoState } from "../../compositor/ProgramFrame";
import { getEffectiveBg } from "../../compositor/ProgramFrameResolver";
import { resolveLowerThird } from "../../compositor/LowerThirdResolver";
import type { LtStyleSlot } from "../../compositor/LowerThirdResolver";

/**
 * Canvas 2D program-feed renderer (Phase 2/3 of the output manager).
 *
 * Pure drawing helpers that rasterize a resolved `ProgramFrame` — backgrounds,
 * verses, media, cameras, timers, songs, custom slides, scene compositions,
 * props, logos, and lower thirds — onto a `CanvasRenderingContext2D`. The
 * window outputs keep their DOM path (which is authoritative for rich text +
 * animations); this module powers the offscreen compositor that recorder/
 * streamer surfaces capture from.
 *
 * The frame is produced by `ProgramFrameResolver.resolveProgramFrame`, so
 * every surface paints the same composition. Missing media (paths in
 * `CanvasResources.failedPaths`) paints a safe placeholder instead of a black
 * hole.
 *
 * Everything here is a pure function of the context + input data so it can
 * be unit-tested with a stub `CanvasRenderingContext2D`.
 */

export { getEffectiveBg };

/** A drawable media source: loaded image/video element or live stream. */
export type DrawableSource =
  | HTMLImageElement
  | HTMLVideoElement
  | CanvasImageSource;

/** Resources the renderer needs resolved ahead of time: media images/videos
 *  keyed by resolved path, camera streams keyed by device id. */
export interface CanvasResources {
  images?: Record<string, HTMLImageElement>;
  videos?: Record<string, HTMLVideoElement>;
  /** camera streams (native getUserMedia or relayed phone feed) by device id */
  cameraStreams?: Record<string, MediaStream>;
  /** video elements currently playing the camera streams, keyed by device id */
  cameraVideos?: Record<string, HTMLVideoElement>;
  /** app data dir for relative media path resolution */
  appDataDir?: string | null;
  /** resolved paths whose load failed; those media paint the safe missing
   *  placeholder instead of silently disappearing. */
  failedPaths?: string[];
}

export interface CanvasGeometry {
  width: number;
  height: number;
}

/** Resolve a stored (possibly relative) media path to the same absolute key
 *  the resource loader in `ProgramFeedCanvas` uses (`collectPaths` keys the
 *  loaded elements by `resolvePath(path, appDataDir)`). Backgrounds, props,
 *  logos, and slide media are persisted relativized, so lookups must resolve
 *  too or they miss the loaded element and paint only the fallback. */
export function resolveResPath(res: CanvasResources, path: string): string {
  return resolvePath(path, res.appDataDir ?? null);
}

/** True when a media path is known-failed and should paint the safe missing
 *  placeholder instead of a black hole. */
export function isMissingRes(res: CanvasResources, path?: string): boolean {
  if (!path || !res.failedPaths || res.failedPaths.length === 0) return false;
  return res.failedPaths.includes(resolveResPath(res, path));
}

/** Safe placeholder for missing/unloadable media: dark panel, diagonal
 *  stripes, and a "not available" glyph. Keeps the program clearly broken
 *  instead of silently showing nothing. */
export function drawMissingPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  ctx.save();
  ctx.fillStyle = "#0b0b0f";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = Math.max(2, Math.min(w, h) / 96);
  const step = Math.max(24, Math.min(w, h) / 5);
  ctx.beginPath();
  for (let sx = x - h; sx < x + w + h; sx += step) {
    ctx.moveTo(sx, y + h);
    ctx.lineTo(sx + h, y);
  }
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.max(16, Math.min(w, h) / 6)}px sans-serif`;
  ctx.fillText("✕", x + w / 2, y + h / 2);
  ctx.restore();
}

// ─── Color helpers ───────────────────────────────────────────────────────────

export function hexToRgba(hex: string, opacity: number): string {
  if (!hex || typeof hex !== "string" || !hex.startsWith("#")) {
    return `rgba(0,0,0,${Math.max(0, Math.min(1, opacity)).toFixed(3)})`;
  }
  const h = hex.replace("#", "");
  let r = 0, g = 0, b = 0;
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16) || 0;
    g = parseInt(h[1] + h[1], 16) || 0;
    b = parseInt(h[2] + h[2], 16) || 0;
  } else {
    r = parseInt(h.slice(0, 2), 16) || 0;
    g = parseInt(h.slice(2, 4), 16) || 0;
    b = parseInt(h.slice(4, 6), 16) || 0;
  }
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, opacity)).toFixed(3)})`;
}

export function mixHex(a: string, b: string, t: number): string {
  const pa = hexToRgba(a, 1);
  const pb = hexToRgba(b, 1);
  const ma = pa.match(/[\d.]+/g)!.map(Number);
  const mb = pb.match(/[\d.]+/g)!.map(Number);
  const r = Math.round(ma[0] + (mb[0] - ma[0]) * t);
  const g = Math.round(ma[1] + (mb[1] - ma[1]) * t);
  const bl = Math.round(ma[2] + (mb[2] - ma[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

// ─── Text helpers ────────────────────────────────────────────────────────────

/** Convert an authored pt size to canvas px at the given render scale.
 *  The DOM renderers set `fontSize: Npt` (browser = pt * 96/72 px); the
 *  compositor draws on a canvas sized to `geometry`, so the same typography
 *  multiplies by scale = height / reference_height. */
export function ptToPx(pt: number, scale: number): number {
  return (pt * 96) / 72 * scale;
}

export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const probe = current ? `${current} ${word}` : word;
    if (ctx.measureText(probe).width <= maxWidth || !current) {
      current = probe;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Draw text centered on a horizontal axis with a hard max-width wrap. */
export function drawWrappedTextCentered(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  startY: number,
  maxWidth: number,
  lineHeight: number
): number {
  const lines = wrapText(ctx, text, maxWidth);
  lines.forEach((line, i) => {
    const w = ctx.measureText(line).width;
    ctx.fillText(line, cx - w / 2, startY + i * lineHeight);
  });
  return lines.length * lineHeight;
}

// ─── Image helpers ───────────────────────────────────────────────────────────

function sourceSize(src: CanvasImageSource): { w: number; h: number } {
  let w = 0, h = 0;
  if (src instanceof HTMLVideoElement) {
    w = src.videoWidth || 0;
    h = src.videoHeight || 0;
  } else if (src instanceof HTMLImageElement) {
    w = src.naturalWidth || 0;
    h = src.naturalHeight || 0;
  } else {
    return { w: 1920, h: 1080 };
  }
  // Zero/non-finite dims would make the crop math produce a 0-wide source
  // rect, and real-canvas `drawImage` throws on that — which would kill the
  // capture loop. Fall back to a sane size instead.
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return { w: 1920, h: 1080 };
  }
  return { w, h };
}

/** object-fit: cover within a box. */
export function drawImageCover(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const s = sourceSize(src);
  const scale = Math.max(w / s.w, h / s.h);
  const sw = w / scale;
  const sh = h / scale;
  // Center the crop like CSS `object-fit: cover` — drawing from (0,0) would
  // show only the top-left corner of a mismatched-aspect source.
  const sx = (s.w - sw) / 2;
  const sy = (s.h - sh) / 2;
  ctx.drawImage(src as CanvasImageSource, sx, sy, sw, sh, x, y, w, h);
}

/** object-fit: contain within a box. */
export function drawImageContain(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const s = sourceSize(src);
  const scale = Math.min(w / s.w, h / s.h);
  const dw = s.w * scale;
  const dh = s.h * scale;
  ctx.drawImage(src as CanvasImageSource, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

export function drawMediaFit(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  x: number,
  y: number,
  w: number,
  h: number,
  fit: "cover" | "contain" | "fill"
): void {
  if (fit === "cover") drawImageCover(ctx, src, x, y, w, h);
  else if (fit === "contain") drawImageContain(ctx, src, x, y, w, h);
  else ctx.drawImage(src as CanvasImageSource, x, y, w, h);
}

// ─── Backgrounds ─────────────────────────────────────────────────────────────

export function drawBackgroundSetting(
  ctx: CanvasRenderingContext2D,
  bg: BackgroundSetting,
  g: CanvasGeometry,
  res: CanvasResources,
  fallbackColor: string
): void {
  switch (bg.type) {
    case "Color":
      ctx.fillStyle = bg.value;
      ctx.fillRect(0, 0, g.width, g.height);
      break;
    case "Image": {
      const img = res.images?.[resolveResPath(res, bg.value.path)];
      if (img) {
        ctx.save();
        ctx.globalAlpha = bg.value.opacity ?? 1;
        drawMediaFit(ctx, img, 0, 0, g.width, g.height, bg.value.objectFit);
        ctx.restore();
      } else {
        ctx.fillStyle = fallbackColor;
        ctx.fillRect(0, 0, g.width, g.height);
      }
      break;
    }
    case "Video": {
      const vid = res.videos?.[resolveResPath(res, bg.value.path)];
      if (vid && vid.readyState >= 2) {
        ctx.save();
        ctx.globalAlpha = bg.value.opacity ?? 1;
        drawMediaFit(ctx, vid, 0, 0, g.width, g.height, bg.value.objectFit);
        ctx.restore();
      } else {
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, g.width, g.height);
      }
      break;
    }
    case "Camera": {
      const stream = res.cameraStreams?.[bg.value.deviceId];
      const vid = bg.value.deviceId.startsWith("phone-camera-")
        ? res.cameraVideos?.[bg.value.deviceId]
        : (stream ? findOrCreateVideo(stream) : undefined);
      if (vid && vid.readyState >= 2) {
        if (bg.value.backdropColor) {
          ctx.fillStyle = bg.value.backdropColor;
          ctx.fillRect(0, 0, g.width, g.height);
        }
        ctx.save();
        ctx.globalAlpha = bg.value.opacity ?? 1;
        if (bg.value.mirrored) {
          ctx.translate(g.width, 0);
          ctx.scale(-1, 1);
          drawMediaFit(ctx, vid, 0, 0, g.width, g.height, bg.value.objectFit);
        } else {
          drawMediaFit(ctx, vid, 0, 0, g.width, g.height, bg.value.objectFit);
        }
        ctx.restore();
      } else {
        ctx.fillStyle = fallbackColor;
        ctx.fillRect(0, 0, g.width, g.height);
      }
      break;
    }
    default:
      ctx.fillStyle = fallbackColor;
      ctx.fillRect(0, 0, g.width, g.height);
  }
}

let videoCache = new WeakMap<MediaStream, HTMLVideoElement>();

/** Get (or lazily create) a muted looping video element playing a stream so
 *  `drawImage` has a ready frame. Only used when the caller didn't supply a
 *  pre-warmed `cameraVideos` entry. */
export function findOrCreateVideo(stream: MediaStream): HTMLVideoElement | undefined {
  if (typeof document === "undefined") return undefined;
  let vid = videoCache.get(stream);
  if (!vid) {
    vid = document.createElement("video");
    vid.muted = true;
    vid.playsInline = true;
    vid.srcObject = stream;
    vid.play().catch(() => {});
    videoCache.set(stream, vid);
  }
  return vid;
}

/** Collect every camera device id the current program frame draws — the
 *  effective background (which may be a camera), a live Camera item, or
 *  cameras pinned inside scene-composition zones. The compositor uses this
 *  to pre-open the needed streams before the draw pass. */
export function collectCameraDeviceIds(
  item: DisplayItem | null,
  settings: PresentationSettings
): string[] {
  const ids = new Set<string>();
  const bg = getEffectiveBg(settings, item);
  if (bg.type === "Camera" && bg.value.deviceId) ids.add(bg.value.deviceId);
  if (item?.type === "Camera" && item.data.deviceId) ids.add(item.data.deviceId);
  if (item?.type === "SceneComposition") {
    for (const zone of item.data.zones) {
      if (zone.item.type === "Camera" && zone.item.data.deviceId) ids.add(zone.item.data.deviceId);
    }
  }
  return [...ids];
}

// ─── Item renderers ──────────────────────────────────────────────────────────

export interface ItemRenderContext {
  settings: PresentationSettings;
  colors: ThemeColors;
  res: CanvasResources;
  scale: number;
  now: number;
  /** Per-zone typography override (Scene Builder). Wins over the song's own
   *  font and the global output settings for Verse/Song zone content. */
  font_size?: number;
  font_family?: string;
}

function drawVerse(ctx: CanvasRenderingContext2D, item: Extract<DisplayItem, { type: "Verse" }>, g: CanvasGeometry, rctx: ItemRenderContext): void {
  const s = rctx.settings;
  const scale = rctx.scale;
  const colors = rctx.colors;
  const isTop = s.reference_position === "top";
  const refColor = s.reference_color && s.reference_color !== "" ? s.reference_color : colors.referenceText;
  const refFontSize = ptToPx(s.reference_font_size ?? 36, scale);
  const refFontFamily = s.reference_font_family ?? "Arial, sans-serif";
  const cvFontSize = ptToPx(s.chapter_verse_font_size ?? (s.reference_font_size ?? 36), scale);
  const cvFontFamily = s.chapter_verse_font_family ?? refFontFamily;
  const cvColor = s.chapter_verse_color && s.chapter_verse_color !== "" ? s.chapter_verse_color : refColor;
  const vFontSize = ptToPx(s.version_font_size ?? Math.round((s.reference_font_size ?? 36) * 0.65), scale);
  const vFontFamily = s.version_font_family ?? refFontFamily;

  const verseFont = `${ptToPx(rctx.font_size ?? s.font_size, scale)}px ${rctx.font_family ?? s.verse_font_family ?? "Georgia, serif"}`;
  const padding = 64 * (g.height / (s.reference_output_height ?? 1080));
  const maxTextWidth = g.width - padding * 2;
  const refLineHeight = refFontSize * 1.25;

  // Build reference string
  const refParts: string[] = [];
  refParts.push(`${item.data.book} ${item.data.chapter}:${item.data.verse}`);
  if (item.data.version) refParts.push(`(${item.data.version})`);
  const refText = refParts.join(" ");

  ctx.save();
  ctx.fillStyle = colors.verseText;
  ctx.font = verseFont;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 16;

  const wrapLines = wrapText(ctx, item.data.text ?? "", maxTextWidth);
  const lineHeight = ptToPx(rctx.font_size ?? s.font_size, scale) * 1.25;
  const totalH = wrapLines.length * lineHeight;
  const refH = refLineHeight;
  const gap = lineHeight * 0.6;
  const contentH = totalH + gap + refH;

  let startY = (g.height - contentH) / 2 + refLineHeight;

  if (isTop) {
    // Reference above text
    ctx.font = `700 ${refFontSize}px ${refFontFamily}`;
    ctx.fillStyle = refColor;
    ctx.fillText(refText.toUpperCase(), g.width / 2, startY);
    startY += refLineHeight + gap;
    ctx.font = verseFont;
    ctx.fillStyle = colors.verseText;
    wrapLines.forEach((line, i) => {
      ctx.fillText(line, g.width / 2, startY + i * lineHeight);
    });
  } else {
    // Text then reference below
    ctx.font = verseFont;
    ctx.fillStyle = colors.verseText;
    wrapLines.forEach((line, i) => {
      ctx.fillText(line, g.width / 2, startY + i * lineHeight);
    });
    startY += totalH + gap;
    ctx.font = `700 ${refFontSize}px ${refFontFamily}`;
    ctx.fillStyle = refColor;
    ctx.fillText(refText.toUpperCase(), g.width / 2, startY);
  }

  // Split marker
  if (item.data.split_index !== undefined && item.data.total_splits !== undefined) {
    ctx.font = `700 ${ptToPx(12, scale)}px ${refFontFamily}`;
    ctx.fillStyle = hexToRgba(colors.verseText, 0.3);
    ctx.textAlign = "right";
    ctx.fillText(
      `PART ${item.data.split_index + 1} / ${item.data.total_splits}`,
      g.width - padding,
      g.height - padding / 2
    );
  }
  ctx.restore();
}

function drawCamera(ctx: CanvasRenderingContext2D, item: Extract<DisplayItem, { type: "Camera" }>, g: CanvasGeometry, rctx: ItemRenderContext, fit?: "cover" | "contain" | "fill"): void {
  const data = item.data;
  if (data.backdropColor) {
    ctx.fillStyle = data.backdropColor;
    ctx.fillRect(0, 0, g.width, g.height);
  }
  const stream = rctx.res.cameraStreams?.[data.deviceId];
  const vid = data.deviceId.startsWith("phone-camera-")
    ? rctx.res.cameraVideos?.[data.deviceId]
    : stream
      ? findOrCreateVideo(stream)
      : undefined;
  if (vid && vid.readyState >= 2) {
    ctx.save();
    ctx.globalAlpha = data.opacity ?? 1;
    const objectFit = (fit ?? data.objectFit ?? "cover") as "cover" | "contain" | "fill";
    if (data.mirrored) {
      ctx.translate(g.width, 0);
      ctx.scale(-1, 1);
      drawMediaFit(ctx, vid, 0, 0, g.width, g.height, objectFit);
    } else {
      drawMediaFit(ctx, vid, 0, 0, g.width, g.height, objectFit);
    }
    ctx.restore();
  }
}

function drawMedia(ctx: CanvasRenderingContext2D, item: Extract<DisplayItem, { type: "Media" }>, g: CanvasGeometry, rctx: ItemRenderContext, fit?: "cover" | "contain" | "fill"): void {
  const data = item.data;
  const mediaFit = (fit ?? data.fit_mode ?? "contain") as "cover" | "contain" | "fill";
  if (data.media_type === "Image") {
    const img = rctx.res.images?.[resolveResPath(rctx.res, data.path)];
    if (isMissingRes(rctx.res, data.path)) {
      drawMissingPanel(ctx, 0, 0, g.width, g.height);
    } else if (img) {
      drawMediaFit(ctx, img, 0, 0, g.width, g.height, mediaFit);
    } else {
      ctx.fillStyle = rctx.colors.background;
      ctx.fillRect(0, 0, g.width, g.height);
    }
  } else if (data.media_type === "Video") {
    const vid = rctx.res.videos?.[resolveResPath(rctx.res, data.path)];
    if (isMissingRes(rctx.res, data.path)) {
      drawMissingPanel(ctx, 0, 0, g.width, g.height);
    } else if (vid && vid.readyState >= 2) {
      drawMediaFit(ctx, vid, 0, 0, g.width, g.height, mediaFit);
    } else {
      ctx.fillStyle = rctx.colors.background;
      ctx.fillRect(0, 0, g.width, g.height);
    }
  } else {
    // Audio card
    const colors = rctx.colors;
    ctx.fillStyle = hexToRgba(colors.background, 0.4);
    const cx = g.width / 2;
    const cy = g.height / 2;
    const d = Math.min(g.width, g.height) * 0.22;
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(colors.referenceText, 0.4);
    ctx.lineWidth = 1;
    ctx.stroke();
    // Simple musical note glyph
    ctx.fillStyle = colors.referenceText;
    ctx.font = `${d * 0.5}px serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("♪", cx, cy);
    ctx.font = `${ptToPx(30, rctx.scale)}px sans-serif`;
    ctx.fillStyle = colors.verseText;
    ctx.fillText(data.name, cx, cy + d * 0.75);
    ctx.font = `${ptToPx(14, rctx.scale)}px sans-serif`;
    ctx.fillStyle = colors.referenceText;
    ctx.fillText("NOW PLAYING".toUpperCase(), cx, cy + d * 0.75 + ptToPx(30, rctx.scale));
  }
}

function drawTimer(ctx: CanvasRenderingContext2D, item: Extract<DisplayItem, { type: "Timer" }>, g: CanvasGeometry, rctx: ItemRenderContext): void {
  const data = item.data;
  let display = "--:--:--";
  let expired = false;
  let lastMinute = false;

  const tick = (now: number) => {
    if (data.timer_type === "clock") {
      const d = new Date(now);
      const h = d.getHours().toString().padStart(2, "0");
      const m = d.getMinutes().toString().padStart(2, "0");
      const s = d.getSeconds().toString().padStart(2, "0");
      display = `${h}:${m}:${s}`;
      return;
    }
    let totalSecs = 0;
    if (data.started_at == null) {
      totalSecs = data.timer_type === "countdown" && data.duration_secs != null ? data.duration_secs : 0;
    } else {
      const elapsed = Math.floor((now - data.started_at) / 1000);
      if (data.timer_type === "countdown") {
        const remaining = (data.duration_secs ?? 0) - elapsed;
        totalSecs = Math.max(0, remaining);
        expired = remaining <= 0;
        lastMinute = !expired && remaining <= 60;
      } else {
        totalSecs = elapsed;
      }
    }
    const hh = Math.floor(totalSecs / 3600);
    const mm = Math.floor((totalSecs % 3600) / 60);
    const ss = totalSecs % 60;
    display = hh > 0
      ? `${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`
      : `${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
  };
  tick(rctx.now);

  const fontPx = Math.min(g.height * 0.19, 200);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 32;
  ctx.font = `700 ${fontPx}px ui-monospace, monospace`;
  ctx.fillStyle = expired ? "#ef4444" : lastMinute ? "#f59e0b" : "#ffffff";
  ctx.fillText(display, g.width / 2, g.height / 2);
  ctx.restore();

  if (data.label) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = hexToRgba("#ffffff", 0.7);
    ctx.font = `${ptToPx(36, rctx.scale)}px sans-serif`;
    ctx.fillText(data.label.toUpperCase(), g.width / 2, g.height / 2 + fontPx * 0.8);
    ctx.restore();
  }
}

function drawSong(ctx: CanvasRenderingContext2D, item: Extract<DisplayItem, { type: "Song" }>, g: CanvasGeometry, rctx: ItemRenderContext): void {
  if (item.data.style !== "FullSlide" && item.data.style !== undefined) {
    return;
  }
  const data = item.data;
  const s = rctx.settings;
  const scale = rctx.scale;
  const finalFontSize = rctx.font_size ?? data.font_size ?? s.font_size;
  const finalFontFamily = rctx.font_family ?? data.font ?? s.verse_font_family ?? "Georgia, serif";
  const finalColor = data.color || rctx.colors.verseText;
  const fontWeight = data.font_weight || "normal";
  const showSectionLabel = !!s.show_song_section_labels;

  const lineFont = `${fontWeight} ${ptToPx(finalFontSize * 0.85, scale)}px ${finalFontFamily}`;
  const lineHeight = ptToPx(finalFontSize * 0.85, scale) * 1.25;
  const padding = g.width * 0.08;
  const maxWidth = g.width - padding * 2;

  const lines = data.lines ?? [];
  const lineCount = lines.length;
  let y = (g.height - (lineCount * lineHeight)) / 2;
  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = finalColor;
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 16;

  if (showSectionLabel && data.section_label) {
    const labelFont = `${ptToPx(18, scale)}px ${finalFontFamily}`;
    ctx.font = labelFont;
    ctx.fillStyle = hexToRgba("#f59e0b", 0.5);
    y -= ptToPx(18, scale) * 1.5;
    ctx.fillText(data.section_label.toUpperCase(), g.width / 2, y);
    y += ptToPx(18, scale) * 1.5 + ptToPx(18, scale) * 0.5;
  }

  ctx.font = lineFont;
  lines.forEach((line, i) => {
    ctx.fillText(line, g.width / 2, y + i * lineHeight);
  });

  if ((data.total_slides ?? 1) - 1 === data.slide_index && data.author) {
    ctx.font = `${ptToPx(16, scale)}px ${finalFontFamily}`;
    ctx.fillStyle = hexToRgba("#ffffff", 0.3);
    ctx.fillText(`— ${data.author}`, g.width / 2, y + data.lines.length * lineHeight + ptToPx(24, scale));
  }
  ctx.restore();
}

function drawCustomSlide(ctx: CanvasRenderingContext2D, item: Extract<DisplayItem, { type: "CustomSlide" }>, g: CanvasGeometry, rctx: ItemRenderContext): void {
  const data = item.data;
  const scale = rctx.scale;
  // Background
  const bg = data.background;
  if (bg.type === "color") {
    ctx.fillStyle = bg.value;
    ctx.fillRect(0, 0, g.width, g.height);
  } else if (bg.type === "gradient") {
    const angle = (bg.angle ?? 0) * (Math.PI / 180);
    const grad = ctx.createLinearGradient(
      g.width / 2 - Math.cos(angle) * g.width,
      g.height / 2 - Math.sin(angle) * g.height,
      g.width / 2 + Math.cos(angle) * g.width,
      g.height / 2 + Math.sin(angle) * g.height
    );
    grad.addColorStop(0, bg.from);
    grad.addColorStop(1, bg.to);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, g.width, g.height);
  } else if (bg.type === "image") {
    const img = rctx.res.images?.[resolveResPath(rctx.res, bg.value)];
    if (isMissingRes(rctx.res, bg.value)) {
      drawMissingPanel(ctx, 0, 0, g.width, g.height);
    } else if (img) {
      ctx.save();
      ctx.globalAlpha = bg.opacity ?? 1;
      drawMediaFit(ctx, img, 0, 0, g.width, g.height, bg.objectFit ?? "cover");
      ctx.restore();
    } else {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, g.width, g.height);
    }
  } else if (bg.type === "video") {
    const vid = rctx.res.videos?.[resolveResPath(rctx.res, bg.value)];
    if (isMissingRes(rctx.res, bg.value)) {
      drawMissingPanel(ctx, 0, 0, g.width, g.height);
    } else if (vid && vid.readyState >= 2) {
      ctx.save();
      ctx.globalAlpha = bg.opacity ?? 1;
      drawMediaFit(ctx, vid, 0, 0, g.width, g.height, bg.objectFit ?? "cover");
      ctx.restore();
    } else {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, g.width, g.height);
    }
  } else {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, g.width, g.height);
  }

  const elements = (data.elements ?? []).slice().sort((a, b) => a.z_index - b.z_index);
  for (const el of elements) {
    if (el.hidden) continue;
    const x = (el.x / 100) * g.width;
    const y = (el.y / 100) * g.height;
    const w = (el.w / 100) * g.width;
    const h = (el.h / 100) * g.height;
    ctx.save();
    ctx.globalAlpha = el.opacity ?? 1;
    if (el.rotation) {
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate((el.rotation * Math.PI) / 180);
      ctx.translate(-(x + w / 2), -(y + h / 2));
    }
    if (el.flipX) {
      ctx.translate(x + w, 0);
      ctx.scale(-1, 1);
    }
    if (el.flipY) {
      ctx.translate(0, y + h);
      ctx.scale(1, -1);
    }

    if (el.kind === "text") {
      const content = el.content;
      const fontSize = el.font_size === "inherit" || !el.font_size
        ? (data.theme?.defaultFontSize ?? 48)
        : el.font_size;
      const fontFamily = el.font_family === "inherit" || !el.font_family
        ? (data.theme?.defaultFontFamily ?? "Georgia, serif")
        : el.font_family;
      const color = el.color === "inherit" || !el.color
        ? (data.theme?.textColor ?? "#ffffff")
        : el.color;
      const fontPx = ptToPx(fontSize, scale);
      const fontBase = `${fontPx}px ${fontFamily}`;
      const maxWidth = w;
      const lineHeight = fontPx * 1.3;
      const tx = el.align === "center" ? x + w / 2 : el.align === "right" ? x + w : x;

      // WP7 (P2-1): when the text carries inline styling (bold/italic/underline/
      // per-run color), render the supported rich-text subset; otherwise keep
      // the deterministic plain-text approximation.
      const richGroups = proseToRuns(content);
      const hasRich = !!richGroups?.some((g) => g.some((r) => r.bold || r.italic || r.underline || r.color));
      if (hasRich && richGroups) {
        const totalLines = richGroups.reduce((acc, g) => acc + wrapCount(ctx, g, maxWidth, fontBase), 0);
        let ty = y;
        const vAlign = el.v_align ?? "top";
        if (vAlign === "middle") ty = y + h / 2 - (totalLines * lineHeight) / 2;
        else if (vAlign === "bottom") ty = y + h - totalLines * lineHeight;
        ctx.save();
        if (el.shadow !== false) {
          ctx.shadowColor = el.shadow_color || "rgba(0,0,0,0.6)";
          ctx.shadowBlur = 8;
          ctx.shadowOffsetY = 2;
        }
        ctx.textBaseline = "alphabetic";
        for (const group of richGroups) {
          const n = drawRichParagraph(ctx, group, tx, ty + fontPx, maxWidth, lineHeight, fontBase, el.align === "center" ? "center" : el.align === "right" ? "right" : "left", tx);
          ty += n * lineHeight;
        }
        ctx.restore();
      } else {
        const text = flattenTextContent(content);
        ctx.font = `${el.bold ? "700" : "400"} ${el.italic ? "italic" : "normal"} ${fontBase}`;
        ctx.fillStyle = color;
        ctx.textAlign = (el.align ?? "left") === "center" ? "center" : (el.align ?? "left") === "right" ? "right" : "left";
        if (el.shadow !== false) {
          ctx.shadowColor = el.shadow_color || "rgba(0,0,0,0.6)";
          ctx.shadowBlur = 8;
          ctx.shadowOffsetY = 2;
        }
        const lines = wrapText(ctx, text, maxWidth);
        const vAlign = el.v_align ?? "top";
        let ty = y;
        if (vAlign === "middle") ty = y + h / 2 - (lines.length * lineHeight) / 2;
        else if (vAlign === "bottom") ty = y + h - lines.length * lineHeight;
        lines.forEach((line, i) => {
          ctx.fillText(line, tx, ty + fontPx + i * lineHeight);
        });
      }
    } else if (el.kind === "image") {
      const img = rctx.res.images?.[resolveResPath(rctx.res, el.content)];
      if (isMissingRes(rctx.res, el.content)) {
        drawMissingPanel(ctx, x, y, w, h);
      } else if (img) {
        drawMediaFit(ctx, img, x, y, w, h, el.objectFit ?? "contain");
      }
    } else if (el.kind === "video") {
      const vid = rctx.res.videos?.[resolveResPath(rctx.res, el.content)];
      if (isMissingRes(rctx.res, el.content)) {
        drawMissingPanel(ctx, x, y, w, h);
      } else if (vid && vid.readyState >= 2) {
        drawMediaFit(ctx, vid, x, y, w, h, el.objectFit ?? "contain");
      }
    } else if (el.kind === "shape") {
      const shape = el.shape ?? "rect";
      const fill = el.fillColor ?? el.color ?? "#ffffff";
      const stroke = el.strokeColor ?? "none";
      const sw = (el.strokeWidth ?? 0) / 10.8;
      ctx.beginPath();
      if (shape === "circle") {
        ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
      } else if (shape === "triangle") {
        ctx.moveTo(x + w / 2, y);
        ctx.lineTo(x + w, y + h);
        ctx.lineTo(x, y + h);
        ctx.closePath();
      } else {
        // rect / rounded
        const rx = shape === "rounded" ? Math.max(0, el.borderRadius ?? 12) * (g.height / 1080) : 0;
        if (rx > 0) {
          ctx.roundRect ? ctx.roundRect(x, y, w, h, rx) : ctx.rect(x, y, w, h);
        } else {
          ctx.rect(x, y, w, h);
        }
      }
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke !== "none") {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = sw * (g.height / 1080);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

function drawSceneComposition(ctx: CanvasRenderingContext2D, item: Extract<DisplayItem, { type: "SceneComposition" }>, g: CanvasGeometry, rctx: ItemRenderContext, depth = 0): void {
  const data: SceneCompositionData = item.data;
  const zones = data.zones.slice().sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  for (const zone of zones) {
    const x = zone.x * g.width;
    const y = zone.y * g.height;
    const w = zone.w * g.width;
    const h = zone.h * g.height;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    // Shift the origin to the zone's top-left corner. Zone renderers draw
    // relative to `(0,0)` (they get `zoneG = { width: w, height: h }`), so
    // without this every zone paints in the canvas's top-left and the clip
    // hides everything that falls outside its rect — only a zone at (0,0)
    // ever appeared.
    ctx.translate(x, y);
    ctx.globalAlpha = zone.opacity ?? 1;
    const zoneG = { width: w, height: h };
    const zoneRctx: ItemRenderContext = {
      ...rctx,
      scale: h / (rctx.settings.reference_output_height ?? 1080),
      font_size: zone.font_size,
      font_family: zone.font_family,
    };
    // The zone's effective background (song/bible/media override) paints
    // behind its content — mirroring the single-item output path, where the
    // content override background is drawn under the live item.
    try {
      const zoneBg = getEffectiveBg(rctx.settings, zone.item);
      drawBackgroundSetting(ctx, zoneBg, zoneG, rctx.res, rctx.colors.background);
      drawItemCanvas(ctx, zone.item, zoneG, zoneRctx, zone.fit, zone.muted, depth);
    } catch (err) {
      // A bad zone must never stop the remaining zones (or the whole frame).
      console.warn("[compositor] zone draw error:", zone.id, err);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }
}

/** Draw a display item to a canvas context (dispatch). */
export function drawItemCanvas(
  ctx: CanvasRenderingContext2D,
  item: DisplayItem,
  g: CanvasGeometry,
  rctx: ItemRenderContext,
  fit?: "cover" | "contain" | "fill",
  muted?: boolean,
  depth = 0
): void {
  if (depth > 4) {
    // Recursion guard for nested scene compositions (flattened at build time).
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, g.width, g.height);
    return;
  }
  switch (item.type) {
    case "Verse":
      drawVerse(ctx, item, g, rctx);
      break;
    case "Camera":
      drawCamera(ctx, item, g, rctx, fit);
      break;
    case "Media":
      drawMedia(ctx, item, g, rctx, fit);
      break;
    case "Timer":
      drawTimer(ctx, item, g, rctx);
      break;
    case "Song":
      drawSong(ctx, item, g, rctx);
      break;
    case "CustomSlide":
      drawCustomSlide(ctx, item, g, rctx);
      break;
    case "SceneComposition":
      drawSceneComposition(ctx, item, g, rctx, depth + 1);
      break;
  }
}

/** Flatten ProseMirror JSON content to plain text lines (paragraph-aware). */
export function flattenTextContent(content: unknown): string {
  if (typeof content === "string") {
    // Legacy HTML bridge — strip tags for canvas approximation.
    return content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  if (!content || typeof content !== "object" || !Array.isArray((content as any).content)) {
    return "";
  }
  const lines: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.text === "string") {
      lines.push(node.text);
      return;
    }
    if (Array.isArray(node.content)) {
      node.content.forEach(walk);
    }
    if (node.type === "paragraph") lines.push("");
  };
  walk(content);
  return lines.join("\n").replace(/\n{2,}/g, "\n").trim();
}

// ─── WP7 (P2-1): supported rich-text subset ──────────────────────────────────
//
// The canvas compositor intentionally approximates rich text. To keep projection
// (DOM, authoritative) and recording/streaming (canvas) from disagreeing for
// normal church slides, we support a small, deterministic subset and fall back
// to plain text for anything else:
//   - alignment, font family/weight, italic, underline, color (per run),
//   - paragraph-aware wrapping, vertical alignment,
//   - explicit plain-text fallback for unsupported nodes (links, highlights,
//     embedded media, unknown marks). We never silently render a different
//     animation/style in the canvas than the DOM shows.

/** One styled text run (a ProseMirror text node + its marks). */
export interface RichTextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
}

/**
 * Parse ProseMirror JSON into paragraph groups of styled runs. Any node/mark we
 * do not model (embedded media, links, highlights, unknown marks) degrades to
 * its plain text so a recording never silently omits or restyles content the
 * projection shows. Returns null for non-ProseMirror input (legacy HTML string
 * or empty) so callers fall back to the plain-text path.
 */
export function proseToRuns(content: unknown): RichTextRun[][] | null {
  if (typeof content === "string" || !content || typeof content !== "object") return null;
  const root = content as any;
  if (!Array.isArray(root.content)) return null;

  const paragraphs: RichTextRun[][] = [];
  let current: RichTextRun[] = [];

  const marksOf = (node: any): { bold?: boolean; italic?: boolean; underline?: boolean; color?: string } => {
    const out: { bold?: boolean; italic?: boolean; underline?: boolean; color?: string } = {};
    for (const m of node.marks ?? []) {
      if (m?.type === "bold") out.bold = true;
      else if (m?.type === "italic") out.italic = true;
      else if (m?.type === "underline") out.underline = true;
      else if (m?.type === "textStyle" && m?.attrs?.color) out.color = m.attrs.color;
      // Unsupported marks (link/highlight/unknown) are ignored — text still renders.
    }
    return out;
  };

  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.text === "string") {
      const marks = marksOf(node);
      const t = node.text;
      // Preserve leading/trailing spaces within a run so wrapping stays exact.
      const existing = current[current.length - 1];
      const sameStyle =
        existing &&
        !!existing.bold === !!marks.bold &&
        !!existing.italic === !!marks.italic &&
        !!existing.underline === !!marks.underline &&
        existing.color === marks.color;
      if (sameStyle) {
        existing.text += t;
      } else {
        current.push({ text: t, ...marks });
      }
      return;
    }
    if (node.type === "hardBreak") {
      current.push({ text: " " });
      return;
    }
    if (Array.isArray(node.content)) {
      node.content.forEach(walk);
    }
    if (node.type === "paragraph") {
      paragraphs.push(current);
      current = [];
    }
  };
  walk(root);
  if (current.length) paragraphs.push(current);

  const normalized = paragraphs.filter((p) => p.some((r) => r.text.length > 0));
  return normalized.length ? normalized : null;
}

/**
 * Wrap runs into visual lines (word-aware) and draw them with per-run styling.
 * Returns the number of lines drawn. Honors underline (the subset the DOM
 * projection also renders); unsupported styling falls back to the run's plain
 * weight/color.
 */
export function drawRichParagraph(
  ctx: CanvasRenderingContext2D,
  runs: RichTextRun[],
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  fontBase: string,
  align: "left" | "center" | "right",
  textAlignX: number
): number {
  const applyFont = (run: RichTextRun) => {
    ctx.font = `${run.bold ? "700" : "400"} ${run.italic ? "italic" : "normal"} ${fontBase}`;
  };
  const measure = (run: RichTextRun) => {
    applyFont(run);
    return ctx.measureText(run.text).width;
  };

  // Tokenize into words, keeping each word's run (and the following space) so
  // wrapping and inter-run styling survive line breaks.
  const tokens: { run: RichTextRun; word: string }[] = [];
  for (const run of runs) {
    const parts = run.text.split(/(\s+)/).filter((p) => p.length > 0);
    for (const part of parts) {
      if (/\s+/.test(part)) {
        const prev = tokens[tokens.length - 1];
        if (prev && prev.run === run) prev.word += part;
        else tokens.push({ run, word: part });
      } else {
        tokens.push({ run, word: part });
      }
    }
  }
  if (tokens.length === 0) return 0;

  const lines: { run: RichTextRun; word: string }[][] = [];
  let line: { run: RichTextRun; word: string }[] = [];
  let lineWidth = 0;
  for (const tok of tokens) {
    const w = measure(tok.run) * (tok.word.trim().length / Math.max(1, tok.word.length));
    const sep = lineWidth > 0 ? measure({ text: " " } as RichTextRun) : 0;
    if (lineWidth > 0 && lineWidth + sep + w > maxWidth) {
      lines.push(line);
      line = [];
      lineWidth = 0;
    }
    line.push(tok);
    lineWidth += (lineWidth > 0 ? sep : 0) + w;
  }
  if (line.length) lines.push(line);

  lines.forEach((ln, i) => {
    const baseline = y + i * lineHeight;
    let lx = x;
    if (align !== "left") {
      const total = ln.reduce((acc, t) => acc + measure(t.run), 0);
      lx = align === "center" ? textAlignX - total / 2 : textAlignX - total;
    }
    for (const t of ln) {
      applyFont(t.run);
      ctx.fillStyle = t.run.color ?? ctx.fillStyle;
      ctx.fillText(t.word, lx, baseline);
      if (t.run.underline) {
        const uw = measure(t.run);
        const th = Math.max(1, (parseFloat(fontBase) || 16) / 16);
        ctx.fillRect(lx, baseline + th * 0.8, uw, th * 0.12);
      }
      lx += measure(t.run);
    }
  });
  return lines.length;
}

/**
 * Count how many wrapped lines a run group occupies at a maxWidth — used to
 * compute vertical centering before drawing. Mirrors the tokenization in
 * `drawRichParagraph` so the count matches the draw.
 */
export function wrapCount(
  ctx: CanvasRenderingContext2D,
  runs: RichTextRun[],
  maxWidth: number,
  fontBase: string
): number {
  const applyFont = (run: RichTextRun) => {
    ctx.font = `${run.bold ? "700" : "400"} ${run.italic ? "italic" : "normal"} ${fontBase}`;
  };
  const measure = (run: RichTextRun) => {
    applyFont(run);
    return ctx.measureText(run.text).width;
  };
  const tokens: { run: RichTextRun; word: string }[] = [];
  for (const run of runs) {
    for (const part of run.text.split(/(\s+)/).filter((p) => p.length > 0)) {
      tokens.push({ run, word: part });
    }
  }
  let lines = 1;
  let width = 0;
  for (const tok of tokens) {
    const w = measure(tok.run) * (tok.word.trim().length / Math.max(1, tok.word.length));
    const sep = width > 0 ? measure({ text: " " } as RichTextRun) : 0;
    if (width > 0 && width + sep + w > maxWidth) {
      lines += 1;
      width = 0;
    }
    width += (width > 0 ? sep : 0) + w;
  }
  return lines;
}

// ─── Overlays ─────────────────────────────────────────────────────────────────

export function drawProps(ctx: CanvasRenderingContext2D, items: PropItem[], g: CanvasGeometry, res: CanvasResources): void {
  for (const p of items.filter((p) => p.visible)) {
    const x = (p.x / 100) * g.width;
    const y = (p.y / 100) * g.height;
    const w = (p.w / 100) * g.width;
    const h = (p.h / 100) * g.height;
    ctx.save();
    ctx.globalAlpha = p.opacity;
    if (p.kind === "image" && p.path) {
      if (isMissingRes(res, p.path)) {
        drawMissingPanel(ctx, x, y, w, h);
      } else {
        const img = res.images?.[resolveResPath(res, p.path)];
        if (img) drawImageContain(ctx, img, x, y, w, h);
      }
    } else if (p.kind === "clock") {
      const now = new Date();
      const fmt = p.text ?? "HH:mm:ss";
      const pad = (n: number) => String(n).padStart(2, "0");
      const hh = pad(now.getHours());
      const h12 = pad(now.getHours() % 12 || 12);
      const mm = pad(now.getMinutes());
      const ss = pad(now.getSeconds());
      const ampm = now.getHours() < 12 ? "AM" : "PM";
      const display = fmt
        .replace("HH", hh)
        .replace("hh", h12)
        .replace("mm", mm)
        .replace("ss", ss)
        .replace("a", ampm);
      ctx.fillStyle = p.color ?? "#ffffff";
      ctx.font = `700 ${Math.min(h * 0.3, w * 0.2)}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(display, x + w / 2, y + h / 2);
    }
    ctx.restore();
  }
}

export function drawLogo(ctx: CanvasRenderingContext2D, state: LogoState, g: CanvasGeometry, res: CanvasResources): void {
  if (state.text) {
    ctx.save();
    ctx.fillStyle = state.textColor ?? "#ffffff";
    ctx.globalAlpha = state.opacity;
    ctx.font = `900 ${ptToPx(24, 1)}px sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(state.text, g.width - 32, g.height - 32);
    ctx.restore();
  } else if (state.path) {
    const logoPath = resolveResPath(res, state.path);
    const img = res.images?.[logoPath];
    const vid = res.videos?.[logoPath];
    if (isMissingRes(res, state.path)) {
      const size = Math.min(g.width, g.height) * 0.12;
      drawMissingPanel(ctx, g.width - 32 - size, g.height - 32 - size, size, size);
    } else if (img) {
      ctx.save();
      ctx.globalAlpha = state.opacity;
      const size = Math.min(g.width, g.height) * 0.12;
      drawImageContain(ctx, img, g.width - 32 - size, g.height - 32 - size, size, size);
      ctx.restore();
    } else if (vid && vid.readyState >= 2) {
      ctx.save();
      ctx.globalAlpha = state.opacity;
      const size = Math.min(g.width, g.height) * 0.12;
      drawImageContain(ctx, vid, g.width - 32 - size, g.height - 32 - size, size, size);
      ctx.restore();
    }
  }
}

export function drawLowerThird(ctx: CanvasRenderingContext2D, lt: LowerThirdPayload, g: CanvasGeometry, scale: number): void {
  const layout = resolveLowerThird(lt);
  const { content, slots, background, accent, border, boxShadow, textShadow, outline, geometry } = layout;

  if (!slots.showHeadline && !slots.showSubline && !slots.showKicker) return;

  const isFullWidth = geometry.isFullWidth;
  const width = isFullWidth ? g.width : Math.max(10, Math.min(100, geometry.widthPct)) * g.width / 100;
  const hAlign = geometry.hAlign;
  const vAlign = geometry.vAlign;
  const offX = geometry.offsetX * scale;
  const offY = geometry.offsetY * scale;

  let x: number;
  if (isFullWidth) x = 0;
  else if (hAlign === "left") x = offX;
  else if (hAlign === "right") x = g.width - width - offX;
  else x = (g.width - width) / 2 + offX;

  let y: number;
  if (vAlign === "top") y = offY;
  else if (vAlign === "bottom") y = g.height - offY;
  else y = g.height / 2 + offY;

  const padX = geometry.paddingX * scale;
  const padY = geometry.paddingY * scale;
  const radius = geometry.borderRadius * scale;
  const headlineSize = slots.showHeadline ? slots.headline.size * scale : 0;
  const sublineSize = slots.showSubline ? slots.subline.size * scale : 0;
  const kickerSize = slots.showKicker ? slots.kicker.size * scale : 0;

  // Measure box height from the resolved slot sizes.
  const boxH = padY * 2 + (kickerSize ? kickerSize * 1.2 : 0) + (headlineSize ? headlineSize * 1.3 : 0) + (sublineSize ? sublineSize * 1.2 : 0);
  const boxY = vAlign === "bottom" ? y - boxH : y;

  const bgAlpha = background.opacity / 100;
  const bgFill = () => {
    if (background.type === "solid") {
      ctx.fillStyle = hexToRgba(background.color, bgAlpha);
    } else if (background.type === "gradient") {
      const grad = ctx.createLinearGradient(x, boxY, x + width, boxY + boxH);
      grad.addColorStop(0, hexToRgba(background.color, bgAlpha));
      grad.addColorStop(1, hexToRgba(background.gradientEnd, bgAlpha));
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = "transparent";
    }
  };

  // Soft drop shadow under the box (boxShadow token).
  if (boxShadow.enabled) {
    ctx.save();
    ctx.shadowColor = boxShadow.color;
    ctx.shadowBlur = boxShadow.blur * scale;
    ctx.shadowOffsetY = 4 * scale;
    bgFill();
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(x, boxY, width, boxH, radius);
    else ctx.rect(x, boxY, width, boxH);
    ctx.fill();
    ctx.restore();
  }

  bgFill();
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, boxY, width, boxH, radius);
  else ctx.rect(x, boxY, width, boxH);
  ctx.fill();

  // Border.
  if (border.enabled) {
    ctx.strokeStyle = border.color;
    ctx.lineWidth = border.width * scale;
    ctx.stroke();
  }

  // Accent bar.
  if (accent.enabled) {
    const side = accent.side;
    const aw = accent.width * scale;
    ctx.fillStyle = accent.color;
    if (side === "left") ctx.fillRect(x, boxY, aw, boxH);
    else if (side === "right") ctx.fillRect(x + width - aw, boxY, aw, boxH);
    else if (side === "top") ctx.fillRect(x, boxY, width, aw);
    else ctx.fillRect(x, boxY + boxH - aw, width, aw);
  }

  // Text.
  const textX = x + padX + (accent.enabled && accent.side === "left" ? accent.width * scale : 0);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  let textY = boxY + padY + headlineSize * 1.3;

  const setFont = (slot: LtStyleSlot, size: number) => {
    ctx.font = `${slot.bold ? "700" : "400"} ${slot.italic ? "italic" : "normal"} ${size}px ${slot.font}`;
    ctx.fillStyle = slot.color;
  };
  const paint = (text: string, xp: number, yp: number) => {
    if (textShadow.enabled) {
      ctx.shadowColor = textShadow.color;
      ctx.shadowBlur = textShadow.blur * scale;
      ctx.shadowOffsetY = 2 * scale;
    }
    if (outline.enabled) {
      ctx.strokeStyle = outline.color;
      ctx.lineWidth = outline.width * scale;
      ctx.strokeText(text, xp, yp);
    }
    ctx.fillText(text, xp, yp);
    ctx.shadowBlur = 0;
  };

  if (slots.showKicker) {
    setFont(slots.kicker, kickerSize);
    paint(slots.kicker.uppercase ? content.kicker.toUpperCase() : content.kicker, textX, textY);
    textY += kickerSize * 1.2;
  }
  if (slots.showHeadline) {
    setFont(slots.headline, headlineSize);
    paint(slots.headline.uppercase ? content.headline.toUpperCase() : content.headline, textX, textY);
    textY += headlineSize * 0.6;
  }
  if (slots.showSubline) {
    textY += sublineSize;
    setFont(slots.subline, sublineSize);
    paint(slots.subline.uppercase ? content.subline.toUpperCase() : content.subline, textX, textY);
  }
  ctx.shadowBlur = 0;
}

// ─── Main entry ──────────────────────────────────────────────────────────────

/** Draw one fully-resolved program frame onto a context sized `frame.canvas`.
 *  The frame is produced by `resolveProgramFrame`, so every output paints the
 *  same composition. The canvas geometry passed by the capture loop may differ
 *  from the frame's nominal canvas (surface rescale); painting scales by
 *  `height / reference_output_height` as the DOM renderers do. */
export function drawProgramFrame(
  ctx: CanvasRenderingContext2D,
  frame: ProgramFrame,
  res: CanvasResources = {}
): void {
  const g: CanvasGeometry = { width: frame.canvas.width, height: frame.canvas.height };
  const settings = frame.settings;
  const colors = frame.colors;
  const now = frame.now;
  const scale = g.height / (frame.reference_output_height ?? 1080);
  const rctx: ItemRenderContext = { settings, colors, res, scale, now };

  // Blackout / blank source — pure black, nothing else.
  if (frame.blackout) {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, g.width, g.height);
    return;
  }

  // Background (already resolved: output override or content-type effective
  // setting for the source item).
  drawBackgroundSetting(ctx, frame.background.setting, g, res, frame.background.fallback);

  // Content
  const item = frame.source.kind === "blank" ? null : frame.source.item;
  if (item) {
    drawItemCanvas(ctx, item, g, rctx);
  } else {
    ctx.save();
    ctx.fillStyle = colors.waitingText;
    ctx.font = `italic 600 ${ptToPx(24, scale)}px Georgia, serif`;
    ctx.textAlign = "center";
    ctx.fillText("Waiting for projection...", g.width / 2, g.height / 2);
    ctx.restore();
  }

  // Overlays (already masked by the output config in the resolver)
  if (frame.overlays.logo) drawLogo(ctx, frame.overlays.logo, g, res);
  if (frame.overlays.props.length) drawProps(ctx, frame.overlays.props, g, res);
  if (frame.overlays.lower_third) drawLowerThird(ctx, frame.overlays.lower_third, g, scale);
}