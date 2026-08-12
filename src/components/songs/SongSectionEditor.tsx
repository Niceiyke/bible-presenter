import React, { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Trash2, ArrowUp, ArrowDown, Plus } from "lucide-react";
import type { LyricSection } from "../../types";
import { splitLyricLines } from "../../utils/song";

interface SongSectionEditorListProps {
  sections: LyricSection[];
  onChange: (next: LyricSection[]) => void;
}

const SECTION_LABELS = ["Verse", "Chorus", "Bridge", "Tag", "Pre-Chorus", "Intro", "Outro", "Instrumental"];

/** Phase 5: one multiline textarea per section (replaces the one-input-per-line
 *  control). Splitting happens via `splitLyricLines` so line order and
 *  intentional internal blank lines survive a save. Section controls use
 *  labelled icon buttons and keyboard navigation; nothing is hover-only. */
export function SongSectionEditorList({ sections, onChange }: SongSectionEditorListProps) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const toggle = (i: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const update = (i: number, patch: Partial<LyricSection>) =>
    onChange(sections.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const updateLines = (i: number, text: string) =>
    update(i, { lines: splitLyricLines(text) });

  const remove = (i: number) => onChange(sections.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) =>
    onChange((() => {
      const j = i + dir;
      if (j < 0 || j >= sections.length) return sections;
      const next = [...sections];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    })());
  const duplicate = (i: number) =>
    onChange((() => {
      const copy = { ...sections[i], id: undefined, label: `${sections[i].label} (copy)` };
      const next = [...sections];
      next.splice(i + 1, 0, copy);
      return next;
    })());

  const addSection = () =>
    onChange([
      ...sections,
      { label: "Verse", lines: [""] },
    ]);

  const iconBtn = (label: string, icon: React.ReactNode, onClick: () => void, disabled?: boolean) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="w-8 h-8 inline-flex items-center justify-center rounded-md text-console-text-subtle hover:text-console-text hover:bg-console-surface-strong disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] transition-all"
    >
      {icon}
    </button>
  );

  return (
    <div className="flex flex-col gap-1.5">
      {sections.map((sec, i) => {
        const isOpen = !collapsed.has(i);
        const lineCount = sec.lines.length;
        return (
          <div key={(sec.id ?? `local-${i}`)} className="border border-console-border rounded-lg bg-console-surface-raised/40">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <button
                type="button"
                aria-label={isOpen ? "Collapse section" : "Expand section"}
                onClick={() => toggle(i)}
                className="w-7 h-7 inline-flex items-center justify-center rounded-md text-console-text-subtle hover:bg-console-surface-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]"
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <select
                className="h-9 flex-1 min-w-0 rounded-md bg-console-surface-raised border border-console-border text-console-text text-xs px-2 focus:border-console-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]"
                value={SECTION_LABELS.includes(sec.label) ? sec.label : ""}
                onChange={(e) => update(i, { label: e.target.value || sec.label })}
              >
                <option value="" disabled>{sec.label || "Section label"}</option>
                {SECTION_LABELS.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
              <input
                className="h-9 w-28 rounded-md bg-console-surface-raised border border-console-border text-console-text text-xs px-2 focus:border-console-border-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]"
                placeholder="Custom label"
                value={SECTION_LABELS.includes(sec.label) ? "" : sec.label}
                onChange={(e) => update(i, { label: e.target.value })}
              />
              <span className="text-[10px] text-console-text-subtle tabular-nums shrink-0 hidden sm:inline">
                {lineCount} line{lineCount === 1 ? "" : "s"}
              </span>
              {iconBtn("Move section up", <ArrowUp size={14} />, () => move(i, -1), i === 0)}
              {iconBtn("Move section down", <ArrowDown size={14} />, () => move(i, 1), i === sections.length - 1)}
              {iconBtn("Duplicate section", <Copy size={14} />, () => duplicate(i))}
              {iconBtn("Delete section", <Trash2 size={14} />, () => remove(i))}
            </div>
            {isOpen && (
              <textarea
                className="w-full min-h-[80px] resize-y bg-console-surface border-t border-console-border text-console-text text-xs px-3 py-2 focus:outline-2 focus:outline-offset-0 focus-visible:outline-[var(--color-focus-ring)] font-mono"
                placeholder={"One lyric line per row"}
                value={sec.lines.join("\n")}
                onChange={(e) => updateLines(i, e.target.value)}
              />
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={addSection}
        className="inline-flex items-center justify-center gap-1.5 h-9 text-[11px] font-bold text-console-text-muted hover:text-console-text border border-dashed border-console-border rounded-lg transition-all focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[var(--color-focus-ring)]"
      >
        <Plus size={13} /> Add section
      </button>
    </div>
  );
}