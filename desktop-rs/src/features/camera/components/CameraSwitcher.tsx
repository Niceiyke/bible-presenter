import React from "react";
import type { CameraSource } from "../types";
import { TallyIndicator } from "./TallyIndicator";

interface Props {
  sources: Map<string, CameraSource>;
  onSetProgram: (deviceId: string | null) => void;
}

export function CameraSwitcher({ sources, onSetProgram }: Props) {
  const programDevice = [...sources.values()].find(s => s.tally === "program");

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-t border-zinc-800">
      <span className="text-xs text-zinc-500 font-medium">PGM:</span>
      <select
        value={programDevice?.deviceId ?? ""}
        onChange={e => onSetProgram(e.target.value || null)}
        className="flex-1 text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200"
      >
        <option value="">— Black —</option>
        {[...sources.values()].map(s => (
          <option key={s.deviceId} value={s.deviceId}>
            {s.deviceName} {s.tally === "program" ? "●" : ""}
          </option>
        ))}
      </select>
      {programDevice && (
        <div className="flex items-center gap-1">
          <TallyIndicator tally="program" size="sm" />
          <span className="text-xs text-red-400 font-medium">LIVE</span>
        </div>
      )}
      <button
        onClick={() => onSetProgram(null)}
        className="text-xs px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded"
      >
        Cut Black
      </button>
    </div>
  );
}
