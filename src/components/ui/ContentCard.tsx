import React from "react";
import { cn } from "./cn";
import { StatusBadge, type StatusTone } from "./StatusBadge";

interface ContentCardProps extends React.HTMLAttributes<HTMLDivElement> {
  selected?: boolean;
  missing?: boolean;
  status?: { tone: StatusTone; label: string };
}

/** Shared content-card shell used by every library grid so all media, song,
 *  and presentation cards share one visual vocabulary. */
export function ContentCard({ selected, missing, status, className, children, ...rest }: ContentCardProps) {
  return (
    <div
      className={cn(
        "relative flex flex-col bg-console-surface rounded-xl overflow-hidden border transition-all",
        missing
          ? "border-state-error/50 bg-state-live-soft/30"
          : selected
          ? "border-action-primary/70 ring-1 ring-action-primary/30"
          : "border-console-border hover:border-console-border-strong hover:shadow-lg hover:shadow-black/30",
        className,
      )}
      {...rest}
    >
      {children}
      {status && (
        <div className="absolute top-2 right-2 z-20">
          <StatusBadge tone={status.tone} label={status.label} />
        </div>
      )}
    </div>
  );
}