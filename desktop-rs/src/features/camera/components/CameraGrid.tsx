import React from "react";
import type { CameraSource } from "../types";
import { CameraThumb } from "./CameraThumb";

interface Props {
  sources: Map<string, CameraSource>;
  onSetProgram: (deviceId: string) => void;
  onAttachPreview: (deviceId: string, el: HTMLVideoElement | null) => void;
}

export function CameraGrid({ sources, onSetProgram, onAttachPreview }: Props) {
  if (sources.size === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-500 text-sm">
        No cameras connected
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 p-2">
      {[...sources.values()].map(source => (
        <CameraThumb
          key={source.deviceId}
          source={source}
          onSetProgram={onSetProgram}
          onAttachPreview={onAttachPreview}
        />
      ))}
    </div>
  );
}
