import React, { useEffect, useState, useRef, useCallback, useLayoutEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { DisplayItem, PropItem, PresentationSettings, LowerThirdData, LowerThirdTemplate } from "../types";
import { THEMES } from "../types";
import {
  getEffectiveBackground,
  getVideoBackground,
  getCameraBackground,
  getTransitionVariants,
  getItemUid
} from "../utils";
import {
  CustomSlideRenderer,
  TimerRenderer,
  SongSlideRenderer,
  LowerThirdOverlay,
  PropsRenderer,
} from "../components/shared/Renderers";
import { AnimatePresence, motion } from "framer-motion";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { signalOperatorWarning } from "../hooks/useAppInitialization";

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

export function OutputWindow() {
  const [liveItem, setLiveItem] = useState<DisplayItem | null>(null);
  const [stagedItem, setStagedItem] = useState<DisplayItem | null>(null);
  const [lowerThird, setLowerThird] = useState<{ data: LowerThirdData; template: LowerThirdTemplate } | null>(null);
  const [propItems, setPropItems] = useState<PropItem[]>([]);
  const [settings, setSettings] = useState<PresentationSettings>({
    theme: "dark",
    reference_position: "bottom",
    background: { type: "None" },
    is_blanked: false,
    font_size: 72,
    disabled_bible_versions: [],
    auto_split_verses: true,
    verse_split_threshold: 200,
  });
  const [appDataDir, setAppDataDir] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const bgVideoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<HTMLVideoElement>(null);
  const mainCameraRef = useRef<HTMLVideoElement>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [mainCameraStream, setMainCameraStream] = useState<MediaStream | null>(null);

  const [windowScale, setWindowScale] = useState(1);
  const isMounted = useRef(true);

  // Auto-fit font size when verse splitting is disabled
  const verseContainerRef = useRef<HTMLDivElement>(null);
  const [fittedFontPt, setFittedFontPt] = useState<number | null>(null);

  // Calculate font scale based on current window height relative to 1080p reference
  useEffect(() => {
    const updateScale = () => {
      setWindowScale(window.innerHeight / 1080);
    };
    updateScale();
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, []);

  // Auto-fit: binary-search the largest font size that fits without overflow
  // Only active when verse splitting is disabled
  useLayoutEffect(() => {
    const isVerse = liveItem?.type === "Verse";
    if (settings.auto_split_verses || !isVerse || !verseContainerRef.current) {
      setFittedFontPt(null);
      return;
    }

    const text = (liveItem as any).data.text as string;
    const maxPt = settings.font_size * windowScale;
    const fontFamily = settings.verse_font_family ?? "Georgia, serif";
    const container = verseContainerRef.current;

    // Reserve ~15% of height for reference tag + gaps
    const availH = container.clientHeight * 0.80;
    const availW = container.clientWidth - 128; // p-16 = 64px each side

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
  }, [
    liveItem,
    settings.auto_split_verses,
    settings.font_size,
    settings.verse_font_family,
    windowScale,
  ]);

  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    const unlistenTrans = listen("live-item-update", (event: any) => {
      const { detected_item } = event.payload;
      setLiveItem(detected_item ?? null);
    });

    const unlistenSettings = listen("settings-changed", (event: any) => {
      setSettings(event.payload as PresentationSettings);
    });

    const unlistenStaged = listen("item-staged", (event: any) => {
      setStagedItem(event.payload as DisplayItem | null);
    });

    const unlistenLt = listen("lower-third-update", (event: any) => {
      if (event.payload) {
        setLowerThird({ data: event.payload.data as LowerThirdData, template: event.payload.template as LowerThirdTemplate });
      } else {
        setLowerThird(null);
      }
    });

    const unlistenMedia = listen("media-control", (event: any) => {
      const { action, volume } = event.payload as { action: string; volume?: number };
      if (action === "video-play-pause") {
        if (videoRef.current) {
          if (videoRef.current.paused) videoRef.current.play();
          else videoRef.current.pause();
        }
      } else if (action === "video-restart") {
        if (videoRef.current) {
          videoRef.current.currentTime = 0;
          videoRef.current.play();
        }
      } else if (action === "video-mute-toggle") {
        if (videoRef.current) {
          videoRef.current.muted = !videoRef.current.muted;
        }
      } else if (action === "video-volume") {
        if (videoRef.current && volume !== undefined) {
          videoRef.current.volume = volume;
        }
      }
    });

    const unlistenProps = listen("props-update", (event: any) => {
      setPropItems((event.payload as PropItem[]) ?? []);
    });

    Promise.all([
      invoke("get_current_item").then((v: any) => { if (v) setLiveItem(v); }).catch((e: any) => signalOperatorWarning(`Output hydrate (live): ${e?.message ?? e}`)),
      invoke("get_current_lower_third").then((lt: any) => { if (lt) setLowerThird(lt); }).catch((e: any) => signalOperatorWarning(`Output hydrate (LT): ${e?.message ?? e}`)),
      invoke("get_settings").then((s: any) => { if (s) setSettings(s); }).catch((e: any) => signalOperatorWarning(`Output hydrate (settings): ${e?.message ?? e}`)),
      invoke<string>("get_app_data_dir").then(setAppDataDir).catch((e: any) => signalOperatorWarning(`Output hydrate (appdir): ${e?.message ?? e}`)),
      invoke<PropItem[]>("get_props").then(setPropItems).catch((e: any) => signalOperatorWarning(`Output hydrate (props): ${e?.message ?? e}`)),
    ]);

    return () => {
      unlistenTrans.then((f) => f());
      unlistenSettings.then((f) => f());
      unlistenStaged.then((f) => f());
      unlistenLt.then((f) => f());
      unlistenMedia.then((f) => f());
      unlistenProps.then((f) => f());
    };
  }, []);

  // Lower Third Auto-Hide Logic
  const remainingScrolls = useRef<number>(0);
  const autoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (autoHideTimer.current) {
      clearTimeout(autoHideTimer.current);
      autoHideTimer.current = null;
    }

    if (!lowerThird) {
      remainingScrolls.current = 0;
      return;
    }

    const t = lowerThird.template;
    
    if (t.scrollEnabled && t.scrollCount > 0) {
      remainingScrolls.current = t.scrollCount;
    } else {
      remainingScrolls.current = 0;
    }

    if (t.autoHideSeconds > 0 && !(t.scrollEnabled && t.scrollCount === 0)) {
      autoHideTimer.current = setTimeout(() => {
        if (isMounted.current) {
          invoke("hide_lower_third").catch(console.error);
        }
      }, t.autoHideSeconds * 1000);
    }

    return () => {
      if (autoHideTimer.current) clearTimeout(autoHideTimer.current);
    };
  }, [lowerThird]);

  const handleLtCycleComplete = useCallback(() => {
    if (remainingScrolls.current > 0) {
      remainingScrolls.current -= 1;
      if (remainingScrolls.current === 0) {
        invoke("hide_lower_third").catch(console.error);
      }
    }
  }, []);

  const videoBg = getVideoBackground(settings, liveItem);
  const cameraBg = getCameraBackground(settings, liveItem);

  // Browser-only camera stream lifecycle
  useEffect(() => {
    let activeStream: MediaStream | null = null;
    
    const startBrowserCamera = async (deviceId: string) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { deviceId: { exact: deviceId } } 
        });
        activeStream = stream;
        setCameraStream(stream);
      } catch (err) {
        console.error("Failed to get camera stream:", err);
      }
    };

    if (cameraBg?.deviceId && !cameraBg.deviceId.startsWith("native:") && !cameraBg.deviceId.startsWith("ndi:")) {
      startBrowserCamera(cameraBg.deviceId);
    } else {
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        setCameraStream(null);
      }
    }

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [cameraBg?.deviceId]);

  // Main camera stream
  useEffect(() => {
    let activeStream: MediaStream | null = null;
    
    const startBrowserCamera = async (deviceId: string) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { deviceId: { exact: deviceId } } 
        });
        activeStream = stream;
        setMainCameraStream(stream);
      } catch (err) {
        console.error("Failed to get main camera stream:", err);
      }
    };

    if (liveItem?.type === "Camera" && liveItem.data.deviceId && !liveItem.data.deviceId.startsWith("native:") && !liveItem.data.deviceId.startsWith("ndi:")) {
      startBrowserCamera(liveItem.data.deviceId);
    } else {
      if (mainCameraStream) {
        mainCameraStream.getTracks().forEach(track => track.stop());
        setMainCameraStream(null);
      }
    }

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [liveItem?.type === "Camera" ? liveItem.data.deviceId : null]);

  useEffect(() => {
    if (bgVideoRef.current && videoBg) {
      bgVideoRef.current.playbackRate = videoBg.playbackRate;
    }
  }, [videoBg?.playbackRate]);

  useEffect(() => {
    if (bgVideoRef.current) {
      bgVideoRef.current.load();
      if (videoBg?.path) bgVideoRef.current.play().catch(() => {});
    }
  }, [videoBg?.path]);

  if (settings.is_blanked) {
    return <div className="fixed inset-0 bg-black cursor-none pointer-events-none select-none" />;
  }

  const { colors } = THEMES[settings.theme] ?? THEMES.dark;
  const isTop = settings.reference_position === "top";
  const bgStyle = getEffectiveBackground(settings, liveItem, colors);

  const refColor = settings.reference_color && settings.reference_color !== ""
    ? settings.reference_color
    : colors.referenceText;
  const refFontSize = settings.reference_font_size ?? 36;
  const refFontFamily = settings.reference_font_family ?? "Arial, sans-serif";

  const cvFontSize = (settings.chapter_verse_font_size ?? refFontSize) * windowScale;
  const cvFontFamily = settings.chapter_verse_font_family ?? refFontFamily;
  const cvColor = settings.chapter_verse_color && settings.chapter_verse_color !== ""
    ? settings.chapter_verse_color
    : refColor;

  const ReferenceTag = liveItem?.type === "Verse" ? (
    <p
      className="uppercase tracking-widest font-bold shrink-0"
      style={{ color: refColor, fontSize: `${refFontSize * windowScale}pt`, fontFamily: refFontFamily }}
    >
      {liveItem.data.book}{" "}
      <span style={{ fontSize: `${cvFontSize}pt`, fontFamily: cvFontFamily, color: cvColor }}>
        {liveItem.data.chapter}:{liveItem.data.verse}
      </span>
      {liveItem.data.version && (
        <span 
          className="font-normal ml-2" 
          style={{ 
            fontSize: `${(settings.version_font_size ?? Math.round(refFontSize * 0.65)) * windowScale}pt`,
            fontFamily: settings.version_font_family ?? refFontFamily,
            color: (settings.version_color && settings.version_color !== "") ? settings.version_color : undefined,
            opacity: (settings.version_color && settings.version_color !== "") ? 1 : 0.6,
          }}
        >
          ({liveItem.data.version})
        </span>
      )}
    </p>
  ) : null;

  return (
    <div
      className="fixed inset-0 overflow-hidden cursor-none pointer-events-none select-none"
      style={
        (videoBg || cameraBg)
          ? { color: colors.verseText }
          : { ...bgStyle, color: colors.verseText }
      }
    >
      {settings.show_background_logo && settings.background_logo_path && (
        <div className="absolute inset-0 z-50 bg-black">
          {settings.background_logo_path.toLowerCase().match(/\.(mp4|webm|mov|mkv|avi)$/) ? (
            <video
              src={convertFileSrc(settings.background_logo_path)}
              className="w-full h-full"
              style={{ objectFit: settings.background_logo_fit ?? "cover" }}
              autoPlay
              loop
              muted
            />
          ) : (
            <img
              src={convertFileSrc(settings.background_logo_path)}
              className="w-full h-full"
              style={{ objectFit: settings.background_logo_fit ?? "cover" }}
              alt="Background Logo"
            />
          )}
        </div>
      )}

      {/* Background camera element */}
      <video
        ref={(el) => {
          if (el && cameraStream) el.srcObject = cameraStream;
          cameraRef.current = el;
        }}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{
          zIndex: 0,
          objectFit: cameraBg?.objectFit ?? "cover",
          opacity: cameraBg?.opacity ?? 1,
          visibility: cameraBg?.deviceId ? "visible" : "hidden",
          transform: cameraBg?.mirrored ? "scaleX(-1)" : "none",
        }}
        autoPlay
        playsInline
      />

      <video
        ref={bgVideoRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{
          zIndex: 0,
          objectFit: videoBg?.objectFit ?? "cover",
          opacity: videoBg?.opacity ?? 1,
          visibility: videoBg?.path ? "visible" : "hidden",
        }}
        src={videoBg?.path ? convertFileSrc(videoBg.path) : undefined}
        autoPlay
        loop={videoBg?.loopVideo ?? true}
        muted={videoBg?.muted ?? true}
        playsInline
      />

      {settings.logo_path && (
        <img
          src={convertFileSrc(settings.logo_path)}
          className="absolute bottom-8 right-8 w-24 h-24 object-contain opacity-50 z-60"
          alt="Logo"
        />
      )}

      <AnimatePresence mode="wait">
        {liveItem ? (
          <motion.div
            key={getItemUid(liveItem)}
            className="absolute inset-0 z-10"
            {...getTransitionVariants(
              settings.slide_transition ?? "fade",
              settings.slide_transition_duration ?? 0.4
            )}
          >
            <ErrorBoundary fallback={<ProjectionErrorFallback />}>
            {liveItem.type === "Verse" ? (
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
                      {liveItem.data.text}
                    </h1>
                    {liveItem.data.split_index !== undefined && liveItem.data.total_splits !== undefined && (
                      <p 
                        className="absolute -bottom-10 right-0 font-black opacity-30 text-xs tracking-widest"
                        style={{ color: colors.verseText, fontSize: `${12 * windowScale}pt` }}
                      >
                        PART {liveItem.data.split_index + 1} / {liveItem.data.total_splits}
                      </p>
                    )}
                  </div>
                  {!isTop && ReferenceTag}
                </motion.div>
              </div>
            ) : liveItem.type === "Camera" ? (
              <div className="absolute inset-0">
                <video
                  ref={(el) => {
                    if (el && mainCameraStream) el.srcObject = mainCameraStream;
                    mainCameraRef.current = el;
                  }}
                  autoPlay
                  playsInline
                  className="w-full h-full"
                  style={{
                    objectFit: (liveItem.data.objectFit as any) ?? "cover",
                    opacity: liveItem.data.opacity ?? 1,
                    transform: liveItem.data.mirrored ? "scaleX(-1)" : "none",
                  }}
                />
              </div>
            ) : liveItem.type === "CustomSlide" ? (
              <div className="absolute inset-0">
                <CustomSlideRenderer slide={liveItem.data} scale={windowScale} appDataDir={appDataDir} />
              </div>
            ) : liveItem.type === "Media" ? (
              <div className="absolute inset-0">
                {liveItem.data.media_type === "Image" ? (
                  <img
                    src={convertFileSrc(liveItem.data.path)}
                    className={`w-full h-full ${
                      liveItem.data.fit_mode === "cover" ? "object-cover"
                      : liveItem.data.fit_mode === "fill" ? "object-fill"
                      : "object-contain"
                    }`}
                    alt={liveItem.data.name}
                  />
                ) : (
                  <video
                    ref={videoRef}
                    src={convertFileSrc(liveItem.data.path)}
                    className={`w-full h-full ${
                      liveItem.data.fit_mode === "cover" ? "object-cover"
                      : liveItem.data.fit_mode === "fill" ? "object-fill"
                      : "object-contain"
                    }`}
                    autoPlay
                    loop
                  />
                )}
              </div>
            ) : liveItem.type === "Timer" ? (
              <TimerRenderer data={liveItem.data} />
            ) : liveItem.type === "Song" ? (
              liveItem.data.style === "FullSlide" ? (
                <SongSlideRenderer 
                  data={liveItem.data} 
                  scale={windowScale} 
                  fontSize={settings.font_size}
                  fontFamily={settings.verse_font_family}
                  color={colors.verseText}
                />
              ) : null
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

      <PropsRenderer items={propItems} appDataDir={appDataDir} />

      <AnimatePresence>
        {lowerThird && (
          <LowerThirdOverlay 
            key="lower-third" 
            data={lowerThird.data} 
            template={lowerThird.template} 
            onCycleComplete={handleLtCycleComplete}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
