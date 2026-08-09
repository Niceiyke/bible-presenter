/**
 * Shared micro-UI primitives used by the split SlideEditor components
 * (P1.4). Previously defined as module-local helpers at the bottom of
 * `SlideEditor.tsx`; extracted so each sub-component can import them
 * without circular imports.
 */

import React from "react";
import { useLayoutEffect } from "react";
import { createPortal } from "react-dom";

export function Btn({ onClick, icon, children, className = "" }: {
  onClick: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 bg-white/8 hover:bg-white/14 hover:ring-1 hover:ring-indigo-400/40 text-slate-300 hover:text-white text-[11px] font-semibold rounded-lg transition-all active:scale-95 shrink-0 ${className}`}
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
      className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all active:scale-90 shrink-0 ${active ? "bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/30" : "bg-white/8 text-slate-400 hover:text-white hover:bg-white/14"}`}
    >
      {children}
    </button>
  );
}

export function Div() {
  return <div className="w-px h-5 bg-white/10 mx-0.5 shrink-0" />;
}

export function Panel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-white/4 rounded-xl border border-white/[0.06] p-3 flex flex-col gap-2.5">
      <p className="text-[8px] font-black uppercase tracking-widest text-slate-600">{label}</p>
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
      className="p-2 bg-white/6 hover:bg-white/12 hover:ring-1 hover:ring-indigo-400/40 text-slate-400 hover:text-white rounded-lg flex items-center justify-center transition-all active:scale-90"
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
      className="p-2 bg-white/6 hover:bg-white/12 text-slate-500 hover:text-white rounded-lg flex items-center justify-center transition-all text-[9px] font-bold"
    >
      {children}
    </button>
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
        className="bg-white/8 hover:bg-white/14 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-slate-300 outline-none max-w-[150px] shrink-0 truncate text-left transition-all"
        style={{ fontFamily: value && canInherit ? value : undefined }}
      >
        {value}
      </button>

      {open && createPortal(
        <div
          data-font-popover
          className="fixed z-[90] w-52 max-h-72 overflow-hidden rounded-lg border border-white/10 bg-slate-900/95 backdrop-blur-xl shadow-2xl flex flex-col"
          style={{ top: pos.top, left: pos.left }}
        >
          <div className="p-1.5 border-b border-white/[0.06] shrink-0">
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.stopPropagation()}
              placeholder="Search fonts…"
              className="w-full bg-white/6 border border-white/10 rounded-md px-2 py-1 text-[11px] text-white outline-none focus:border-indigo-500/50 transition-colors placeholder:text-slate-600"
            />
          </div>
          <div className="overflow-y-auto custom-scrollbar">
            {canInherit && q.length === 0 && (
              <button
                onClick={() => pick("inherit")}
                className={`w-full px-2 py-1.5 text-left text-[11px] font-bold rounded transition-all ${value === "inherit" ? "bg-indigo-500 text-white" : "text-slate-400 hover:text-white hover:bg-white/10"}`}
              >
                {inheritLabel}
              </button>
            )}
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-[10px] text-slate-600 text-center">No matches</p>
            )}
            {filtered.map(f => (
              <button
                key={f}
                onClick={() => pick(f)}
                className={`w-full px-2 py-1.5 text-left text-[11px] rounded transition-all ${value !== "inherit" && value === f ? "bg-white/10 text-white" : "text-slate-300 hover:text-white hover:bg-white/10"}`}
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