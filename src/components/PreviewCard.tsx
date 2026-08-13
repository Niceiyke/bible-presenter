import React, { useRef, useState, useCallback, useEffect, useLayoutEffect } from "react";
import { emit } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import {
  Play, Pause, RotateCcw, Volume2, VolumeX, SkipBack, SkipForward, Music,
} from "lucide-react";
import {
  CustomSlideRenderer,
  SongSlideRenderer,
} from "./shared/Renderers";
import { useAppStore } from "../store";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { useReferenceHeight } from "../hooks/useReferenceHeight";
import { THEMES } from "../types";
import type { DisplayItem, MediaItem } from "../types";
import { getEffectiveBackground, getItemUid, getVideoBackground, resolvePath } from "../utils";

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function PreviewCard({
  item,
  label,
  accent,
  badge,
  empty,
  isLocalPreview = false,
  hideHeader = false,
}: {
  item: DisplayItem | null;
  label: string;
  accent: string;
  badge: React.ReactNode;
  empty: string;
  isLocalPreview?: boolean;
  hideHeader?: boolean;
}) {
  const { appDataDir, settings } = useAppStore();
  const isVideo = item?.type === "Media" && (item.data as MediaItem).media_type === "Video";
  const isAudio = item?.type === "Media" && (item.data as MediaItem).media_type === "Audio";
  const isCamera = item?.type === "Camera";
  const showControls = isVideo || isAudio;

  const themeColors = THEMES[settings.theme]?.colors ?? THEMES.dark.colors;
  const effectiveColors = settings.custom_theme_colors ? { ...themeColors, ...settings.custom_theme_colors } : themeColors;
  const refColor = settings.reference_color && settings.reference_color !== "" ? settings.reference_color : effectiveColors.referenceText;
  const bgStyle = item ? getEffectiveBackground(settings, item, effectiveColors, appDataDir) : {};
  const bgVideo = getVideoBackground(settings, item);

  // Measure the 16:9 slide box and scale slide/song fonts against the
  // configured reference (1080p by default) — the same policy
  // `useCanvasScale` uses, so the preview always matches the output
  // proportions regardless of the cockpit's resizable width.
  const slideBoxRef = useRef<HTMLDivElement | null>(null);
  const referenceHeight = useReferenceHeight();
  const [slideScale, setSlideScale] = useState(0.25);

  useLayoutEffect(() => {
    const el = slideBoxRef.current;
    if (!el) return;
    const update = () => setSlideScale(el.clientHeight / referenceHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [item, referenceHeight]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraPreviewRef = useRef<HTMLVideoElement | null>(null);
  const videoCleanupRef = useRef<(() => void) | null>(null);
  const videoItemRef = useRef<MediaItem | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [rate, setRate] = useState(1);

  // Live-mode state feedback from the output window's playback element.
  useTauriEvent("media-state", (state) => {
    if (isLocalPreview || !state) return;
    setPlaying(state.playing);
    setMuted(state.muted);
    setCurrentTime(state.currentTime);
    if (state.duration > 0) setDuration(state.duration);
    setVolume(state.volume);
  });

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setMuted(true);
    setVolume(1);
    setRate(1);
  }, [item]);

  // The video element's ref callback is stable across renders (keyed on
  // `isLocalPreview` only), so it can't capture `item` directly. Keep the
  // current media item in a ref so the callback always reads live data and
  // never sees a stale (null) item during the initial stage/live mount.
  videoItemRef.current = item?.type === "Media" ? (item.data as MediaItem) : null;

  useEffect(() => {
    let activeStream: MediaStream | null = null;

    const startBrowser = async (deviceId: string) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { deviceId: { exact: deviceId } } 
        });
        activeStream = stream;
        if (cameraPreviewRef.current) {
          cameraPreviewRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error("PreviewCard: browser camera failed", err);
      }
    };

    if (isCamera && item?.data.deviceId && !item.data.deviceId.startsWith("native:") && !item.data.deviceId.startsWith("ndi:")) {
      startBrowser(item.data.deviceId);
    }

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach(t => t.stop());
      }
    };
  }, [isCamera, item?.type === "Camera" ? item.data.deviceId : null]);

  const setVideoRefCallback = useCallback(
    (el: HTMLVideoElement | null) => {
      if (videoCleanupRef.current) {
        videoCleanupRef.current();
        videoCleanupRef.current = null;
      }
      videoRef.current = el;
      if (!el || !isLocalPreview) return;

      el.muted = true;
      el.playbackRate = videoItemRef.current?.playback_rate ?? 1;
      el.volume = videoItemRef.current?.volume ?? 1;
      setRate(el.playbackRate);

      const onPlay = () => setPlaying(true);
      const onPause = () => setPlaying(false);
      const onEnded = () => { setPlaying(false); };
      const onTimeUpdate = () => setCurrentTime(el.currentTime);
      const onDuration = () => { if (isFinite(el.duration)) setDuration(el.duration); };

      el.addEventListener("play", onPlay);
      el.addEventListener("pause", onPause);
      el.addEventListener("ended", onEnded);
      el.addEventListener("timeupdate", onTimeUpdate);
      el.addEventListener("durationchange", onDuration);
      el.addEventListener("loadedmetadata", onDuration);

      videoCleanupRef.current = () => {
        el.removeEventListener("play", onPlay);
        el.removeEventListener("pause", onPause);
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("timeupdate", onTimeUpdate);
        el.removeEventListener("durationchange", onDuration);
        el.removeEventListener("loadedmetadata", onDuration);
      };
    },
    [isLocalPreview],
  );

  const handlePlayPause = () => {
    if (isLocalPreview && videoRef.current) {
      if (videoRef.current.paused) videoRef.current.play();
      else videoRef.current.pause();
    } else {
      emit("media-control", { action: "video-play-pause" });
    }
  };

  const handleRestart = () => {
    if (isLocalPreview && videoRef.current) {
      videoRef.current.currentTime = 0;
      setCurrentTime(0);
      videoRef.current.play();
    } else {
      emit("media-control", { action: "video-restart" });
    }
  };

  const handleMuteToggle = () => {
    if (isLocalPreview && videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setMuted(videoRef.current.muted);
    } else {
      emit("media-control", { action: "video-mute-toggle" });
    }
  };

  const handleSkip = (secs: number) => {
    if (isLocalPreview && videoRef.current) {
      videoRef.current.currentTime = Math.max(
        0,
        Math.min(duration || 0, videoRef.current.currentTime + secs),
      );
    } else {
      emit("media-control", { action: "video-seek", currentTime: Math.max(0, Math.min(duration || 0, currentTime + secs)) });
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    if (isLocalPreview && videoRef.current) {
      videoRef.current.currentTime = t;
    } else {
      emit("media-control", { action: "video-seek", currentTime: t });
    }
    setCurrentTime(t);
  };

  const handleVolume = (v: number) => {
    setVolume(v);
    if (isLocalPreview && videoRef.current) videoRef.current.volume = v;
    else emit("media-control", { action: "video-volume", volume: v });
  };

  const handleRate = (r: number) => {
    setRate(r);
    if (isLocalPreview && videoRef.current) videoRef.current.playbackRate = r;
    else emit("media-control", { action: "video-rate", volume: undefined, currentTime: undefined, rate: r });
  };

  const videoPath = isVideo ? convertFileSrc((item!.data as MediaItem).path) : "";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {!hideHeader && (
        <div className="flex justify-between items-center mb-3 shrink-0">
          <h2 className={`text-xs font-bold uppercase tracking-widest ${accent}`}>{label}</h2>
          {badge}
        </div>
      )}
      <div
        className={`flex-1 flex flex-col items-center justify-center bg-black/40 rounded-2xl border border-slate-800 text-center min-h-0 relative group overflow-hidden ${
          item?.type === "Media" ? "p-0" : "p-6"
        }`}
        style={bgStyle}
      >
        {bgVideo?.path && (
          <video
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            style={{ opacity: bgVideo.opacity ?? 1 }}
            src={convertFileSrc(resolvePath(bgVideo.path, appDataDir))}
            autoPlay
            muted={bgVideo.muted ?? true}
            loop={bgVideo.loopVideo ?? true}
            playsInline
          />
        )}
        {item ? (
          <motion.div 
            key={getItemUid(item)}
            className="w-full h-full flex flex-col items-center justify-center relative"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2 }}
          >
            {item.type === "Verse" ? (
              <div ref={slideBoxRef} className="w-full h-full flex flex-col items-center justify-center gap-3 text-center">
                {settings.reference_position === "top" && (
                  <p
                    className="uppercase tracking-widest font-bold shrink-0"
                    style={{ color: refColor, fontSize: `${(settings.reference_font_size ?? 36) * slideScale}px`, fontFamily: settings.reference_font_family ?? "Arial, sans-serif" }}
                  >
                    {item.data.book} {item.data.chapter}:{item.data.verse}
                  </p>
                )}
                <p
                  className="leading-snug"
                  style={{ color: effectiveColors.verseText, fontFamily: settings.verse_font_family ?? "Georgia, serif", fontSize: `${settings.font_size * slideScale}px` }}
                >
                  {item.data.text}
                </p>
                {settings.reference_position !== "top" && (
                  <p
                    className="uppercase tracking-widest font-bold shrink-0"
                    style={{ color: refColor, fontSize: `${(settings.reference_font_size ?? 36) * slideScale}px`, fontFamily: settings.reference_font_family ?? "Arial, sans-serif" }}
                  >
                    {item.data.book} {item.data.chapter}:{item.data.verse}
                  </p>
                )}
              </div>
            ) : item.type === "CustomSlide" ? (
              <div ref={slideBoxRef} className="w-full" style={{ aspectRatio: "16/9" }}>
                <CustomSlideRenderer slide={item.data} scale={slideScale} appDataDir={appDataDir} />
              </div>
            ) : item.type === "Timer" ? (
              <div className="flex flex-col items-center justify-center gap-2">
                <span className="text-4xl font-mono font-black text-cyan-400">⏱</span>
                <p className="text-cyan-400 text-xs font-bold uppercase">{item.data.timer_type}</p>
                {item.data.label && (
                  <p className="text-slate-400 text-[10px]">{item.data.label}</p>
                )}
                {item.data.timer_type === "countdown" && item.data.duration_secs != null && (
                  <p className="text-slate-500 text-[10px] font-mono">
                    {Math.floor(item.data.duration_secs / 60).toString().padStart(2, "0")}:
                    {String(item.data.duration_secs % 60).padStart(2, "0")}
                  </p>
                )}
              </div>
            ) : item.type === "Song" ? (
              <div ref={slideBoxRef} className="w-full" style={{ aspectRatio: "16/9" }}>
                <SongSlideRenderer data={item.data} scale={slideScale} fontSize={settings.font_size} showSectionLabel={!!settings.show_song_section_labels} />
              </div>
            ) : item.type === "Camera" ? (
              <div className="w-full h-full relative border border-slate-800 rounded-lg overflow-hidden bg-black">
                <video
                  ref={cameraPreviewRef}
                  autoPlay
                  playsInline
                  className="w-full h-full object-contain"
                  style={{ transform: item.data.mirrored ? "scaleX(-1)" : "none" }}
                />
                <div className="absolute top-2 left-2 px-1.5 py-0.5 bg-red-500/80 rounded text-[8px] font-black text-white flex items-center gap-1 animate-pulse">
                  <div className="w-1.5 h-1.5 rounded-full bg-white" />
                  LIVE CAMERA
                </div>
              </div>
            ) : (
              <div className="w-full h-full overflow-hidden relative">
                {(item.data as MediaItem).media_type === "Image" ? (
                  <img
                    src={convertFileSrc((item.data as MediaItem).path)}
                    className={`w-full h-full rounded shadow-xl ${({cover:"object-cover",fill:"object-fill"} as Record<string,string>)[(item.data as MediaItem).fit_mode ?? ""] ?? "object-contain"}`}
                    alt={(item.data as MediaItem).name}
                  />
                ) : (item.data as MediaItem).media_type === "Audio" ? (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-slate-900/70 rounded-xl backdrop-blur-sm">
                    <div className="w-16 h-16 rounded-full bg-gradient-to-br from-amber-500/30 to-purple-500/30 border border-amber-500/40 flex items-center justify-center">
                      <Music size={26} className="text-amber-300" />
                    </div>
                    <audio
                      src={convertFileSrc((item.data as MediaItem).path)}
                      controls
                      autoPlay={isLocalPreview}
                      className="w-4/5"
                    />
                  </div>
                ) : (
                  <video
                    key={videoPath}
                    ref={setVideoRefCallback}
                    src={videoPath}
                    className={`w-full h-full rounded ${({cover:"object-cover",fill:"object-fill"} as Record<string,string>)[(item.data as MediaItem).fit_mode ?? ""] ?? "object-contain"}`}
                    preload={isLocalPreview ? "auto" : "metadata"}
                    loop={(item.data as MediaItem).loop_playback ?? true}
                  />
                )}
                {!(isLocalPreview && isVideo) && (
                  <p className="text-slate-400 text-[10px] font-bold uppercase truncate max-w-full absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 px-2 py-0.5 rounded backdrop-blur-sm">
                    {(item.data as MediaItem).name}
                  </p>
                )}
              </div>
            )}

            {showControls && (
              isLocalPreview && isVideo ? (
                <div className="absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-3 pb-2 pt-10 flex flex-col gap-1.5">
                  <p className="text-[9px] text-slate-400 font-bold uppercase truncate text-center mb-0.5">
                    {(item.data as MediaItem).name}
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-slate-400 font-mono w-8 text-right shrink-0">
                      {formatTime(currentTime)}
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={duration || 100}
                      step={0.1}
                      value={currentTime}
                      onChange={handleSeek}
                      className="flex-1 h-1.5 accent-amber-500 cursor-pointer rounded-full"
                    />
                    <span className="text-[9px] text-slate-400 font-mono w-8 shrink-0">
                      {formatTime(duration)}
                    </span>
                  </div>
                  <div className="flex items-center justify-center gap-1.5">
                    <button
                      onClick={() => handleSkip(-10)}
                      className="w-7 h-7 flex items-center justify-center bg-slate-800/80 hover:bg-slate-700 text-slate-300 rounded-full transition-colors"
                      title="Back 10s"
                    >
                      <SkipBack size={12} />
                    </button>
                    <button
                      onClick={handlePlayPause}
                      className="w-9 h-9 flex items-center justify-center bg-amber-500 hover:bg-amber-400 text-black rounded-full transition-colors shadow-lg"
                      title="Play / Pause"
                    >
                      {playing ? <Pause size={16} /> : <Play size={16} />}
                    </button>
                    <button
                      onClick={() => handleSkip(10)}
                      className="w-7 h-7 flex items-center justify-center bg-slate-800/80 hover:bg-slate-700 text-slate-300 rounded-full transition-colors"
                      title="Forward 10s"
                    >
                      <SkipForward size={12} />
                    </button>
                    <div className="w-px h-4 bg-slate-600 mx-0.5" />
                    <button
                      onClick={handleRestart}
                      className="w-7 h-7 flex items-center justify-center bg-slate-800/80 hover:bg-slate-700 text-slate-300 rounded-full transition-colors"
                      title="Restart"
                    >
                      <RotateCcw size={12} />
                    </button>
                    <button
                      onClick={handleMuteToggle}
                      className="w-7 h-7 flex items-center justify-center bg-slate-800/80 hover:bg-slate-700 text-slate-300 rounded-full transition-colors"
                      title="Mute / Unmute"
                    >
                      {muted || volume === 0 ? <VolumeX size={12} /> : <Volume2 size={12} />}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={volume}
                      onChange={(e) => handleVolume(parseFloat(e.target.value))}
                      className="w-16 h-1 accent-slate-400 cursor-pointer rounded-full opacity-60 hover:opacity-100 transition-opacity"
                    />
                    <div className="w-px h-4 bg-slate-600 mx-0.5" />
                    <select
                      value={rate}
                      onChange={(e) => handleRate(parseFloat(e.target.value))}
                      className="h-7 px-1.5 rounded bg-slate-800 text-slate-300 text-[9px] font-bold border border-slate-700"
                      title="Playback speed"
                    >
                      {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                        <option key={r} value={r}>{r}×</option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-slate-900/90 backdrop-blur-md border border-slate-700 p-1.5 rounded-full shadow-2xl transition-all z-20">
                  {(isVideo || (!isLocalPreview && isAudio)) && (
                    <>
                      <button
                        onClick={handlePlayPause}
                        className="w-8 h-8 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full transition-colors"
                        title="Play / Pause"
                      >
                        {playing ? <Pause size={14} /> : <Play size={14} />}
                      </button>
                      <button
                        onClick={() => handleSkip(-10)}
                        className="w-7 h-7 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full transition-colors"
                        title="Back 10s"
                      >
                        <SkipBack size={12} />
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={duration || 100}
                        step={0.1}
                        value={currentTime}
                        onChange={handleSeek}
                        className="w-20 h-1 accent-amber-500 cursor-pointer rounded-full"
                        title="Seek"
                      />
                      <button
                        onClick={() => handleSkip(10)}
                        className="w-7 h-7 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full transition-colors"
                        title="Forward 10s"
                      >
                        <SkipForward size={12} />
                      </button>
                      <button
                        onClick={handleRestart}
                        className="w-8 h-8 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full transition-colors"
                        title="Restart"
                      >
                        <RotateCcw size={14} />
                      </button>
                      <button
                        onClick={handleMuteToggle}
                        className="w-8 h-8 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full transition-colors"
                        title="Mute / Unmute"
                      >
                        {muted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={volume}
                        onChange={(e) => handleVolume(parseFloat(e.target.value))}
                        className="w-16 h-1 accent-slate-400 cursor-pointer rounded-full opacity-60 hover:opacity-100 transition-opacity"
                        title="Volume"
                      />
                      <select
                        value={rate}
                        onChange={(e) => handleRate(parseFloat(e.target.value))}
                        className="h-7 px-1 rounded bg-slate-800 text-slate-300 text-[9px] font-bold border border-slate-700"
                        title="Playback speed"
                      >
                        {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                          <option key={r} value={r}>{r}×</option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
              )
            )}
          </motion.div>
        ) : (
          <p className="text-slate-800 font-serif italic text-sm">{empty}</p>
        )}
      </div>
    </div>
  );
}
