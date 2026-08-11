import React from "react";
import { Check, Loader2, X, CloudOff } from "lucide-react";
import { cn } from "./cn";

export type SaveStatusState = "idle" | "unsaved" | "saving" | "saved" | "failed";

interface SaveStatusProps {
  state: SaveStatusState;
  className?: string;
}

const META: Record<SaveStatusState, { label: string; cls: string; icon?: React.ReactNode }> = {
  idle: { label: "", cls: "" },
  unsaved: { label: "Unsaved changes", cls: "text-state-warning", icon: <X size={11} /> },
  saving: { label: "Saving…", cls: "text-console-text-muted", icon: <Loader2 size={11} className="animate-spin" /> },
  saved: { label: "Saved", cls: "text-state-success", icon: <Check size={11} /> },
  failed: { label: "Save failed", cls: "text-state-error", icon: <CloudOff size={11} /> },
};

/** Save progress indicator — text + icon, aligned with the success/error palette. */
export function SaveStatus({ state, className }: SaveStatusProps) {
  const m = META[state];
  if (!m.label) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider", m.cls, className)}>
      {m.icon}
      {m.label}
    </span>
  );
}