import React from "react";
import { cn } from "./cn";

export type StatusTone = "neutral" | "live" | "stage" | "success" | "warning" | "error" | "design" | "audio";

interface StatusBadgeProps {
  tone: StatusTone;
  label: string;
  icon?: React.ReactNode;
  pulsing?: boolean;
  className?: string;
}

const TONES: Record<StatusTone, { dot: string; text: string; bg: string; border: string }> = {
  neutral: { dot: "bg-console-text-subtle", text: "text-console-text-subtle", bg: "bg-console-surface-raised", border: "border-console-border" },
  live: { dot: "bg-state-live", text: "text-state-live", bg: "bg-state-live-soft", border: "border-state-live/40" },
  stage: { dot: "bg-state-stage", text: "text-state-stage", bg: "bg-state-stage-soft", border: "border-state-stage/40" },
  success: { dot: "bg-state-success", text: "text-state-success", bg: "bg-state-stage-soft", border: "border-state-success/40" },
  warning: { dot: "bg-state-warning", text: "text-state-warning", bg: "bg-state-live-soft", border: "border-state-warning/40" },
  error: { dot: "bg-state-error", text: "text-state-error", bg: "bg-state-live-soft", border: "border-state-error/40" },
  design: { dot: "bg-tool-design", text: "text-tool-design", bg: "bg-tool-design/10", border: "border-tool-design/40" },
  audio: { dot: "bg-tool-audio", text: "text-tool-audio", bg: "bg-tool-audio/10", border: "border-tool-audio/40" },
};

/** Status pill: pair a colored icon/dot with readable text — never color alone. */
export function StatusBadge({ tone, label, icon, pulsing, className }: StatusBadgeProps) {
  const t = TONES[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-[10px] font-bold uppercase tracking-wider",
        t.bg, t.border, t.text, className,
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", t.dot, pulsing && "animate-pulse")} />
      {icon}
      <span className="truncate">{label}</span>
    </span>
  );
}