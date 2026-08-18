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
      const text = flattenTextContent(content);
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
      ctx.font = `${el.bold ? "700" : "400"} ${el.italic ? "italic" : "normal"} ${fontPx}px ${fontFamily}`;
      ctx.fillStyle = color;
      ctx.textAlign = (el.align ?? "left") === "center" ? "center" : (el.align ?? "left") === "right" ? "right" : "left";
      if (el.shadow !== false) {
        ctx.shadowColor = el.shadow_color || "rgba(0,0,0,0.6)";
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 2;
      }
      const maxWidth = w;
      const lineHeight = fontPx * 1.3;
      const lines = wrapText(ctx, text, maxWidth);
      const vAlign = el.v_align ?? "top";
      let ty = y;
      if (vAlign === "middle") ty = y + h / 2 - (lines.length * lineHeight) / 2;
      else if (vAlign === "bottom") ty = y + h - lines.length * lineHeight;
      const tx = el.align === "center" ? x + w / 2 : el.align === "right" ? x + w : x;
      lines.forEach((line, i) => {
        ctx.fillText(line, tx, ty + fontPx + i * lineHeight);
      });
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
  const t = lt.template;
  const data = lt.data;
  let headline = "";
  let subline = "";
  if (data.kind === "Nameplate") {
    headline = data.data.name;
    subline = data.data.title || "";
  } else if (data.kind === "Lyrics") {
    headline = data.data.line1;
    subline = data.data.line2 || "";
  } else if (!(data.kind === "FreeText" && t.scrollEnabled)) {
    headline = data.data.text;
  }

  if (!headline) return;

  const isFullWidth = (t.widthPct ?? 70) >= 100;
  const width = isFullWidth ? g.width : Math.max(10, Math.min(100, t.widthPct ?? 70)) * g.width / 100;
  const hAlign = t.hAlign ?? "left";
  const vAlign = t.vAlign ?? "bottom";
  const offX = (t.offsetX ?? 40) * scale;
  const offY = (t.offsetY ?? 40) * scale;

  let x: number;
  if (isFullWidth) x = 0;
  else if (hAlign === "left") x = offX;
  else if (hAlign === "right") x = g.width - width - offX;
  else x = (g.width - width) / 2 + offX;

  let y: number;
  if (vAlign === "top") y = offY;
  else if (vAlign === "bottom") y = g.height - offY;
  else y = g.height / 2 + offY;

  const padX = (t.paddingX ?? 24) * scale;
  const padY = (t.paddingY ?? 12) * scale;
  const radius = (t.borderRadius ?? 8) * scale;
  const primarySize = (t.primarySize ?? 32) * scale;
  const secondarySize = (t.secondarySize ?? 20) * scale;

  // Measure box height from content
  const boxH = padY * 2 + primarySize * 1.3 + (subline ? secondarySize * 1.2 : 0);
  const boxY = vAlign === "bottom" ? y - boxH : y;

  // Background
  if (t.bgType === "solid" || !t.bgType) {
    ctx.fillStyle = hexToRgba(t.bgColor ?? "#000000", (t.bgOpacity ?? 70) / 100);
  } else if (t.bgType === "gradient") {
    const grad = ctx.createLinearGradient(x, boxY, x + width, boxY + boxH);
    grad.addColorStop(0, hexToRgba(t.bgColor ?? "#000000", (t.bgOpacity ?? 70) / 100));
    grad.addColorStop(1, hexToRgba(t.bgGradientEnd ?? "#111111", (t.bgOpacity ?? 70) / 100));
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = "transparent";
  }
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, boxY, width, boxH, radius);
  else ctx.rect(x, boxY, width, boxH);
  ctx.fill();

  // Accent bar
  if (t.accentEnabled && t.accentSide) {
    const side = t.accentSide;
    const aw = (t.accentWidth ?? 6) * scale;
    ctx.fillStyle = t.accentColor ?? "#f59e0b";
    if (side === "left") ctx.fillRect(x, boxY, aw, boxH);
    else if (side === "right") ctx.fillRect(x + width - aw, boxY, aw, boxH);
    else if (side === "top") ctx.fillRect(x, boxY, width, aw);
    else ctx.fillRect(x, boxY + boxH - aw, width, aw);
  }

  // Text
  const textX = x + padX + (t.accentEnabled && t.accentSide === "left" ? (t.accentWidth ?? 6) * scale : 0);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const textY = boxY + padY + primarySize;
  ctx.font = `${t.primaryBold ? "700" : "400"} ${t.primaryItalic ? "italic" : "normal"} ${primarySize}px ${t.primaryFont ?? "Arial, sans-serif"}`;
  ctx.fillStyle = t.primaryColor ?? "#ffffff";
  if (t.textShadow) {
    ctx.shadowColor = t.textShadowColor ?? "rgba(0,0,0,0.5)";
    ctx.shadowBlur = (t.textShadowBlur ?? 4) * scale;
    ctx.shadowOffsetY = 2 * scale;
  }
  ctx.fillText(headline, textX, textY);
  if (subline) {
    ctx.shadowBlur = 0;
    ctx.font = `${t.secondaryBold ? "700" : "400"} ${t.secondaryItalic ? "italic" : "normal"} ${secondarySize}px ${t.secondaryFont ?? "Arial, sans-serif"}`;
    ctx.fillStyle = t.secondaryColor ?? "#dddddd";
    ctx.fillText(subline, textX, textY + primarySize * 0.6 + secondarySize);
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