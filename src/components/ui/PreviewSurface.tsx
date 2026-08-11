import React from "react";
import { cn } from "./cn";

interface PreviewSurfaceProps {
  accent?: "stage" | "live" | "neutral";
  children?: React.ReactNode;
  empty?: string;
  className?: string;
}

const ACCENTS = {
  stage: "ring-1 ring-state-stage/30",
  live: "ring-2 ring-state-live/30",
  neutral: "ring-1 ring-console-border",
};

/** 16:9 preview surface used by cockpit and content cards. */
export function PreviewSurface({ accent = "neutral", children, empty, className }: PreviewSurfaceProps) {
  return (
    <div className={cn("w-full rounded-lg overflow-hidden bg-black relative", ACCENTS[accent], className)} style={{ aspectRatio: "16/9" }}>
      {children}
      {empty && !children && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[10px] font-bold uppercase tracking-widest text-console-text-subtle">{empty}</span>
        </div>
      )}
    </div>
  );
}