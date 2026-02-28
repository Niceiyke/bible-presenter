import React from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Upload } from "lucide-react";
import { useAppStore } from "../store";
import { CameraFeedRenderer } from "./shared/Renderers";
import type { DisplayItem, CameraSource, MediaFitMode } from "../types";

interface MediaTabProps {
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onAddToSchedule: (item: DisplayItem) => void;
  onLoadMedia: () => void;
  onDeleteMedia: (id: string) => void;
  onSetAsLogo: (path: string) => void;
  onSetAsBackgroundLogo: (path: string) => void;
  remoteUrl: string;
  remotePin: string;
  cameraSources: Map<string, CameraSource>;
  onEnableCameraPreview: (deviceId: string) => void;
  onDisableCameraPreview: (deviceId: string) => void;
  onRemoveCameraSource: (deviceId: string) => void;
  previewVideoMapRef: React.RefObject<Map<string, HTMLVideoElement>>;
  previewObserverMapRef: React.RefObject<Map<string, IntersectionObserver>>;
}

const FIT_OPTIONS: { mode: MediaFitMode; label: string; title: string }[] = [
  { mode: "contain", label: "FIT",    title: "Fit — show entire image, letterbox if needed" },
  { mode: "cover",   label: "CROP",   title: "Crop — fill frame, clip edges to maintain ratio" },
  { mode: "fill",    label: "STRETCH",title: "Stretch — fill frame, ignore aspect ratio" },
];

export function MediaTab({
  onStage,
  onLive,
  onAddToSchedule,
  onLoadMedia,
  onDeleteMedia,
  onSetAsLogo,
  onSetAsBackgroundLogo,
  remoteUrl,
  remotePin,
  cameraSources,
  onEnableCameraPreview,
  onDisableCameraPreview,
  onRemoveCameraSource,
  previewVideoMapRef,
  previewObserverMapRef,
}: MediaTabProps) {
  const {
    media, setMedia,
    cameras, setCameras,
    enabledLocalCameras, setEnabledLocalCameras,
    mediaFilter, setMediaFilter,
    pauseWhisper, setPauseWhisper,
  } = useAppStore();

  async function handleSetFit(id: string, fitMode: MediaFitMode) {
    await invoke("set_media_fit", { id, fitMode });
    setMedia(media.map((m) => m.id === id ? { ...m, fit_mode: fitMode } : m));
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Header + upload */}
      <div className="flex justify-between items-center">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Media Library</h2>
        {mediaFilter !== "camera" && (
          <button onClick={onLoadMedia} className="text-[10px] bg-amber-500 hover:bg-amber-600 text-black font-bold px-3 py-1.5 rounded transition-all flex items-center gap-1.5">
            <Upload size={11} /> UPLOAD
          </button>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-0.5 bg-slate-900/60 rounded-lg p-0.5 border border-slate-800">
        {(["image", "video", "camera"] as const).map((f) => (
          <button
            key={f}
            onClick={() => {
              setMediaFilter(f);
              if (f === "camera") {
                navigator.mediaDevices?.getUserMedia({ video: true })
                  .then((stream) => {
                    stream.getTracks().forEach((t) => t.stop());
                    return navigator.mediaDevices.enumerateDevices();
                  })
                  .then((devs) => setCameras(devs.filter((d) => d.kind === "videoinput")))
                  .catch(() => {
                    navigator.mediaDevices?.enumerateDevices()
                      .then((devs) => setCameras(devs.filter((d) => d.kind === "videoinput")))
                      .catch(() => {});
                  });
              }
            }}
            className={`flex-1 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide transition-all ${
              mediaFilter === f
                ? "bg-amber-500 text-black shadow"
                : "text-slate-500 hover:text-slate-300"
            }`}
          >
            {f === "image"
              ? `Images (${media.filter((m) => m.media_type === "Image").length})`
              : f === "video"
              ? `Videos (${media.filter((m) => m.media_type === "Video").length})`
              : `Cameras (${cameras.length})`}
          </button>
        ))}
      </div>

      {/* Images grid */}
      {mediaFilter === "image" && (
        media.filter((m) => m.media_type === "Image").length === 0 ? (
          <p className="text-slate-700 text-xs italic text-center pt-8">No images. Click + UPLOAD to add.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {media.filter((m) => m.media_type === "Image").map((item) => (
              <div key={item.id} className="flex flex-col bg-slate-800/50 rounded-lg overflow-hidden border border-slate-700 hover:border-slate-600 transition-all">
                <div className="aspect-video overflow-hidden bg-slate-900 shrink-0">
                  <img src={convertFileSrc(item.thumbnail_path || item.path)} className="w-full h-full object-cover" alt={item.name} />
                </div>
                <div className="px-1.5 py-1.5">
                  <p className="text-[8px] text-slate-400 truncate mb-1.5">{item.name}</p>
                  {/* Fit mode selector */}
                  <div className="flex gap-0.5 mb-1.5">
                    {FIT_OPTIONS.map(({ mode, label, title }) => (
                      <button
                        key={mode}
                        onClick={() => handleSetFit(item.id, mode)}
                        title={title}
                        className={`flex-1 text-[7px] font-bold py-0.5 rounded transition-all ${
                          (item.fit_mode ?? "contain") === mode
                            ? "bg-blue-600 text-white"
                            : "bg-slate-700 text-slate-400 hover:text-slate-200"
                        }`}
                      >{label}</button>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    <button onClick={() => onStage({ type: "Media", data: item })} className="bg-slate-700 hover:bg-slate-600 text-white text-[7px] font-bold py-1.5 rounded transition-all" title="Stage">STG</button>
                    <button onClick={() => onLive({ type: "Media", data: item })} className="bg-amber-500 hover:bg-amber-400 text-black text-[7px] font-bold py-1.5 rounded transition-all" title="Display Live">LIVE</button>
                    <button onClick={() => onAddToSchedule({ type: "Media", data: item })} className="bg-slate-700 hover:bg-slate-600 text-amber-400 text-[7px] font-bold py-1.5 rounded transition-all" title="Add to Queue">+Q</button>
                    <button onClick={() => onSetAsBackgroundLogo(item.path)} className="bg-purple-900/50 hover:bg-purple-700 text-purple-300 text-[7px] font-bold py-1.5 rounded transition-all" title="Set as Background Logo">BG LOGO</button>
                    <button onClick={() => onSetAsLogo(item.path)} className="bg-teal-900/50 hover:bg-teal-700 text-teal-300 text-[7px] font-bold py-1.5 rounded transition-all" title="Set as Corner Logo">CORNER</button>
                    <button onClick={() => onDeleteMedia(item.id)} className="bg-red-900/50 hover:bg-red-800 text-red-300 text-[7px] font-bold py-1.5 rounded transition-all" title="Delete">DEL</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Videos grid */}
      {mediaFilter === "video" && (
        media.filter((m) => m.media_type === "Video").length === 0 ? (
          <p className="text-slate-700 text-xs italic text-center pt-8">No videos. Click + UPLOAD to add.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {media.filter((m) => m.media_type === "Video").map((item) => (
              <div key={item.id} className="flex flex-col bg-slate-800/50 rounded-lg overflow-hidden border border-slate-700 hover:border-slate-600 transition-all">
                <div className="aspect-video overflow-hidden bg-slate-900 relative shrink-0">
                  <video src={convertFileSrc(item.path)} className="w-full h-full object-cover" muted preload="metadata" />
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <span className="text-white/50 text-xl">▶</span>
                  </div>
                </div>
                <div className="px-1.5 py-1.5">
                  <p className="text-[8px] text-slate-400 truncate mb-1.5">{item.name}</p>
                  {/* Fit mode selector */}
                  <div className="flex gap-0.5 mb-1.5">
                    {FIT_OPTIONS.map(({ mode, label, title }) => (
                      <button
                        key={mode}
                        onClick={() => handleSetFit(item.id, mode)}
                        title={title}
                        className={`flex-1 text-[7px] font-bold py-0.5 rounded transition-all ${
                          (item.fit_mode ?? "contain") === mode
                            ? "bg-blue-600 text-white"
                            : "bg-slate-700 text-slate-400 hover:text-slate-200"
                        }`}
                      >{label}</button>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    <button onClick={() => onStage({ type: "Media", data: item })} className="bg-slate-700 hover:bg-slate-600 text-white text-[7px] font-bold py-1.5 rounded transition-all" title="Stage">STG</button>
                    <button onClick={() => onLive({ type: "Media", data: item })} className="bg-amber-500 hover:bg-amber-400 text-black text-[7px] font-bold py-1.5 rounded transition-all" title="Display Live">LIVE</button>
                    <button onClick={() => onAddToSchedule({ type: "Media", data: item })} className="bg-slate-700 hover:bg-slate-600 text-amber-400 text-[7px] font-bold py-1.5 rounded transition-all" title="Add to Queue">+Q</button>
                    <button onClick={() => onSetAsBackgroundLogo(item.path)} className="bg-purple-900/50 hover:bg-purple-700 text-purple-300 text-[7px] font-bold py-1.5 rounded transition-all" title="Set as Background Logo">BG LOGO</button>
                    <button onClick={() => onSetAsLogo(item.path)} className="bg-teal-900/50 hover:bg-teal-700 text-teal-300 text-[7px] font-bold py-1.5 rounded transition-all" title="Set as Corner Logo">CORNER</button>
                    <button onClick={() => onDeleteMedia(item.id)} className="bg-red-900/50 hover:bg-red-800 text-red-300 text-[7px] font-bold py-1.5 rounded transition-all" title="Delete">DEL</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* Camera feed tab */}
      {mediaFilter === "camera" && (
        <>
          {/* LAN Camera Input Bank */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">LAN Camera Inputs</h3>
              <div className="flex items-center gap-2">
                {cameraSources.size > 0 && (
                  <span className="text-[8px] text-green-400 font-bold">{cameraSources.size} connected</span>
                )}
                {cameraSources.size > 0 && (
                  <button
                    onClick={() => setPauseWhisper((p) => !p)}
                    className={`flex items-center gap-1 text-[8px] font-bold px-2 py-1 rounded border transition-all ${
                      pauseWhisper
                        ? "bg-amber-500/20 border-amber-500/50 text-amber-400"
                        : "bg-slate-700/50 border-slate-600 text-slate-400 hover:text-slate-300"
                    }`}
                  >
                    {pauseWhisper ? "⏸ Whisper" : "🎙 Whisper"}
                  </button>
                )}
                <a
                  href={`${remoteUrl || "http://localhost:7420"}/camera`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[8px] bg-blue-600 hover:bg-blue-500 text-white font-bold px-2 py-1 rounded transition-all"
                >
                  + ADD
                </a>
              </div>
            </div>
            {cameraSources.size === 0 ? (
              <div className="text-center py-6 text-slate-600 text-xs">
                <p className="mb-2">No LAN cameras connected.</p>
                <p className="text-[9px]">Share <span className="text-amber-400 font-mono">{remoteUrl || "http://…"}/camera</span> with a phone and enter PIN <span className="text-amber-400 font-mono">{remotePin || "––––"}</span>.</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {Array.from(cameraSources.values()).map((src) => (
                  <div key={src.device_id} className={`flex flex-col rounded-lg overflow-hidden border transition-all ${src.enabled ? "bg-slate-800/50 border-slate-700 hover:border-slate-600" : "bg-slate-900/50 border-slate-800"}`}>
                    <div className="aspect-video overflow-hidden bg-slate-900 shrink-0 relative">
                      <button
                        onClick={() => onRemoveCameraSource(src.device_id)}
                        className="absolute top-1 left-1 z-10 text-[9px] bg-red-700/80 hover:bg-red-500 text-white w-4 h-4 flex items-center justify-center rounded font-bold transition-all leading-none"
                      >×</button>

                      {src.enabled ? (
                        <>
                          <video
                            ref={(el) => {
                              const oldObs = previewObserverMapRef.current?.get(src.device_id);
                              if (el) {
                                previewVideoMapRef.current?.set(src.device_id, el);
                                if (src.previewStream && !el.srcObject) el.srcObject = src.previewStream;
                                if (oldObs) oldObs.disconnect();
                                const obs = new IntersectionObserver(
                                  (entries) => entries.forEach((entry) => {
                                    const v = previewVideoMapRef.current?.get(src.device_id);
                                    if (v) {
                                      if (entry.isIntersecting) v.play().catch(() => {});
                                      else v.pause();
                                    }
                                  }),
                                  { threshold: 0.1 }
                                );
                                obs.observe(el);
                                previewObserverMapRef.current?.set(src.device_id, obs);
                              } else {
                                if (oldObs) { oldObs.disconnect(); previewObserverMapRef.current?.delete(src.device_id); }
                                previewVideoMapRef.current?.delete(src.device_id);
                              }
                            }}
                            className="w-full h-full object-cover"
                            autoPlay muted playsInline
                          />
                          {src.status !== "connected" && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                              <span className="text-[8px] text-slate-400 animate-pulse">
                                {src.status === "connecting" ? "Connecting…" : "Offline"}
                              </span>
                            </div>
                          )}
                          <div className={`absolute top-1 right-1 text-[7px] font-bold px-1.5 py-0.5 rounded ${src.status === "connected" ? "bg-green-500/90 text-white" : "bg-slate-700/90 text-slate-400"}`}>
                            {src.status === "connected" ? "● LIVE" : "◌"}
                          </div>
                        </>
                      ) : (
                        <button
                          onClick={() => onEnableCameraPreview(src.device_id)}
                          className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-slate-600 hover:text-slate-400 transition-all"
                        >
                          <span className="text-lg leading-none">⏻</span>
                          <span className="text-[8px]">Enable</span>
                        </button>
                      )}
                    </div>
                    <div className="px-1.5 py-1.5">
                      <div className="flex items-center gap-1 mb-1.5">
                        <p className="text-[8px] text-slate-300 truncate font-medium flex-1">
                          {src.device_name || `Camera ${src.device_id.slice(0, 8)}`}
                        </p>
                        <button
                          onClick={() => src.enabled ? onDisableCameraPreview(src.device_id) : onEnableCameraPreview(src.device_id)}
                          className={`text-[8px] font-bold px-1.5 py-0.5 rounded border transition-all shrink-0 ${
                            src.enabled
                              ? "bg-green-600/20 border-green-500/40 text-green-400 hover:bg-red-600/20 hover:border-red-500/40 hover:text-red-400"
                              : "bg-slate-700/50 border-slate-600 text-slate-500 hover:text-slate-300"
                          }`}
                        >{src.enabled ? "ON" : "OFF"}</button>
                      </div>
                      <div className="grid grid-cols-3 gap-0.5">
                        <button
                          onClick={() => onStage({ type: "CameraFeed", data: { device_id: src.device_id, label: src.device_name || src.device_id, lan: true, device_name: src.device_name } })}
                          className="bg-slate-700 hover:bg-slate-600 text-white text-[8px] font-bold py-1 rounded transition-all"
                        >STAGE</button>
                        <button
                          onClick={() => onLive({ type: "CameraFeed", data: { device_id: src.device_id, label: src.device_name || src.device_id, lan: true, device_name: src.device_name } })}
                          className="bg-amber-500 hover:bg-amber-400 text-black text-[8px] font-bold py-1 rounded transition-all"
                        >LIVE</button>
                        <button
                          onClick={() => onAddToSchedule({ type: "CameraFeed", data: { device_id: src.device_id, label: src.device_name || src.device_id, lan: true, device_name: src.device_name } })}
                          className="bg-slate-700 hover:bg-slate-600 text-amber-400 text-[8px] font-bold py-1 rounded transition-all"
                        >+Q</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Local Camera Inputs */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Local Cameras</h3>
              <button
                onClick={() =>
                  navigator.mediaDevices?.enumerateDevices()
                    .then((devs) => setCameras(devs.filter((d) => d.kind === "videoinput")))
                    .catch(() => {})
                }
                className="text-[9px] bg-slate-700 hover:bg-slate-600 text-slate-300 font-bold px-2 py-1 rounded transition-all border border-slate-600"
              >
                ↺ Refresh
              </button>
            </div>
            {cameras.length === 0 ? (
              <p className="text-slate-700 text-xs italic text-center pt-4">No cameras found.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {cameras.map((cam) => {
                  const isOn = enabledLocalCameras.has(cam.deviceId);
                  return (
                    <div key={cam.deviceId} className={`flex flex-col rounded-lg overflow-hidden border transition-all ${isOn ? "bg-slate-800/50 border-slate-700 hover:border-slate-600" : "bg-slate-900/50 border-slate-800"}`}>
                      <div className="aspect-video overflow-hidden bg-slate-900 shrink-0 relative">
                        <button
                          onClick={() => {
                            setCameras(cameras.filter((c) => c.deviceId !== cam.deviceId));
                            setEnabledLocalCameras((prev) => { const next = new Set(prev); next.delete(cam.deviceId); return next; });
                          }}
                          className="absolute top-1 left-1 z-10 text-[9px] bg-red-700/80 hover:bg-red-500 text-white w-4 h-4 flex items-center justify-center rounded font-bold transition-all leading-none"
                        >×</button>
                        {isOn ? (
                          <CameraFeedRenderer deviceId={cam.deviceId} />
                        ) : (
                          <button
                            onClick={() => setEnabledLocalCameras((prev) => new Set([...prev, cam.deviceId]))}
                            className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-slate-600 hover:text-slate-400 transition-all"
                          >
                            <span className="text-lg leading-none">⏻</span>
                            <span className="text-[8px]">Enable</span>
                          </button>
                        )}
                      </div>
                      <div className="px-1.5 py-1.5">
                        <div className="flex items-center gap-1 mb-1.5">
                          <p className="text-[8px] text-slate-300 truncate font-medium flex-1">{cam.label || `Camera ${cam.deviceId.slice(0, 8)}`}</p>
                          <button
                            onClick={() => setEnabledLocalCameras((prev) => {
                              const next = new Set(prev);
                              if (isOn) next.delete(cam.deviceId); else next.add(cam.deviceId);
                              return next;
                            })}
                            className={`text-[8px] font-bold px-1.5 py-0.5 rounded border transition-all shrink-0 ${
                              isOn
                                ? "bg-green-600/20 border-green-500/40 text-green-400"
                                : "bg-slate-700/50 border-slate-600 text-slate-500"
                            }`}
                          >{isOn ? "ON" : "OFF"}</button>
                        </div>
                        <div className="grid grid-cols-3 gap-0.5">
                          <button
                            onClick={() => onStage({ type: "CameraFeed", data: { device_id: cam.deviceId, label: cam.label } })}
                            className="bg-slate-700 hover:bg-slate-600 text-white text-[8px] font-bold py-1 rounded transition-all"
                          >STAGE</button>
                          <button
                            onClick={() => onLive({ type: "CameraFeed", data: { device_id: cam.deviceId, label: cam.label } })}
                            className="bg-amber-500 hover:bg-amber-400 text-black text-[8px] font-bold py-1 rounded transition-all"
                          >LIVE</button>
                          <button
                            onClick={() => onAddToSchedule({ type: "CameraFeed", data: { device_id: cam.deviceId, label: cam.label } })}
                            className="bg-slate-700 hover:bg-slate-600 text-amber-400 text-[8px] font-bold py-1 rounded transition-all"
                          >+Q</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
