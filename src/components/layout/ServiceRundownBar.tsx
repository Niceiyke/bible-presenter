import React, { useEffect, useRef, useState } from "react";
import {
  CalendarDays, ChevronDown, ExternalLink, GripVertical, Save, X, Zap,
} from "lucide-react";
import { useAppStore } from "../../store";
import { displayItemLabel, getItemUid } from "../../utils";
import type { DisplayItem, ScheduleEntry } from "../../types";

export function ServiceRundownBar({
  nextLiveItem,
  stageItem,
  sendLive,
  persistSchedule,
}: {
  nextLiveItem: DisplayItem | null;
  stageItem: (item: DisplayItem) => Promise<boolean>;
  sendLive: (item: DisplayItem) => Promise<boolean>;
  persistSchedule: () => Promise<void>;
}) {
  const {
    scheduleEntries, pushScheduleState,
    stagedItem, liveItem, previousItem,
    services, activeServiceId,
    bottomDeckOpen, setBottomDeckOpen,
    setActiveTab,
    busyActions,
  } = useAppStore();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("pref_rundownCollapsed") === "1");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const compact = collapsed || bottomDeckOpen;
  const activeService = services.find((service) => service.id === activeServiceId);

  useEffect(() => {
    liveRef.current?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [liveItem && getItemUid(liveItem)]);

  const toggleCollapsed = () => {
    if (bottomDeckOpen) {
      setBottomDeckOpen(false);
      setCollapsed(false);
      localStorage.setItem("pref_rundownCollapsed", "0");
      return;
    }
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("pref_rundownCollapsed", next ? "1" : "0");
  };

  const reorder = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= scheduleEntries.length || to >= scheduleEntries.length) return;
    const next = [...scheduleEntries];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    pushScheduleState(next);
    void persistSchedule();
  };

  const remove = (entry: ScheduleEntry) => {
    pushScheduleState(scheduleEntries.filter((candidate) => candidate.id !== entry.id));
    void persistSchedule();
  };

  const openPlan = () => {
    setBottomDeckOpen(false);
    setActiveTab("schedule");
  };

  return (
    <section className="z-10 shrink-0 border-b border-console-border bg-console-surface shadow-[0_8px_24px_rgba(0,0,0,.16)]" aria-label="Service rundown">
      <header className="flex h-12 items-center gap-2 px-3">
        <button onClick={toggleCollapsed} className="flex h-7 w-7 items-center justify-center rounded-lg bg-action-primary/10 text-action-primary hover:bg-action-primary hover:text-black" aria-label={compact ? "Expand service rundown" : "Collapse service rundown"}>
          <ChevronDown size={13} className={`transition-transform ${compact ? "-rotate-90" : ""}`} />
        </button>
        <CalendarDays size={13} className="shrink-0 text-action-primary" />
        <div className="min-w-0">
          <h2 className="text-[9px] font-black uppercase tracking-[0.13em] text-console-text">Service rundown</h2>
          <p className="truncate text-[7px] font-bold text-console-text-subtle">{activeService?.name ?? "Active service"} · {scheduleEntries.length} item{scheduleEntries.length === 1 ? "" : "s"}</p>
        </div>

        {compact && scheduleEntries.length > 0 && (
          <div className="ml-2 flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {liveItem && <span className="max-w-[180px] truncate rounded bg-state-live/12 px-2 py-1 text-[8px] font-black text-state-live">LIVE · {displayItemLabel(liveItem)}</span>}
            {stagedItem && <span className="max-w-[180px] truncate rounded bg-state-stage/12 px-2 py-1 text-[8px] font-black text-state-stage">PREVIEW · {displayItemLabel(stagedItem)}</span>}
            {nextLiveItem && <span className="max-w-[180px] truncate rounded bg-action-primary/10 px-2 py-1 text-[8px] font-black text-action-primary">NEXT · {displayItemLabel(nextLiveItem)}</span>}
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button onClick={() => void persistSchedule()} disabled={busyActions.includes("save")} className="flex h-7 items-center gap-1.5 rounded-lg border border-console-border bg-console-canvas px-2 text-[8px] font-black uppercase text-console-text-muted hover:bg-console-surface-strong hover:text-console-text disabled:opacity-40">
            <Save size={10} /> Save
          </button>
          <button onClick={openPlan} className="flex h-7 items-center gap-1.5 rounded-lg border border-console-border bg-console-canvas px-2 text-[8px] font-black uppercase text-console-text-muted hover:border-action-primary/35 hover:text-action-primary">
            <ExternalLink size={10} /> Open plan
          </button>
        </div>
      </header>

      {!compact && (
        <div className="custom-scrollbar flex h-[96px] items-stretch gap-2 overflow-x-auto border-t border-console-border/70 px-3 py-2">
          {scheduleEntries.map((entry, index) => {
            const uid = getItemUid(entry.item);
            const isLive = !!liveItem && getItemUid(liveItem) === uid;
            const isStaged = !!stagedItem && getItemUid(stagedItem) === uid;
            const isNext = !isLive && !isStaged && !!nextLiveItem && getItemUid(nextLiveItem) === uid;
            const isPrevious = !isLive && !!previousItem && getItemUid(previousItem) === uid;
            const state = isLive ? "LIVE" : isStaged ? "PREVIEW" : isNext ? "NEXT" : isPrevious ? "PREVIOUS" : null;
            return (
              <div
                key={entry.id}
                ref={isLive ? liveRef : undefined}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => { if (dragIndex !== null) reorder(dragIndex, index); setDragIndex(null); }}
                onDragEnd={() => setDragIndex(null)}
                onClick={() => void stageItem(entry.item)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void stageItem(entry.item); } }}
                role="button"
                tabIndex={0}
                className={`group relative flex w-52 shrink-0 items-center gap-2 rounded-xl border px-2.5 text-left transition-all focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
                  isLive ? "border-state-live/45 bg-state-live/10"
                  : isStaged ? "border-state-stage/45 bg-state-stage/10"
                  : isNext ? "border-action-primary/30 bg-action-primary/5"
                  : "border-console-border/70 bg-console-canvas/45 hover:border-console-border-strong hover:bg-console-surface-raised"
                } ${dragIndex === index ? "opacity-40" : ""}`}
              >
                <GripVertical size={12} className="shrink-0 cursor-grab text-console-text-subtle opacity-45 group-hover:opacity-100" />
                <span className="w-4 shrink-0 text-right text-[8px] font-black tabular-nums text-console-text-subtle">{index + 1}</span>
                <span className={`h-10 w-1 shrink-0 rounded-full ${isLive ? "bg-state-live" : isStaged ? "bg-state-stage" : isNext ? "bg-action-primary" : "bg-console-border"}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[10px] font-bold text-console-text">{displayItemLabel(entry.item)}</span>
                  <span className="mt-1 flex items-center gap-1.5">
                    <span className="text-[7px] font-black uppercase tracking-wider text-console-text-subtle">{entry.item.type}</span>
                    {state && <span className={`rounded px-1.5 py-0.5 text-[7px] font-black ${isLive ? "bg-state-live text-white" : isStaged ? "bg-state-stage text-slate-950" : "bg-action-primary/15 text-action-primary"}`}>{state}</span>}
                  </span>
                </span>
                <span className="absolute right-1.5 top-1.5 hidden gap-1 group-hover:flex group-focus-within:flex">
                  <button onClick={(event) => { event.stopPropagation(); void sendLive(entry.item); }} aria-label={`Go live with ${displayItemLabel(entry.item)}`} className="flex h-6 w-6 items-center justify-center rounded-md bg-console-surface-strong text-console-text-muted hover:bg-action-primary hover:text-black"><Zap size={9} fill="currentColor" /></button>
                  <button onClick={(event) => { event.stopPropagation(); remove(entry); }} aria-label={`Remove ${displayItemLabel(entry.item)} from service`} className="flex h-6 w-6 items-center justify-center rounded-md bg-console-surface-strong text-console-text-muted hover:bg-state-live-soft hover:text-state-live"><X size={10} /></button>
                </span>
              </div>
            );
          })}

          {scheduleEntries.length === 0 && (
            <button onClick={openPlan} className="flex min-w-72 flex-1 items-center justify-center gap-2 rounded-xl border border-dashed border-console-border text-[9px] font-bold text-console-text-subtle hover:border-action-primary/35 hover:text-action-primary">
              <CalendarDays size={13} /> Open Service Plan to build your rundown
            </button>
          )}
        </div>
      )}
    </section>
  );
}
