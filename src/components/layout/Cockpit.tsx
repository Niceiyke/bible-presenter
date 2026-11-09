import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { EyeOff, Loader2, Monitor, X, Zap } from "lucide-react";
import { useAppStore } from "../../store";
import { displayItemLabel } from "../../utils";
import { PreviewCard } from "../PreviewCard";
import { ProgramSurfacePreview } from "../outputs/ProgramSurfacePreview";
import { ProgressBar } from "../ui";
import { itemMetaAt } from "../../items/registry";
import type { DisplayItem, PresentationSettings } from "../../types";

interface CockpitProps {
  goLive: () => Promise<boolean>;
  clearStaged: () => Promise<boolean>;
  clearLive: () => Promise<boolean>;
  updateSettings: (s: PresentationSettings) => Promise<void>;
}

/**
 * The live surface belongs above the workspace, not beside it. This keeps the
 * operator's eye on Preview → Program while restoring the full width of the
 * primary content browser for Scripture, songs, media, and service planning.
 */
export function Cockpit({
  goLive,
  clearStaged,
  clearLive,
  updateSettings,
}: CockpitProps) {
  const {
    stagedItem: primaryStagedItem,
    liveItem: primaryLiveItem,
    settings, setIsBlackout,
    busyActions,
    setBackendError,
    setBusyAction,
    outputBuses, selectedOutputBusId, setSelectedOutputBusId, outputBusItems,
    outputs, outputStates,
  } = useAppStore();
  const selectedBus = outputBuses.find((bus) => bus.id === selectedOutputBusId) ?? outputBuses[0];
  const isPrimaryBus = selectedBus?.primary !== false;
  const busItems = isPrimaryBus ? null : outputBusItems[selectedBus?.id ?? ""];
  const stagedItem = isPrimaryBus ? primaryStagedItem : busItems?.stagedItem ?? null;
  const liveItem = isPrimaryBus ? primaryLiveItem : busItems?.liveItem ?? null;
  const busOutput = isPrimaryBus
    ? outputs.find((output) => output.id === "output")
    : outputs.find((output) => output.kind === "window" && output.program_bus === selectedBus?.id);
  const busWindowVisible = busOutput
    ? (outputStates[busOutput.id]?.visible ?? busOutput.visible)
    : false;
  const goLiveBusy = busyActions.includes("goLive");
  const clearBusy = busyActions.includes("clearLive");
  const windowBusy = busyActions.includes("output-bus-window");
  const monitorBusy = busyActions.includes("output-monitor");
  const [monitors, setMonitors] = React.useState<Array<{ name: string; primary: boolean; width: number; height: number }>>([]);

  React.useEffect(() => {
    invoke<Array<{ name: string; primary: boolean; width: number; height: number }>>("outputs_monitors")
      .then(setMonitors)
      .catch((error: any) => setBackendError(`Could not list monitors: ${error?.message ?? error}`));
  }, [setBackendError]);

  const toggleBusWindow = async () => {
    if (!busOutput || windowBusy) return;
    setBusyAction("output-bus-window", true);
    try {
      await invoke("outputs_set_visible", { id: busOutput.id, visible: !busWindowVisible });
    } catch (error: any) {
      setBackendError(`Output window: ${error?.message ?? error}`);
    } finally {
      setBusyAction("output-bus-window", false);
    }
  };

  const assignBusMonitor = async (monitorName: string) => {
    if (!busOutput || monitorBusy) return;
    setBusyAction("output-monitor", true);
    try {
      const nextOutputs = outputs.map((output) => output.id === busOutput.id
        ? { ...output, monitor_name: monitorName || undefined }
        : output);
      await invoke("outputs_update", { configs: nextOutputs });
      // Re-applying visible state moves an on-air window immediately. The
      // backend still enforces signed output capacity on this path.
      if (busWindowVisible) {
        await invoke("outputs_set_visible", { id: busOutput.id, visible: true });
      }
    } catch (error: any) {
      setBackendError(`Monitor assignment: ${error?.message ?? error}`);
    } finally {
      setBusyAction("output-monitor", false);
    }
  };

  return (
    <section className="shrink-0 border-b border-console-border bg-console-surface px-4 pb-3 pt-2" aria-label="Live canvas">
      <header className="mb-2 flex items-center justify-between gap-3 px-0.5">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-state-stage" />
          <h2 className="text-[10px] font-black uppercase tracking-[0.16em] text-console-text">Live Canvas</h2>
          <label className="flex items-center gap-1.5 text-[8px] font-black uppercase tracking-wider text-console-text-subtle">
            Target
            <select
              value={selectedBus?.id ?? "primary"}
              onChange={(event) => setSelectedOutputBusId(event.target.value)}
              className="h-6 rounded-md border border-console-border bg-console-canvas px-1.5 text-[8px] font-black uppercase tracking-wider text-console-text outline-none hover:border-action-primary/45"
              aria-label="Presentation output target"
            >
              {outputBuses.map((bus) => <option key={bus.id} value={bus.id}>{bus.label}</option>)}
            </select>
          </label>
          {busOutput && monitors.length > 1 && (
            <label className="hidden items-center gap-1.5 text-[8px] font-black uppercase tracking-wider text-console-text-subtle lg:flex">
              Screen
              <select
                value={busOutput.monitor_name ?? ""}
                onChange={(event) => void assignBusMonitor(event.target.value)}
                disabled={monitorBusy}
                className="h-6 max-w-32 rounded-md border border-console-border bg-console-canvas px-1.5 text-[8px] font-black text-console-text outline-none hover:border-action-primary/45 disabled:opacity-50"
                aria-label="Output monitor assignment"
              >
                <option value="">Auto</option>
                {monitors.map((monitor) => (
                  <option key={monitor.name} value={monitor.name}>
                    {monitor.name} · {monitor.width}×{monitor.height}{monitor.primary ? " (Primary)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="text-[8px] font-bold uppercase tracking-wider text-console-text-subtle">Preview → Program</span>
        </div>
        <span className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-[8px] font-black uppercase ${liveItem ? "border-state-live/35 bg-state-live/10 text-state-live" : "border-console-border bg-console-canvas text-console-text-subtle"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${liveItem ? "bg-state-live animate-pulse" : "bg-console-text-subtle"}`} />
          {liveItem ? "On air" : "Program clear"}
        </span>
      </header>

      <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_172px]">
        <CanvasMonitor
          tone="stage"
          title="Preview"
          subtitle={isPrimaryBus ? "Staged · safe to review" : "Independent preview"}
          item={stagedItem}
          empty="Nothing staged"
          onClear={() => void clearStaged()}
          clearDisabled={!stagedItem}
        >
          <PreviewCard item={stagedItem} label="" accent="" badge={null} empty="Stage is empty" isLocalPreview hideHeader />
        </CanvasMonitor>

        <CanvasMonitor
          tone="live"
          title="Program"
          subtitle={isPrimaryBus ? "Audience output" : `${selectedBus?.label ?? "Auxiliary"} output`}
          item={liveItem}
          empty="Output clear"
          onClear={() => void clearLive()}
          clearDisabled={!liveItem || clearBusy}
          clearBusy={clearBusy}
        >
          {isPrimaryBus ? (
            <ProgramSurfacePreview className="absolute inset-0 h-full w-full" />
          ) : (
            <PreviewCard item={liveItem} label="" accent="" badge={null} empty="Output clear" isLocalPreview hideHeader />
          )}
        </CanvasMonitor>

        <div className="flex min-h-0 flex-col gap-2 rounded-xl border border-console-border bg-console-canvas/45 p-2">
          <button
            onClick={() => void goLive()}
            disabled={!stagedItem || goLiveBusy}
            className="group flex min-h-16 flex-1 flex-col items-center justify-center rounded-xl border border-action-primary/50 bg-action-primary px-3 text-black shadow-lg shadow-action-primary/10 transition-all hover:bg-action-primary-hover disabled:cursor-not-allowed disabled:border-console-border disabled:bg-console-surface-raised disabled:text-console-text-subtle disabled:shadow-none"
          >
            {goLiveBusy ? <Loader2 size={18} className="animate-spin" /> : <Zap size={18} fill="currentColor" />}
            <span className="mt-1 text-[11px] font-black uppercase tracking-[0.1em]">Take live</span>
            <span className="mt-0.5 w-full truncate text-center text-[7px] font-bold opacity-65">{stagedItem ? displayItemLabel(stagedItem) : "Stage content first"}</span>
          </button>
          <div className="grid grid-cols-2 gap-1.5">
            {isPrimaryBus ? (
              <button
                onClick={() => {
                  const nextBlanked = !settings.is_blanked;
                  void updateSettings({ ...settings, is_blanked: nextBlanked });
                  setIsBlackout(nextBlanked);
                }}
                aria-pressed={settings.is_blanked}
                className={`flex h-10 flex-col items-center justify-center rounded-lg border text-[7px] font-black uppercase tracking-wider transition-all ${settings.is_blanked ? "border-state-warning bg-state-warning text-black" : "border-console-border bg-console-surface text-console-text-muted hover:border-state-warning/40 hover:text-state-warning"}`}
              >
                <EyeOff size={12} />
                {settings.is_blanked ? "Restore" : "Black"}
              </button>
            ) : (
              <button
                onClick={() => void toggleBusWindow()}
                disabled={!busOutput || windowBusy}
                className={`flex h-10 flex-col items-center justify-center rounded-lg border text-[7px] font-black uppercase tracking-wider transition-all ${busWindowVisible ? "border-action-primary/50 bg-action-primary/15 text-action-primary" : "border-console-border bg-console-surface text-console-text-muted hover:border-action-primary/40 hover:text-action-primary"}`}
              >
                {windowBusy ? <Loader2 size={12} className="animate-spin" /> : <Monitor size={12} />}
                {busWindowVisible ? "Output on" : "Open output"}
              </button>
            )}
            <button onClick={() => void clearLive()} disabled={!liveItem || clearBusy} className="flex h-10 flex-col items-center justify-center rounded-lg border border-console-border bg-console-surface text-[7px] font-black uppercase tracking-wider text-console-text-muted hover:border-state-live/40 hover:text-state-live disabled:opacity-40">
              {clearBusy ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
              Clear
            </button>
          </div>
        </div>
      </div>

    </section>
  );
}

function CanvasMonitor({
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
      <header className="flex h-8 items-center gap-2 px-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${stage ? "bg-state-stage" : item ? "bg-state-live animate-pulse" : "bg-console-text-subtle"}`} />
        <span className={`text-[9px] font-black uppercase tracking-[0.12em] ${stage ? "text-state-stage" : "text-state-live"}`}>{title}</span>
        <span className="min-w-0 flex-1 truncate text-right text-[7px] font-bold uppercase text-console-text-subtle">{subtitle}</span>
        <button onClick={onClear} disabled={clearDisabled} className="flex h-6 w-6 items-center justify-center rounded-md text-console-text-subtle hover:bg-state-live-soft hover:text-state-live disabled:opacity-20" aria-label={`Clear ${title.toLowerCase()}`}>{clearBusy ? <Loader2 size={10} className="animate-spin" /> : <X size={11} />}</button>
      </header>
      <div className={`relative h-32 overflow-hidden bg-black ring-1 ring-inset sm:h-36 xl:h-40 ${stage ? "ring-state-stage/20" : "ring-state-live/20"}`}>
        {children}
        {!item && <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25"><span className="text-[8px] font-black uppercase tracking-wider text-white/30">{empty}</span></div>}
      </div>
      <div className="flex min-h-9 items-center px-2.5 py-1.5">
        {meta ? <div className="min-w-0 flex-1"><p className="truncate text-[8px] font-bold text-console-text" title={meta.title}>{meta.title}</p>{meta.progress !== null && <ProgressBar value={meta.progress} tone={tone} label={meta.progressLabel ?? undefined} className="mt-1" />}</div> : <p className="text-[8px] font-bold text-console-text-subtle">{empty}</p>}
      </div>
    </article>
  );
}
