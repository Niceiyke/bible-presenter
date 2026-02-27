import React, { useRef, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { 
  ParsedSlide, 
  CustomSlide, 
  CustomSlideDisplayData, 
  DisplayItem, 
  SceneData, 
  LayerContent,
  LowerThirdData,
  LowerThirdTemplate,
  TimerData,
  PropItem
} from "../../types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function hexToRgba(hex: string, opacity: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${(opacity / 100).toFixed(2)})`;
}

// ─── Slide Renderer ───────────────────────────────────────────────────────────

export function SlideRenderer({ slide }: { slide: ParsedSlide }) {
  const bgStyle: React.CSSProperties = slide.backgroundColor
    ? { backgroundColor: slide.backgroundColor }
    : { backgroundColor: "#1a1a2e" };

  return (
    <div className="w-full h-full relative overflow-hidden" style={bgStyle}>
      {slide.images.map((img, i) => (
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
      {slide.textBoxes.map((tb, i) => (
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
              color: tb.color || "#ffffff",
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

export function CustomSlideRenderer({
  slide,
  scale = 1,
}: {
  slide: CustomSlide | CustomSlideDisplayData;
  scale?: number;
}) {
  const isDisplayData = "background_color" in slide;
  
  const header = isDisplayData ? (slide as CustomSlideDisplayData).header : (slide as CustomSlide).header;
  const body = isDisplayData ? (slide as CustomSlideDisplayData).body : (slide as CustomSlide).body;
  const bgColor = isDisplayData ? (slide as CustomSlideDisplayData).background_color : (slide as CustomSlide).backgroundColor;
  const bgImage = isDisplayData ? (slide as CustomSlideDisplayData).background_image : (slide as CustomSlide).backgroundImage;

  const headerEnabled = isDisplayData ? (slide as CustomSlideDisplayData).header_enabled : (slide as CustomSlide).headerEnabled;
  const headerHeightPct = (isDisplayData ? (slide as CustomSlideDisplayData).header_height_pct : (slide as CustomSlide).headerHeightPct) ?? 35;

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

  if (headerEnabled === false) {
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
      <div className="flex items-center justify-center" style={{ flex: `0 0 ${headerHeightPct}%`, padding: `${14 * scale}px ${24 * scale}px` }}>
        <p style={zoneStyle(header)}>{header.text}</p>
      </div>
      <div style={{ height: `${Math.max(1, scale)}px`, backgroundColor: "rgba(255,255,255,0.15)", margin: `0 ${24 * scale}px` }} />
      <div className="flex items-center justify-center flex-1" style={{ padding: `${14 * scale}px ${24 * scale}px` }}>
        <p style={zoneStyle(body)}>{body.text}</p>
      </div>
    </div>
  );
}

// ─── Camera Feed Renderer ─────────────────────────────────────────────────────

export function CameraFeedRenderer({ deviceId }: { deviceId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
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

// ─── Scene Renderer ──────────────────────────────────────────────────────────

export function SceneRenderer({
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

export function LayerContentRenderer({ content, outputMode = false }: { content: LayerContent; outputMode?: boolean }) {
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
    case "Timer":
      return <TimerRenderer data={item.data} />;
    default:
      return null;
  }
}

// ─── Lower Third Overlay ──────────────────────────────────────────────────────

export function LowerThirdOverlay({ data, template: t }: { data: LowerThirdData; template: LowerThirdTemplate }) {
  const containerStyle = {
    paddingLeft: t.paddingX, paddingRight: t.paddingX,
    paddingTop: t.paddingY, paddingBottom: t.paddingY,
    borderRadius: t.borderRadius, overflow: "hidden",
    backdropFilter: t.bgBlur ? "blur(8px)" : undefined,
    ...(t.bgType === "solid" ? { background: hexToRgba(t.bgColor, t.bgOpacity) } : 
       t.bgType === "gradient" ? { background: `linear-gradient(135deg, ${hexToRgba(t.bgColor, t.bgOpacity)} 0%, ${hexToRgba(t.bgGradientEnd, t.bgOpacity)} 100%)` } :
       t.bgType === "image" && t.bgImagePath ? { backgroundImage: `url("${convertFileSrc(t.bgImagePath)}")`, backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" } :
       { background: "transparent" }),
    ...(t.accentEnabled ? {
      [`border${t.accentSide.charAt(0).toUpperCase() + t.accentSide.slice(1)}`]: `${t.accentWidth}px solid ${t.accentColor}`
    } : {})
  } as React.CSSProperties;

  const buildLtTextStyle = (
    font: string, size: number, color: string,
    bold: boolean, italic: boolean, uppercase: boolean
  ): React.CSSProperties => ({
    fontFamily: font, fontSize: size, color,
    fontWeight: bold ? "bold" : "normal",
    fontStyle: italic ? "italic" : "normal",
    textTransform: uppercase ? "uppercase" : undefined,
    lineHeight: 1.25, margin: 0,
  });

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
  const positionStyle = {
    position: "absolute", zIndex: 50, width: `${t.widthPct}%`,
    ...(t.hAlign === "left" ? { left: t.offsetX } : t.hAlign === "right" ? { right: t.offsetX } : { left: "50%", transform: "translateX(-50%)" }),
    ...(t.vAlign === "top" ? { top: t.offsetY } : t.vAlign === "bottom" ? { bottom: t.offsetY } : { top: "50%", transform: (t.hAlign === "center" ? "translate(-50%, -50%)" : "translateY(-50%)") })
  } as React.CSSProperties;

  return (
    <motion.div
      style={positionStyle}
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
            <div style={{ overflow: "hidden", whiteSpace: "nowrap" }}>
              <span style={{
                ...buildLtTextStyle(t.primaryFont, t.primarySize, t.primaryColor, t.primaryBold, t.primaryItalic, t.primaryUppercase),
                display: "inline-block",
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

export function PropsRenderer({ items }: { items: PropItem[] }) {
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

export function SmallItemPreview({ item }: { item: DisplayItem }) {
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
    case "Timer":
      return <TimerRenderer data={item.data} />;
    default:
      return null;
  }
}

export function SlideThumbnail({
  slide,
  index,
  onStage,
  onLive,
}: {
  slide: ParsedSlide | CustomSlide;
  index: number;
  onStage: () => void;
  onLive: () => void;
}) {
  const isCustom = "header" in slide;
  
  if (isCustom) {
    return (
      <div
        className="group relative aspect-video rounded overflow-hidden border border-slate-700 hover:border-amber-500/50 transition-all cursor-pointer"
        onClick={onStage}
      >
        <CustomSlideRenderer slide={slide as CustomSlide} scale={0.1} />
        <div className="absolute bottom-0 left-0 px-1 py-0.5 bg-black/50">
          <span className="text-[7px] text-white/70">{index + 1}</span>
        </div>
        <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-all flex flex-col items-center justify-center gap-1 p-1">
          <button
            onClick={(e) => { e.stopPropagation(); onStage(); }}
            className="w-full bg-slate-600 hover:bg-slate-500 text-white text-[9px] font-bold py-1 rounded"
          >
            STAGE
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onLive(); }}
            className="w-full bg-amber-500 hover:bg-amber-400 text-black text-[9px] font-bold py-1 rounded"
          >
            DISPLAY
          </button>
        </div>
      </div>
    );
  }

  const ps = slide as ParsedSlide;
  const bgStyle: React.CSSProperties = ps.backgroundColor
    ? { backgroundColor: ps.backgroundColor }
    : { backgroundColor: "#1a1a2e" };

  return (
    <div
      className="group relative aspect-video rounded overflow-hidden border border-slate-700 hover:border-amber-500/50 transition-all cursor-pointer"
      style={bgStyle}
      onClick={onStage}
    >
      {ps.images?.[0] && (
        <img src={ps.images[0].dataUrl} className="absolute inset-0 w-full h-full object-cover" alt="" />
      )}
      {ps.textBoxes?.[0] && (
        <div className="absolute inset-0 flex items-center justify-center p-1">
          <p
            className="text-center font-bold leading-tight"
            style={{
              fontSize: "8px",
              color: ps.textBoxes[0].color || "#ffffff",
              textShadow: "0 1px 3px rgba(0,0,0,0.8)",
            }}
          >
            {ps.textBoxes[0].text.slice(0, 60)}
          </p>
        </div>
      )}
      <div className="absolute bottom-0 left-0 px-1 py-0.5 bg-black/50">
        <span className="text-[7px] text-white/70">{index + 1}</span>
      </div>
      <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-all flex flex-col items-center justify-center gap-1 p-1">
        <button
          onClick={(e) => { e.stopPropagation(); onStage(); }}
          className="w-full bg-slate-600 hover:bg-slate-500 text-white text-[9px] font-bold py-1 rounded"
        >
          STAGE
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onLive(); }}
          className="w-full bg-amber-500 hover:bg-amber-400 text-black text-[9px] font-bold py-1 rounded"
        >
          DISPLAY
        </button>
      </div>
    </div>
  );
}
