import React, { useRef, useEffect, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolvePath, getTransitionVariants } from "../../utils";
import { sanitizeSlideHtml } from "../../utils/sanitize";
import { useAppStore } from "../../store";
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
  DEFAULT_LT_TEMPLATE,
  SlideElement,
  SlideBackground,
  SlideTheme,
  TextElement,
} from "../../types";
import { renderDocToHtml, isJsonContent } from "../editors/slide/slideTextExtensions";
import { useAutoSizeText, resolveAutoSizeInputs, docToPlainText } from "./useAutoSizeText";

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
 * Resolve a `TextElement` style prop with the theme cascade (P2.4):
 * "inherit" pulls from the supplied `SlideTheme` rather than the
 * element's own override. Concrete values win; absent defaults fall
 * back to the historical "Arial/32pt/white" so the renderer never
 * produces invisible text on an un-themed slide.
 */
function resolveTextFont(el: TextElement, theme: SlideTheme | undefined) {
  const fontFamily =
    el.font_family === "inherit" || el.font_family === undefined
      ? theme?.defaultFontFamily ?? "Arial"
      : el.font_family;
  const fontSize =
    el.font_size === "inherit" || el.font_size === undefined
      ? theme?.defaultFontSize ?? 32
      : el.font_size;
  const color = el.color === "inherit" || el.color === undefined
    ? theme?.textColor ?? "#ffffff"
    : el.color;
  return { fontFamily, fontSize, color };
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
  const { fontFamily, fontSize, color } = resolveTextFont(el, theme);
  const html = isJsonContent(el.content)
    ? renderDocToHtml(el.content)
    : sanitizeSlideHtml(String(el.content ?? ""));
  const textPlain = docToPlainText(el.content);
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
    boxPx ? resolveAutoSizeInputs(el, theme, scale, textPlain, boxPx.h, boxPx.w) : null,
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
    if (hiddenElementIds.includes(el.id)) return null;

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
  // animation wrapper when the caller enabled it (projection path only).
  const animatedElements = entranceEnabled
    ? elements
        .map((el, i) => {
          if (hiddenElementIds.includes(el.id)) return null;
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
  color = "#ffffff",
}: {
  data: SongSlideData;
  scale?: number;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
}) {
  const finalFontSize = data.font_size || fontSize;
  const finalFontFamily = data.font || fontFamily;
  const finalColor = data.color || color;
  const fontWeight = data.font_weight || "normal";

  return (
    <div className="w-full h-full relative overflow-hidden flex flex-col items-center justify-center p-[8%] text-center">
      <div className="flex flex-col items-center justify-center max-w-[95%]">
        {data.section_label && (
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

const substituteTokens = (text: string) => {
  const now = new Date();
  return text
    .replace(/{time}/g, now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    .replace(/{date}/g, now.toLocaleDateString());
};

export function LowerThirdOverlay({
  data,
  template: rawTemplate,
  onCycleComplete
}: {
  data: LowerThirdData;
  template: LowerThirdTemplate;
  onCycleComplete?: () => void;
}) {
  const t = { ...DEFAULT_LT_TEMPLATE, ...(rawTemplate || {}) };
  // Guards against onCycleComplete firing multiple times per scroll cycle
  const cycleCompleteFiredRef = useRef(false);
  const containerStyle = {
    paddingLeft: t.paddingX, paddingRight: t.paddingX,
    paddingTop: t.paddingY, paddingBottom: t.paddingY,
    borderRadius: t.borderRadius, overflow: "hidden",
    backdropFilter: t.bgBlur ? `blur(${t.bgBlurAmount ?? 8}px)` : undefined,
    ...(t.bgType === "solid" ? { background: hexToRgba(t.bgColor, t.bgOpacity) } : 
       t.bgType === "gradient" ? { background: `linear-gradient(135deg, ${hexToRgba(t.bgColor, t.bgOpacity)} 0%, ${hexToRgba(t.bgGradientEnd, t.bgOpacity)} 100%)` } :
       t.bgType === "image" && t.bgImagePath ? { backgroundImage: `url("${convertFileSrc(t.bgImagePath)}")`, backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" } :
       { background: "transparent" }),
    ...(t.accentEnabled ? {
      [`border${t.accentSide.charAt(0).toUpperCase() + t.accentSide.slice(1)}`]: `${t.accentWidth}px solid ${t.accentColor}`
    } : {}),
    ...(t.borderEnabled ? { border: `${t.borderWidth}px solid ${t.borderColor}` } : {}),
    ...(t.boxShadow ? { boxShadow: `0 10px 30px ${t.boxShadowColor || "rgba(0,0,0,0.5)"}` } : {})
  } as React.CSSProperties;

  const buildLtTextStyle = (
    font: string, size: number, color: string,
    bold: boolean, italic: boolean, uppercase: boolean
  ): React.CSSProperties => ({
    fontFamily: font, fontSize: size, color,
    fontWeight: bold ? "bold" : "normal",
    fontStyle: italic ? "italic" : "normal",
    textTransform: uppercase ? "uppercase" : undefined,
    textShadow: t.textShadow ? `0 2px ${t.textShadowBlur}px ${t.textShadowColor}` : "none",
    WebkitTextStroke: t.textOutline ? `${t.textOutlineWidth}px ${t.textOutlineColor}` : undefined,
    lineHeight: 1.25, margin: 0,
    ...(t.maxLines > 0 ? {
      display: "-webkit-box",
      WebkitLineClamp: t.maxLines,
      WebkitBoxOrient: "vertical",
      overflow: "hidden",
      textOverflow: "ellipsis"
    } : {})
  });

    const getVariants = () => {
      const entry = t.entryAnimation || t.animation;
      const exit = t.exitAnimation || t.animation;
  
      const variants: any = {
        initial: { opacity: 1, x: 0, y: 0, filter: "blur(0px)" },
        animate: { opacity: 1, x: 0, y: 0, filter: "blur(0px)" },
        exit: { opacity: 1, x: 0, y: 0, filter: "blur(0px)" }
      };
  
      // Entry
      if (entry === "fade") variants.initial = { opacity: 0 };
      else if (entry === "slide-up") variants.initial = { opacity: 0, y: 40 };
      else if (entry === "slide-left") variants.initial = { opacity: 0, x: 60 };
      else if (entry === "slide-right") variants.initial = { opacity: 0, x: -60 };
      else if (entry === "blur-in") variants.initial = { opacity: 0, filter: "blur(20px)", scale: 0.95 };
      else if (entry === "none") variants.initial = { opacity: 1 };
  
      // Exit
      if (exit === "fade") variants.exit = { opacity: 0 };
      else if (exit === "slide-up") variants.exit = { opacity: 0, y: 40 };
      else if (exit === "slide-left") variants.exit = { opacity: 0, x: 60 };
      else if (exit === "slide-right") variants.exit = { opacity: 0, x: -60 };
      else if (exit === "blur-out") variants.exit = { opacity: 0, filter: "blur(20px)", scale: 0.95 };
      else if (exit === "none") variants.exit = { opacity: 1 };
  
      return variants;
    };
  

  const variants = getVariants();
  
  // Robust positioning logic
  const isFullWidth = t.widthPct >= 100;
  const positionStyle: React.CSSProperties = {
    position: "absolute",
    zIndex: 40,
    width: isFullWidth ? "100%" : `${t.widthPct}%`,
    pointerEvents: "none",
  };

  if (isFullWidth) {
    positionStyle.left = 0;
  } else if (t.hAlign === "left") {
    positionStyle.left = t.offsetX;
  } else if (t.hAlign === "right") {
    positionStyle.right = t.offsetX;
  } else {
    positionStyle.left = "50%";
    positionStyle.transform = "translateX(-50%)";
  }

  if (t.vAlign === "top") {
    positionStyle.top = t.offsetY;
  } else if (t.vAlign === "bottom") {
    positionStyle.bottom = t.offsetY;
  } else {
    positionStyle.top = "50%";
    const currentTransform = positionStyle.transform || "";
    positionStyle.transform = `${currentTransform} translateY(-50%)`.trim();
  }

  return (
    <motion.div
      style={positionStyle}
      initial={variants.initial}
      animate={variants.animate}
      exit={{ ...variants.exit, transition: { duration: t.exitDuration ?? 0.2 } }}
      transition={{ 
        duration: t.animationDuration || 0.5, 
        ease: "easeOut",
        scale: { type: "spring", stiffness: 300, damping: 20 },
        filter: { duration: (t.animationDuration || 0.5) * 1.5 }
      }}
    >
      <div style={containerStyle}>
        {data.kind === "Nameplate" && (
          <div className="w-full">
            {t.variant === "modern" ? (
              <div className="flex flex-col items-center text-center">
                <p style={buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase)}>
                  {substituteTokens(data.data.name)}
                </p>
                {data.data.title && (
                  <>
                    <div className="w-1/4 h-px my-2 opacity-30" style={{ backgroundColor: t.secondaryColor }} />
                    <p style={buildLtTextStyle(t.secondaryFont, t.secondarySize, t.secondaryColor, t.secondaryBold, t.secondaryItalic, t.secondaryUppercase)}>
                      {substituteTokens(data.data.title)}
                    </p>
                  </>
                )}
              </div>
            ) : t.variant === "banner" ? (
              <div className="flex items-center gap-4">
                <div className="shrink-0 py-1 px-4 rounded" style={{ background: t.accentColor, color: t.bgColor }}>
                   <p className="font-black text-xl uppercase tracking-tighter">{t.bannerBadgeText || "LIVE"}</p>
                </div>
                <div className="flex-1 min-w-0">
                  <p style={buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase)}>
                    {substituteTokens(data.data.name)}
                  </p>
                  {data.data.title && (
                    <p style={buildLtTextStyle(t.secondaryFont, t.secondarySize, t.secondaryColor, t.secondaryBold, t.secondaryItalic, t.secondaryUppercase)}>
                      {substituteTokens(data.data.title)}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <>
                <p style={buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase)}>
                  {substituteTokens(data.data.name)}
                </p>
                {data.data.title && (
                  <p style={{ ...buildLtTextStyle(t.secondaryFont, t.secondarySize, t.secondaryColor, t.secondaryBold, t.secondaryItalic, t.secondaryUppercase), marginTop: 4 }}>
                    {substituteTokens(data.data.title)}
                  </p>
                )}
              </>
            )}
          </div>
        )}
        {data.kind === "Lyrics" && (
          <>
            {data.data.section_label && t.labelVisible && (
              <p style={{ ...buildLtTextStyle(t.secondaryFont, t.labelSize, t.labelColor, true, false, t.labelUppercase), letterSpacing: "0.1em", marginBottom: 4 }}>
                {data.data.section_label}
              </p>
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
            <div style={{ overflow: "hidden", position: "relative" }}>
              <motion.div
                className="whitespace-nowrap inline-block"
                style={{ minWidth: '100%' }}
                initial={{ x: t.scrollDirection === "rtl" ? "100%" : "-100%" }}
                animate={{ x: t.scrollDirection === "rtl" ? "-100%" : "100%" }}
                transition={{
                  duration: (11 - t.scrollSpeed) * 5,
                  ease: "linear",
                  repeat: Infinity,
                  repeatType: "loop",
                }}
                onUpdate={(latest: any) => {
                  const xValue = parseFloat(latest.x);
                  const nearEnd = t.scrollDirection === "rtl" ? xValue < -98 : xValue > 98;
                  if (nearEnd && !cycleCompleteFiredRef.current) {
                    cycleCompleteFiredRef.current = true;
                    onCycleComplete?.();
                  } else if (!nearEnd) {
                    cycleCompleteFiredRef.current = false;
                  }
                }}
              >
                <span style={{
                  ...buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase),
                  display: "inline-block",
                  flexShrink: 0,
                }}>
                  {substituteTokens(data.data.text)}
                </span>
              </motion.div>
            </div>
          ) : (
            <p style={buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase)}>
              {substituteTokens(data.data.text)}
            </p>
          )
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
  switch (item.type) {
    case "Verse":
      return (
        <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center bg-black/40">
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
      return <CustomSlideRenderer slide={item.data} scale={0.1} appDataDir={appDataDir} />;
    case "Timer":
      return <TimerRenderer data={item.data} />;
    case "Song":
      return <SongSlideRenderer data={item.data} scale={0.2} />;
    default:
      return null;
  }
}

export function SlideThumbnail({
  slide,
  index,
  onStage,
  onLive,
  onAddToSchedule,
  appDataDir = null,
}: {
  slide: CustomSlide;
  index: number;
  onStage?: () => void;
  onLive?: () => void;
  onAddToSchedule?: () => void;
  appDataDir?: string | null;
}) {
  const showOverlay = onStage || onLive || onAddToSchedule;
  
  return (
    <div
      className="group relative aspect-video rounded overflow-hidden border border-white/[0.08] hover:border-indigo-400/60 transition-all cursor-pointer"
      onClick={onStage}
    >
      <CustomSlideRenderer slide={slide} scale={0.1} appDataDir={appDataDir} />
      <div className="absolute bottom-0 left-0 px-1 py-0.5 bg-black/50">
        <span className="text-[7px] text-white/70">{index + 1}</span>
      </div>
      {showOverlay && (
        <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-all flex flex-col items-center justify-center gap-1 p-1">
          {onStage && (
            <button
              onClick={(e) => { e.stopPropagation(); onStage(); }}
              className="w-full bg-white/15 hover:bg-white/25 text-white text-[9px] font-bold py-1 rounded backdrop-blur-sm"
            >
              STAGE
            </button>
          )}
          {onLive && (
            <button
              onClick={(e) => { e.stopPropagation(); onLive(); }}
              className="w-full bg-gradient-to-br from-amber-400 to-amber-600 hover:from-amber-300 hover:to-amber-500 text-black text-[9px] font-bold py-1 rounded shadow-lg shadow-amber-500/30"
            >
              DISPLAY
            </button>
          )}
          {onAddToSchedule && (
            <button
              onClick={(e) => { e.stopPropagation(); onAddToSchedule(); }}
              className="w-full bg-purple-600/40 hover:bg-purple-600 text-purple-300 text-[9px] font-bold py-1 rounded"
            >
              + SERVICE
            </button>
          )}
        </div>
      )}
    </div>
  );
}
