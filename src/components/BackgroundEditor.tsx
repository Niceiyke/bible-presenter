import React, { useState, useEffect } from "react";
import { MediaPickerModal } from "./MediaPickerModal";
import { useAppStore } from "../store";
import { relativizePath } from "../utils";
import type { BackgroundSetting, VideoBackground, CameraBackground, AudioBackground, ImageBackground, MediaItem } from "../types";

const DEFAULT_IMAGE_BG: ImageBackground = {
  path: "",
  objectFit: "cover",
  opacity: 1,
};

const DEFAULT_VIDEO_BG: VideoBackground = {
  path: "",
  loopVideo: true,
  muted: true,
  objectFit: "cover",
  opacity: 1,
  playbackRate: 1,
};

const DEFAULT_CAMERA_BG: CameraBackground = {
  deviceId: "",
  opacity: 1,
  objectFit: "cover",
  mirrored: false,
};

const DEFAULT_AUDIO_BG: AudioBackground = {
  path: "",
  loopAudio: true,
  volume: 1,
};

export function BackgroundEditor({
  label,
  value,
  onChange,
  media = [],
  onUploadMedia = async () => {},
}: {
  label: string;
  value: BackgroundSetting | undefined;
  onChange: (bg: BackgroundSetting) => void;
  media?: MediaItem[];
  onUploadMedia?: () => Promise<void>;
}) {
  const { appDataDir, availableCameras, refreshCameras } = useAppStore();
  const [pickerMode, setPickerMode] = useState<null | "image" | "video" | "audio">(null);
  const current: BackgroundSetting = value ?? { type: "None" };

  const vbg = current.type === "Video" ? (current as { type: "Video"; value: VideoBackground }).value : null;
  const cbg = current.type === "Camera" ? (current as { type: "Camera"; value: CameraBackground }).value : null;
  const abg = current.type === "Audio" ? (current as { type: "Audio"; value: AudioBackground }).value : null;
  const ibg = current.type === "Image" ? (current as { type: "Image"; value: ImageBackground }).value : null;

  const updateVbg = (patch: Partial<VideoBackground>) =>
    onChange({ type: "Video", value: { ...(vbg ?? DEFAULT_VIDEO_BG), ...patch } });

  const updateCbg = (patch: Partial<CameraBackground>) =>
    onChange({ type: "Camera", value: { ...(cbg ?? DEFAULT_CAMERA_BG), ...patch } });

  const updateAbg = (patch: Partial<AudioBackground>) =>
    onChange({ type: "Audio", value: { ...(abg ?? DEFAULT_AUDIO_BG), ...patch } });

  const updateIbg = (patch: Partial<ImageBackground>) =>
    onChange({ type: "Image", value: { ...(ibg ?? DEFAULT_IMAGE_BG), ...patch } });

  useEffect(() => {
    if (current.type === "Camera" && availableCameras.length === 0) {
      refreshCameras();
    }
  }, [current.type]);

  return (
    <>
      <div>
        {label && <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mb-1.5">{label}</p>}
        <div className="flex gap-1.5 mb-1.5 overflow-x-auto pb-1 no-scrollbar">
          {(["None", "Color", "Image", "Video", "Camera", "Audio"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                if (mode === "None") onChange({ type: "None" });
                else if (mode === "Color") onChange({ type: "Color", value: current.type === "Color" ? (current as any).value : "#000000" });
                else if (mode === "Image") onChange({ type: "Image", value: current.type === "Image" ? (current as any).value : { path: "", objectFit: "cover", opacity: 1 } });
                else if (mode === "Video") onChange({ type: "Video", value: current.type === "Video" ? (current as any).value : { ...DEFAULT_VIDEO_BG } });
                else if (mode === "Camera") onChange({ type: "Camera", value: current.type === "Camera" ? (current as any).value : { ...DEFAULT_CAMERA_BG } });
                else onChange({ type: "Audio", value: current.type === "Audio" ? (current as any).value : { ...DEFAULT_AUDIO_BG } });
              }}
              className={`flex-none px-3 py-1 rounded text-[9px] font-bold border transition-all ${
                current.type === mode ? "border-amber-500 bg-amber-500/10 text-amber-400" : "border-slate-700 bg-slate-800/50 text-slate-500 hover:border-slate-600"
              }`}
            >
              {mode === "None" ? "Inherit" : mode}
            </button>
          ))}
        </div>

        {current.type === "Color" && (
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={(current as { type: "Color"; value: string }).value}
              onChange={(e) => onChange({ type: "Color", value: e.target.value })}
              className="w-8 h-8 rounded cursor-pointer border border-slate-700 bg-transparent"
            />
            <span className="text-[9px] font-mono text-slate-500">{(current as { type: "Color"; value: string }).value}</span>
          </div>
        )}

        {current.type === "Image" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPickerMode("image")}
                className="flex-1 py-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-[9px] font-bold text-slate-300 transition-all"
              >
                {(current as { type: "Image"; value: ImageBackground }).value?.path ? "Change from Library..." : "Pick from Library..."}
              </button>
              {(current as { type: "Image"; value: ImageBackground }).value?.path && (
                <button
                  onClick={() => onChange({ type: "Image", value: { path: "", objectFit: "cover", opacity: 1 } })}
                  className="text-red-500/70 hover:text-red-400 text-[10px] font-bold shrink-0"
                  title="Clear image"
                >✕</button>
              )}
            </div>
            {(current as { type: "Image"; value: ImageBackground }).value?.path && (
              <p className="text-[8px] text-slate-600 truncate -mt-1">
                {(current as { type: "Image"; value: ImageBackground }).value.path.split(/[/\\]/).pop()}
              </p>
            )}

            {/* Fit */}
            <div>
              <p className="text-[8px] text-slate-600 uppercase font-bold mb-1">Fit</p>
              <div className="flex gap-1">
                {(["cover", "contain", "fill"] as const).map((fit) => (
                  <button
                    key={fit}
                    onClick={() => updateIbg({ objectFit: fit })}
                    className={`flex-1 py-0.5 rounded text-[8px] font-bold border transition-all capitalize ${
                      ibg?.objectFit === fit
                        ? "border-amber-500 bg-amber-500/10 text-amber-400"
                        : "border-slate-700 bg-slate-800/50 text-slate-500"
                    }`}
                  >
                    {fit === "contain" ? "Fit" : fit === "cover" ? "Crop" : "Stretch"}
                  </button>
                ))}
              </div>
            </div>

            {/* Opacity */}
            <div>
              <div className="flex justify-between mb-0.5">
                <p className="text-[8px] text-slate-600 uppercase font-bold">Opacity</p>
                <span className="text-[8px] text-slate-500">{Math.round((ibg?.opacity ?? 1) * 100)}%</span>
              </div>
              <input
                type="range" min="0" max="1" step="0.05"
                value={ibg?.opacity ?? 1}
                onChange={(e) => updateIbg({ opacity: parseFloat(e.target.value) })}
                className="w-full h-1 appearance-none bg-slate-700 rounded accent-amber-500 cursor-pointer"
              />
            </div>
          </div>
        )}

        {vbg !== null && (
          <div className="flex flex-col gap-2">
            {/* File picker */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPickerMode("video")}
                className="flex-1 py-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-[9px] font-bold text-slate-300 transition-all"
              >
                {vbg.path ? "Change from Library..." : "Pick from Library..."}
              </button>
              {vbg.path && (
                <button
                  onClick={() => updateVbg({ path: "" })}
                  className="text-red-500/70 hover:text-red-400 text-[10px] font-bold shrink-0"
                  title="Clear video"
                >✕</button>
              )}
            </div>
            {vbg.path && (
              <p className="text-[8px] text-slate-600 truncate -mt-1">
                {vbg.path.split(/[/\\]/).pop()}
              </p>
            )}

            {/* Loop + Muted toggles */}
            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={() => updateVbg({ loopVideo: !vbg.loopVideo })}
                className={`py-1 rounded text-[9px] font-bold border transition-all ${
                  vbg.loopVideo ? "border-amber-500 bg-amber-500/10 text-amber-400" : "border-slate-700 bg-slate-800/50 text-slate-500"
                }`}
              >
                Loop: {vbg.loopVideo ? "On" : "Off"}
              </button>
              <button
                onClick={() => updateVbg({ muted: !vbg.muted })}
                className={`py-1 rounded text-[9px] font-bold border transition-all ${
                  vbg.muted ? "border-amber-500 bg-amber-500/10 text-amber-400" : "border-slate-700 bg-slate-800/50 text-slate-500"
                }`}
              >
                Muted: {vbg.muted ? "On" : "Off"}
              </button>
            </div>

            {/* Object Fit */}
            <div>
              <p className="text-[8px] text-slate-600 uppercase font-bold mb-1">Fit</p>
              <div className="flex gap-1">
                {(["cover", "contain", "fill"] as const).map((fit) => (
                  <button
                    key={fit}
                    onClick={() => updateVbg({ objectFit: fit })}
                    className={`flex-1 py-0.5 rounded text-[8px] font-bold border transition-all capitalize ${
                      vbg.objectFit === fit
                        ? "border-amber-500 bg-amber-500/10 text-amber-400"
                        : "border-slate-700 bg-slate-800/50 text-slate-500"
                    }`}
                  >
                    {fit}
                  </button>
                ))}
              </div>
            </div>

            {/* Opacity */}
            <div>
              <div className="flex justify-between mb-0.5">
                <p className="text-[8px] text-slate-600 uppercase font-bold">Opacity</p>
                <span className="text-[8px] text-slate-500">{Math.round(vbg.opacity * 100)}%</span>
              </div>
              <input
                type="range" min="0.05" max="1" step="0.05"
                value={vbg.opacity}
                onChange={(e) => updateVbg({ opacity: parseFloat(e.target.value) })}
                className="w-full h-1 appearance-none bg-slate-700 rounded accent-amber-500 cursor-pointer"
              />
            </div>

            {/* Playback Speed */}
            <div>
              <div className="flex justify-between mb-0.5">
                <p className="text-[8px] text-slate-600 uppercase font-bold">Speed</p>
                <span className="text-[8px] text-slate-500">{vbg.playbackRate}×</span>
              </div>
              <input
                type="range" min="0.25" max="2" step="0.25"
                value={vbg.playbackRate}
                onChange={(e) => updateVbg({ playbackRate: parseFloat(e.target.value) })}
                className="w-full h-1 appearance-none bg-slate-700 rounded accent-amber-500 cursor-pointer"
              />
            </div>
          </div>
        )}

        {cbg !== null && (
          <div className="flex flex-col gap-2">
            <div>
              <p className="text-[8px] text-slate-600 uppercase font-bold mb-1">Device</p>
              <select
                value={cbg.deviceId}
                onChange={(e) => updateCbg({ deviceId: e.target.value })}
                className="w-full py-1 px-2 rounded border border-slate-700 bg-slate-800 text-[10px] text-slate-300"
              >
                <option value="">Select Camera...</option>
                {availableCameras.map((cam) => (
                  <option key={cam.deviceId} value={cam.deviceId}>{cam.label}</option>
                ))}
              </select>
              <button 
                onClick={() => refreshCameras()}
                className="text-[8px] text-amber-500 hover:text-amber-400 mt-1 font-bold"
              >
                Refresh Devices
              </button>
            </div>

            <button
              onClick={() => updateCbg({ mirrored: !cbg.mirrored })}
              className={`py-1 rounded text-[9px] font-bold border transition-all ${
                cbg.mirrored ? "border-amber-500 bg-amber-500/10 text-amber-400" : "border-slate-700 bg-slate-800/50 text-slate-500"
              }`}
            >
              Mirrored: {cbg.mirrored ? "On" : "Off"}
            </button>

            {/* Object Fit */}
            <div>
              <p className="text-[8px] text-slate-600 uppercase font-bold mb-1">Fit</p>
              <div className="flex gap-1">
                {(["cover", "contain", "fill"] as const).map((fit) => (
                  <button
                    key={fit}
                    onClick={() => updateCbg({ objectFit: fit })}
                    className={`flex-1 py-0.5 rounded text-[8px] font-bold border transition-all capitalize ${
                      cbg.objectFit === fit
                        ? "border-amber-500 bg-amber-500/10 text-amber-400"
                        : "border-slate-700 bg-slate-800/50 text-slate-500"
                    }`}
                  >
                    {fit}
                  </button>
                ))}
              </div>
            </div>

            {/* Opacity */}
            <div>
              <div className="flex justify-between mb-0.5">
                <p className="text-[8px] text-slate-600 uppercase font-bold">Opacity</p>
                <span className="text-[8px] text-slate-500">{Math.round(cbg.opacity * 100)}%</span>
              </div>
              <input
                type="range" min="0.05" max="1" step="0.05"
                value={cbg.opacity}
                onChange={(e) => updateCbg({ opacity: parseFloat(e.target.value) })}
                className="w-full h-1 appearance-none bg-slate-700 rounded accent-amber-500 cursor-pointer"
              />
            </div>
          </div>
        )}

        {abg !== null && (
          <div className="flex flex-col gap-2">
            {/* File picker */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPickerMode("audio")}
                className="flex-1 py-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-[9px] font-bold text-slate-300 transition-all"
              >
                {abg.path ? "Change from Library..." : "Pick from Library..."}
              </button>
              {abg.path && (
                <button
                  onClick={() => updateAbg({ path: "" })}
                  className="text-red-500/70 hover:text-red-400 text-[10px] font-bold shrink-0"
                  title="Clear audio"
                >✕</button>
              )}
            </div>
            {abg.path && (
              <p className="text-[8px] text-slate-600 truncate -mt-1">
                {abg.path.split(/[/\\]/).pop()}
              </p>
            )}

            {/* Loop toggle */}
            <button
              onClick={() => updateAbg({ loopAudio: !abg.loopAudio })}
              className={`py-1 rounded text-[9px] font-bold border transition-all ${
                abg.loopAudio ? "border-amber-500 bg-amber-500/10 text-amber-400" : "border-slate-700 bg-slate-800/50 text-slate-500"
              }`}
            >
              Loop: {abg.loopAudio ? "On" : "Off"}
            </button>

            {/* Volume */}
            <div>
              <div className="flex justify-between mb-0.5">
                <p className="text-[8px] text-slate-600 uppercase font-bold">Volume</p>
                <span className="text-[8px] text-slate-500">{Math.round(abg.volume * 100)}%</span>
              </div>
              <input
                type="range" min="0" max="1" step="0.05"
                value={abg.volume}
                onChange={(e) => updateAbg({ volume: parseFloat(e.target.value) })}
                className="w-full h-1 appearance-none bg-slate-700 rounded accent-amber-500 cursor-pointer"
              />
            </div>
          </div>
        )}
      </div>

      {pickerMode && (
        <MediaPickerModal
          images={media}
          mode={pickerMode}
          onSelect={(path) => {
            if (pickerMode === "image") {
              onChange({ type: "Image", value: { ...(ibg ?? DEFAULT_IMAGE_BG), path: relativizePath(path, appDataDir) } });
            } else if (pickerMode === "video") {
              onChange({ type: "Video", value: { ...(vbg ?? DEFAULT_VIDEO_BG), path: relativizePath(path, appDataDir) } });
            } else {
              onChange({ type: "Audio", value: { ...(abg ?? DEFAULT_AUDIO_BG), path: relativizePath(path, appDataDir) } });
            }
          }}
          onClose={() => setPickerMode(null)}
          onUpload={onUploadMedia}
        />
      )}
    </>
  );
}
