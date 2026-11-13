import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, CalendarDays, Clock3, Monitor, Keyboard, X, Signal, EyeOff, MonitorSmartphone, Save, ScrollText, Loader2 } from "lucide-react";
import { useAppStore } from "../../store";
import { BrandLockup } from "../brand/Brand";
import { IconButton, StatusBadge } from "../ui";

export function AppHeader({ onPersistSchedule }: { onPersistSchedule?: () => Promise<void> }) {
  const {
    isLogOpen, setIsLogOpen,
    showShortcuts, setShowShortcuts,
    outputVisible,
    backendError, setBackendError,
    backendAvailable,
    busyActions, setBusyAction,
    settings,
    services, activeServiceId, scheduleEntries,
    setActiveTab,
    setBottomDeckOpen,
    outputs, outputStates,
  } = useAppStore();

  // Authoritative visibility comes from the OutputManager state the backend
  // broadcasts (output-config-changed / output-state-changed). The legacy
  // `outputVisible` store flag is only a pre-hydration fallback.
  const outputOn =
    outputStates["output"]?.visible ??
    outputs.find((o) => o.window_label === "output")?.visible ??
    outputVisible;

  const [remoteCount, setRemoteCount] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(() => new Date());

  React.useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  React.useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const st = await invoke<any>("remote_status");
        if (!alive) return;
        setRemoteCount(
          st?.enabled ? (st.devices?.filter((d: any) => d.connected).length ?? 0) : null
        );
      } catch {
        if (alive) setRemoteCount(null);
      }
    };
    poll();
    const id = window.setInterval(poll, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const outputBusy = busyActions.includes("output");
  const saveBusy = busyActions.includes("save");

  const toggleOutput = async () => {
    if (outputBusy) return;
    setBusyAction("output", true);
    try {
      // The backend is the single source of truth for visibility: it toggles
      // the window, persists outputs.json, and broadcasts the authoritative
      // output config/state, which the store mirrors into `outputStates`.
      await invoke("toggle_output_window");
    } catch (e: any) {
      setBackendError(`Output window: ${e?.message ?? e}`);
    } finally {
      setBusyAction("output", false);
    }
  };

  const activeService = services.find((s) => s.id === activeServiceId);
  const itemCount = scheduleEntries.length;

  return (
    <header className="z-30 flex h-14 shrink-0 items-center gap-3 border-b border-console-border bg-console-surface px-3 shadow-lg shadow-black/10">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex shrink-0 items-center">
          <BrandLockup className="h-7 w-auto" />
        </div>

        <div className="hidden h-6 w-px bg-console-border sm:block" />
        <button
          onClick={() => { setBottomDeckOpen(false); setActiveTab("schedule"); }}
          className="hidden min-w-0 max-w-[240px] items-center gap-2 rounded-lg border border-console-border bg-console-canvas/60 px-2.5 py-1.5 text-left transition-colors hover:border-action-primary/40 hover:bg-console-surface-strong sm:flex"
          title="Open service plan"
        >
          <CalendarDays size={13} className="shrink-0 text-action-primary" />
          <span className="min-w-0">
            <span className="block text-[10px] font-black uppercase tracking-wider text-console-text-subtle">Service plan</span>
            <span className="block truncate text-[11px] font-bold text-console-text">
              {activeService?.name ?? "No service selected"}
              <span className="text-console-text-subtle"> · {itemCount} {itemCount === 1 ? "item" : "items"}</span>
            </span>
          </span>
        </button>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center gap-2 overflow-hidden">
        <button
          onClick={toggleOutput}
          disabled={outputBusy}
          aria-label="Toggle Output Window (Ctrl+O)"
          aria-pressed={outputOn}
          title="Toggle the audience output window (Ctrl+O)"
          className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[10px] font-bold uppercase tracking-wider transition-colors disabled:opacity-50 ${outputOn ? "border-state-success/40 bg-state-success/10 text-state-success" : "border-console-border bg-console-surface-raised text-console-text-muted hover:border-console-border-strong hover:text-console-text"}`}
        >
          {outputBusy ? <Loader2 size={11} className="animate-spin" /> : <Monitor size={11} />}
          <span aria-live="polite">{outputOn ? "Output On" : "Output Off"}</span>
        </button>
        {settings.is_blanked && (
          <StatusBadge tone="warning" icon={<EyeOff size={10} />} label="Blackout" />
        )}
        {remoteCount !== null && (
          <button
            onClick={() => setActiveTab("remote")}
            title="Remote control — click to open"
            aria-label="Remote control devices"
            className="shrink-0 transition-opacity hover:opacity-80"
          >
            <StatusBadge
              tone={remoteCount > 0 ? "success" : "neutral"}
              icon={<MonitorSmartphone size={10} />}
              label={`Remote ${remoteCount}`}
              className="hidden md:inline-flex"
            />
          </button>
        )}
        {!backendAvailable && (
          <StatusBadge
            tone="error"
            icon={<Signal size={10} />}
            label="Service Offline"
            className="hidden lg:inline-flex"
          />
        )}
      </div>

      {backendError && (
        <div className="flex shrink-0 items-center gap-1 rounded-full border border-state-live/50 bg-state-live-soft py-1 pl-1.5 pr-1">
          <button
            onClick={() => setIsLogOpen(true)}
            className="flex items-center gap-1.5 rounded-full px-1 py-0.5 text-state-live transition-colors hover:bg-state-live/15"
            title={backendError}
          >
            <StatusBadge tone="error" label="Service issue" icon={<AlertTriangle size={11} />} className="border-transparent bg-transparent py-0" />
          </button>
          <button
            onClick={() => setBackendError(null)}
            aria-label="Dismiss service error"
            className="flex h-6 w-6 items-center justify-center rounded-full text-state-live/70 transition-colors hover:bg-state-live/15 hover:text-state-live"
          >
            <X size={11} />
          </button>
        </div>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {onPersistSchedule && (
          <button
            onClick={() => void onPersistSchedule()}
            disabled={saveBusy}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-console-border bg-console-canvas px-2.5 text-[10px] font-bold uppercase text-console-text-muted transition-colors hover:bg-console-surface-strong hover:text-console-text disabled:opacity-50"
            title="Save service plan"
            aria-label="Save service plan"
          >
            {saveBusy ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
            {saveBusy ? "Saving" : "Save"}
          </button>
        )}
        <div className="mr-1 hidden items-center gap-1.5 rounded-lg border border-console-border bg-console-canvas/50 px-2.5 py-1.5 xl:flex" title={now.toLocaleDateString()}>
          <Clock3 size={11} className="text-console-text-subtle" />
          <span className="font-mono text-[11px] font-bold tabular-nums text-console-text">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <IconButton
          label="System logs"
          active={isLogOpen}
          onClick={() => setIsLogOpen(!isLogOpen)}
          size={15}
        >
          <ScrollText size={15} />
        </IconButton>
        <IconButton
          label="Keyboard shortcuts (?)"
          active={showShortcuts}
          onClick={() => setShowShortcuts(true)}
          size={15}
        >
          <Keyboard size={15} />
        </IconButton>
      </div>
    </header>
  );
}
