import React, { useState } from "react";
import { MediaPickerModal } from "./MediaPickerModal";
import { useAppStore } from "../store";
import { relativizePath } from "../utils";
import type { BackgroundSetting, MediaItem } from "../types";

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

  return (
    <>
      <div>
        {label && <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mb-1.5">{label}</p>}
        <div className="flex gap-1.5 mb-1.5">
          {(["None", "Color", "Image", "Camera"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                if (mode === "None") onChange({ type: "None" });
                else if (mode === "Color") onChange({ type: "Color", value: current.type === "Color" ? (current as any).value : "#000000" });
                else if (mode === "Image") onChange({ type: "Image", value: current.type === "Image" ? (current as any).value : "" });
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
