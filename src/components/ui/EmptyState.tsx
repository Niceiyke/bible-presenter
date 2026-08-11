import React from "react";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

/** Neutral empty-state block with readable text and an optional action. */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center">
      {icon && <span className="text-console-text-subtle">{icon}</span>}
      <p className="op-control-label text-console-text-muted">{title}</p>
      {description && <p className="text-[10px] text-console-text-subtle max-w-xs">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}