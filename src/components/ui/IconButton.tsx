import React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "./cn";

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  tone?: "neutral" | "live" | "stage" | "success" | "warning";
  loading?: boolean;
  size?: number;
}

const TONES: Record<NonNullable<IconButtonProps["tone"]>, { active: string; idle: string }> = {
  neutral: {
    active: "bg-console-surface-strong text-console-text",
    idle: "text-console-text-subtle hover:text-console-text hover:bg-console-surface-strong",
  },
  live: {
    active: "bg-state-live-soft text-state-live",
    idle: "text-console-text-subtle hover:text-state-live hover:bg-state-live-soft",
  },
  stage: {
    active: "bg-state-stage-soft text-state-stage",
    idle: "text-console-text-subtle hover:text-state-stage hover:bg-state-stage-soft",
  },
  success: {
    active: "bg-state-stage-soft text-state-success",
    idle: "text-console-text-subtle hover:text-state-success hover:bg-state-stage-soft",
  },
  warning: {
    active: "bg-state-live-soft text-state-warning",
    idle: "text-console-text-subtle hover:text-state-warning hover:bg-state-live-soft",
  },
};

export function IconButton({
  label,
  active,
  tone = "neutral",
  loading = false,
  size = 15,
  className,
  children,
  ...rest
}: IconButtonProps) {
  const toneClasses = tone === "neutral" || active ? TONES[tone][active ? "active" : "idle"] : TONES[tone].idle;

  return (
    <button
      aria-label={label}
      title={label}
      aria-pressed={typeof active === "boolean" ? active : undefined}
      className={cn(
        "inline-flex items-center justify-center rounded-md h-10 w-10 transition-all select-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]",
        "disabled:opacity-40 disabled:pointer-events-none",
        toneClasses,
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={size} className="animate-spin" /> : children}
    </button>
  );
}