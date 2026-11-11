import React from "react";
import { useAppStore } from "../../store";
import { displayItemLabel, getItemUid } from "../../utils";
import { hasDisplayItemDrag, readDisplayItemDrop } from "../../utils/dragItem";
import { itemMetaAt } from "../../items/registry";
import type { DisplayItem } from "../../types";

/**
 * Compact service queue shown beside the preparation workspace. Rows stage
 * content only — going live stays in the Live Canvas Take Live control, so a
 * single misclick cannot change what the audience sees.
 */
export function UpNextPanel({
  onStage,
  onAddToSchedule,
  className = "",
  fill = false,
}: {
  onStage: (item: DisplayItem) => void;
  onAddToSchedule: (item: DisplayItem) => void;
  className?: string;
  /** Fill the parent row instead of capping the panel height. */
  fill?: boolean;
}) {
  const { scheduleEntries, activeScheduleIdx, liveItem, stagedItem } = useAppStore();
  const [dragOver, setDragOver] = React.useState(false);
  const start = activeScheduleIdx === null ? 0 : activeScheduleIdx + 1;
  const entries = scheduleEntries
    .slice(start)
    .filter((entry) => !liveItem || getItemUid(entry.item) !== getItemUid(liveItem));

  const content = (
    <>
      <header className="flex shrink-0 items-center justify-between gap-2 px-0.5">
        <h3 className="text-[11px] font-black uppercase tracking-[0.12em] text-console-text-muted">Up next</h3>
        {entries.length > 0 && <span className="text-[10px] font-bold text-console-text-subtle">{entries.length}</span>}
      </header>
      <div className="mt-1.5 min-h-0 flex-1 space-y-0.5 overflow-y-auto custom-scrollbar">
        {entries.length === 0 ? (
          <p className="px-1 py-2 text-[10px] leading-relaxed text-console-text-subtle">No further items in this service. Drop Bible verses, media, songs, or slides here.</p>
        ) : entries.map((entry, index) => {
          const label = displayItemLabel(entry.item);
          const isStaged = stagedItem ? getItemUid(entry.item) === getItemUid(stagedItem) : false;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onStage(entry.item)}
              title={`Stage ${label}`}
              className="group flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-console-border hover:bg-console-surface"
            >
              <span className="w-4 shrink-0 text-[10px] font-bold tabular-nums text-console-text-subtle">{start + index + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-bold text-console-text">{label}</span>
                <span className="block truncate text-[10px] text-console-text-subtle">{itemMetaAt(entry.item, Date.now()).kindLabel}</span>
              </span>
              <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-bold uppercase tracking-wide ${isStaged ? "bg-state-stage/10 text-state-stage" : "text-state-stage opacity-70 group-hover:opacity-100"}`}>
                {isStaged ? "Staged" : "Stage"}
              </span>
            </button>
          );
        })}
      </div>
      {dragOver && <p className="mt-1 shrink-0 px-1 text-[10px] font-bold text-action-primary">Drop to add to Up Next</p>}
    </>
  );

  return (
    <section
      onDragOver={(event) => {
        if (!hasDisplayItemDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(event) => {
        const item = readDisplayItemDrop(event);
        if (!item) return;
        event.preventDefault();
        setDragOver(false);
        onAddToSchedule(item);
      }}
      className={`rounded-xl border bg-console-canvas/35 transition-colors ${dragOver ? "border-action-primary/60 bg-action-primary/[0.06] ring-1 ring-action-primary/30" : "border-console-border"} ${fill ? "relative min-h-0" : "flex max-h-[clamp(140px,22vh,240px)] min-h-0 flex-col"} ${className}`}
      aria-label="Up next in the service. Drop Bible verses, media, songs, or slides here to add them."
    >
      {fill ? (
        <div className="absolute inset-0 flex min-h-0 flex-col p-2.5">{content}</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col p-2.5">{content}</div>
      )}
    </section>
  );
}
