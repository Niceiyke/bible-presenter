import React, { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  DisplayItem,
  SceneCompositionData,
  SceneZone,
  PresentationSettings,
  ThemeColors,
} from "../../types";
import { THEMES } from "../../types";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolvePath, getEffectiveBackground, getVideoBackground } from "../../utils";
import {
  CustomSlideRenderer,
  TimerRenderer,
  SongSlideRenderer,
} from "./Renderers";
import PhoneCameraVideo, {
  usePhoneCameraOrientation,
  usePhoneCameraLook,
  useCameraChroma,
} from "./PhoneCameraVideo";
import { Music } from "lucide-react";

/**
 * Opens a native (non-phone) camera stream for a zone. Each camera zone owns
 * its own stream so multiple cameras can be composited at once; the stream is
 * stopped when the zone unmounts. Phone cameras are relayed separately over
 * WebRTC and pulled from `phoneStreams` by the zone content renderer.
 */
function useNativeCameraStream(deviceId: string | null): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null);
  useEffect(() => {
    let active: MediaStream | null = null;
    let cancelled = false;
    if (!deviceId) {
      setStream(null);
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: { exact: deviceId } } })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        active = s;
        setStream(s);
      })
      .catch((e) => console.error("Zone camera stream failed:", e));
    return () => {
      cancelled = true;
      if (active) active.getTracks().forEach((t) => t.stop());
    };
  }, [deviceId]);
  return stream;
}

/** Full-frame Verse block used inside a zone (compact reference + text). */
function ZoneVerse({
  item,
  settings,
  colors,
  windowScale,
  font_size,
  font_family,
}: {
  item: Extract<DisplayItem, { type: "Verse" }>;
  settings: PresentationSettings;
  colors: ThemeColors;
  windowScale: number;
  font_size?: number;
  font_family?: string;
}) {
  const isTop = settings.reference_position === "top";
  const fontPt = font_size != null
    ? Math.max(8, font_size * windowScale)
    : Math.max(16, (settings.font_size * windowScale) / 2);
  const fontFamily = font_family ?? settings.verse_font_family ?? "Georgia, serif";
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center p-[6%] text-center">
      <div className="w-full flex flex-col items-center gap-3">
        {isTop && (
          <p className="font-bold opacity-70 tracking-widest" style={{ color: colors.referenceText, fontSize: fontPt * 0.35 }}>
            {item.data.book} {item.data.chapter}:{item.data.verse}
            {item.data.version ? ` (${item.data.version})` : ""}
          </p>
        )}
        <p
          className="leading-tight drop-shadow-xl"
          style={{ color: colors.verseText, fontFamily, fontSize: `${fontPt}pt` }}
        >
          {item.data.text}
        </p>
        {!isTop && (
          <p className="font-bold opacity-70 tracking-widest" style={{ color: colors.referenceText, fontSize: fontPt * 0.35 }}>
            {item.data.book} {item.data.chapter}:{item.data.verse}
            {item.data.version ? ` (${item.data.version})` : ""}
          </p>
        )}
      </div>
    </div>
  );
}

/** Media zone content — image, video, or an audio card (respecting mute). */
function ZoneMedia({
  item,
  fit,
  muted,
  appDataDir,
}: {
  item: Extract<DisplayItem, { type: "Media" }>;
  fit: SceneZone["fit"];
  muted?: boolean;
  appDataDir: string | null;
}) {
  const src = convertFileSrc(resolvePath(item.data.path, appDataDir));
  const fitClass = fit === "cover" ? "object-cover" : fit === "fill" ? "object-fill" : "object-contain";
  if (item.data.media_type === "Image") {
    return <img src={src} className={`w-full h-full ${fitClass}`} alt={item.data.name} />;
  }
  if (item.data.media_type === "Audio") {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-black/30">
        <div className="w-20 h-20 rounded-full flex items-center justify-center bg-white/10 border border-white/20">
          <Music size={28} style={{ color: "#e2e8f0" }} className="animate-pulse" />
        </div>
        <p className="text-lg font-bold text-white drop-shadow-lg">{item.data.name}</p>
      </div>
    );
  }
  return (
    <video
      src={src}
      className={`w-full h-full ${fitClass}`}
      autoPlay
      loop={item.data.loop_playback ?? true}
      muted={muted}
      style={{ objectPosition: "center" }}
    />
  );
}

/**
 * Camera zone content. Hooks must run unconditionally, so this is a separate
 * component: native camera zones open their own getUserMedia stream (stopped
 * on unmount), phone camera zones pull the relayed WebRTC stream from
 * `phoneStreams` and apply the phone's live orientation/look/chroma.
 */
function ZoneCamera({
  item,
  phoneStreams,
}: {
  item: Extract<DisplayItem, { type: "Camera" }>;
  phoneStreams?: Record<string, MediaStream>;
}) {
  const deviceId = item.data.deviceId;
  const isPhone = deviceId.startsWith("phone-camera-");
  const nativeStream = useNativeCameraStream(isPhone ? null : deviceId);
  const stream = isPhone ? (phoneStreams?.[deviceId] ?? null) : nativeStream;
  const orientation = isPhone ? usePhoneCameraOrientation(deviceId) : null;
  const look = isPhone ? usePhoneCameraLook(deviceId) : null;
  const chroma = isPhone ? useCameraChroma(deviceId) : null;
  if (!deviceId) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#0b1220]">
        <span className="text-[10px] uppercase tracking-widest text-white/30">Empty</span>
      </div>
    );
  }
  return (
    <PhoneCameraVideo
      stream={stream}
      orientation={orientation}
      look={look}
      mirrored={item.data.mirrored}
      objectFit={item.data.objectFit as any}
      style={{ opacity: item.data.opacity ?? 1 }}
      chromaKey={chroma}
    />
  );
}

/**
 * Zone background layer — paints the content item's *effective* background
 * (settings bible/media overrides, or the song's per-song background) behind
 * the zone content, mirroring the single-item output path. Only used for
 * zones whose renderer does not draw its own background (Verse, Song, Media);
 * custom slides and cameras paint themselves.
 */
function ZoneBackground({
  item,
  settings,
  colors,
  appDataDir,
}: {
  item: DisplayItem;
  settings: PresentationSettings;
  colors: ThemeColors;
  appDataDir: string | null;
}) {
  const style = getEffectiveBackground(settings, item, colors, appDataDir);
  const videoBg = getVideoBackground(settings, item);
  return (
    <div className="absolute inset-0" style={style}>
      {videoBg?.path && (
        <video
          src={convertFileSrc(resolvePath(videoBg.path, appDataDir))}
          className="absolute inset-0 w-full h-full"
          style={{ objectFit: videoBg.objectFit ?? "cover" }}
          autoPlay
          loop
          muted
          playsInline
        />
      )}
    </div>
  );
}

/**
 * Renders a single zone's content inside its (already positioned) container.
 * Reuses the same renderers as the single-item output path so compositions
 * look identical to live content.
 */
export function ZoneContent({
  zone,
  settings,
  colors,
  windowScale,
  appDataDir,
  phoneStreams,
}: {
  zone: SceneZone;
  settings: PresentationSettings;
  colors: ThemeColors;
  windowScale: number;
  appDataDir: string | null;
  phoneStreams?: Record<string, MediaStream>;
}) {
  const item = zone.item;
  // Content scales with the zone's height relative to the full canvas, so a
  // zone rendered at 50% of the output height draws text at half the full-canvas
  // scale (matches the output and makes previews resize live as you drag).
  const zoneScale = windowScale * (zone.h || 1);
  const container: CSSProperties = {
    position: "absolute",
    left: `${zone.x * 100}%`,
    top: `${zone.y * 100}%`,
    width: `${zone.w * 100}%`,
    height: `${zone.h * 100}%`,
    zIndex: zone.z,
    opacity: zone.opacity,
    overflow: "hidden",
  };

  let content: React.ReactNode = null;
  switch (item.type) {
    case "Verse":
      content = <ZoneVerse item={item} settings={settings} colors={colors} windowScale={zoneScale} font_size={zone.font_size} font_family={zone.font_family} />;
      break;
    case "Camera":
      content = <ZoneCamera item={item} phoneStreams={phoneStreams} />;
      break;
    case "CustomSlide":
      content = <CustomSlideRenderer slide={item.data} scale={zoneScale} appDataDir={appDataDir} theme={item.data.theme} />;
      break;
    case "Media":
      content = <ZoneMedia item={item} fit={zone.fit} muted={zone.muted} appDataDir={appDataDir} />;
      break;
    case "Timer":
      content = <TimerRenderer data={item.data} />;
      break;
    case "Song":
      content = item.data.style === "FullSlide" || !item.data.style ? (
        <SongSlideRenderer
          data={item.data}
          scale={zoneScale}
          fontSize={settings.font_size}
          fontFamily={settings.verse_font_family}
          fontSizeOverride={zone.font_size}
          fontFamilyOverride={zone.font_family}
          color={colors.verseText}
          showSectionLabel={!!settings.show_song_section_labels}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-black/40" />
      );
      break;
    case "SceneComposition":
      // Nested compositions are flattened at build time; render a fallback.
      content = <div className="w-full h-full flex items-center justify-center text-white/60 text-sm">Nested scene</div>;
      break;
  }

  return (
    <div style={container}>
      {(item.type === "Verse" || item.type === "Song" || item.type === "Media") && (
        <ZoneBackground item={item} settings={settings} colors={colors} appDataDir={appDataDir} />
      )}
      {content}
    </div>
  );
}

/**
 * Renders a live `SceneComposition` display item on the output canvas: each
 * zone is positioned/sized/stacked per its normalized rect. `phoneStreams`
 * supplies the relayed phone-camera feeds (managed by the window hosting the
 * answering WebRTC peer); native camera zones open their own streams.
 */
export function CompositionRenderer({
  data,
  settings,
  appDataDir,
  windowScale,
  phoneStreams,
}: {
  data: SceneCompositionData;
  settings: PresentationSettings;
  appDataDir: string | null;
  windowScale: number;
  phoneStreams?: Record<string, MediaStream>;
}) {
  const colors: ThemeColors = (THEMES[settings.theme] ?? THEMES.dark).colors;
  return (
    <div className="absolute inset-0">
      {data.zones.map((zone) => (
        <ZoneContent
          key={zone.id}
          zone={zone}
          settings={settings}
          colors={colors}
          windowScale={windowScale}
          appDataDir={appDataDir}
          phoneStreams={phoneStreams}
        />
      ))}
    </div>
  );
}
