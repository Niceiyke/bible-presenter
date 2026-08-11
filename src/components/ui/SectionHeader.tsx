import React from "react";
import { cn } from "./cn";

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function SectionHeader({ title, subtitle, icon, actions, className }: SectionHeaderProps) {
  return (
    <div className={cn("flex items-center gap-2.5 px-2 py-1.5 min-h-10", className)}>
      {icon && (
        <span className="inline-flex items-center justify-center text-console-text-muted shrink-0">{icon}</span>
      )}
      <div className="flex-1 min-w-0">
        <h2 className="op-control-label text-console-text uppercase tracking-widest truncate">{title}</h2>
        {subtitle && <p className="text-[10px] text-console-text-subtle truncate">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
    </div>
  );
}