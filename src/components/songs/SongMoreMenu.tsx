import React, { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "../ui";

export interface SongMoreMenuItem {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  /** Executed and the menu closes after selection. */
  onClick?: () => void;
}

interface SongMoreMenuProps {
  items: SongMoreMenuItem[];
  label?: string;
  className?: string;
}

/** Card-level "More" menu (Phase 4). Opens on click or Enter/Space, closes on
 *  Escape or outside click, restores focus to the trigger on close — every
 *  secondary song action is reachable from the keyboard and never hover-only. */
export function SongMoreMenu({ items, label = "More actions", className }: SongMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Focus restoration: when the menu closes, return focus to the trigger so
  // keyboard users aren't dropped (mirrors the operator design system's
  // EditorMenu behavior).
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => {
      if (rootRef.current && rootRef.current.contains(document.activeElement)) {
        triggerRef.current?.focus();
      }
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocMouse = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocMouse);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouse);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative shrink-0", className)}>
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        className="w-10 h-10 inline-flex items-center justify-center rounded-lg text-console-text-muted hover:text-console-text hover:bg-console-surface-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] transition-all"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-[80] mt-1 rounded-lg border border-console-border-strong bg-console-surface shadow-2xl p-1 flex flex-col min-w-[160px]"
        >
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onClick?.();
              }}
              className={cn(
                "flex items-center gap-2.5 px-2.5 py-2 text-[11px] font-bold rounded text-left transition-all focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[var(--color-focus-ring)]",
                it.danger
                  ? "text-state-error hover:text-state-error hover:bg-state-live-soft"
                  : "text-console-text-muted hover:text-console-text hover:bg-console-surface-strong",
              )}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}