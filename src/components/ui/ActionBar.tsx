import React from "react";
import { cn } from "./cn";
import { StatusBadge, type StatusTone } from "./StatusBadge";

interface ActionBarProps {
  left?: React.ReactNode;
  label?: string;
  status?: { tone: StatusTone; label: string };
  right?: React.ReactNode;
  className?: string;
}

/** Bottom action bar: consistent placement for primary + status on each panel. */
export function ActionBar({ left, label, status, right, className }: ActionBarProps) {
  return (
    <div className={cn("flex items-center gap-2 p-2 border-t border-console-border bg-console-canvas/40 min-h-12", className)}>
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {left}
        {label && <span className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle truncate">{label}</span>}
      </div>
      {status && <StatusBadge tone={status.tone} label={status.label} />}
      {right && (
        <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          {right}
        </div>
      )}
    </div>
  );
}