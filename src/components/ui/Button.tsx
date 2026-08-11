import React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "./cn";

export type ButtonVariant =
  | "primary"    // Main operator action (amber)
  | "live"       // On-air / destructive (red)
  | "stage"      // Prepared / up-next (cyan)
  | "success"    // Saved / connected (green)
  | "warning"    // Attention
  | "ghost"      // Subtle neutral
  | "bare";      // Text-only, no background

export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-action-primary text-black hover:bg-action-primary-hover shadow-lg shadow-action-primary/20",
  live: "bg-state-live text-white hover:bg-state-live/90 shadow-lg shadow-state-live/20",
  stage: "bg-state-stage text-slate-950 hover:bg-state-stage/90 shadow-lg shadow-state-stage/20",
  success: "bg-state-success text-slate-950 hover:bg-state-success/90",
  warning: "bg-state-warning text-slate-950 hover:bg-state-warning/90",
  ghost: "bg-console-surface-raised text-console-text-muted hover:bg-console-surface-strong hover:text-console-text",
  bare: "bg-transparent text-console-text-muted hover:text-console-text hover:bg-console-surface-strong",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-[10px] gap-1",
  md: "h-10 px-3.5 text-[11px] gap-1.5",
  lg: "h-11 px-4 text-xs gap-2",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-md font-bold uppercase tracking-wide transition-all select-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]",
        "disabled:opacity-40 disabled:pointer-events-none",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}