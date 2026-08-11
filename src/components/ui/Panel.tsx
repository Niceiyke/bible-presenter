import React from "react";
import { cn } from "./cn";

interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  elevated?: boolean;
}

/** Standard operator panel surface. */
export function Panel({ elevated, className, children, ...rest }: PanelProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-console-border bg-console-surface",
        elevated && "shadow-lg shadow-black/30",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}