import React from "react";
import { ArrowUp, ArrowDown, Copy, X, RotateCcw, Trash2, Plus } from "lucide-react";
import type { LyricSection, Song, SongArrangementStep } from "../../types";
import { buildArrangementStepsFromSections } from "../../utils/song";

interface SongArrangementEditorProps {
  draft: Song;
  onChange: (steps: SongArrangementStep[]) => void;
}

const idMap = (sections: LyricSection[]): Map<string, LyricSection> =>
  new Map(sections.filter((s) => s.id).map((s) => [s.id!, s]));

/** Phase 5: arrangement-step editor. Steps reference section ids (a chorus can
 *  be repeated without duplicating its lyric content). Reordering steps only
 *  changes playback order; source sections stay in place. */
export function SongArrangementEditor({ draft, onChange }: SongArrangementEditorProps) {
  const byId = idMap(draft.sections);
  const steps = draft.arrangement_steps && draft.arrangement_steps.length > 0 ? draft.arrangement_steps : [];

  const setSteps = (next: SongArrangementStep[]) => onChange(next);

  const addStep = (sectionId: string) => setSteps([...steps, { section_id: sectionId }]);
  const removeAt = (i: number) => setSteps(steps.filter((_, idx) => idx !== i));
  const duplicateAt = (i: number) => {
    const next = [...steps];
    next.splice(i + 1, 0, steps[i]);
    setSteps(next);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
  };
  const reset = () => setSteps(buildArrangementStepsFromSections(draft.sections));
  const clear = () => setSteps([]);

  const stepBtn = (label: string, icon: React.ReactNode, onClick: () => void, disabled?: boolean) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="w-7 h-7 inline-flex items-center justify-center rounded-md text-console-text-subtle hover:text-console-text hover:bg-console-surface-strong disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] transition-all"
    >
      {icon}
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">Arrangement</p>
        <div className="flex gap-1">
          {stepBtn("Reset to natural order", <RotateCcw size={13} />, reset, draft.sections.length === 0)}
          {stepBtn("Clear arrangement", <Trash2 size={13} />, clear, steps.length === 0)}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {draft.sections.map((sec) => (
          <button
            key={sec.id ?? sec.label}
            type="button"
            onClick={() => sec.id && addStep(sec.id)}
            className="inline-flex items-center gap-1 h-8 px-2 text-[10px] font-bold rounded bg-console-surface-raised text-console-text-muted hover:text-console-text border border-console-border hover:border-console-border-strong transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]"
          >
            <Plus size={11} /> {sec.label}
          </button>
        ))}
      </div>

      {steps.length === 0 ? (
        <p className="text-[10px] text-console-text-subtle italic">Using natural section order.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {steps.map((step, i) => {
            const sec = byId.get(step.section_id);
            return (
              <li key={`${step.section_id}-${i}`} className="flex items-center gap-2 h-9 px-2 rounded-md bg-console-surface-raised border border-console-border">
                <span className="text-[10px] font-bold tabular-nums text-console-text-subtle w-5">{i + 1}.</span>
                <span className="text-xs font-bold text-console-text flex-1 truncate">{sec?.label ?? "Missing section"}</span>
                {stepBtn("Move step up", <ArrowUp size={13} />, () => move(i, -1), i === 0)}
                {stepBtn("Move step down", <ArrowDown size={13} />, () => move(i, 1), i === steps.length - 1)}
                {stepBtn("Duplicate step", <Copy size={13} />, () => duplicateAt(i))}
                {stepBtn("Remove step", <X size={13} />, () => removeAt(i))}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}