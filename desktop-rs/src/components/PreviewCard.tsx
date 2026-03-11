import React, { useRef, useState, useCallback, useEffect } from "react";
import { emit } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play, Pause, RotateCcw, Volume2, VolumeX, SkipBack, SkipForward,
} from "lucide-react";
import {
  CustomSlideRenderer,
  SceneRenderer,
  SongSlideRenderer,
} from "./shared/Renderers";
import { useAppStore } from "../store";
import { useNativeStream } from "../hooks/useNativeStream";
import type { DisplayItem, MediaItem } from "../types";
import { getItemUid } from "../utils";

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
  /** When true, video controls act on the local preview element only (stage panel).
   *  When false (default), controls emit media-control events to the output window. */
  isLocalPreview?: boolean;
  /** When true, suppresses the label/badge header row entirely. */
  hideHeader?: boolean;
}) {
  const { appDataDir } = useAppStore();
  const isVideo = item?.type === "Media" && (item.data as MediaItem).media_type === "Video";
  const isCamera = item?.type === "Camera";
  const showControls = isVideo;

  // Local preview video state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cameraPreviewRef = useRef<HTMLVideoElement | null>(null);
  const [useNativePreview, setUseNativePreview] = useState(false);
  const nativeFrameUrl = useNativeStream(useNativePreview);
  const videoCleanupRef = useRef<(() => void) | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);

  // Reset playback state when item changes
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setMuted(true);
    setVolume(1);
  }, [item]);

  // Manage camera preview stream
  useEffect(() => {
    let activeStream: MediaStream | null = null;
    let frameLoopActive = false;

    const startBrowser = async (deviceId: string) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { deviceId: { exact: deviceId } } 
        });
        activeStream = stream;
        setUseNativePreview(false);
        if (cameraPreviewRef.current) {
          cameraPreviewRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error("PreviewCard: browser camera failed", err);
      }
    };

    const startNative = async (id: string) => {
      const isNdi = id.startsWith("ndi:");
      const val = id.split(":")[1];
      if (!isNdi) {
        await invoke("start_camera_stream", { index: parseInt(val) });
      }
      setUseNativePreview(true);
    };

    if (isCamera && item?.data.deviceId) {
      if (item.data.deviceId.startsWith("native:") || item.data.deviceId.startsWith("ndi:")) {
        startNative(item.data.deviceId);
      } else {
        startBrowser(item.data.deviceId);
      }
    }

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach(t => t.stop());
      }
    };
  }, [isCamera, item?.type === "Camera" ? item.data.deviceId : null]);

  // Callback ref — attaches DOM event listeners for local preview; cleans up on unmount/swap
  const setVideoRefCallback = useCallback(
    (el: HTMLVideoElement | null) => {
      // Tear down previous listeners
      if (videoCleanupRef.current) {
        videoCleanupRef.current();
        videoCleanupRef.current = null;
      }
      videoRef.current = el;
      if (!el || !isLocalPreview) return;

      // Start muted
      el.muted = true;

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

  // ── Controls ────────────────────────────────────────────────────────────────

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
    if (!videoRef.current) return;
    videoRef.current.currentTime = Math.max(
      0,
      Math.min(duration || 0, videoRef.current.currentTime + secs),
    );
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!videoRef.current) return;
    const t = parseFloat(e.target.value);
    videoRef.current.currentTime = t;
    setCurrentTime(t);
  };

  // ── Render ──────────────────────────────────────────────────────────────────

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
        className={`flex-1 flex flex-col items-center justify-center bg-black/40 rounded-2xl border border-slate-800 text-center min-h-0 relative group ${
          item?.type === "Media" || item?.type === "Scene" ? "p-0 overflow-hidden" : "p-6"
        }`}
      >
        {item ? (
          <motion.div 
            key={getItemUid(item)}
            className="w-full h-full flex flex-col items-center justify-center relative"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2 }}
          >
            {item.type === "Verse" ? (
              <div className="flex flex-col items-center justify-center gap-3">
                <p className="text-xl font-serif text-slate-300 leading-snug line-clamp-5">
                  {item.data.text}
                </p>
                <p className="text-amber-500 font-mono font-bold uppercase tracking-widest text-sm shrink-0">
                  {item.data.book} {item.data.chapter}:{item.data.verse}
                </p>
              </div>
            ) : item.type === "CustomSlide" ? (
              <div className="w-full" style={{ aspectRatio: "16/9" }}>
                <CustomSlideRenderer slide={item.data} scale={0.25} appDataDir={appDataDir} />
              </div>
            ) : item.type === "Scene" ? (
              <div className="w-full h-full relative border border-slate-800 rounded-lg overflow-hidden">
                <SceneRenderer scene={item.data} scale={0.25} appDataDir={appDataDir} />
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
              <div className="w-full" style={{ aspectRatio: "16/9" }}>
                <SongSlideRenderer data={item.data} scale={0.25} fontSize={48} />
              </div>
            ) : item.type === "Camera" ? (
              <div className="w-full h-full relative border border-slate-800 rounded-lg overflow-hidden bg-black">
                {useNativePreview ? (
                  <img
                    src={nativeFrameUrl}
                    crossOrigin="anonymous"
                    className="w-full h-full object-contain"
                    style={{ transform: item.data.mirrored ? "scaleX(-1)" : "none" }}
                    alt="Native Preview"
                  />
                ) : (
                  <video
                    ref={cameraPreviewRef}
                    autoPlay
                    playsInline
                    className="w-full h-full object-contain"
                    style={{ transform: item.data.mirrored ? "scaleX(-1)" : "none" }}
                  />
                )}
                <div className="absolute top-2 left-2 px-1.5 py-0.5 bg-red-500/80 rounded text-[8px] font-black text-white flex items-center gap-1 animate-pulse">
                  <div className="w-1.5 h-1.5 rounded-full bg-white" />
                  LIVE CAMERA
                </div>
              </div>
            ) : (
              /* Media (image or video) */
              <div className="w-full h-full overflow-hidden relative">
                {(item.data as MediaItem).media_type === "Image" ? (
                  <img
                    src={convertFileSrc((item.data as MediaItem).path)}
                    className={`w-full h-full rounded shadow-xl ${({cover:"object-cover",fill:"object-fill"} as Record<string,string>)[(item.data as MediaItem).fit_mode ?? ""] ?? "object-contain"}`}
                    alt={(item.data as MediaItem).name}
                  />
                ) : (
                  /* Video — key forces remount when src changes so ref fires fresh */
                  <video
                    key={videoPath}
                    ref={setVideoRefCallback}
                    src={videoPath}
                    className={`w-full h-full rounded ${({cover:"object-cover",fill:"object-fill"} as Record<string,string>)[(item.data as MediaItem).fit_mode ?? ""] ?? "object-contain"}`}
                    preload={isLocalPreview ? "auto" : "metadata"}
                  />
                )}
                {/* Filename label — hidden when local preview controls cover the bottom */}
                {!(isLocalPreview && isVideo) && (
                  <p className="text-slate-400 text-[10px] font-bold uppercase truncate max-w-full absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 px-2 py-0.5 rounded backdrop-blur-sm">
                    {(item.data as MediaItem).name}
                  </p>
                )}
              </div>
            )}

            {/* ── Controls overlay ── */}
            {showControls && (
              isLocalPreview && isVideo ? (
                /* Rich overlay for operator stage preview */
                <div className="absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-3 pb-2 pt-10 flex flex-col gap-1.5">
                  {/* Filename */}
                  <p className="text-[9px] text-slate-400 font-bold uppercase truncate text-center mb-0.5">
                    {(item.data as MediaItem).name}
                  </p>
                  {/* Scrubber */}
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
                  {/* Buttons */}
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
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        setVolume(v);
                        if (isLocalPreview && videoRef.current) videoRef.current.volume = v;
                        else emit("media-control", { action: "video-volume", volume: v });
                      }}
                      className="w-16 h-1 accent-slate-400 cursor-pointer rounded-full opacity-60 hover:opacity-100 transition-opacity"
                    />
                  </div>
                </div>
              ) : (
                /* Pill controls for live card */
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-slate-900/90 backdrop-blur-md border border-slate-700 p-1.5 rounded-full shadow-2xl transition-all z-20">
                  {isVideo && (
                    <>
                      <button
                        onClick={handlePlayPause}
                        className="w-8 h-8 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full transition-colors"
                        title="Play / Pause"
                      >
                        <Play size={14} />
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
                        <VolumeX size={14} />
                      </button>
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
