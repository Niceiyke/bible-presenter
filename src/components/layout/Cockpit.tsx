import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Captions, ChevronRight, Clock, EyeOff, History, LayoutGrid, Layers,
  Loader2, Shapes, Timer, Undo2, Video, X, Zap,
} from "lucide-react";
import { useAppStore } from "../../store";
import { displayItemLabel, getItemUid } from "../../utils";
import { PreviewCard } from "../PreviewCard";
import { ProgramSurfacePreview } from "../outputs/ProgramSurfacePreview";
import { ClearAllModal } from "./ClearAllModal";
import { ProgressBar } from "../ui";
import { itemMetaAt } from "../../items/registry";
import type { DisplayItem, PresentationSettings } from "../../types";
import type { ClearSnapshot } from "../../hooks/useItemActions";

interface CockpitProps {
  nextLiveItem: DisplayItem | null;
  stageItem: (item: DisplayItem) => Promise<boolean>;
  goLive: () => Promise<boolean>;
  sendLive: (item: DisplayItem) => Promise<boolean>;
  clearStaged: () => Promise<boolean>;
  clearAll: () => Promise<ClearSnapshot | null>;
  undoClearAll: (snapshot: ClearSnapshot) => Promise<boolean>;
  updateSettings: (s: PresentationSettings) => Promise<void>;
  cockpitWidth: number;
  setCockpitWidth: (v: number) => void;
}

export function Cockpit({
  nextLiveItem,
  stageItem,
  goLive,
  sendLive,
  clearStaged,
  clearAll,
  undoClearAll,
  updateSettings,
  cockpitWidth,
  setCockpitWidth,
}: CockpitProps) {
  const {
    stagedItem,
    liveItem, setLiveItem,
    previousItem,
    settings, setIsBlackout,
    currentLowerThird, ltVisible, timerRunning, propItems, scenes,
    bottomDeckMode, setBottomDeckMode, setBottomDeckOpen,
    busyActions,
    setBackendError,
    setBusyAction,
  } = useAppStore();

  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [clearSnapshot, setClearSnapshot] = useState<ClearSnapshot | null>(null);
  const [liveHistory, setLiveHistory] = useState<DisplayItem[]>([]);
  const [, setNowTick] = useState(0);

  useEffect(() => {
    if (liveItem?.type !== "Timer" || !liveItem.data.started_at) return;
    const timer = window.setInterval(() => setNowTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [liveItem]);

  useEffect(() => {
    if (!liveItem) return;
    setLiveHistory((current) => {
      if (current[0] && getItemUid(current[0]) === getItemUid(liveItem)) return current;
      return [liveItem, ...current].slice(0, 10);
    });
  }, [liveItem]);

  const goLiveBusy = busyActions.includes("goLive");
  const clearBusy = busyActions.includes("clearLive");
  const clearAllBusy = busyActions.includes("clear");
  const historyItems = liveHistory.filter((item) => !liveItem || getItemUid(item) !== getItemUid(liveItem)).slice(0, 6);
  const liveTools = [
    { mode: "live-lt" as const, label: "Lower Third", icon: Captions, active: ltVisible && !!currentLowerThird, detail: ltVisible && currentLowerThird ? "On air" : "Off" },
    { mode: "timer" as const, label: "Timers", icon: Timer, active: timerRunning, detail: timerRunning ? "Running" : "Stopped" },
    { mode: "props" as const, label: "Props", icon: Shapes, active: propItems.length > 0, detail: `${propItems.length} active` },
    { mode: "camera" as const, label: "Camera", icon: Video, active: liveItem?.type === "Camera", detail: liveItem?.type === "Camera" ? "On air" : "Ready" },
    { mode: "scenes" as const, label: "Scenes", icon: LayoutGrid, active: false, detail: `${scenes.length} saved` },
  ];

  const clearLive = async () => {
    setBusyAction("clearLive", true);
    try {
      await invoke("clear_live");
      setLiveItem(null);
    } catch (error: any) {
      setBackendError(`Clear failed: ${error?.message ?? error}`);
    } finally {
      setBusyAction("clearLive", false);
    }
  };

  const handleClearAll = async () => {
    const snapshot = await clearAll();
    if (snapshot) setClearSnapshot(snapshot);
  };

  const handleUndoClear = async () => {
    if (!clearSnapshot) return;
    await undoClearAll(clearSnapshot);
    setClearSnapshot(null);
  };

  return (
    <>
      <div
        className="w-1 shrink-0 cursor-col-resize bg-console-border transition-colors hover:bg-action-primary/55 focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
        role="slider"
        tabIndex={0}
        aria-label="Live control panel width"
        aria-valuemin={340}
        aria-valuemax={620}
        aria-valuenow={cockpitWidth}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            const next = Math.min(620, cockpitWidth + 16);
            setCockpitWidth(next); localStorage.setItem("pref_cockpitWidth", String(Math.round(next)));
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            const next = Math.max(340, cockpitWidth - 16);
            setCockpitWidth(next); localStorage.setItem("pref_cockpitWidth", String(Math.round(next)));
          }
        }}
        onMouseDown={(event) => {
          const startX = event.clientX;
          const startWidth = cockpitWidth;
          const move = (moveEvent: MouseEvent) => {
            const next = Math.max(340, Math.min(620, startWidth - (moveEvent.clientX - startX)));
            setCockpitWidth(next);
            localStorage.setItem("pref_cockpitWidth", String(Math.round(next)));
          };
          const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
          };
          document.addEventListener("mousemove", move);
          document.addEventListener("mouseup", up);
        }}
      />

      <aside
        className="flex shrink-0 flex-col overflow-hidden border-l border-console-border bg-console-surface shadow-2xl shadow-black/20"
        style={{ width: `min(${cockpitWidth}px, 44vw)` }}
        aria-label="Live control"
      >
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-console-border bg-gradient-to-l from-state-live/5 to-transparent px-3">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-state-live/10 text-state-live"><Zap size={13} /></span>
            <div>
              <h2 className="text-[10px] font-black uppercase tracking-[0.14em] text-console-text">Live Control</h2>
              <p className="text-[7px] font-bold uppercase tracking-wider text-console-text-subtle">Preview → Program</p>
            </div>
          </div>
          <span className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-[8px] font-black uppercase ${liveItem ? "border-state-live/35 bg-state-live/10 text-state-live" : "border-console-border bg-console-canvas text-console-text-subtle"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${liveItem ? "bg-state-live animate-pulse" : "bg-console-text-subtle"}`} />
            {liveItem ? "On Air" : "Program Clear"}
          </span>
        </header>

        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
        <section className="border-b border-console-border p-3">
          <div className="grid grid-cols-1 gap-2">
            <MonitorCard
              tone="stage"
              title="Preview"
              subtitle="Not live"
              item={stagedItem}
              empty="Nothing staged"
              onClear={() => void clearStaged()}
              clearDisabled={!stagedItem}
            >
              <PreviewCard item={stagedItem} label="" accent="" badge={null} empty="Stage is empty" isLocalPreview hideHeader />
            </MonitorCard>

            <MonitorCard
              tone="live"
              title="Program"
              subtitle="Audience output"
              item={liveItem}
              empty="Output clear"
              onClear={() => void clearLive()}
              clearDisabled={!liveItem || clearBusy}
              clearBusy={clearBusy}
            >
              <ProgramSurfacePreview className="absolute inset-0 h-full w-full" />
            </MonitorCard>
          </div>

          <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
            <button
              onClick={() => void goLive()}
              disabled={!stagedItem || goLiveBusy}
              aria-label="Go Live"
              className="group flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-xl border border-action-primary/50 bg-action-primary px-4 text-black shadow-lg shadow-action-primary/15 transition-all hover:bg-action-primary-hover hover:shadow-action-primary/25 disabled:cursor-not-allowed disabled:border-console-border disabled:bg-console-surface-raised disabled:text-console-text-subtle disabled:shadow-none"
            >
              {goLiveBusy ? <Loader2 size={16} className="animate-spin" /> : <Zap size={16} fill="currentColor" />}
              <span className="min-w-0 text-left">
                <span className="block text-[11px] font-black uppercase tracking-[0.08em]">Go Live</span>
                <span className="block max-w-[230px] truncate text-[8px] font-bold opacity-65">{stagedItem ? displayItemLabel(stagedItem) : "Stage content first"}</span>
              </span>
              <ChevronRight size={14} className="transition-transform group-hover:translate-x-0.5" />
            </button>
            <button
              onClick={() => {
                const nextBlanked = !settings.is_blanked;
                void updateSettings({ ...settings, is_blanked: nextBlanked });
                setIsBlackout(nextBlanked);
              }}
              aria-pressed={settings.is_blanked}
              className={`flex min-w-20 flex-col items-center justify-center rounded-xl border px-3 text-[8px] font-black uppercase tracking-wider transition-all ${settings.is_blanked ? "border-state-warning bg-state-warning text-black" : "border-console-border bg-console-canvas text-console-text-muted hover:border-state-warning/40 hover:text-state-warning"}`}
            >
              <EyeOff size={14} />
              {settings.is_blanked ? "Restore" : "Blackout"}
            </button>
          </div>

          <div className="mt-2 flex items-center gap-2">
            {nextLiveItem ? (
              <button onClick={() => void stageItem(nextLiveItem)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-state-stage/25 bg-state-stage/5 px-2.5 py-2 text-left hover:bg-state-stage/10">
                <span className="shrink-0 text-[8px] font-black uppercase tracking-wider text-state-stage">Stage next</span>
                <span className="min-w-0 flex-1 truncate text-[9px] font-bold text-console-text-muted">{displayItemLabel(nextLiveItem)}</span>
                <ChevronRight size={11} className="shrink-0 text-state-stage" />
              </button>
            ) : <div className="flex-1" />}
            {previousItem && (
              <button onClick={() => void sendLive(previousItem)} className="flex h-9 items-center gap-1.5 rounded-lg border border-console-border bg-console-canvas px-2.5 text-[8px] font-black uppercase text-console-text-muted hover:bg-console-surface-strong hover:text-console-text" title={`Return live to ${displayItemLabel(previousItem)}`}>
                <Clock size={11} /> Previous
              </button>
            )}
            <button onClick={() => setClearModalOpen(true)} disabled={clearAllBusy} className="flex h-9 items-center gap-1.5 rounded-lg border border-console-border bg-console-canvas px-2.5 text-[8px] font-black uppercase text-console-text-muted hover:border-state-live/35 hover:bg-state-live-soft hover:text-state-live disabled:opacity-50">
              {clearAllBusy ? <Loader2 size={11} className="animate-spin" /> : <Layers size={11} />} Clear all
            </button>
          </div>

          {clearSnapshot && (
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-state-live/20 bg-state-live-soft px-2.5 py-1.5">
              <span className="flex-1 text-[9px] font-bold text-state-live">Output layers cleared</span>
              <button onClick={() => void handleUndoClear()} disabled={clearAllBusy} className="flex items-center gap-1 text-[8px] font-black uppercase text-state-live hover:text-console-text"><Undo2 size={10} /> Undo</button>
            </div>
          )}
        </section>

        <section className="border-b border-console-border p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers size={12} className="text-tool-design" />
              <h3 className="text-[9px] font-black uppercase tracking-[0.13em] text-console-text">Live Tools</h3>
            </div>
            <span className="text-[7px] font-bold uppercase tracking-wider text-console-text-subtle">Open in dock</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {liveTools.map(({ mode: toolMode, label, icon: Icon, active, detail }) => (
              <button
                key={toolMode}
                onClick={() => { setBottomDeckMode(toolMode); setBottomDeckOpen(true); }}
                className={`flex min-h-12 items-center gap-2 rounded-xl border px-2.5 text-left transition-all ${bottomDeckMode === toolMode ? "border-tool-design/35 bg-tool-design/10" : "border-console-border bg-console-canvas/45 hover:bg-console-surface-raised"}`}
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${active ? "bg-state-live/12 text-state-live" : "bg-console-surface-strong text-console-text-muted"}`}><Icon size={13} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[9px] font-black text-console-text">{label}</span>
                  <span className={`mt-0.5 flex items-center gap-1 text-[7px] font-bold ${active ? "text-state-live" : "text-console-text-subtle"}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-state-live" : "bg-console-border-strong"}`} /> {detail}
                  </span>
                </span>
                <ChevronRight size={10} className="text-console-text-subtle" />
              </button>
            ))}
          </div>
        </section>

        <section className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <History size={12} className="text-action-primary" />
              <h3 className="text-[9px] font-black uppercase tracking-[0.13em] text-console-text">Quick History</h3>
            </div>
            <span className="text-[7px] font-bold uppercase tracking-wider text-console-text-subtle">This session</span>
          </div>
          <div className="space-y-1">
            {historyItems.map((item, index) => (
              <div key={`${getItemUid(item)}-${index}`} className="group flex min-h-10 items-center gap-2 rounded-xl border border-transparent bg-console-canvas/45 px-2 hover:border-console-border hover:bg-console-surface-raised">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-console-surface-strong text-[8px] font-black text-console-text-subtle">{index + 1}</span>
                <button onClick={() => void stageItem(item)} className="min-w-0 flex-1 text-left" title="Stage this previous item">
                  <span className="block truncate text-[9px] font-bold text-console-text">{displayItemLabel(item)}</span>
                  <span className="block text-[7px] font-black uppercase tracking-wider text-console-text-subtle">{item.type} · click to preview</span>
                </button>
                <button onClick={() => void sendLive(item)} className="flex h-7 items-center gap-1 rounded-lg border border-console-border bg-console-surface-strong px-2 text-[7px] font-black uppercase text-console-text-muted opacity-0 transition-all hover:border-action-primary/40 hover:bg-action-primary hover:text-black group-hover:opacity-100 group-focus-within:opacity-100" aria-label={`Restore ${displayItemLabel(item)} live`}>
                  <Zap size={9} /> Restore
                </button>
              </div>
            ))}
            {historyItems.length === 0 && (
              <div className="rounded-xl border border-dashed border-console-border px-3 py-5 text-center">
                <p className="text-[9px] font-bold text-console-text-subtle">Previous live items will appear here.</p>
              </div>
            )}
          </div>
        </section>
        </div>
      </aside>

      <ClearAllModal open={clearModalOpen} onClose={() => setClearModalOpen(false)} onConfirm={handleClearAll} />
    </>
  );
}

function MonitorCard({
  tone,
  title,
  subtitle,
  item,
  empty,
  onClear,
  clearDisabled,
  clearBusy = false,
  children,
}: {
  tone: "stage" | "live";
  title: string;
  subtitle: string;
  item: DisplayItem | null;
  empty: string;
  onClear: () => void;
  clearDisabled: boolean;
  clearBusy?: boolean;
  children: React.ReactNode;
}) {
  const meta = item ? itemMetaAt(item, Date.now()) : null;
  const stage = tone === "stage";
  return (
    <article className={`min-w-0 overflow-hidden rounded-xl border bg-console-canvas/50 ${stage ? "border-state-stage/30" : "border-state-live/30"}`}>
      <header className="flex h-9 items-center gap-2 px-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${stage ? "bg-state-stage" : item ? "bg-state-live animate-pulse" : "bg-console-text-subtle"}`} />
        <span className={`text-[9px] font-black uppercase tracking-[0.12em] ${stage ? "text-state-stage" : "text-state-live"}`}>{title}</span>
        {stage && item && <span className="rounded bg-state-stage/15 px-1.5 py-0.5 text-[7px] font-black uppercase text-state-stage">Staged</span>}
        <span className="min-w-0 flex-1 truncate text-right text-[7px] font-bold uppercase text-console-text-subtle">{subtitle}</span>
        <button onClick={onClear} disabled={clearDisabled} className="flex h-6 w-6 items-center justify-center rounded-md text-console-text-subtle hover:bg-state-live-soft hover:text-state-live disabled:opacity-20" aria-label={`Clear ${title.toLowerCase()}`}>
          {clearBusy ? <Loader2 size={10} className="animate-spin" /> : <X size={11} />}
        </button>
      </header>
      <div className={`relative aspect-video overflow-hidden bg-black ring-1 ring-inset ${stage ? "ring-state-stage/20" : "ring-state-live/20"}`}>
        {children}
        {!item && <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25"><span className="text-[8px] font-black uppercase tracking-wider text-white/30">{empty}</span></div>}
      </div>
      <div className="min-h-10 px-2.5 py-1.5">
        {meta ? <>
          <p className="truncate text-[9px] font-bold text-console-text" title={meta.title}>{meta.title}</p>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="text-[7px] font-black uppercase tracking-wider text-console-text-subtle">{meta.kindLabel}</span>
            {meta.detail && <span className="truncate text-[7px] text-console-text-subtle">{meta.detail}</span>}
          </div>
          {meta.progress !== null && <ProgressBar value={meta.progress} tone={tone} label={meta.progressLabel ?? undefined} className="mt-1" />}
        </> : <p className="pt-1 text-[8px] font-bold text-console-text-subtle">{empty}</p>}
      </div>
    </article>
  );
}
