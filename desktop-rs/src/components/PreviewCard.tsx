import React from "react";
import { emit } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { RefreshCw, Clock, MicOff, EyeOff } from "lucide-react";
import { 
  CustomSlideRenderer, 
  CameraFeedRenderer, 
  SceneRenderer, 
  TimerRenderer 
} from "./shared/Renderers";
import type { DisplayItem, MediaItem } from "../types";

export function PreviewCard({
  item,
  label,
  accent,
  badge,
  empty,
}: {
  item: DisplayItem | null;
  label: string;
  accent: string;
  badge: React.ReactNode;
  empty: string;
}) {
  const isVideo = item?.type === "Media" && item.data.media_type === "Video";
  const isCamera = item?.type === "CameraFeed";
  const showControls = isVideo || isCamera;

  const sendMediaControl = (action: string, value?: any) => {
    const payload = { action, value };
    console.log("Emitting media-control:", payload);
    emit("media-control", payload);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex justify-between items-center mb-3 shrink-0">
        <h2 className={`text-xs font-bold uppercase tracking-widest ${accent}`}>{label}</h2>
        {badge}
      </div>
      <div className={`flex-1 flex flex-col items-center justify-center bg-black/40 rounded-2xl border border-slate-800 text-center min-h-0 relative group ${item?.type === "Media" || item?.type === "CameraFeed" ? "p-0 overflow-hidden" : "p-6"}`}>
        {item ? (
          <div className="animate-in fade-in zoom-in-95 duration-300 w-full h-full flex flex-col items-center justify-center relative">
            {item.type === "Verse" ? (
              <div className="flex flex-col items-center justify-center gap-3">
                <p className="text-xl font-serif text-slate-300 leading-snug line-clamp-5">
                  {item.data.text}
                </p>
                <p className="text-amber-500 font-bold uppercase tracking-widest text-sm shrink-0">
                  {item.data.book} {item.data.chapter}:{item.data.verse}
                </p>
              </div>
            ) : item.type === "PresentationSlide" ? (
              <div className="flex flex-col items-center justify-center gap-3">
                <div className="text-orange-400 text-xs font-black uppercase bg-orange-400/10 px-2 py-0.5 rounded">
                  SLIDE {item.data.slide_index + 1} / {item.data.slide_count || "?"}
                </div>
                <p className="text-slate-400 text-xs font-bold truncate max-w-full">
                  {item.data.presentation_name}
                </p>
              </div>
            ) : item.type === "CustomSlide" ? (
              <div className="w-full" style={{ aspectRatio: "16/9" }}>
                <CustomSlideRenderer slide={item.data} scale={0.25} />
              </div>
            ) : item.type === "CameraFeed" ? (
              <div className="w-full h-full rounded overflow-hidden relative">
                {item.data.lan ? (
                  <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900/60 gap-2">
                    <span className="text-3xl">📷</span>
                    <p className="text-teal-400 text-[10px] font-bold uppercase text-center px-2">
                      {item.data.device_name || item.data.label || "LAN Camera"}
                    </p>
                    <span className="text-[8px] text-green-400 font-bold bg-green-500/10 px-2 py-0.5 rounded">● LAN</span>
                  </div>
                ) : (
                  <CameraFeedRenderer deviceId={item.data.device_id} />
                )}
                <p className="text-teal-400 text-[10px] font-bold uppercase truncate max-w-full absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 px-2 py-0.5 rounded backdrop-blur-sm">
                  {item.data.device_name || item.data.label || item.data.device_id.slice(0, 16)}
                </p>
              </div>
            ) : item.type === "Scene" ? (
              <div className="w-full h-full relative border border-slate-800 rounded-lg overflow-hidden">
                <SceneRenderer scene={item.data} scale={0.25} />
              </div>
            ) : item.type === "Timer" ? (
              <div className="flex flex-col items-center justify-center gap-2">
                <span className="text-4xl font-mono font-black text-cyan-400">⏱</span>
                <p className="text-cyan-400 text-xs font-bold uppercase">{item.data.timer_type}</p>
                {item.data.label && <p className="text-slate-400 text-[10px]">{item.data.label}</p>}
                {item.data.timer_type === "countdown" && item.data.duration_secs != null && (
                  <p className="text-slate-500 text-[10px] font-mono">
                    {Math.floor(item.data.duration_secs / 60).toString().padStart(2,"0")}:{String(item.data.duration_secs % 60).padStart(2,"0")}
                  </p>
                )}
              </div>
            ) : (
              <div className="w-full h-full overflow-hidden flex flex-col items-center justify-center relative">
                {(item.data as MediaItem).media_type === "Image" ? (
                  <img
                    src={convertFileSrc((item.data as MediaItem).path)}
                    className="w-full h-full object-contain rounded shadow-xl"
                    alt={(item.data as MediaItem).name}
                  />
                ) : (
                  <video
                    src={convertFileSrc((item.data as MediaItem).path)}
                    className="w-full h-full object-contain rounded"
                    muted
                    preload="metadata"
                  />
                )}
                <p className="text-slate-400 text-[10px] font-bold uppercase truncate max-w-full absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 px-2 py-0.5 rounded backdrop-blur-sm">
                  {(item.data as MediaItem).name}
                </p>
              </div>
            )}

            {showControls && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-slate-900/90 backdrop-blur-md border border-slate-700 p-1.5 rounded-full shadow-2xl transition-all z-20">
                {isVideo && (
                  <>
                    <button
                      onClick={() => sendMediaControl("video-play-pause")}
                      className="w-8 h-8 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full transition-colors"
                      title="Play / Pause"
                    >
                      <RefreshCw size={14} />
                    </button>
                    <button
                      onClick={() => sendMediaControl("video-restart")}
                      className="w-8 h-8 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full transition-colors"
                      title="Restart"
                    >
                      <Clock size={14} />
                    </button>
                    <button
                      onClick={() => sendMediaControl("video-mute-toggle")}
                      className="w-8 h-8 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full transition-colors"
                      title="Mute / Unmute"
                    >
                      <MicOff size={14} />
                    </button>
                  </>
                )}
                {isCamera && (
                   <button
                   onClick={() => sendMediaControl("camera-mute-toggle")}
                   className="w-8 h-8 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-full transition-colors"
                   title="Hide / Show Camera"
                 >
                   <EyeOff size={14} />
                 </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-slate-800 font-serif italic text-sm">{empty}</p>
        )}
      </div>
    </div>
  );
}
