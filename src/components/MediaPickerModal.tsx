import React, { useState, useEffect } from "react";
import type { MediaItem } from "../types";
import { Film } from "lucide-react";
import { MediaThumb } from "./MediaThumb";

export function MediaPickerModal({
  images,
  onSelect,
  onClose,
  onUpload,
  mode = "image",
}: {
  images: MediaItem[];
  onSelect: (path: string) => void;
  onClose: () => void;
  onUpload: () => Promise<void>;
  mode?: "image" | "video" | "audio";
}) {
  const [uploading, setUploading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => { setRefreshKey(k => k + 1); }, [images]);

  const items = mode === "video"
    ? images.filter(i => i.media_type === "Video")
    : mode === "audio"
      ? images.filter(i => i.media_type === "Audio")
      : images.filter(i => i.media_type === "Image");

  const handleUpload = async () => {
    setUploading(true);
    try { await onUpload(); } finally { setUploading(false); }
  };

  const label = mode === "video" ? "Video" : mode === "audio" ? "Audio" : "Image";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-8" style={{ backgroundColor: "rgba(0,0,0,0.75)" }}>
      <div className="bg-black/40 rounded-xl border border-white/[0.08] flex flex-col w-full max-w-2xl" style={{ maxHeight: "80vh" }}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06] shrink-0">
          <span className="text-sm font-bold text-slate-200">Media Library — Pick {label}</span>
          <div className="flex gap-2">
            <button
              onClick={handleUpload}
              disabled={uploading}
              className="text-[10px] bg-amber-500 hover:bg-amber-400 text-black font-bold px-3 py-1.5 rounded transition-all disabled:opacity-50"
            >
              {uploading ? "Uploading..." : "+ Upload New"}
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none px-1">×</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4" key={refreshKey}>
          {items.length === 0 ? (
            <p className="text-slate-600 text-xs italic text-center py-12">
              No {label.toLowerCase()}s in library yet. Click "+ Upload New" to add {label.toLowerCase()}s.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {items.map((img) => (
                <button
                  key={img.id}
                  onClick={() => { onSelect(img.path); onClose(); }}
                  className="aspect-video rounded-lg overflow-hidden border border-white/[0.08] hover:border-indigo-400/60 transition-all group relative bg-white/[0.05]"
                >
                  {img.media_type === "Video" || img.media_type === "Audio" ? (
                    <div className="w-full h-full relative">
                      <MediaThumb item={img} className="w-full h-full" objectFit="contain" />
                      <span className="absolute top-1 right-1 bg-black/70 text-white text-[8px] px-1 py-0.5 rounded flex items-center gap-1">
                        <Film size={9} /> {img.media_type}
                      </span>
                    </div>
                  ) : (
                    <MediaThumb item={img} className="w-full h-full" />
                  )}
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center">
                    <span className="text-white text-[10px] font-bold">SELECT</span>
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
                    <p className="text-[8px] text-white truncate">{img.name}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
