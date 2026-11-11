import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, CornerDownLeft, EyeOff, Image as ImageIcon, Loader2, Monitor, Scan, X, Zap } from "lucide-react";
import { useAppStore } from "../../store";
import { displayItemLabel } from "../../utils";
import { PreviewCard } from "../PreviewCard";
import { ProgramSurfacePreview } from "../outputs/ProgramSurfacePreview";
import { ConfirmModal } from "../ui";
import { UpNextPanel } from "./UpNextPanel";
import type { DisplayItem, PresentationSettings } from "../../types";

interface CockpitProps {
  goLive: () => Promise<boolean>;
  clearStaged: () => Promise<boolean>;
  clearLive: () => Promise<boolean>;
  updateSettings: (s: PresentationSettings) => Promise<void>;
  stageItem: (item: DisplayItem) => Promise<boolean>;
  onAddToSchedule: (item: DisplayItem) => void;
}

/**
 * The live surface belongs above the workspace, not beside it. This keeps the
 * operator's eye on Preview → Program while restoring the full width of the
 * primary content browser for Scripture, songs, media, and service planning.
 *
 * Both monitors render inside a true 16:9 viewport. The preview is only useful
 * if it wraps text and crops backgrounds exactly like the audience output — a
 * fixed-height strip silently changes both.
 */
export function Cockpit({
  goLive,
  clearStaged,
  clearLive,
  updateSettings,
  stageItem,
  onAddToSchedule,
}: CockpitProps) {
  const {
    stagedItem: primaryStagedItem,
    liveItem: primaryLiveItem,
    settings, setIsBlackout,
    busyActions,
    setBackendError,
    setBusyAction,
    outputBuses, selectedOutputBusId, setSelectedOutputBusId, outputBusItems,
    outputs, outputStates, outputVisible,
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
  const primaryOutputVisible =
    outputStates["output"]?.visible ??
    outputs.find((output) => output.window_label === "output")?.visible ??
    outputVisible;
  const audienceOutputVisible = isPrimaryBus ? primaryOutputVisible : busWindowVisible;
  const outputWindowBusy = busyActions.includes("output") || busyActions.includes("output-bus-window");
  const goLiveBusy = busyActions.includes("goLive");
  const clearBusy = busyActions.includes("clearLive");
  const windowBusy = busyActions.includes("output-bus-window");
  const monitorBusy = busyActions.includes("output-monitor");
  const [monitors, setMonitors] = React.useState<Array<{ name: string; primary: boolean; width: number; height: number }>>([]);
  const [showGuides, setShowGuides] = React.useState(false);
  const [confirmClearLive, setConfirmClearLive] = React.useState(false);

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

  const revealAudienceOutput = async () => {
    if (outputWindowBusy) return;
    if (!isPrimaryBus) {
      await toggleBusWindow();
      return;
    }
    setBusyAction("output", true);
    try {
      await invoke("toggle_output_window");
    } catch (error: any) {
      setBackendError(`Output window: ${error?.message ?? error}`);
    } finally {
      setBusyAction("output", false);
    }
  };

  const stagedLabel = stagedItem ? displayItemLabel(stagedItem) : null;
  const logoConfigured = !!(settings.background_logo_path || settings.background_logo_text);
  const logoActive = !!settings.show_background_logo;

  return (
    <section className="shrink-0 border-b border-console-border bg-console-surface px-4 pb-3 pt-2" aria-label="Live canvas">
      <div className="live-canvas-shell mx-auto w-full">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <h2 className="text-[11px] font-black uppercase tracking-[0.14em] text-console-text">Live canvas</h2>
          <span className="hidden items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-console-text-subtle sm:flex" aria-label="Preview is staged, program is on air">
            <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-state-stage" />Preview</span>
            <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-state-live" />Program</span>
          </span>
          <label className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-console-text-subtle">
            Target
            <select
              value={selectedBus?.id ?? "primary"}
              onChange={(event) => setSelectedOutputBusId(event.target.value)}
              className="h-7 rounded-md border border-console-border bg-console-canvas px-2 text-[10px] font-bold uppercase tracking-wide text-console-text outline-none hover:border-action-primary/45"
              aria-label="Presentation output target"
            >
              {outputBuses.map((bus) => <option key={bus.id} value={bus.id}>{bus.label}</option>)}
            </select>
          </label>
          {busOutput && monitors.length > 1 && (
            <label className="hidden items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-console-text-subtle lg:flex">
              Screen
              <select
                value={busOutput.monitor_name ?? ""}
                onChange={(event) => void assignBusMonitor(event.target.value)}
                disabled={monitorBusy}
                className="h-7 max-w-36 rounded-md border border-console-border bg-console-canvas px-2 text-[10px] font-bold text-console-text outline-none hover:border-action-primary/45 disabled:opacity-50"
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
          <button
            onClick={() => setShowGuides((visible) => !visible)}
            aria-pressed={showGuides}
            title="Show title-safe and action-safe guides"
            className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-[10px] font-bold uppercase tracking-wide transition-colors ${showGuides ? "border-state-stage/45 bg-state-stage/10 text-state-stage" : "border-console-border bg-console-canvas text-console-text-muted hover:border-console-border-strong hover:text-console-text"}`}
          >
            <Scan size={12} />
            Guides
          </button>
        </div>
      </header>

      <div className="live-canvas-grid grid gap-2">
        <UpNextPanel onStage={stageItem} onAddToSchedule={onAddToSchedule} fill className="live-canvas-upnext" />

        <CanvasMonitor
          tone="stage"
          title="Preview"
          state={stagedItem ? "Staged" : "Empty"}
          subtitle="Safe to review"
          item={stagedItem}
          empty="Nothing staged"
          onClear={() => void clearStaged()}
          clearDisabled={!stagedItem}
          guides={showGuides}
          className="mx-auto w-full max-w-[560px] xl:max-w-none"
        >
          <PreviewCard item={stagedItem} label="" accent="" badge={null} empty="Stage is empty" isLocalPreview hideHeader />
        </CanvasMonitor>

        <CanvasMonitor
          tone="live"
          title="Program"
          state={liveItem ? "On air" : "Clear"}
          subtitle={isPrimaryBus ? "Audience output" : `${selectedBus?.label ?? "Auxiliary"} output`}
          item={liveItem}
          empty="Output clear"
          clearDisabled={!liveItem || clearBusy}
          clearBusy={clearBusy}
          guides={showGuides}
          hideEmptyOverlay
          className="mx-auto w-full max-w-[560px] xl:max-w-none"
        >
          {isPrimaryBus ? (
            <ProgramSurfacePreview className="absolute inset-0 h-full w-full" />
          ) : (
            <PreviewCard item={liveItem} label="" accent="" badge={null} empty="Output clear" isLocalPreview hideHeader />
          )}
        </CanvasMonitor>

        <div className="flex w-full max-w-[560px] min-h-0 flex-col gap-1.5 justify-self-center rounded-xl border border-console-border bg-console-canvas/45 p-3 xl:max-w-none">
          <div className="flex items-center gap-2 rounded-lg border border-console-border bg-console-surface px-2.5 py-1.5">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${liveItem ? "bg-state-live animate-pulse" : "bg-console-text-subtle"}`} />
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-console-text-subtle">Live</span>
            <span className={`ml-auto min-w-0 truncate text-[11px] font-bold ${liveItem ? "text-console-text" : "text-console-text-subtle"}`}>
              {liveItem ? displayItemLabel(liveItem) : "Nothing on air"}
            </span>
          </div>

          {liveItem && !audienceOutputVisible && (
            <div className="flex items-center gap-2 rounded-lg border border-state-warning/40 bg-state-warning/10 px-2.5 py-1.5 text-state-warning" role="status">
              <AlertTriangle size={13} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-bold uppercase tracking-wide">Output window off</p>
                <p className="truncate text-[10px] text-state-warning/80">Not reaching the audience</p>
              </div>
              <button
                onClick={() => void revealAudienceOutput()}
                disabled={outputWindowBusy}
                className="h-7 shrink-0 rounded border border-state-warning/40 px-2 text-[10px] font-bold uppercase tracking-wide text-state-warning hover:bg-state-warning/15 disabled:opacity-50"
              >
                {outputWindowBusy ? "Opening…" : "Open"}
              </button>
            </div>
          )}

          <button
            onClick={() => void goLive()}
            disabled={!stagedItem || goLiveBusy}
            title={stagedItem ? `Take ${stagedLabel} live (Enter)` : "Stage content in the preview first"}
            className="group flex min-h-20 w-full flex-col items-center justify-center rounded-xl border border-action-primary/50 bg-action-primary px-3 py-3 text-black shadow-lg shadow-action-primary/10 transition-all hover:bg-action-primary-hover disabled:cursor-not-allowed disabled:border-console-border disabled:bg-console-surface-raised disabled:text-console-text-subtle disabled:shadow-none"
          >
            <span className="flex items-center justify-center gap-2">
              {goLiveBusy ? <Loader2 size={18} className="animate-spin" /> : <Zap size={18} fill="currentColor" />}
              <span className="text-[13px] font-black uppercase tracking-[0.08em]">Take live</span>
              {stagedItem && (
                <span className="inline-flex items-center gap-1 rounded border border-black/20 bg-black/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide opacity-80">
                  <CornerDownLeft size={10} /> Enter
                </span>
              )}
            </span>
            <span className="mt-1 w-full truncate px-1 text-center text-[12px] font-bold opacity-75">
              {stagedLabel ?? "Stage content first"}
            </span>
          </button>
          <div className={`grid gap-1.5 ${isPrimaryBus ? "grid-cols-3" : "grid-cols-2"}`}>
            {isPrimaryBus && (
              <button
                onClick={() => { void updateSettings({ ...settings, show_background_logo: !logoActive }); }}
                disabled={!logoConfigured}
                aria-pressed={logoActive}
                title={logoConfigured
                  ? (logoActive ? "Hide the logo from the audience output" : "Show the media logo on the audience output")
                  : "Set a media item as Logo in the Media library first"}
                className={`flex h-11 flex-col items-center justify-center rounded-lg border text-[10px] font-black uppercase tracking-wide transition-all disabled:opacity-40 ${logoActive ? "border-tool-design/50 bg-tool-design/15 text-tool-design" : "border-console-border bg-console-surface text-console-text-muted hover:border-tool-design/40 hover:text-tool-design"}`}
              >
                <ImageIcon size={13} />
                {logoActive ? "Hide logo" : "Logo"}
              </button>
            )}
            {isPrimaryBus ? (
              <button
                onClick={() => {
                  const nextBlanked = !settings.is_blanked;
                  void updateSettings({ ...settings, is_blanked: nextBlanked });
                  setIsBlackout(nextBlanked);
                }}
                aria-pressed={settings.is_blanked}
                title={settings.is_blanked ? "Restore the audience output" : "Blank the audience output without dropping the live item"}
                className={`flex h-11 flex-col items-center justify-center rounded-lg border text-[10px] font-black uppercase tracking-wide transition-all ${settings.is_blanked ? "border-state-warning bg-state-warning text-black" : "border-console-border bg-console-surface text-console-text-muted hover:border-state-warning/40 hover:text-state-warning"}`}
              >
                <EyeOff size={13} />
                {settings.is_blanked ? "Restore" : "Blackout"}
              </button>
            ) : (
              <button
                onClick={() => void toggleBusWindow()}
                disabled={!busOutput || windowBusy}
                className={`flex h-11 flex-col items-center justify-center rounded-lg border text-[10px] font-black uppercase tracking-wide transition-all ${busWindowVisible ? "border-action-primary/50 bg-action-primary/15 text-action-primary" : "border-console-border bg-console-surface text-console-text-muted hover:border-action-primary/40 hover:text-action-primary"}`}
              >
                {windowBusy ? <Loader2 size={12} className="animate-spin" /> : <Monitor size={13} />}
                {busWindowVisible ? "Output on" : "Open output"}
              </button>
            )}
            <button
              onClick={() => setConfirmClearLive(true)}
              disabled={!liveItem || clearBusy}
              title="Remove the live item from the program"
              className="flex h-11 flex-col items-center justify-center rounded-lg border border-console-border bg-console-surface text-[10px] font-black uppercase tracking-wide text-console-text-muted transition-colors hover:border-state-live/45 hover:text-state-live disabled:opacity-40"
            >
              {clearBusy ? <Loader2 size={12} className="animate-spin" /> : <X size={13} />}
              Clear
            </button>
          </div>
          <p className="mt-auto px-0.5 text-[10px] leading-snug text-console-text-subtle">
            <span className="font-bold text-console-text-muted">Blackout</span> blanks the screen. <span className="font-bold text-console-text-muted">Clear</span> removes the live item.
          </p>
        </div>

      </div>
      </div>

      <ConfirmModal
        open={confirmClearLive}
        title="Clear program?"
        description={liveItem ? `This removes ${displayItemLabel(liveItem)} from the audience output and returns the program to the waiting screen.` : "The program is already clear."}
        confirmLabel="Clear program"
        confirmVariant="live"
        icon={<X size={18} className="text-state-live" />}
        busy={clearBusy}
        onConfirm={async () => {
          await clearLive();
        }}
        onClose={() => setConfirmClearLive(false)}
      />
    </section>
  );
}

function CanvasMonitor({
  tone,
  title,
  state,
  subtitle,
  item,
  empty,
  onClear,
  clearDisabled = true,
  clearBusy = false,
  guides = false,
  hideEmptyOverlay = false,
  className = "",
  children,
}: {
  tone: "stage" | "live";
  title: string;
  state: string;
  subtitle: string;
  item: DisplayItem | null;
  empty: string;
  onClear?: () => void;
  clearDisabled?: boolean;
  clearBusy?: boolean;
  guides?: boolean;
  /** The shared ProgramSurface already renders its own "waiting" state. */
  hideEmptyOverlay?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const stage = tone === "stage";
  return (
    <article className={`live-canvas-monitor min-w-0 overflow-hidden rounded-xl border bg-console-canvas/50 ${stage ? "border-state-stage/30" : item ? "border-state-live/40 shadow-lg shadow-state-live/10" : "border-console-border"} ${className}`}>
      <header className={`flex h-9 items-center gap-2 border-b px-2.5 ${stage ? "border-state-stage/15 bg-state-stage/[0.04]" : item ? "border-state-live/15 bg-state-live/[0.06]" : "border-console-border bg-transparent"}`}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${stage ? "bg-state-stage" : item ? "bg-state-live animate-pulse" : "bg-console-text-subtle"}`} />
        <span className={`text-[10px] font-black uppercase tracking-[0.12em] ${stage ? "text-state-stage" : "text-state-live"}`}>{title}</span>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${stage ? "border-state-stage/30 bg-state-stage/10 text-state-stage" : item ? "border-state-live/40 bg-state-live/15 text-state-live" : "border-console-border bg-console-surface text-console-text-subtle"}`}>{state}</span>
        <span className="ml-auto min-w-0 truncate text-[10px] font-semibold text-console-text-subtle">{subtitle}</span>
        {onClear && (
          <button
            onClick={onClear}
            disabled={clearDisabled}
            title={`Clear ${title.toLowerCase()}`}
            aria-label={`Clear ${title.toLowerCase()}`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-console-text-subtle transition-colors hover:bg-state-live-soft hover:text-state-live disabled:opacity-20"
          >
            {clearBusy ? <Loader2 size={11} className="animate-spin" /> : <X size={12} />}
          </button>
        )}
      </header>
      <div className={`relative w-full overflow-hidden bg-black ring-1 ring-inset ${stage ? "ring-state-stage/20" : "ring-state-live/20"}`} style={{ aspectRatio: "16 / 9" }}>
        {children}
        {guides && <SafeAreaGuides />}
        {!item && !hideEmptyOverlay && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25">
            <span className="text-[11px] font-bold uppercase tracking-wide text-white/40">{empty}</span>
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * Title-safe (90%) and action-safe (93%) guides for the operator preview. These
 * are diagnostic chrome only — never rendered into the audience output.
 */
function SafeAreaGuides() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20" aria-hidden="true">
      <div className="absolute inset-[5%] border border-white/35" />
      <div className="absolute inset-[3.5%] border border-dashed border-white/20" />
      <div className="absolute left-1/2 top-0 h-full w-px bg-white/10" />
      <div className="absolute left-0 top-1/2 h-px w-full bg-white/10" />
      <div className="absolute inset-x-0 top-[5%] flex justify-center">
        <span className="rounded-b bg-black/65 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white/60">Title safe</span>
      </div>
    </div>
  );
}
