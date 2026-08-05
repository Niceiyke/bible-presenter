import React, { useRef, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolvePath } from "../../utils";
import { useAppStore } from "../../store";
import {
  CustomSlide,
  CustomSlideDisplayData,
  DisplayItem,
  SceneData,
  LayerContent,
  LowerThirdData,
  LowerThirdTemplate,
  TimerData,
  PropItem,
  SongSlideData,
  PresentationSettings,
  DEFAULT_LT_TEMPLATE
} from "../../types";
  
  // ─── Live Context (for OBS-style source layers in Scene Renderer) ─────────────
  

export interface SceneLiveContext {
  liveItem: DisplayItem | null;
  lowerThird: { data: LowerThirdData; template: LowerThirdTemplate } | null;
  outputWsRef: React.RefObject<WebSocket | null>;
  hubRelayStreamA?: MediaStream | null;
  hubRelayStreamB?: MediaStream | null;
}

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

export function CustomSlideRenderer({
  slide,
  scale = 1,
  appDataDir = null,
  hiddenElementIds = [],
}: {
  slide: CustomSlide | CustomSlideDisplayData;
  scale?: number;
  appDataDir?: string | null;
  hiddenElementIds?: string[];
}) {
  const isDisplayData = "background_color" in slide;
  
  const bgColor = isDisplayData ? (slide as CustomSlideDisplayData).background_color : (slide as CustomSlide).backgroundColor;
  const bgImage = isDisplayData ? (slide as CustomSlideDisplayData).background_image : (slide as CustomSlide).backgroundImage;
  const bgVideo = isDisplayData ? (slide as CustomSlideDisplayData).background_video : (slide as CustomSlide).backgroundVideo;
  const bgVideoLoop = isDisplayData ? (slide as CustomSlideDisplayData).background_video_loop : (slide as CustomSlide).backgroundVideoLoop;
  const bgVideoMuted = isDisplayData ? (slide as CustomSlideDisplayData).background_video_muted : (slide as CustomSlide).backgroundVideoMuted;
  const elements = isDisplayData ? (slide as CustomSlideDisplayData).elements : (slide as CustomSlide).elements;

  // Fallback to legacy structure if elements are missing
  const headerEnabled = isDisplayData ? (slide as CustomSlideDisplayData).header_enabled : (slide as CustomSlide).headerEnabled;
  const headerHeightPct = (isDisplayData ? (slide as CustomSlideDisplayData).header_height_pct : (slide as CustomSlide).headerHeightPct) ?? 35;
  const header = isDisplayData ? (slide as CustomSlideDisplayData).header : (slide as CustomSlide).header;
  const body = isDisplayData ? (slide as CustomSlideDisplayData).body : (slide as CustomSlide).body;

  const resolvedBgImage = resolvePath(bgImage, appDataDir);
  const bgStyle: React.CSSProperties = resolvedBgImage
    ? { backgroundImage: `url(${convertFileSrc(resolvedBgImage)})`, backgroundSize: "cover", backgroundPosition: "center" }
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

  // Modern Elements Rendering
  if (elements && elements.length > 0) {
    const resolvedBgVideo = resolvePath(bgVideo, appDataDir);
    return (
      <div className="w-full h-full relative overflow-hidden" style={bgStyle}>
        {resolvedBgVideo && (
          <video
            src={convertFileSrc(resolvedBgVideo)}
            className="absolute inset-0 w-full h-full object-cover z-0"
            autoPlay
            loop={bgVideoLoop !== false}
            muted={bgVideoMuted !== false}
            playsInline
          />
        )}
        {elements.map((el) => {
          if (hiddenElementIds.includes(el.id)) return null;

          const elStyle: React.CSSProperties = {
            position: "absolute",
            left: `${el.x}%`,
            top: `${el.y}%`,
            width: `${el.w}%`,
            height: `${el.h}%`,
            zIndex: el.z_index,
            opacity: el.opacity ?? 1,
          };

          if (el.kind === "text") {
            const vAlign = el.v_align === "middle" ? "center" : el.v_align === "bottom" ? "flex-end" : "flex-start";
            const isHtml = el.content.includes("<");
            
            return (
              <div key={el.id} style={{ ...elStyle, display: "flex", flexDirection: "column", justifyContent: vAlign }}>
                {isHtml ? (
                  <div 
                    className="tiptap-rendered-content"
                    style={{
                      fontFamily: el.font_family ?? "Arial",
                      fontSize: `${(el.font_size ?? 32) * scale}pt`,
                      color: el.color ?? "#ffffff",
                      fontWeight: el.bold ? "bold" : "normal",
                      fontStyle: el.italic ? "italic" : "normal",
                      textAlign: (el.align ?? "left") as React.CSSProperties["textAlign"],
                      textShadow: el.shadow === false ? "none" : `0 2px 8px ${el.shadow_color || "rgba(0,0,0,0.6)"}`,
                      lineHeight: 1.3,
                      width: "100%",
                    }}
                    dangerouslySetInnerHTML={{ __html: el.content }}
                  />
                ) : (
                  <p style={{
                    fontFamily: el.font_family ?? "Arial",
                    fontSize: `${(el.font_size ?? 32) * scale}pt`,
                    color: el.color ?? "#ffffff",
                    fontWeight: el.bold ? "bold" : "normal",
                    fontStyle: el.italic ? "italic" : "normal",
                    textAlign: (el.align ?? "left") as React.CSSProperties["textAlign"],
                    textShadow: el.shadow === false ? "none" : `0 2px 8px ${el.shadow_color || "rgba(0,0,0,0.6)"}`,
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.3,
                    margin: 0,
                    width: "100%",
                  }}>
                    {el.content}
                  </p>
                )}
              </div>
            );
          } else if (el.kind === "image") {
            const resolvedImg = resolvePath(el.content, appDataDir);
            return (
              <div key={el.id} style={elStyle}>
                <img src={convertFileSrc(resolvedImg)} className="w-full h-full object-contain" alt="" />
              </div>
            );
          } else if (el.kind === "video") {
            const resolvedVideo = resolvePath(el.content, appDataDir);
            return (
              <div key={el.id} style={elStyle}>
                <video
                  src={convertFileSrc(resolvedVideo)}
                  className="w-full h-full object-contain"
                  autoPlay
                  loop={el.loop !== false}
                  muted={el.muted !== false}
                  playsInline
                />
              </div>
            );
          } else if (el.kind === "shape") {
            // Basic support for shapes (e.g., color blocks)
            return (
              <div key={el.id} style={{ ...elStyle, backgroundColor: el.color ?? "#ffffff" }} />
            );
          }
          return null;
        })}
      </div>
    );
  }

  // Legacy fallback rendering
  if (headerEnabled === false) {
    return (
      <div className="w-full h-full relative overflow-hidden flex flex-col" style={bgStyle}>
        <div className="flex items-center justify-center flex-1" style={{ padding: `${14 * scale}px ${24 * scale}px` }}>
          {body && <p style={zoneStyle(body)}>{body.text}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative overflow-hidden flex flex-col" style={bgStyle}>
      <div className="flex items-center justify-center" style={{ flex: `0 0 ${headerHeightPct}%`, padding: `${14 * scale}px ${24 * scale}px` }}>
        {header && <p style={zoneStyle(header)}>{header.text}</p>}
      </div>
      <div style={{ height: `${Math.max(1, scale)}px`, backgroundColor: "rgba(255,255,255,0.15)", margin: `0 ${24 * scale}px` }} />
      <div className="flex items-center justify-center flex-1" style={{ padding: `${14 * scale}px ${24 * scale}px` }}>
        {body && <p style={zoneStyle(body)}>{body.text}</p>}
      </div>
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

// ─── Scene Renderer ──────────────────────────────────────────────────────────

export function SceneRenderer({
  scene,
  scale = 1,
  activeLayerId,
  onLayerClick,
  outputMode = false,
  liveContext,
  appDataDir = null,
  settings,
}: {
  scene: SceneData;
  scale?: number;
  activeLayerId?: string | null;
  onLayerClick?: (id: string) => void;
  outputMode?: boolean;
  liveContext?: SceneLiveContext;
  appDataDir?: string | null;
  settings?: PresentationSettings;
}) {
  const bg = scene.background;
  const resolvedBg = bg?.type === "Image" ? resolvePath(bg.value, appDataDir) : null;
  
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        width: "100%",
        height: "100%",
        backgroundColor: bg?.type === "Color" ? bg.value : "#000000",
        backgroundImage: resolvedBg ? `url(${convertFileSrc(resolvedBg)})` : undefined,
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
            cursor: outputMode ? "none" : "pointer",
            overflow: "hidden",
          }}
        >
          <LayerContentRenderer content={layer.content} scale={scale} outputMode={outputMode} liveContext={liveContext} appDataDir={appDataDir} settings={settings} />
          {!outputMode && activeLayerId === layer.id && (
            <div className="absolute top-1 right-1 bg-blue-500 text-white text-[8px] font-black px-1 rounded shadow-lg pointer-events-none">ACTIVE</div>
          )}
        </div>
      ))}
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

export function LayerContentRenderer({
  content,
  scale = 1,
  outputMode = false,
  liveContext,
  appDataDir = null,
  settings,
}: {
  content: LayerContent;
  scale?: number;
  outputMode?: boolean;
  liveContext?: SceneLiveContext;
  appDataDir?: string | null;
  settings?: PresentationSettings;
}) {
  if (content.kind === "empty") {
    if (outputMode) return null;
    return (
      <div className="w-full h-full flex items-center justify-center"
        style={{ background: "repeating-conic-gradient(#1e293b 0% 25%, #0f172a 0% 50%) 0 0 / 16px 16px" }}>
        <span className="text-slate-600 text-xs">+</span>
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
  if (content.kind === "static-color") {
    return <div style={{ background: content.color }} className="w-full h-full" />;
  }
  if (content.kind === "static-image") {
    const resolved = resolvePath(content.path, appDataDir);
    return <img src={convertFileSrc(resolved)} className="w-full h-full object-cover" alt="" />;
  }
  if (content.kind === "source") {
    const src = content.source;
    if (src.type === "live-output") {
      const li = liveContext?.liveItem;
      if (li && li.type !== "Scene") {
        return <LayerContentRenderer content={{ kind: "item", item: li }} scale={scale} outputMode={outputMode} liveContext={liveContext} settings={settings} />;
      }
      return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1"
          style={{ background: "repeating-conic-gradient(#1e293b 0% 25%, #0f172a 0% 50%) 0 0 / 16px 16px" }}>
          <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">LIVE OUTPUT</span>
        </div>
      );
    }
    if (src.type === "lower-third") {
      const lt = liveContext?.lowerThird;
      if (lt) {
        return (
          <div className="absolute inset-0">
            <LowerThirdOverlay data={lt.data} template={lt.template} />
          </div>
        );
      }
      return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-gradient-to-b from-transparent to-black/60">
          <span className="text-[10px] font-black text-amber-400 uppercase tracking-widest">LOWER THIRD</span>
        </div>
      );
    }
    return null;
  }

  const { item } = content as { kind: "item"; item: any };
  switch (item.type) {
    case "Verse":
      const applyDynamicStyling = (text: string) => {
        if (!settings?.highlight_divine_words) return text;
        const color = settings.highlight_color || "#ef4444";
        // Simple regex to find quoted text (assumed to be spoken by Christ in many Bible versions)
        // or specific divine names if we wanted to expand.
        // This is a basic implementation that can be refined with specific word lists.
        return text.replace(/"([^"]*)"/g, `<span style="color: ${color}">"$1"</span>`);
      };

      const displayText = item.data.text;
      const isHtml = settings?.highlight_divine_words && displayText.includes('"');

      return (
        <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center">
          <div className="relative w-full flex flex-col items-center">
            {isHtml && outputMode ? (
              <div 
                className={outputMode ? "font-serif text-5xl text-white leading-snug drop-shadow-2xl" : "text-xs font-serif line-clamp-3 mb-1 opacity-80"}
                style={outputMode ? { fontSize: `${(settings?.font_size ?? 48) * scale}pt`, fontFamily: settings?.verse_font_family } : undefined}
                dangerouslySetInnerHTML={{ __html: applyDynamicStyling(displayText) }}
              />
            ) : (
              <p className={outputMode ? "font-serif text-5xl text-white leading-snug drop-shadow-2xl" : "text-xs font-serif line-clamp-3 mb-1 opacity-80"}
                 style={outputMode ? { fontSize: `${(settings?.font_size ?? 48) * scale}pt`, fontFamily: settings?.verse_font_family } : undefined}>
                {displayText}
              </p>
            )}
            {outputMode && item.data.split_index !== undefined && item.data.total_splits !== undefined && (
              <p 
                className="absolute -bottom-6 right-0 font-black opacity-30 text-[8px] tracking-widest uppercase"
                style={{ fontSize: `${10 * scale}pt` }}
              >
                Part {item.data.split_index + 1} / {item.data.total_splits}
              </p>
            )}
          </div>
          {outputMode ? (
            <ReferenceTag book={item.data.book} chapter={item.data.chapter} verse={item.data.verse} version={item.data.version} settings={settings} scale={scale} />
          ) : (
            <p className="text-[8px] font-black text-amber-500 uppercase">
              {item.data.book} {item.data.chapter}:{item.data.verse} ({item.data.version})
            </p>
          )}
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
    case "CustomSlide":
      return <CustomSlideRenderer slide={item.data} scale={outputMode ? scale : 0.1} appDataDir={appDataDir} />;
    case "PresentationSlide":
      return (
        <div className="w-full h-full bg-orange-900/20 flex items-center justify-center text-[10px] font-bold text-orange-500">
          PPTX SLIDE
        </div>
      );
    case "Scene":
      return <SceneRenderer scene={item.data} scale={scale} outputMode={outputMode} />;
    case "Timer":
      return <TimerRenderer data={item.data} />;
    case "Song":
      return <SongSlideRenderer data={item.data} scale={outputMode ? scale : 0.2} />;
    default:
      return null;
  }
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
      return <CustomSlideRenderer slide={item.data} scale={0.1} appDataDir={appDataDir} />;
    case "Scene":
      return <SceneRenderer scene={item.data} />;
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
  appDataDir = null,
}: {
  slide: CustomSlide;
  index: number;
  onStage?: () => void;
  onLive?: () => void;
  appDataDir?: string | null;
}) {
  const showOverlay = onStage || onLive;
  
  return (
    <div
      className="group relative aspect-video rounded overflow-hidden border border-slate-700 hover:border-amber-500/50 transition-all cursor-pointer"
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
              className="w-full bg-slate-600 hover:bg-slate-500 text-white text-[9px] font-bold py-1 rounded"
            >
              STAGE
            </button>
          )}
          {onLive && (
            <button
              onClick={(e) => { e.stopPropagation(); onLive(); }}
              className="w-full bg-amber-500 hover:bg-amber-400 text-black text-[9px] font-bold py-1 rounded"
            >
              DISPLAY
            </button>
          )}
        </div>
      )}
    </div>
  );
}
