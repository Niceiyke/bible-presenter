/**
 * Shared micro-UI primitives used by the split SlideEditor components
 * (P1.4). Previously defined as module-local helpers at the bottom of
 * `SlideEditor.tsx`; extracted so each sub-component can import them
 * without circular imports.
 */

import React from "react";
import { useLayoutEffect, useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight } from "lucide-react";

export function Btn({ onClick, icon, children, className = "" }: {
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 min-h-[40px] px-3 bg-console-surface-raised hover:bg-console-surface-strong text-console-text-muted hover:text-console-text text-xs font-bold rounded-lg border border-console-border transition-all shrink-0 ${className}`}
    >
      {icon}{children}
    </button>
  );
}

export function ToggleBtn({ active, onClick, title, children }: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`w-10 h-10 flex items-center justify-center rounded-lg border transition-all shrink-0 focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
        active
          ? "bg-state-stage/20 text-state-stage border-state-stage/50"
          : "bg-console-surface-raised text-console-text-muted hover:text-console-text hover:bg-console-surface-strong border-console-border"
      }`}
    >
      {children}
    </button>
  );
}

export function Div() {
  return <div className="w-px h-6 bg-console-border mx-1 shrink-0" />;
}

export function Panel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-console-surface-raised/40 rounded-xl border border-console-border p-3 flex flex-col gap-2.5">
      <p className="text-[11px] font-bold text-console-text-subtle">{label}</p>
      {children}
    </div>
  );
}

export function IconBtn({ onClick, title, children }: {
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="w-10 h-10 bg-console-surface-raised hover:bg-console-surface-strong text-console-text-muted hover:text-console-text rounded-lg border border-console-border flex items-center justify-center transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
    >
      {children}
    </button>
  );
}

export function TextBtn({ onClick, title, children }: {
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="w-10 h-10 bg-console-surface-raised hover:bg-console-surface-strong text-console-text-muted hover:text-console-text rounded-lg border border-console-border flex items-center justify-center transition-all text-[11px] font-bold focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
    >
      {children}
    </button>
  );
}

/**
 * EditorMenu — a click/focus dropdown menu for the editor toolbar
 * (SLIDE_EDITOR_MODERNIZATION_PLAN §5.5 / §6.4). Replaces hover-only
 * popovers: the menu opens on click (or Enter/Space on the trigger) and
 * closes on Escape or outside click, so every action is reachable from
 * the keyboard.
 */
export function EditorMenu<T extends string | number>({
  trigger,
  label,
  activeLabel,
  items,
  value,
  onSelect,
  align = "left",
  className = "",
  triggerClassName = "",
}: {
  trigger: React.ReactNode;
  label: string;
  activeLabel?: string;
  items: { value: T; label: React.ReactNode }[];
  value?: T;
  onSelect: (v: T) => void;
  align?: "left" | "right";
  className?: string;
  /** Extra classes for the trigger button (e.g. `w-full justify-center`). */
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // P7: focus restoration — when the menu closes (Escape / outside click /
  // item select), return focus to the trigger so keyboard users aren't
  // dropped. The effect runs on every open→close transition.
  useEffect(() => {
    if (open) return;
    // Only restore when focus is inside the menu (closing transitions).
    // We schedule on next tick so the item-select click doesn't fight us.
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
    <div ref={rootRef} className={`relative shrink-0 ${className}`}>
      <button
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(o => !o);
          }
        }}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        className={`flex items-center gap-1.5 min-h-[40px] px-3 bg-console-surface-raised hover:bg-console-surface-strong text-console-text-muted hover:text-console-text text-xs font-bold rounded-lg border border-console-border transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${triggerClassName}`}
      >
        {trigger}
        {activeLabel !== undefined && (
          <span className="text-[10px] font-bold tabular-nums text-console-text-subtle">{activeLabel}</span>
        )}
        <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute z-[80] mt-1 rounded-lg border border-console-border-strong bg-console-surface shadow-2xl p-1 flex flex-col min-w-[150px]"
          style={{ left: align === "left" ? 0 : undefined, right: align === "right" ? 0 : undefined }}
        >
          {items.map(it => (
            <button
              key={it.value}
              role="menuitem"
              onClick={() => { setOpen(false); onSelect(it.value); }}
              className={`flex items-center justify-between gap-3 px-2.5 py-2 text-[11px] font-bold rounded text-left transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
                value === it.value
                  ? "bg-state-stage/15 text-state-stage"
                  : "text-console-text-muted hover:text-console-text hover:bg-console-surface-strong"
              }`}
            >
              {it.label}
              {value === it.value && <Check size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * TextInputModal — small reusable text-input modal used instead of
 * `window.prompt` (SLIDE_EDITOR_MODERNIZATION_PLAN §5.6). Rendered in a
 * portal so it overlays the whole editor.
 */
export function TextInputModal({
  title,
  placeholder = "",
  defaultValue = "",
  confirmLabel = "Create",
  onConfirm,
  onCancel,
}: {
  title: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = React.useState(defaultValue);

  return createPortal(
    <div className="fixed inset-0 z-[110] bg-black/70 flex items-center justify-center backdrop-blur-sm">
      <div className="bg-console-surface border border-console-border-strong rounded-2xl p-5 w-full max-w-xs mx-4 shadow-2xl">
        <p className="text-sm font-bold text-console-text mb-3">{title}</p>
        <input
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === "Enter") onConfirm(value.trim() || defaultValue);
            else if (e.key === "Escape") onCancel();
          }}
          placeholder={placeholder}
          aria-label={title}
          className="w-full bg-console-surface-raised border border-console-border rounded-lg px-3 py-2 text-sm text-console-text outline-none focus:border-console-border-strong focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] transition-colors placeholder:text-console-text-subtle"
        />
        <div className="flex gap-2 mt-4">
          <button onClick={onCancel} className="flex-1 py-2 bg-console-surface-raised hover:bg-console-surface-strong text-console-text-muted text-[11px] font-bold rounded-lg transition-all">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(value.trim() || defaultValue)}
            className="flex-1 py-2 bg-action-primary hover:bg-action-primary-hover text-black text-[11px] font-bold rounded-lg transition-all"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * FontPicker (P3.8) — a searchable popover that replaces the `<select>`
 * font picker. The trigger shows the current family (rendered in that
 * face when possible); opening it reveals a filterable list where every
 * family name is drawn in its own font so the operator can see the type.
 */
export function FontPicker({
  fonts,
  value,
  inheritLabel = "— Inherit theme —",
  canInherit = false,
  onSelect,
}: {
  fonts: string[];
  value: string;
  /** Show an "inherit" entry at the top? */
  canInherit?: boolean;
  inheritLabel?: string;
  onSelect: (family: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [anchorEl, setAnchorEl] = React.useState<HTMLButtonElement | null>(null);
  const [pos, setPos] = React.useState({ top: 0, left: 0 });

  // Measure the trigger once the popover opens so we can anchor a portal
  // with fixed coordinates — the toolbar list scrolls horizontally
  // (`overflow-x-auto`), which would otherwise clip an absolutely-positioned
  // child of the trigger.
  useLayoutEffect(() => {
    if (!open || !anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left });
  }, [open, anchorEl]);

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    const onDocMouse = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorEl && anchorEl.contains(t)) return;
      if (t instanceof Element && t.closest("[data-font-popover]")) return;
      setOpen(false);
    };
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onResize = () => {
      if (open && anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        setPos({ top: rect.bottom + 4, left: rect.left });
      }
    };
    document.addEventListener("mousedown", onDocMouse);
    document.addEventListener("keydown", onDocKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDocMouse);
      document.removeEventListener("keydown", onDocKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open, anchorEl]);

  // Reset the search each time the popover opens.
  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = fonts.filter(f => f.toLowerCase().includes(q));

  const pick = (family: string) => {
    setOpen(false);
    onSelect(family);
  };

  return (
    <>
      <button
        ref={setAnchorEl}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        title="Font family"
        aria-label="Font family"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="min-h-[40px] bg-console-surface-raised hover:bg-console-surface-strong border border-console-border rounded-lg px-2 py-1 text-[11px] text-console-text outline-none max-w-[150px] shrink-0 truncate text-left transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
        style={{ fontFamily: value && canInherit ? value : undefined }}
      >
        {value}
      </button>

      {open && createPortal(
        <div
          data-font-popover
          className="fixed z-[90] w-52 max-h-72 overflow-hidden rounded-lg border border-console-border-strong bg-console-surface shadow-2xl flex flex-col"
          style={{ top: pos.top, left: pos.left }}
        >
          <div className="p-1.5 border-b border-console-border shrink-0">
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.stopPropagation()}
              placeholder="Search fonts…"
              className="w-full bg-console-surface-raised border border-console-border rounded-md px-2 py-1 text-[11px] text-console-text outline-none focus:border-console-border-strong transition-colors placeholder:text-console-text-subtle"
            />
          </div>
          <div className="overflow-y-auto custom-scrollbar">
            {canInherit && q.length === 0 && (
              <button
                onClick={() => pick("inherit")}
                className={`w-full px-2 py-1.5 text-left text-[11px] font-bold rounded transition-all ${value === "inherit" ? "bg-state-stage/20 text-state-stage" : "text-console-text-muted hover:text-console-text hover:bg-console-surface-strong"}`}
              >
                {inheritLabel}
              </button>
            )}
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-[10px] text-console-text-subtle text-center">No matches</p>
            )}
            {filtered.map(f => (
              <button
                key={f}
                onClick={() => pick(f)}
                className={`w-full px-2 py-1.5 text-left text-[11px] rounded transition-all ${value !== "inherit" && value === f ? "bg-console-surface-strong text-console-text" : "text-console-text-muted hover:text-console-text hover:bg-console-surface-strong"}`}
                style={{ fontFamily: f }}
              >
                {f}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

/**
 * InspectorSection — a collapsible inspector section
 * (SLIDE_EDITOR_MODERNIZATION_PLAN §5.6 / Phase 4). Replaces the
 * equal-width tab bar with stacked, independently collapsible panels so
 * advanced controls do not crowd the default view. Each section owns its
 * open/closed state; the header carries a label and an optional
 * right-aligned badge.
 */
export function InspectorSection({
  label,
  badge,
  defaultOpen = true,
  children,
}: {
  label: string;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-console-border bg-console-surface-raised/40 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2.5 transition-all hover:bg-console-surface-strong focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
      >
        <ChevronRight size={13} className={`text-console-text-subtle transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="text-[11px] font-bold text-console-text flex-1 text-left">{label}</span>
        {badge && <span className="text-[9px] text-console-text-subtle font-bold">{badge}</span>}
      </button>
      {open && <div className="px-3 pb-3 flex flex-col gap-2.5">{children}</div>}
    </div>
  );
}