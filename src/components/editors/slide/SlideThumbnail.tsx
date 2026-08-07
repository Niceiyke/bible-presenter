/**
 * SlideThumbnail — P4.6 offscreen canvas thumbnails.
 *
 * Replaces mounting a full-size `CustomSlideRenderer` (scaled via CSS
 * `scale`) for every slide in the rail. Each slide is rendered once into a
 * hidden off-screen host, serialized to a PNG data-URL by `html-to-image`
 * (which rasterizes DOM+SVG+images onto a canvas), and cached by slide ID.
 * Scrolling a large deck then recycles cached <img> tags — no live
 * ProseMirror / JSX re-render per row, and no 100 full renderers resident.
 *
 * Caching is module-level LRU (bounded to THUMB_CACHE_MAX) so thumbnails
 * survive a re-open of the editor within a window session but a huge deck
 * doesn't keep every slide resident after it scrolls away.
 */

import React, { useState, useEffect, useRef } from "react";
import { toPng } from "html-to-image";
import type { Options } from "html-to-image/lib/types";
import { CustomSlideRenderer } from "../../shared/Renderers";
import type { CustomSlide, SlideTheme } from "../../../types";

// Snapshot at 320×180 (16:9). Small enough to serialize fast, sharp enough
// for the ~0.07-scale rail thumbnail.
const THUMB_W = 320;
const THUMB_H = 180;
const THUMB_CACHE_MAX = 256;

const thumbCache = new Map<string, string>();

function cacheSet(id: string, url: string) {
  thumbCache.set(id, url);
  while (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value;
    if (oldest === undefined) break;
    thumbCache.delete(oldest);
  }
}

interface SlideThumbnailProps {
  slide: CustomSlide;
  appDataDir?: string | null;
  theme?: SlideTheme;
  className?: string;
  alt?: string;
  width: number;
  height: number;
}

export function SlideThumbnail({
  slide,
  appDataDir = null,
  theme,
  className,
  alt,
  width,
  height,
}: SlideThumbnailProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Start from cache so scrolling back doesn't re-snapshot.
  const [dataUrl, setDataUrl] = useState<string | null>(() => thumbCache.get(slide.id) ?? null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (dataUrl) { setReady(true); return; }
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;

    const opts: Options = {
      width: THUMB_W,
      height: THUMB_H,
      pixelRatio: 1,
      backgroundColor: "#000000",
      cacheBust: true,
    } as Options;

    // Wait two frames so the freshly-mounted hidden renderer paints (fonts,
    // images, ProseMirror HTML) before html-to-image clones the node.
    (async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r as any)));
      if (cancelled) return;
      try {
        const base64 = await toPng(host, opts);
        if (cancelled) return;
        cacheSet(slide.id, base64);
        setDataUrl(base64);
        setReady(true);
      } catch {
        // Leave the host visible content as a graceful fallback.
        setReady(true);
      }
    })();

    return () => { cancelled = true; };
  }, [dataUrl, slide.id]);

  // Hidden host the snapshotter reads. `aria-hidden` keeps it out of the
  // a11y tree; it's visually hidden but still laid out at real size so
  // html-to-image can measure it.
  const hiddenHost = !dataUrl ? (
    <div
      ref={hostRef}
      aria-hidden
      style={{ position: "absolute", left: -99999, top: 0, width: THUMB_W, height: THUMB_H, overflow: "hidden", background: "#000", pointerEvents: "none" }}
    >
      <CustomSlideRenderer slide={slide} scale={1} appDataDir={appDataDir} theme={theme} />
    </div>
  ) : null;

  if (!dataUrl) {
    // Snapshot-in-progress placeholder: a plain dark slot sized to the
    // thumbnail. Only the (once) hidden host renderer is mounted — we don't
    // mount a second live renderer here, so a scrolled rail never carries
    // many full-size renderers. The <img> replaces this once the PNG lands.
    return (
      <div className={className} style={{ width, height, background: "#0f0f1f" }} aria-hidden>
        {hiddenHost}
      </div>
    );
  }

  return (
    <img
      src={dataUrl}
      alt={alt}
      className={className}
      draggable={false}
      style={{ width, height, objectFit: "cover", display: "block" }}
    />
  );
}