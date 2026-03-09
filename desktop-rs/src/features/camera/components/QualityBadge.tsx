import React from "react";
import { Battery, Wifi } from "lucide-react";
import type { QualityStats } from "../types";

interface Props { quality: QualityStats; className?: string }

function signalColor(rttMs?: number): string {
  if (rttMs === undefined) return "text-zinc-500";
  if (rttMs < 50)  return "text-green-400";
  if (rttMs < 150) return "text-yellow-400";
  return "text-red-400";
}

function batteryColor(pct?: number): string {
  if (pct === undefined) return "text-zinc-500";
  if (pct > 50) return "text-green-400";
  if (pct > 20) return "text-yellow-400";
  return "text-red-400";
}

export function QualityBadge({ quality, className = "" }: Props) {
  return (
    <div className={`flex items-center gap-1.5 text-xs ${className}`}>
      <Wifi className={`w-3 h-3 ${signalColor(quality.rttMs)}`} />
      {quality.rttMs !== undefined && (
        <span className={signalColor(quality.rttMs)}>{quality.rttMs}ms</span>
      )}
      {quality.batteryPct !== undefined && (
        <>
          <Battery className={`w-3 h-3 ${batteryColor(quality.batteryPct)}`} />
          <span className={batteryColor(quality.batteryPct)}>{quality.batteryPct}%</span>
        </>
      )}
    </div>
  );
}
