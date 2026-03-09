import React, { useRef, useEffect } from "react";
import type { CameraSource } from "../types";
import { TallyIndicator } from "./TallyIndicator";
import { QualityBadge } from "./QualityBadge";

interface Props {
  source: CameraSource;
  onSetProgram: (deviceId: string) => void;
  onAttachPreview: (deviceId: string, el: HTMLVideoElement | null) => void;
}

export function CameraThumb({ source, onSetProgram, onAttachPreview }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    onAttachPreview(source.deviceId, videoRef.current);
    return () => { onAttachPreview(source.deviceId, null); };
  }, [source.deviceId, onAttachPreview]);

  const borderClass =
    source.tally === "program" ? "ring-2 ring-red-500" :
    source.tally === "preview" ? "ring-2 ring-green-500" :
    "ring-1 ring-zinc-700";

  return (
    <div className={`relative rounded-lg overflow-hidden bg-zinc-900 ${borderClass} group`}>
      {/* Video preview */}
      <div className="relative aspect-video bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover"
        />
        {source.status !== "connected" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <span className="text-zinc-400 text-xs capitalize">{source.status}</span>
          </div>
        )}
        {/* Tally overlay */}
        {source.tally === "program" && (
          <div className="absolute top-1.5 left-1.5 bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
            PGM
          </div>
        )}
        {source.tally === "preview" && (
          <div className="absolute top-1.5 left-1.5 bg-green-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
            PVW
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-2 py-1.5 flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <TallyIndicator tally={source.tally} size="sm" />
          <span className="text-xs text-zinc-200 truncate">{source.deviceName}</span>
        </div>
        <QualityBadge quality={source.quality} />
      </div>

      {/* Hover actions */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-center pb-2 gap-1 bg-black/40">
        <button
          onClick={() => onSetProgram(source.deviceId)}
          className="text-[10px] font-bold px-2 py-1 bg-red-600 hover:bg-red-500 text-white rounded"
        >
          PGM
        </button>
      </div>
    </div>
  );
}
