import React, { useRef, useEffect, useState, useMemo, useLayoutEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolvePath, getTransitionVariants } from "../../utils";
import { sanitizeSlideHtml } from "../../utils/sanitize";
import { useAppStore } from "../../store";
import { useReferenceHeight } from "../../hooks/useReferenceHeight";
import {
  CustomSlide,
  CustomSlideDisplayData,
  DisplayItem,
  LowerThirdData,
  LowerThirdTemplate,
  TimerData,
  PropItem,
  SongSlideData,
  PresentationSettings,
  SlideElement,
  SlideBackground,
  SlideTheme,
  TextElement,
} from "../../types";
import { renderDocToHtml, isJsonContent } from "../editors/slide/slideTextExtensions";
import { ptToScaleHtml } from "../editors/slide/textStyleSystem";
import { resolveElementTextStyle } from "../editors/slide/textStyleSystem";
import { useAutoSizeText, resolveAutoSizeInputs } from "./useAutoSizeText";
import { useSlideFit } from "../../hooks/useSlideFit";
import { resolveLowerThird } from "../../compositor/LowerThirdResolver";
import type { LtStyleSlot } from "../../compositor/LowerThirdResolver";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function hexToRgba(hex: string, opacity: number): string {
  if (!hex || typeof hex !== "string" || !hex.startsWith("#")) {
    return `rgba(0,0,0,${((opacity ?? 100) / 100).toFixed(2)})`;
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
  return `rgba(${r},${g},${b},${((opacity ?? 100) / 100).toFixed(2)})`;
}

// ─── Custom Slide Renderer ───────────────────────────────────────────────────

/**
 * Resolve a `SlideBackground` discriminated union into a CSS style object
 * for the container div. Video backgrounds return an empty style — the
 * `<video>` element rendered separately covers the slide. Image
 * backgrounds optionally respect an `objectFit` override (Phase 2.1
 * added the field; defaults to `cover` for back-compat with v0/v1).
 */
function backgroundToStyle(
  bg: SlideBackground,
  appDataDir: string | null,
): React.CSSProperties {
  switch (bg.type) {
    case "color": {
      return { backgroundColor: bg.value };
    }
    case "image": {
      const resolved = resolvePath(bg.value, appDataDir);
      return {
        backgroundImage: `url(${convertFileSrc(resolved)})`,
        backgroundSize: bg.objectFit === "contain" ? "contain" : bg.objectFit === "fill" ? "100% 100%" : "cover",
        backgroundPosition: "center",
        opacity: bg.opacity ?? 1,
      };
    }
    case "video": {
      // The `<video>` overlay below covers the slide; the container just
      // paints a neutral colour underneath in case the video is still
      // loading. Use the canvas default so flash is dark, not white.
      return { backgroundColor: "#000000" };
    }
    case "gradient": {
      return {
        background: `linear-gradient(${bg.angle}deg, ${bg.from}, ${bg.to})`,
      };
    }
    default: {
      // Exhaustiveness — adding a new background variant is a compile
      // error here so the renderer never silently drops a new type.
      const _exhaustive: never = bg;
      void _exhaustive;
      return {};
    }
  }
}

/**
 * If the slide carries a non-null video background, render the autoplay
 * loop that covers the slide. Memoized so changing other slide props
 * doesn't reload the underlying video element.
 */
function BackgroundVideoEl({ value, loop, muted, objectFit, opacity, appDataDir }: {
  value: string; loop?: boolean; muted?: boolean;
  objectFit?: "cover" | "contain" | "fill"; opacity?: number;
  appDataDir: string | null;
}) {
  const resolved = resolvePath(value, appDataDir);
  if (!resolved) return null;
  return (
    <video
      src={convertFileSrc(resolved)}
      className="absolute inset-0 w-full h-full z-0"
      style={{ objectFit: objectFit ?? "cover", opacity: opacity ?? 1 }}
      autoPlay
      loop={loop !== false}
      muted={muted !== false}
      playsInline
    />
  );
}

/**
 * Single text-element renderer used by `CustomSlideRenderer` so the
 * auto-size algorithm (P3.3) can own its own DOM ref and probe element
 * without the parent's per-slide memo re-running on every binary-search
 * iteration. Honors both `mode: "shrink"` (binary-search down) and
 * `mode: "grow"` (ResizeObserver-driven box expansion).
 */
function SlideTextElement({
  el, scale, theme, elStyle, vAlign,
}: {
  el: TextElement;
  scale: number;
  theme?: SlideTheme;
  elStyle: React.CSSProperties;
  vAlign: "flex-start" | "center" | "flex-end";
}) {
  // Element-level cascade defaults ("inherit" → theme) shared with the
  // editor CSS, thumbnails, and the auto-size probe (textStyleSystem.ts).
  const { fontFamily, fontSize, color } = resolveElementTextStyle(el, theme);
  const html = isJsonContent(el.content)
    ? renderDocToHtml(el.content)
    : ptToScaleHtml(sanitizeSlideHtml(String(el.content ?? "")));
  const autosize = el.autoSize ?? "fixed";

  // ── shrink: binary-search the largest pt that fits inside the box. ─────
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxPx, setBoxPx] = useState<{ w: number; h: number } | null>(null);
  useLayout(() => {
    const node = boxRef.current;
    if (!node || autosize !== "shrink") { setBoxPx(null); return; }
    // 2px each side so a long paragraph does not render flush against
    // the element border (matches the editor's outline + handle inset).
    setBoxPx({ w: node.clientWidth - 4, h: node.clientHeight - 4 });
  }, [el.w, el.h, autosize, html, scale]);
  const shrinkPt = useAutoSizeText(
    autosize === "shrink" && boxPx !== null,
    boxPx ? resolveAutoSizeInputs(el, theme, scale, html, boxPx.h, boxPx.w) : null,
  );
  const effectivePt = shrinkPt ?? fontSize * scale;

  // ── grow: ResizeObserver-driven box expansion below content height. ─────
  // `min-h` is the declared `h` percentage; the box grows past it inline.
  const growChildRef = useRef<HTMLDivElement>(null);
  const [growOverrideH, setGrowOverrideH] = useState<string | null>(null);
  useLayout(() => {
    if (autosize !== "grow") { setGrowOverrideH(null); return; }
    const child = growChildRef.current;
    if (!child) return;
    const sync = () => {
      const measured = child.scrollHeight;
      // Convert to % of the slide's height. The parent box is sized
      // in %, so we express the override in the same unit; the slide
      // container's height is the 100% reference.
      const parentH = (child.parentElement?.parentElement?.clientHeight) ?? 0;
      if (parentH <= 0) return;
      const pct = (measured / parentH) * 100;
      // The declared `el.h` is the floor; only grow past it.
      if (pct > (el.h + 0.05)) setGrowOverrideH(`${pct}%`);
      else setGrowOverrideH(null);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(child);
    return () => ro.disconnect();
  }, [autosize, html, el.h, scale]);

  const heightStyle = growOverrideH ?? undefined;

  return (
    <div
      ref={boxRef}
      key={el.id}
      style={{
        ...elStyle,
        height: heightStyle ?? elStyle.height,
        display: "flex",
        flexDirection: "column",
        justifyContent: vAlign,
      }}
    >
      <div
        ref={growChildRef}
        className="tiptap-rendered-content"
        style={{
          fontFamily,
          fontSize: `${effectivePt}pt`,
          // Single multiply point: every per-word mark and P4.3 recipe in
          // the HTML is `calc(Npt * var(--slide-scale))`, so scaling the
          // slide (output/stage/thumbnail/editor canvas) must set this var
          // here. The auto-size probe mirrors it as `mid / baseFontSize`.
          ["--slide-scale" as any]: effectivePt / (fontSize || 1),
          color,
          fontWeight: el.bold ? "bold" : "normal",
          fontStyle: el.italic ? "italic" : "normal",
          textAlign: (el.align ?? "left") as React.CSSProperties["textAlign"],
          textShadow: el.shadow === false ? "none" : `0 2px 8px ${el.shadow_color || "rgba(0,0,0,0.6)"}`,
          lineHeight: 1.3,
          width: "100%",
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/** Tiny alias so the text-renderer's `useLayoutEffect` reads cleanly —
 *  hoisted here so the rest of the file can keep using the React prime
 *  when we want suspense-free development. */
import { useLayoutEffect as useLayout } from "react";

export interface CustomSlideRendererProps {
  slide: CustomSlide | CustomSlideDisplayData;
  scale?: number;
  appDataDir?: string | null;
  hiddenElementIds?: string[];
  /** Optional cascade theme. Inherited only for elements with
   *  `font_family|font_size|color === "inherit"` (P2.4). The output
   *  window may omit it if the calling side does not know the
   *  presentation's theme. */
  theme?: SlideTheme;
  /** P4.5: when true, elements carrying an `entrance` recipe animate in
   *  (fade/slide/zoom) on first mount. Only the live/projection path
   *  passes this; the editor canvas + thumbnails keep `false` so the
   *  authoring surface never animates. */
  entranceEnabled?: boolean;
}

export function CustomSlideRenderer({
  slide,
  scale = 1,
  appDataDir = null,
  hiddenElementIds = [],
  theme,
  entranceEnabled = false,
}: CustomSlideRendererProps) {
  // Both `CustomSlide` and `CustomSlideDisplayData` carry the same
  // `background` union + `elements` array (P2.3 collapsed the dual
  // access path); the only structural difference is the metadata
  // fields packed next to the slide content on the on-wire shape.
  const background: SlideBackground = (slide as any).background;
  const elements: SlideElement[] = ((slide as any).elements as SlideElement[]) ?? [];

  const bgStyle = useMemo(() => backgroundToStyle(background, appDataDir), [background, appDataDir]);

  // Render the video background only when the union covers a video.
  const bgVideoEl = useMemo(() => {
    if (background.type !== "video") return null;
    return (
      <BackgroundVideoEl
        value={background.value}
        loop={background.loop}
        muted={background.muted}
        objectFit={background.objectFit}
        opacity={background.opacity}
        appDataDir={appDataDir}
      />
    );
  }, [background, appDataDir]);

  // Memoize per-element render so PropsRenderer Southbank-build churn doesn't
  // re-serialize every slide change. `JSON.stringify` content keys are
  // memoized further inside `renderDocToHtml`, so a banner that toggles
  // background colour every frame does not reparse its neighbour.
  const renderedElements = useMemo(() => elements.map((el) => {
    if (hiddenElementIds.includes(el.id) || el.hidden) return null;

    const elStyle: React.CSSProperties = {
      position: "absolute",
      left: `${el.x}%`,
      top: `${el.y}%`,
      width: `${el.w}%`,
      height: `${el.h}%`,
      zIndex: el.z_index,
      opacity: el.opacity ?? 1,
      // P3.4: rotation about the element's box center; flip mirroring
      // along the X / Y axis. `transform-box: fill-box` doesn't matter
      // here because the box is sized in % of the parent — the default
      // transform-origin is the element's center, which is what we
      // want.
      transform: [
        el.rotation ? `rotate(${el.rotation}deg)` : "",
        el.flipX ? "scaleX(-1)" : "",
        el.flipY ? "scaleY(-1)" : "",
      ].filter(Boolean).join(" ") || undefined,
    };

    switch (el.kind) {
      case "text": {
        const vAlign = el.v_align === "middle" ? "center" : el.v_align === "bottom" ? "flex-end" : "flex-start";
        return (
          <SlideTextElement
            key={el.id}
            el={el}
            scale={scale}
            theme={theme}
            elStyle={elStyle}
            vAlign={vAlign}
          />
        );
      }
      case "image": {
        const resolvedImg = resolvePath(el.content, appDataDir);
        // P3.6: image presentation — fit, position, filter chain,
        // border, radius. Filter strength comes through as a 0–100
        // value; translate to the right CSS unit for each filter.
        const fit = el.objectFit ?? "contain";
        const position = el.objectPosition ?? "center";
        let cssFilter = "none";
        if (el.filter && el.filter !== "none") {
          const v = el.filterValue ?? 100;
          cssFilter =
            el.filter === "grayscale" ? `grayscale(${v}%)` :
            el.filter === "sepia" ? `sepia(${v}%)` :
            el.filter === "brightness" ? `brightness(${(100 + v) / 100})` :
            el.filter === "blur" ? `blur(${v / 4}px)` :
            "none";
        }
        const border = el.border;
        const style: React.CSSProperties = {
          objectFit: fit,
          objectPosition: position,
          filter: cssFilter,
          borderRadius: el.borderRadius ? `${el.borderRadius}px` : undefined,
          border: border ? `${border.width}px solid ${border.color}` : undefined,
        };
        return (
          <div key={el.id} style={elStyle}>
            <img
              src={convertFileSrc(resolvedImg)}
              className="w-full h-full"
              alt=""
              style={style}
            />
          </div>
        );
      }
      case "video": {
        const resolvedVideo = resolvePath(el.content, appDataDir);
        const fit = el.objectFit ?? "contain";
        return (
          <div key={el.id} style={elStyle}>
            <video
              src={convertFileSrc(resolvedVideo)}
              className="w-full h-full"
              style={{ objectFit: fit }}
              autoPlay
              loop={el.loop !== false}
              muted={el.muted !== false}
              playsInline
            />
          </div>
        );
      }
      case "shape": {
        // P3.5: render shapes via inline SVG. The container div retains
        // the element's box; the SVG fills it 100% × 100% so the shape
        // scales crisp at any canvas size (vector rather than raster).
        // `preserveAspectRatio="none"` lets the element's box stretch
        // the shape; the strokeWidth uses `non-scaling-stroke` so the
        // stroke remains a constant visual weight regardless of the
        // element's aspect ratio.
        const shape = el.shape ?? "rect";
        const fill = el.fillColor ?? el.color ?? "#ffffff";
        const stroke = el.strokeColor ?? "none";
        const sw = el.strokeWidth ?? 0;
        // `borderRadius` lives in CSS px at 1080p reference height;
        // SVG `viewBox` is 100×100 so normalise the radius to viewbox
        // units by dividing by 10.8 (1080/100). Rounded rect uses `rx`.
        const rx = shape === "rounded" ? Math.max(0, (el.borderRadius ?? 12)) / 10.8 : shape === "rect" ? 0 : 0;
        const common = { fill, stroke, strokeWidth: sw / 10.8, vectorEffect: "non-scaling-stroke" as const };
        return (
          <div key={el.id} style={elStyle}>
            <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
              {shape === "rect" && <rect x={0} y={0} width={100} height={100} {...common} />}
              {shape === "rounded" && <rect x={0} y={0} width={100} height={100} rx={rx} ry={rx} {...common} />}
              {shape === "circle" && <circle cx={50} cy={50} r={50} {...common} />}
              {shape === "triangle" && <polygon points="50,4 96,96 4,96" {...common} />}
              {shape === "line" && (
                <line x1={2} y1={50} x2={98} y2={50} stroke={stroke === "none" ? fill : stroke} strokeWidth={(sw || 4) / 10.8} vectorEffect="non-scaling-stroke" />
              )}
            </svg>
          </div>
        );
      }
      default: {
        // Exhaustiveness check — TS errors if a new kind is added without a
        // branch above. We still render nothing for an unknown kind so a
        // future renderer doesn't crash the projection window.
        const _exhaustive: never = el;
        void _exhaustive;
        return null;
      }
    }
  }).map((node) => node), [elements, hiddenElementIds, scale, appDataDir, theme, entranceEnabled]);

  // P4.5 — after computing each element's node, apply the entrance
  // P7: respect prefers-reduced-motion — skip entrance animations when the
  //  operator has requested reduced motion. The slide still renders; only the
  //  animated entrance wrapper is bypassed.
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);

  // animation wrapper when the caller enabled it (projection path only).
  const animatedElements = entranceEnabled && !reducedMotion
    ? elements
        .map((el, i) => {
          if (hiddenElementIds.includes(el.id) || el.hidden) return null;
          const ent = el.entrance;
          if (!ent || ent.type === "none") return renderedElements[i] ?? null;
          const v = getTransitionVariants(ent.type, ent.duration / 1000);
          return (
            <motion.div
              key={`${(slide as any).id}-${el.id}`}
              className="absolute inset-0"
              style={{ zIndex: el.z_index }}
              initial={v.initial}
              animate={v.animate}
              exit={v.exit}
              transition={{ ...v.transition, delay: (ent.delay ?? 0) / 1000 }}
            >
              {renderedElements[i]}
            </motion.div>
          );
        })
    : renderedElements;

  return (
    <div className="w-full h-full relative overflow-hidden" style={bgStyle}>
      {bgVideoEl}
      {entranceEnabled ? animatedElements : renderedElements}
    </div>
  );
}

// ─── Song Slide Renderer ─────────────────────────────────────────────────────

export function SongSlideRenderer({
  data,
  scale = 1,
  fontSize = 72,
  fontFamily = "Georgia, serif",
  fontSizeOverride,
  fontFamilyOverride,
  color = "#ffffff",
  showSectionLabel = false,
}: {
  data: SongSlideData;
  scale?: number;
  fontSize?: number;
  fontFamily?: string;
  /** Per-zone typography override (Scene Builder). Wins over the song's own
   *  font and the output settings. */
  fontSizeOverride?: number;
  fontFamilyOverride?: string;
  color?: string;
  /** Whether the section label ("Verse 1", "Chorus") is projected. Controlled by
   *  the `show_song_section_labels` output setting; off by default. */
  showSectionLabel?: boolean;
}) {
  const finalFontSize = fontSizeOverride ?? (data.font_size || fontSize);
  const finalFontFamily = fontFamilyOverride ?? (data.font || fontFamily);
  const finalColor = data.color || color;
  const fontWeight = data.font_weight || "normal";

  return (
    <div className="w-full h-full relative overflow-hidden flex flex-col items-center justify-center p-[8%] text-center">
      <div className="flex flex-col items-center justify-center max-w-[95%]">
        {showSectionLabel && data.section_label && (
          <p className="uppercase tracking-[0.25em] font-black text-amber-500/50 mb-6" style={{ fontSize: `${18 * scale}pt` }}>
            {data.section_label}
          </p>
        )}
        <div className="flex flex-col gap-4">
          {data.lines.map((line, i) => (
            <p key={i} className="leading-tight drop-shadow-2xl" style={{ 
              color: finalColor,
              fontSize: `${finalFontSize * 0.85 * scale}pt`,
              fontFamily: finalFontFamily,
              fontWeight: fontWeight,
            }}>
              {line}
            </p>
          ))}
        </div>
        {data.slide_index === data.total_slides - 1 && data.author && (
          <p className="mt-12 text-white/30 italic font-medium" style={{ fontSize: `${16 * scale}pt` }}>
            — {data.author}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Reference Tag ───────────────────────────────────────────────────────────

function ReferenceTag({
  book,
  chapter,
  verse,
  version,
  settings,
  scale = 1,
}: {
  book: string;
  chapter: number;
  verse: number;
  version: string;
  settings?: PresentationSettings;
  scale?: number;
}) {
  const finalFontSize = (settings?.reference_font_size ?? 36) * scale;
  const finalFontFamily = settings?.reference_font_family ?? "Arial, sans-serif";
  const finalColor = (settings?.reference_color && settings.reference_color !== "") ? settings.reference_color : "#f59e0b";

  const cvFontSize = (settings?.chapter_verse_font_size ?? (settings?.reference_font_size ?? 36)) * scale;
  const cvFontFamily = settings?.chapter_verse_font_family ?? finalFontFamily;
  const cvColor = (settings?.chapter_verse_color && settings.chapter_verse_color !== "") ? settings.chapter_verse_color : finalColor;

  const vFontSize = (settings?.version_font_size ?? 24) * scale;
  const vFontFamily = settings?.version_font_family ?? "Arial, sans-serif";
  const vColor = (settings?.version_color && settings.version_color !== "") ? settings.version_color : undefined;

  return (
    <div className="flex items-baseline gap-3 mt-4">
      <p style={{
        fontSize: `${finalFontSize}pt`,
        fontFamily: finalFontFamily,
        color: finalColor,
        fontWeight: "900",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}>
        {book}{" "}
        <span style={{ fontSize: `${cvFontSize}pt`, fontFamily: cvFontFamily, color: cvColor }}>
          {chapter}:{verse}
        </span>
      </p>
      <p style={{
        fontSize: `${vFontSize}pt`,
        fontFamily: vFontFamily,
        color: vColor || finalColor,
        opacity: vColor ? 1 : 0.5,
        fontWeight: "700",
      }}>
        ({version})
      </p>
    </div>
  );
}
  
// ─── Lower Third Overlay ──────────────────────────────────────────────────────

export function LowerThirdOverlay({
  data,
  template: rawTemplate,
  onCycleComplete,
  scale = 1,
}: {
  data: LowerThirdData;
  template: LowerThirdTemplate;
  onCycleComplete?: () => void;
  /** Multiplier for all authored pixel metrics (offsets, sizes, spacing).
   *  The template is authored for the reference output canvas; pass
   *  windowScale (windowHeight / referenceHeight) so the overlay stays
   *  proportionally correct when the output window isn't at the reference. */
  scale?: number;
}) {
  const s = scale;
  // Resolve the shared lower-third model: content → style slots, background,
  // accent/border/shadow tokens, and geometry come from `resolveLowerThird` —
  // the SAME pure descriptor the canvas `drawLowerThird` consumes, so the two
  // renderers can never drift apart. This component keeps CSS positioning,
  // animation, and ticker DOM behavior.
  const layout = useMemo(() => resolveLowerThird({ data, template: rawTemplate }), [data, rawTemplate]);
  const { content, slots, background, accent, border, boxShadow, textShadow, outline, geometry, animation } = layout;
  // Guards against onCycleComplete firing multiple times per scroll cycle
  const cycleCompleteFiredRef = useRef(false);
  const containerStyle = {
    paddingLeft: geometry.paddingX * s, paddingRight: geometry.paddingX * s,
    paddingTop: geometry.paddingY * s, paddingBottom: geometry.paddingY * s,
    borderRadius: geometry.borderRadius * s, overflow: "hidden",
    backdropFilter: background.blurEnabled ? `blur(${background.blur}px)` : undefined,
    ...(background.type === "solid" ? { background: hexToRgba(background.color, background.opacity) } : 
       background.type === "gradient" ? { background: `linear-gradient(135deg, ${hexToRgba(background.color, background.opacity)} 0%, ${hexToRgba(background.gradientEnd, background.opacity)} 100%)` } :
       background.type === "image" && background.imagePath ? { backgroundImage: `url("${convertFileSrc(background.imagePath)}")`, backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" } :
       { background: "transparent" }),
    ...(accent.enabled ? {
      [`border${accent.side.charAt(0).toUpperCase() + accent.side.slice(1)}`]: `${accent.width * s}px solid ${accent.color}`
    } : {}),
    ...(border.enabled ? { border: `${border.width * s}px solid ${border.color}` } : {}),
    ...(boxShadow.enabled ? { boxShadow: `0 ${10 * s}px ${30 * s}px ${boxShadow.color}` } : {})
  } as React.CSSProperties;

  const buildLtTextStyle = (slot: LtStyleSlot): React.CSSProperties => ({
    fontFamily: slot.font, fontSize: slot.size * s, color: slot.color,
    fontWeight: slot.bold ? "bold" : "normal",
    fontStyle: slot.italic ? "italic" : "normal",
    textTransform: slot.uppercase ? "uppercase" : undefined,
    textShadow: textShadow.enabled ? `0 ${2 * s}px ${textShadow.blur * s}px ${textShadow.color}` : "none",
    WebkitTextStroke: outline.enabled ? `${outline.width * s}px ${outline.color}` : undefined,
    lineHeight: 1.25, margin: 0,
    ...(geometry.maxLines > 0 ? {
      display: "-webkit-box",
      WebkitLineClamp: geometry.maxLines,
      WebkitBoxOrient: "vertical",
      overflow: "hidden",
      textOverflow: "ellipsis"
    } : {})
  });

    const getVariants = () => {
      const entry = animation.entry;
      const exit = animation.exit;
  
      const variants: any = {
        initial: { opacity: 1, x: 0, y: 0, filter: "blur(0px)" },
        animate: { opacity: 1, x: 0, y: 0, filter: "blur(0px)" },
        exit: { opacity: 1, x: 0, y: 0, filter: "blur(0px)" }
      };
  
// Entry
      if (entry === "fade") variants.initial = { opacity: 0 };
      else if (entry === "slide-up") variants.initial = { opacity: 0, y: 40 * s };
      else if (entry === "slide-left") variants.initial = { opacity: 0, x: 60 * s };
      else if (entry === "slide-right") variants.initial = { opacity: 0, x: -60 * s };
      else if (entry === "blur-in") variants.initial = { opacity: 0, filter: "blur(20px)", scale: 0.95 };
      else if (entry === "none") variants.initial = { opacity: 1 };

      // Exit
      if (exit === "fade") variants.exit = { opacity: 0 };
      else if (exit === "slide-up") variants.exit = { opacity: 0, y: 40 * s };
      else if (exit === "slide-left") variants.exit = { opacity: 0, x: 60 * s };
      else if (exit === "slide-right") variants.exit = { opacity: 0, x: -60 * s };
      else if (exit === "blur-out") variants.exit = { opacity: 0, filter: "blur(20px)", scale: 0.95 };
      else if (exit === "none") variants.exit = { opacity: 1 };
  
      return variants;
    };
  

  const variants = getVariants();
  
  // Keep layout positioning separate from Framer Motion's transform-based
  // animation. The transform template appends the alignment transform after
  // Motion has generated its entry/exit transform.
  const isFullWidth = geometry.isFullWidth;
  const positionStyle: React.CSSProperties = {
    position: "absolute",
    zIndex: 40,
    width: isFullWidth ? "100%" : `${Math.max(10, Math.min(100, geometry.widthPct))}%`,
    boxSizing: "border-box",
    pointerEvents: "none",
  };

if (isFullWidth) {
    positionStyle.left = 0;
  } else if (geometry.hAlign === "left") {
    positionStyle.left = geometry.offsetX * s;
  } else if (geometry.hAlign === "right") {
    positionStyle.right = geometry.offsetX * s;
  } else {
    positionStyle.left = `calc(50% + ${geometry.offsetX * s}px)`;
  }

  if (geometry.vAlign === "top") {
    positionStyle.top = geometry.offsetY * s;
  } else if (geometry.vAlign === "bottom") {
    positionStyle.bottom = geometry.offsetY * s;
  } else {
    positionStyle.top = `calc(50% + ${geometry.offsetY * s}px)`;
  }

  const alignmentTransform = [
    !isFullWidth && geometry.hAlign === "center" ? "translateX(-50%)" : "",
    geometry.vAlign === "middle" ? "translateY(-50%)" : "",
  ].filter(Boolean).join(" ");

const alignFlex = geometry.hAlign === "center"
    ? "items-center text-center"
    : geometry.hAlign === "right"
    ? "items-end"
    : "items-start";

  const tickerMode = content.tickerMode;
  const showHeadline = slots.showHeadline;
  const showSubline = slots.showSubline;
  const showKicker = slots.showKicker;
  const headline = content.headline;
  const subline = content.subline;
  const kicker = content.kicker;
  const headlineStyle = buildLtTextStyle(slots.headline);
  const sublineStyle = buildLtTextStyle(slots.subline);
  const kickerStyle = buildLtTextStyle(slots.kicker);
  const badgeText = content.badgeText;

  const body = tickerMode ? null : (
    <div className="w-full">
      {layout.variant === "modern" && (
        <div className={`flex flex-col ${alignFlex}`}>
          {showKicker && <p style={{ ...kickerStyle, letterSpacing: "0.1em", marginBottom: 4 }}>{kicker}</p>}
          {showHeadline && <p style={headlineStyle}>{headline}</p>}
          {showSubline && (
            <>
              <div className="w-1/4 h-px my-2 opacity-30" style={{ backgroundColor: accent.color || slots.subline.color }} />
              <p style={sublineStyle}>{subline}</p>
            </>
          )}
        </div>
      )}
      {layout.variant === "banner" && (
        <div className="flex items-center gap-4">
          <div className="shrink-0 py-1 px-4 rounded" style={{ background: accent.color, color: background.color }}>
            <p className="font-black text-xl uppercase tracking-tighter">{badgeText}</p>
          </div>
          <div className="flex-1 min-w-0">
            {showHeadline && <p style={headlineStyle}>{headline}</p>}
            {showSubline && <p style={{ ...sublineStyle, marginTop: 2 }}>{subline}</p>}
          </div>
        </div>
      )}
      {layout.variant === "plaque" && (
        <div className="flex flex-col">
          {showKicker && <p style={{ ...kickerStyle, letterSpacing: "0.35em", marginBottom: 6, opacity: 0.9 }}>{kicker}</p>}
          {showHeadline && <p style={headlineStyle}>{headline}</p>}
          {showSubline && (
            <>
              <div className="w-1/3 h-px my-2 opacity-25" style={{ backgroundColor: accent.color || slots.subline.color }} />
              <p style={{ ...sublineStyle, opacity: 0.92 }}>{subline}</p>
            </>
          )}
        </div>
      )}
      {layout.variant === "classic" && (
        <div className="w-full">
          {showKicker && <p style={{ ...kickerStyle, letterSpacing: "0.1em", marginBottom: 4 }}>{kicker}</p>}
          {showHeadline && <p style={headlineStyle}>{headline}</p>}
          {showSubline && <p style={{ ...sublineStyle, marginTop: 4 }}>{subline}</p>}
        </div>
      )}
    </div>
  );

  return (
    <motion.div
      style={positionStyle}
      transformTemplate={(_transform, generatedTransform) => {
        const motion = generatedTransform && generatedTransform !== "none" ? generatedTransform : "";
        return `${motion} ${alignmentTransform}`.trim() || "none";
      }}
      initial={variants.initial}
      animate={variants.animate}
      exit={{ ...variants.exit, transition: { duration: animation.exitDuration ?? 0.2 } }}
      transition={{ 
        duration: animation.duration || 0.5, 
        ease: "easeOut",
        scale: { type: "spring", stiffness: 300, damping: 20 },
        filter: { duration: (animation.duration || 0.5) * 1.5 }
      }}
    >
      <div style={{ ...containerStyle, textAlign: geometry.hAlign, boxSizing: "border-box", minWidth: 0 }}>
        {tickerMode && data.kind === "FreeText" ? (
          <div style={{ overflow: "hidden", position: "relative" }}>
            <motion.div
              className="whitespace-nowrap inline-block"
              style={{ minWidth: '100%' }}
              initial={{ x: layout.scroll.direction === "rtl" ? "100%" : "-100%" }}
              animate={{ x: layout.scroll.direction === "rtl" ? "-100%" : "100%" }}
              transition={{
                duration: (11 - layout.scroll.speed) * 5,
                ease: "linear",
                repeat: Infinity,
                repeatType: "loop",
              }}
              onUpdate={(latest: any) => {
                const xValue = parseFloat(latest.x);
                const nearEnd = layout.scroll.direction === "rtl" ? xValue < -98 : xValue > 98;
                if (nearEnd && !cycleCompleteFiredRef.current) {
                  cycleCompleteFiredRef.current = true;
                  onCycleComplete?.();
                } else if (!nearEnd) {
                  cycleCompleteFiredRef.current = false;
                }
              }}
            >
              {Array.from({ length: 3 }).map((_, i) => (
                <span key={i} style={{ display: "inline-block", marginRight: i < 2 ? layout.scroll.gap : 0 }}>
                  {i > 0 && (
                    <span style={{
                      margin: `0 ${layout.scroll.gap}px`,
                      ...buildLtTextStyle(slots.headline),
                      opacity: 0.7,
                    }}>
                      {layout.scroll.separator}
                    </span>
                  )}
                  <span style={{
                    ...buildLtTextStyle(slots.headline),
                    display: "inline-block",
                    flexShrink: 0,
                  }}>
                    {content.bodyText}
                  </span>
                </span>
              ))}
            </motion.div>
          </div>
        ) : (
          body
        )}
      </div>
    </motion.div>
  );
}

// ─── Timer Renderer ──────────────────────────────────────────────────────────

export function TimerRenderer({ data }: { data: TimerData }) {
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

// ─── Props Renderer ───────────────────────────────────────────────────────────

export function PropClockRenderer({ color, format }: { color?: string; format?: string }) {
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

export function PropsRenderer({ items, appDataDir = null }: { items: PropItem[]; appDataDir?: string | null }) {
  return (
    <div className="absolute inset-0 z-50 pointer-events-none">
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
            <img src={convertFileSrc(resolvePath(p.path, appDataDir))} className="w-full h-full object-contain" alt="" />
          )}
          {p.kind === "clock" && (
            <PropClockRenderer color={p.color} format={p.text} />
          )}
        </div>
      ))}
    </div>
  );
}

export function SmallItemPreview({
  item,
  appDataDir = null,
  settings,
}: {
  item: DisplayItem;
  appDataDir?: string | null;
  settings?: PresentationSettings;
}) {
  // Letterbox the 16:9 slide/song design inside the (possibly non-16:9)
  // preview box via `useSlideFit` — the renderer fills the largest 16:9
  // sub-rectangle that fits and scales fonts from its height, so wider or
  // narrower hosts never overflow text. The previous hardcoded scales
  // (0.1 / 0.2) only matched one fixed box height.
  const [boxRef, fit] = useSlideFit();
  const fitReady = fit.width > 0 && fit.height > 0;

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
    case "CustomSlide":
      return (
        <div ref={boxRef} className="w-full h-full flex items-center justify-center">
          {fitReady && (
            <div style={{ width: fit.width, height: fit.height }}>
              <CustomSlideRenderer slide={item.data} scale={fit.scale} appDataDir={appDataDir} />
            </div>
          )}
        </div>
      );
    case "Timer":
      return <TimerRenderer data={item.data} />;
    case "Song":
      return (
        <div ref={boxRef} className="w-full h-full flex items-center justify-center">
          {fitReady && (
            <div style={{ width: fit.width, height: fit.height }}>
              <SongSlideRenderer data={item.data} scale={fit.scale} fontSize={settings?.font_size} />
            </div>
          )}
        </div>
      );
    default:
      return null;
  }
}
