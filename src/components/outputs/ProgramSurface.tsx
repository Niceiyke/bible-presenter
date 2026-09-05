import React, { useRef, useCallback, useLayoutEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Music } from "lucide-react";
import type {
  ResolvedOutputFrame,
} from "../../outputs/resolveOutputFrame";
import {
  getEffectiveBackground,
  getTransitionVariants,
  getItemUid,
  resolvePath,
} from "../../utils";
import { ErrorBoundary } from "../ErrorBoundary";
import {
  CustomSlideRenderer,
  TimerRenderer,
  SongSlideRenderer,
  LowerThirdOverlay,
  PropsRenderer,
} from "../shared/Renderers";
import { CompositionRenderer } from "../shared/CompositionRenderer";
import PhoneCameraVideo, {
  usePhoneCameraOrientation,
  usePhoneCameraLook,
  useCameraChroma,
} from "../shared/PhoneCameraVideo";

export interface ProgramSurfaceRuntimeProps {
  /** Mutable window scale computed from the current window height. */
  windowScale: number;
  /** App data dir for asset path resolution. */
  appDataDir: string | null;
  /** Monitor test-pattern mode. */
  monitorTest: boolean;
  /** Media transports that live in the owning window (controlled). */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  bgVideoRef: React.RefObject<HTMLVideoElement | null>;
  bgAudioRef: React.RefObject<HTMLAudioElement | null>;
  /** Camera streams (background + main) provided by the owning window. */
  cameraStream: MediaStream | null;
  mainCameraStream: MediaStream | null;
  /** Phone camera relay streams keyed by device id. */
  phoneStreams: Record<string, MediaStream>;
  /** Lower-third scroll cycle completion callback (window-owned auto-hide). */
  onLowerThirdCycleComplete?: () => void;
}

export interface ProgramSurfaceProps {
  frame: ResolvedOutputFrame;
  runtime: ProgramSurfaceRuntimeProps;
  /** "output" = full projection surface; "preview" = scaled containment. */
  mode?: "output" | "preview";
  /** Visual-only preview: media renders muted and never autoplays (no audio,
   *  no transport wiring). Used by the Cockpit On-Air preview so it never
   *  duplicates the output window's authoritative playback. */
  silent?: boolean;
}

/**
 * Shared DOM program surface. Renders the audience output from a single
 * resolved frame, so OutputWindow (mode="output") and the Cockpit preview
 * (mode="preview") execute identical presentation code. This is the "one
 * renderer" DOM path: media/camera transports and Tauri event wiring stay in
 * the owning window; this component is purely presentational.
 */
export function ProgramSurface({ frame, runtime, mode = "output", silent = false }: ProgramSurfaceProps) {
  const {
    windowScale,
    appDataDir,
    monitorTest,
    videoRef,
    bgVideoRef,
    bgAudioRef,
    cameraStream,
    mainCameraStream,
    phoneStreams,
    onLowerThirdCycleComplete,
  } = runtime;

  // Render-only refs owned by the surface.
  const verseContainerRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLVideoElement>(null);
  const mainCameraRef = useRef<HTMLVideoElement>(null);

  const { settings, baseSettings, colors, item, propItems, lowerThird, overlays, blanked, backgrounds, watermark } = frame;

  // Verse auto-fit (only when verse splitting is disabled). DOM measurement,
  // so it lives inside the surface rather than the pure resolver.
  const [fittedFontPt, setFittedFontPt] = useState<number | null>(null);
  useLayoutEffect(() => {
    const isVerse = item?.type === "Verse";
    if (settings.auto_split_verses || !isVerse || !verseContainerRef.current) {
      setFittedFontPt(null);
      return;
    }
    const text = (item as { data: { text: string } }).data.text;
    const maxPt = settings.font_size * windowScale;
    const fontFamily = settings.verse_font_family ?? "Georgia, serif";
    const container = verseContainerRef.current;

    const availH = container.clientHeight * 0.8;
    const availW = container.clientWidth - 128;

    if (availH <= 0 || availW <= 0) return;

    const probe = document.createElement("p");
    probe.style.cssText = [
      "position:absolute",
      "visibility:hidden",
      "pointer-events:none",
      `width:${availW}px`,
      `font-family:${fontFamily}`,
      "text-align:center",
      "word-break:break-word",
      "line-height:1.25",
      "white-space:normal",
    ].join(";");
    container.appendChild(probe);

    let lo = 10, hi = maxPt, best = 10;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      probe.style.fontSize = `${mid}pt`;
      probe.textContent = text;
      if (probe.scrollHeight <= availH) {
        best = mid;
        lo = mid + 0.25;
      } else {
        hi = mid - 0.25;
      }
    }
    container.removeChild(probe);
    setFittedFontPt(best < maxPt ? Math.floor(best) : null);
  }, [item, settings.auto_split_verses, settings.font_size, settings.verse_font_family, windowScale, verseContainerRef]);

  if (blanked) {
    return <div className="fixed inset-0 bg-black cursor-none pointer-events-none select-none" />;
  }

  const isTop = settings.reference_position === "top";
  const bgStyle = getEffectiveBackground(settings, item, colors, appDataDir);

  const refColor = baseSettings.reference_color && baseSettings.reference_color !== ""
    ? baseSettings.reference_color
    : colors.referenceText;
  const refFontSize = baseSettings.reference_font_size ?? 36;
  const refFontFamily = baseSettings.reference_font_family ?? "Arial, sans-serif";

  const cvFontSize = (baseSettings.chapter_verse_font_size ?? refFontSize) * windowScale;
  const cvFontFamily = baseSettings.chapter_verse_font_family ?? refFontFamily;
  const cvColor = baseSettings.chapter_verse_color && baseSettings.chapter_verse_color !== ""
    ? baseSettings.chapter_verse_color
    : refColor;

  const liveCameraDeviceId = item?.type === "Camera" ? item.data.deviceId ?? null : null;
  const livePhoneOrientation = usePhoneCameraOrientation(
    liveCameraDeviceId?.startsWith("phone-camera-") ? liveCameraDeviceId : null
  );
  const liveCameraLook = usePhoneCameraLook(liveCameraDeviceId);
  const liveCameraChroma = useCameraChroma(liveCameraDeviceId);

  const bgCameraLook = usePhoneCameraLook(backgrounds.camera?.deviceId ?? null);
  const bgCameraChroma = useCameraChroma(backgrounds.camera?.deviceId ?? null);
  const bgPhoneOrientation = usePhoneCameraOrientation(
    backgrounds.camera?.deviceId?.startsWith("phone-camera-") ? backgrounds.camera.deviceId : null
  );

  const ReferenceTag = item?.type === "Verse" ? (
    <p
      className="uppercase tracking-widest font-bold shrink-0"
      style={{ color: refColor, fontSize: `${refFontSize * windowScale}pt`, fontFamily: refFontFamily }}
    >
      {item.data.book}{" "}
      <span style={{ fontSize: `${cvFontSize}pt`, fontFamily: cvFontFamily, color: cvColor }}>
        {item.data.chapter}:{item.data.verse}
      </span>
      {item.data.version && (
        <span
          className="font-normal ml-2"
          style={{
            fontSize: `${(baseSettings.version_font_size ?? Math.round(refFontSize * 0.65)) * windowScale}pt`,
            fontFamily: baseSettings.version_font_family ?? refFontFamily,
            color: (baseSettings.version_color && baseSettings.version_color !== "") ? baseSettings.version_color : undefined,
            opacity: (baseSettings.version_color && baseSettings.version_color !== "") ? 1 : 0.6,
          }}
        >
          ({item.data.version})
        </span>
      )}
    </p>
  ) : null;

  const scale = windowScale;

  return (
    <div
      className={`${mode === "preview" ? "absolute inset-0" : "fixed inset-0"} overflow-hidden cursor-none pointer-events-none select-none`}
      style={
        (backgrounds.video || backgrounds.camera || backgrounds.image)
          ? { color: colors.verseText }
          : { ...bgStyle, color: colors.verseText }
      }
    >
      {monitorTest && (
        <div className="absolute inset-0 z-[70] bg-black flex flex-col items-center justify-center gap-6">
          <div className="grid grid-cols-4 w-4/5 h-1/2 rounded overflow-hidden border border-white/20">
            {["#ffffff", "#ffff00", "#00ffff", "#00ff00", "#ff00ff", "#ff0000", "#0000ff", "#000000"].map((c) => (
              <div key={c} className="flex items-center justify-center" style={{ backgroundColor: c }}>
                <span className="text-[10px] font-black uppercase text-black/60 mix-blend-difference">{c}</span>
              </div>
            ))}
          </div>
          <p className="text-white text-2xl font-black uppercase tracking-widest">Monitor Test Pattern</p>
          <p className="text-white/50 text-sm">{window.innerWidth}×{window.innerHeight}</p>
        </div>
      )}

      {baseSettings.show_background_logo && (baseSettings.background_logo_path || baseSettings.background_logo_text) && (
        <div className="absolute inset-0 z-50 bg-black">
          {baseSettings.background_logo_text ? (
            <div className="w-full h-full flex items-center justify-center px-16 text-center">
              <p
                className="font-black leading-tight drop-shadow-2xl"
                style={{ color: baseSettings.background_logo_text_color ?? "#ffffff", fontSize: "4.5rem" }}
              >
                {baseSettings.background_logo_text}
              </p>
            </div>
          ) : baseSettings.background_logo_path?.toLowerCase().match(/\.(mp4|webm|mov|mkv|avi)$/) ? (
            <video
              src={convertFileSrc(resolvePath(baseSettings.background_logo_path, appDataDir))}
              className="w-full h-full"
              style={{ objectFit: baseSettings.background_logo_fit ?? "cover" }}
              autoPlay
              loop
              muted
            />
          ) : baseSettings.background_logo_path ? (
            <img
              src={convertFileSrc(resolvePath(baseSettings.background_logo_path, appDataDir))}
              className="w-full h-full"
              style={{ objectFit: baseSettings.background_logo_fit ?? "cover" }}
              alt="Background Logo"
            />
          ) : null}
        </div>
      )}

      {backgrounds.camera?.backdropColor ? (
        <div
          className="absolute inset-0 z-0 pointer-events-none"
          style={{ background: backgrounds.camera.backdropColor }}
        />
      ) : null}

      <div
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: 0, visibility: backgrounds.camera?.deviceId ? "visible" : "hidden" }}
      >
        <PhoneCameraVideo
          stream={cameraStream}
          orientation={backgrounds.camera?.deviceId?.startsWith("phone-camera-") ? bgPhoneOrientation : null}
          look={bgCameraLook}
          mirrored={backgrounds.camera?.mirrored}
          objectFit={(backgrounds.camera?.objectFit as any) ?? "cover"}
          style={{ opacity: backgrounds.camera?.opacity ?? 1 }}
          chromaKey={bgCameraChroma}
          videoRef={(el) => { cameraRef.current = el; }}
        />
      </div>

      <video
        ref={bgVideoRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{
          zIndex: 0,
          objectFit: backgrounds.video?.objectFit ?? "cover",
          opacity: backgrounds.video?.opacity ?? 1,
          visibility: backgrounds.video?.path ? "visible" : "hidden",
        }}
        src={backgrounds.video?.path ? convertFileSrc(resolvePath(backgrounds.video.path, appDataDir)) : undefined}
        autoPlay
        loop={backgrounds.video?.loopVideo ?? true}
        muted={backgrounds.video?.muted ?? true}
        playsInline
      />

      <audio ref={bgAudioRef} className="hidden" />

      {backgrounds.image && (
        <div
          className="absolute inset-0 z-0 pointer-events-none"
          style={{
            backgroundImage: `url(${convertFileSrc(resolvePath(backgrounds.image.path, appDataDir))})`,
            backgroundSize: backgrounds.image.objectFit === "contain" ? "contain" : backgrounds.image.objectFit === "fill" ? "100% 100%" : "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            opacity: backgrounds.image.opacity ?? 1,
          }}
        />
      )}

      {overlays.logo && (baseSettings.logo_text ? (
        <p
          className="absolute bottom-8 right-8 z-60 font-black leading-tight opacity-60 text-right"
          style={{ color: baseSettings.logo_text_color ?? "#ffffff", fontSize: "1.5rem" }}
        >
          {baseSettings.logo_text}
        </p>
      ) : baseSettings.logo_path?.toLowerCase().match(/\.(mp4|webm|mov|mkv|avi)$/) ? (
        <video
          src={convertFileSrc(resolvePath(baseSettings.logo_path, appDataDir))}
          className="absolute bottom-8 right-8 w-24 h-24 object-contain opacity-50 z-60"
          autoPlay
          loop
          muted
        />
      ) : baseSettings.logo_path ? (
        <img
          src={convertFileSrc(resolvePath(baseSettings.logo_path, appDataDir))}
          className="absolute bottom-8 right-8 w-24 h-24 object-contain opacity-50 z-60"
          alt="Logo"
        />
      ) : null)}

      <AnimatePresence mode="wait">
        {item ? (
          <motion.div
            key={getItemUid(item)}
            className="absolute inset-0 z-10"
            {...getTransitionVariants(
              settings.slide_transition ?? "fade",
              settings.slide_transition_duration ?? 0.4
            )}
          >
            <ErrorBoundary fallback={<ProjectionErrorFallback />}>
            {item.type === "Verse" ? (
              <div ref={verseContainerRef} className="absolute inset-0 flex flex-col items-center justify-center p-16 text-center">
                <motion.div
                  className="w-full flex flex-col items-center gap-8"
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.6, delay: 0.1 }}
                >
                  {isTop && ReferenceTag}
                  <div className="relative w-full flex flex-col items-center">
                    <h1
                      className="leading-tight drop-shadow-2xl"
                      style={{
                        color: colors.verseText,
                        fontSize: `${(fittedFontPt ?? (settings.font_size * windowScale))}pt`,
                        fontFamily: settings.verse_font_family ?? "Georgia, serif",
                      }}
                    >
                      {item.data.text}
                    </h1>
                    {item.data.split_index !== undefined && item.data.total_splits !== undefined && (
                      <p
                        className="absolute -bottom-10 right-0 font-black opacity-30 text-xs tracking-widest"
                        style={{ color: colors.verseText, fontSize: `${12 * windowScale}pt` }}
                      >
                        PART {item.data.split_index + 1} / {item.data.total_splits}
                      </p>
                    )}
                  </div>
                  {!isTop && ReferenceTag}
                </motion.div>
              </div>
            ) : item.type === "Camera" ? (
              <div className="absolute inset-0">
                {item.data.backdropColor ? (
                  <div
                    className="absolute inset-0"
                    style={{ background: item.data.backdropColor }}
                  />
                ) : null}
                <PhoneCameraVideo
                  stream={mainCameraStream}
                  orientation={livePhoneOrientation}
                  look={liveCameraLook}
                  mirrored={item.data.mirrored}
                  objectFit={(item.data.objectFit as any) ?? "cover"}
                  style={{ opacity: item.data.opacity ?? 1 }}
                  chromaKey={liveCameraChroma}
                  videoRef={(el) => { mainCameraRef.current = el; }}
                />
              </div>
            ) : item.type === "CustomSlide" ? (
              <div className="absolute inset-0">
                <CustomSlideRenderer slide={item.data} scale={windowScale} appDataDir={appDataDir} theme={item.data.theme} entranceEnabled />
              </div>
            ) : item.type === "Media" ? (
              <div className="absolute inset-0">
                {item.data.media_type === "Image" ? (
                  <img
                    src={convertFileSrc(item.data.path)}
                    className={`w-full h-full ${
                      item.data.fit_mode === "cover" ? "object-cover"
                      : item.data.fit_mode === "fill" ? "object-fill"
                      : "object-contain"
                    }`}
                    alt={item.data.name}
                  />
                ) : item.data.media_type === "Audio" ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-6">
                    <div
                      className="w-32 h-32 rounded-full flex items-center justify-center"
                      style={{
                        backgroundColor: colors.background + "66",
                        border: `1px solid ${colors.referenceText}66`,
                        boxShadow: `0 0 80px ${colors.referenceText}33`,
                      }}
                    >
                      <Music size={48} style={{ color: colors.referenceText }} className="animate-pulse" />
                    </div>
                    <p className="text-3xl font-bold drop-shadow-lg" style={{ color: colors.verseText }}>{item.data.name}</p>
                    <p className="text-sm uppercase tracking-widest" style={{ color: colors.referenceText }}>
                      Now Playing
                    </p>
                  </div>
                ) : (
                  <video
                    ref={(el) => {
                      if (silent) { videoRef.current = null; return; }
                      videoRef.current = el;
                      if (el) {
                        el.playbackRate = item.data.playback_rate ?? 1;
                        el.volume = item.data.volume ?? 1;
                      }
                    }}
                    src={convertFileSrc(item.data.path)}
                    className={`w-full h-full ${
                      item.data.fit_mode === "cover" ? "object-cover"
                      : item.data.fit_mode === "fill" ? "object-fill"
                      : "object-contain"
                    }`}
                    autoPlay={!silent}
                    muted={silent}
                    loop={item.data.loop_playback ?? true}
                  />
                )}
                {!silent && item.data.media_type === "Audio" && (
                  <audio
                    src={convertFileSrc(item.data.path)}
                    ref={(el) => { (window as any).__liveAudio = el; if (el) el.volume = item.data.volume ?? 1; }}
                    autoPlay
                    loop={item.data.loop_playback ?? true}
                  />
                )}
              </div>
            ) : item.type === "Timer" ? (
              <TimerRenderer data={item.data} />
            ) : item.type === "Song" ? (
              item.data.style === "FullSlide" ? (
                <SongSlideRenderer
                  data={item.data}
                  scale={windowScale}
                  fontSize={settings.font_size}
                  fontFamily={settings.verse_font_family}
                  color={colors.verseText}
                  showSectionLabel={!!settings.show_song_section_labels}
                />
              ) : null
            ) : item.type === "SceneComposition" ? (
              <CompositionRenderer
                data={item.data}
                settings={settings}
                appDataDir={appDataDir}
                windowScale={windowScale}
                phoneStreams={phoneStreams}
              />
            ) : null}
            </ErrorBoundary>
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

      {overlays.props && <PropsRenderer items={propItems} appDataDir={appDataDir} />}

      <AnimatePresence>
        {overlays.lower_third && lowerThird && (
          <LowerThirdOverlay
            key={lowerThird.data.kind === "Lyrics" ? `lt-${JSON.stringify(lowerThird.data)}` : "lt-static"}
            data={lowerThird.data}
            template={lowerThird.template}
            onCycleComplete={onLowerThirdCycleComplete}
            scale={windowScale}
          />
        )}
      </AnimatePresence>

      {watermark && (
        <div className="absolute inset-0 z-[65] pointer-events-none flex items-end justify-center pb-3">
          <span
            className="text-[12px] font-black uppercase tracking-widest text-white/40"
            style={{ textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}
          >
            Wordlyte Free
          </span>
        </div>
      )}
    </div>
  );
}

function ProjectionErrorFallback() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black text-center px-8">
      <div className="w-14 h-14 rounded-full bg-red-500/20 flex items-center justify-center mb-4">
        <span className="text-red-400 text-3xl font-black">!</span>
      </div>
      <p className="text-red-300 text-2xl font-bold mb-1">Projection Error</p>
      <p className="text-slate-400 text-sm">See operator console. Output will recover on the next slide.</p>
    </div>
  );
}
