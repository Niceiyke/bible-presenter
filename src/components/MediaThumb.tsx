import React, { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Film, Music, Image as ImageIcon, Play } from "lucide-react";
import type { MediaItem } from "../types";

function formatDuration(secs?: number): string {
  if (typeof secs !== "number" || !isFinite(secs) || secs < 0) return "";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Shared media preview tile for the library grid and the pickers. Renders a
 *  lazy image (thumbnail or original), a muted video, or an audio badge, with
 *  a duration chip for videos/audio. `className` sizes the box; the caller
 *  decides whether thumbnails fill (`object-cover`) or contain. */
export function MediaThumb({
  item,
  className = "",
  objectFit = "cover",
  dimmed = false,
}: {
  item: MediaItem;
  className?: string;
  objectFit?: "cover" | "contain" | "fill";
  dimmed?: boolean;
}) {
  const [imgError, setImgError] = useState(false);
  const fit = objectFit === "cover" ? "object-cover" : objectFit === "fill" ? "object-fill" : "object-contain";
  const src = item.thumbnail_path || item.path;
  const dim = dimmed ? "opacity-20 grayscale" : "";

  if (item.media_type === "Video") {
    return (
      <div className={`w-full h-full overflow-hidden relative ${dim}`}>
        <video
          src={convertFileSrc(item.path)}
          className={`w-full h-full ${fit}`}
          muted
          playsInline
          preload="metadata"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent pointer-events-none" />
        <span className="absolute bottom-1 right-1 px-1.5 py-0.5 bg-black/70 text-white text-[8px] font-mono rounded flex items-center gap-1">
          <Play size={8} fill="currentColor" />
          {formatDuration(item.duration) || "VIDEO"}
        </span>
      </div>
    );
  }

  if (item.media_type === "Audio") {
    return (
      <div className={`w-full h-full flex flex-col items-center justify-center gap-1.5 bg-gradient-to-br from-slate-800 to-slate-900 ${dim}`}>
        <div className="w-9 h-9 rounded-full bg-amber-500/15 flex items-center justify-center border border-amber-500/30">
          <Music size={16} className="text-amber-500/90" />
        </div>
        <span className="text-white/70 text-[8px] font-mono">
          {formatDuration(item.duration) || "AUDIO"}
        </span>
      </div>
    );
  }

  // Image
  if (!imgError) {
    return (
      <img
        src={convertFileSrc(src)}
        loading="lazy"
        onError={() => setImgError(true)}
        className={`w-full h-full ${fit} ${dim}`}
        alt={item.name}
      />
    );
  }
  return (
    <div className={`w-full h-full flex items-center justify-center bg-white/[0.05] ${dim}`}>
      <ImageIcon size={22} className="text-slate-600" />
    </div>
  );
}

/** Small type badge shown on cards: Film / Music / (nothing for images). */
export function MediaTypeIcon({ item }: { item: MediaItem }) {
  if (item.media_type === "Video") return <Film size={10} className="text-slate-400" />;
  if (item.media_type === "Audio") return <Music size={10} className="text-amber-400" />;
  return <ImageIcon size={10} className="text-slate-500" />;
}

export { formatDuration };
