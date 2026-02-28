import React, { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { MediaPickerModal } from "./MediaPickerModal";
import { useAppStore } from "../store";
import { relativizePath } from "../utils";
import type { BackgroundSetting, VideoBackground, MediaItem } from "../types";

const DEFAULT_VIDEO_BG: VideoBackground = {
  path: "",
  loopVideo: true,
  muted: true,
  objectFit: "cover",
  opacity: 1,
  playbackRate: 1,
};

export function BackgroundEditor({
  label,
  value,
  onChange,
  mediaImages = [],
  onUploadMedia = async () => {},
  cameras = [],
}: {
  label: string;
  value: BackgroundSetting | undefined;
  onChange: (bg: BackgroundSetting) => void;
  mediaImages?: MediaItem[];
  onUploadMedia?: () => Promise<void>;
  cameras?: MediaDeviceInfo[];
}) {
  const { appDataDir } = useAppStore();
  const [showPicker, setShowPicker] = useState(false);
  const current: BackgroundSetting = value ?? { type: "None" };

  const vbg = current.type === "Video" ? (current as { type: "Video"; value: VideoBackground }).value : null;
  const updateVbg = (patch: Partial<VideoBackground>) =>
    onChange({ type: "Video", value: { ...(vbg ?? DEFAULT_VIDEO_BG), ...patch } });

  const handlePickVideo = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Videos", extensions: ["mp4", "webm", "mov", "mkv", "avi", "m4v"] }],
      });
      if (typeof selected !== "string") return;
      const rel = relativizePath(selected, appDataDir);
      onChange({ type: "Video", value: { ...(vbg ?? DEFAULT_VIDEO_BG), path: rel } });
    } catch {}
  };

  return (
    <>
      <div>
        {label && <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mb-1.5">{label}</p>}
        <div className="flex gap-1.5 mb-1.5">
          {(["None", "Color", "Image", "Video", "Camera"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                if (mode === "None") onChange({ type: "None" });
                else if (mode === "Color") onChange({ type: "Color", value: current.type === "Color" ? (current as any).value : "#000000" });
                else if (mode === "Image") onChange({ type: "Image", value: current.type === "Image" ? (current as any).value : "" });
                else if (mode === "Video") onChange({ type: "Video", value: current.type === "Video" ? (current as any).value : { ...DEFAULT_VIDEO_BG } });
                else onChange({ type: "Camera", value: cameras[0]?.deviceId ?? "" });
              }}
              className={`flex-1 py-1 rounded text-[9px] font-bold border transition-all ${
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
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowPicker(true)}
              className="flex-1 py-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-[9px] font-bold text-slate-300 transition-all"
            >
              {(current as { type: "Image"; value: string }).value ? "Change from Library..." : "Pick from Library..."}
            </button>
            {(current as { type: "Image"; value: string }).value && (
              <button
                onClick={() => onChange({ type: "Image", value: "" })}
                className="text-red-500/70 hover:text-red-400 text-[10px] font-bold shrink-0"
                title="Clear image"
              >✕</button>
            )}
          </div>
        )}
        {current.type === "Image" && (current as { type: "Image"; value: string }).value && (
          <p className="text-[8px] text-slate-600 truncate mt-1">
            {(current as { type: "Image"; value: string }).value.split(/[/\\]/).pop()}
          </p>
        )}

        {current.type === "Camera" && (
          cameras.length === 0 ? (
            <p className="text-[9px] text-slate-600 italic mt-1">No cameras detected. Visit the Cameras tab to grant access.</p>
          ) : (
            <select
              value={(current as { type: "Camera"; value: string }).value}
              onChange={(e) => onChange({ type: "Camera", value: e.target.value })}
              className="w-full mt-1 bg-slate-800 text-white border border-slate-700 rounded px-2 py-1 text-[9px] focus:outline-none focus:ring-1 focus:ring-amber-500"
            >
              {cameras.map((cam) => (
                <option key={cam.deviceId} value={cam.deviceId}>
                  {cam.label || `Camera ${cam.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          )
        )}

        {vbg !== null && (
          <div className="flex flex-col gap-2">
            {/* File picker */}
            <div className="flex items-center gap-2">
              <button
                onClick={handlePickVideo}
                className="flex-1 py-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-[9px] font-bold text-slate-300 transition-all"
              >
                {vbg.path ? "Change Video..." : "Pick Video File..."}
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
      </div>

      {showPicker && (
        <MediaPickerModal
          images={mediaImages}
          onSelect={(path) => { onChange({ type: "Image", value: relativizePath(path, appDataDir) }); }}
          onClose={() => setShowPicker(false)}
          onUpload={onUploadMedia}
        />
      )}
    </>
  );
}
