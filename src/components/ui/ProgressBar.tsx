import React from "react";
import { cn } from "./cn";

interface ProgressBarProps {
  value: number;      // 0..1 fraction
  tone?: "stage" | "live" | "neutral" | "success";
  className?: string;
  label?: string;     // textual progress e.g. "3 / 10" (kept for non-color status)
}

const TONES = {
  stage: "bg-state-stage",
  live: "bg-state-live",
  neutral: "bg-console-text-subtle",
  success: "bg-state-success",
};

export function ProgressBar({ value, tone = "neutral", className, label }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div
      className={cn("flex items-center gap-1.5 min-w-0", className)}
      role="progressbar"
      aria-valuenow={Math.round(pct * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? undefined}
    >
      <div className="flex-1 h-1 rounded-full bg-console-surface-strong overflow-hidden min-w-0">
        <div className={cn("h-full rounded-full transition-all", TONES[tone])} style={{ width: `${pct * 100}%` }} />
      </div>
      {label && (
        <span className="text-[9px] font-black text-console-text-muted shrink-0">{label}</span>
      )}
    </div>
  );
}