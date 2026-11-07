import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, CalendarDays, Clock3, Monitor, Repeat, Keyboard, X, Signal, EyeOff, MonitorSmartphone, ExternalLink, Save } from "lucide-react";
import { useAppStore } from "../../store";
import { IconButton, StatusBadge } from "../ui";

export function AppHeader({ onPersistSchedule }: { onPersistSchedule?: () => Promise<void> }) {
  const {
    isLogOpen, setIsLogOpen,
    showShortcuts, setShowShortcuts,
    outputVisible, setOutputVisible,
    backendError, setBackendError,
    busyActions, setBusyAction,
    settings,
    services, activeServiceId, scheduleEntries,
    backendAvailable,
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

  return (
    <header className="z-30 flex h-14 shrink-0 items-center gap-3 border-b border-console-border bg-console-surface px-3 shadow-lg shadow-black/10">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-action-primary text-[10px] font-black text-black shadow-lg shadow-action-primary/20">WL</div>
          <div className="hidden md:block">
            <span className="block text-[10px] font-black uppercase tracking-[0.18em] text-console-text">Wordlyte</span>
            <span className="block text-[7px] font-black uppercase tracking-[0.16em] text-console-text-subtle">Operator</span>
          </div>
        </div>

        <div className="hidden h-6 w-px bg-console-border sm:block" />
        <button
          onClick={() => { setBottomDeckOpen(false); setActiveTab("schedule"); }}
          className="hidden min-w-0 max-w-[220px] items-center gap-2 rounded-lg border border-console-border bg-console-canvas/60 px-2.5 py-1.5 text-left transition-colors hover:border-action-primary/40 hover:bg-console-surface-strong sm:flex"
          title="Open Service Plan"
        >
          <CalendarDays size={12} className="shrink-0 text-action-primary" />
          <span className="min-w-0">
            <span className="block text-[7px] font-black uppercase tracking-wider text-console-text-subtle">Service rundown</span>
            <span className="block truncate text-[10px] font-black text-console-text">{activeService?.name ?? "No service selected"} <span className="text-console-text-subtle">· {scheduleEntries.length}</span></span>
          </span>
        </button>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 overflow-hidden">
        <StatusBadge
          tone={outputOn ? "success" : "neutral"}
          icon={<Monitor size={10} />}
          label={outputOn ? "Output On" : "Output Off"}
          className="max-w-[110px]"
        />
        <StatusBadge
          tone={settings.is_blanked ? "warning" : "neutral"}
          icon={<EyeOff size={10} />}
          label={settings.is_blanked ? "Blackout" : "Live"}
          className={`${settings.is_blanked ? "" : "hidden xl:inline-flex"}`}
        />
        <StatusBadge
          tone={backendAvailable ? "success" : "error"}
          icon={<Signal size={10} />}
          label={backendAvailable ? "Backend Ready" : "Backend Offline"}
          className="hidden lg:inline-flex"
        />
        {remoteCount !== null && (
          <button
            onClick={() => setActiveTab("remote")}
            title="Remote Control — click to open"
            aria-label="Remote Control devices"
            className="hover:opacity-80 transition-opacity shrink-0"
          >
            <StatusBadge
              tone={remoteCount > 0 ? "success" : "neutral"}
              icon={<MonitorSmartphone size={10} />}
              label={`Remote ${remoteCount}`}
              className="hidden md:inline-flex"
            />
          </button>
        )}
      </div>

      {backendError && (
        <button
          onClick={() => { setIsLogOpen(true); setBackendError(null); }}
          className="flex items-center gap-1.5 pl-1 pr-1 py-1 rounded-full bg-state-live-soft border border-state-live/50 text-state-live hover:bg-state-live/15 transition-all group shrink-0"
          title={backendError}
        >
          <StatusBadge tone="error" label="Backend issue" icon={<AlertTriangle size={11} />} className="border-transparent bg-transparent py-0" />
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); setBackendError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setBackendError(null); } }}
            className="text-state-live/70 hover:text-state-live shrink-0"
          >
            <X size={11} />
          </span>
        </button>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <div className="mr-1 hidden items-center gap-1 sm:flex">
          {onPersistSchedule && <button onClick={() => void onPersistSchedule()} disabled={busyActions.includes("save")} className="flex h-7 items-center gap-1.5 rounded-lg border border-console-border bg-console-canvas px-2 text-[8px] font-black uppercase text-console-text-muted hover:bg-console-surface-strong hover:text-console-text disabled:opacity-40" title="Save service plan"><Save size={10} /> Save</button>}
          <button onClick={() => { setBottomDeckOpen(false); setActiveTab("schedule"); }} className="flex h-7 items-center gap-1.5 rounded-lg border border-console-border bg-console-canvas px-2 text-[8px] font-black uppercase text-console-text-muted hover:border-action-primary/35 hover:text-action-primary" title="Open service plan"><ExternalLink size={10} /> Plan</button>
        </div>
        <div className="mr-1 hidden items-center gap-1.5 rounded-lg border border-console-border bg-console-canvas/50 px-2.5 py-1.5 xl:flex" title={now.toLocaleDateString()}>
          <Clock3 size={11} className="text-console-text-subtle" />
          <span className="font-mono text-[11px] font-bold tabular-nums text-console-text">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <IconButton
          label="Toggle Output Window (Ctrl+O)"
          tone="success"
          active={outputOn}
          loading={outputBusy}
          onClick={toggleOutput}
          disabled={outputBusy}
          size={15}
        >
          <Monitor size={15} />
        </IconButton>
        <div className="w-px h-4 bg-console-border mx-0.5" />
        <IconButton
          label="System Logs"
          active={isLogOpen}
          onClick={() => setIsLogOpen(!isLogOpen)}
          size={15}
        >
          <Repeat size={15} className="rotate-90" />
        </IconButton>
        <IconButton
          label="Keyboard Shortcuts (?)"
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
