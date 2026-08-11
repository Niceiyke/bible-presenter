import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Monitor, Repeat, Keyboard, X, Signal, Video, User, EyeOff } from "lucide-react";
import { useAppStore } from "../../store";
import { IconButton, StatusBadge } from "../ui";
import { displayItemLabel } from "../../utils";

export function AppHeader() {
  const {
    isLogOpen, setIsLogOpen,
    showShortcuts, setShowShortcuts,
    outputVisible, setOutputVisible,
    backendError, setBackendError,
    busyActions, setBusyAction,
    stagedItem,
    settings,
    services, activeServiceId,
    backendAvailable,
  } = useAppStore();

  const outputBusy = busyActions.includes("output");

  const toggleOutput = async () => {
    if (outputBusy) return;
    setBusyAction("output", true);
    try {
      await invoke("toggle_output_window");
      setOutputVisible((v: boolean) => !v);
    } catch (e: any) {
      setBackendError(`Output window: ${e?.message ?? e}`);
    } finally {
      setBusyAction("output", false);
    }
  };

  const activeService = services.find((s) => s.id === activeServiceId);

  return (
    <header className="h-12 bg-console-surface border-b border-console-border flex items-center justify-between gap-3 px-3 shrink-0 z-30">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 bg-action-primary rounded-md flex items-center justify-center text-black font-black text-xs shadow-lg shadow-action-primary/20 shrink-0">WL</div>
          <span className="text-[11px] font-black uppercase tracking-[0.2em] text-console-text hidden md:block">Wordlyte</span>
        </div>

        {/* Active service */}
        {activeService && (
          <div className="flex items-center gap-1.5 max-w-[180px] min-w-0 hidden sm:flex">
            <User size={11} className="text-console-text-subtle shrink-0" />
            <span className="text-[10px] font-black uppercase tracking-wider text-console-text truncate" title={activeService.name}>
              {activeService.name}
            </span>
          </div>
        )}
      </div>

      {/* Live status cluster — text + icon, never color alone. */}
      <div className="flex items-center gap-1.5 min-w-0">
        <StatusBadge
          tone={outputVisible ? "success" : "neutral"}
          icon={<Monitor size={10} />}
          label={outputVisible ? "Output On" : "Output Off"}
          className="max-w-[110px]"
        />
        <StatusBadge
          tone={stagedItem ? "stage" : "neutral"}
          icon={<Video size={10} />}
          label={stagedItem ? `Staged: ${displayItemLabel(stagedItem)}` : "Nothing staged"}
          className={`max-w-[180px] ${stagedItem ? "" : "hidden sm:inline-flex"}`}
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

      <div className="flex items-center gap-1 shrink-0 ml-auto">
        <IconButton
          label="Toggle Output Window (Ctrl+O)"
          tone="success"
          active={outputVisible}
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