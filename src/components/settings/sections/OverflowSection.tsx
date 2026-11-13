import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeOff, Monitor } from "lucide-react";
import { useAppStore } from "../../../store";
import { useT } from "../../../i18n";
import type { SettingsSectionProps } from "../shared";
import type { MonitorInfo } from "../../../types";

/** Monitor assignment and visibility for the independent Overflow output bus. */
export function OverflowSection(_props: SettingsSectionProps) {
  const t = useT();
  const outputs = useAppStore((state) => state.outputs);
  const outputStates = useAppStore((state) => state.outputStates);
  const setBackendError = useAppStore((state) => state.setBackendError);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [busy, setBusy] = useState(false);

  const overflow = outputs.find((output) => output.id === "overflow" || output.window_label === "overflow");
  const visible = overflow
    ? (outputStates[overflow.id]?.visible ?? overflow.visible)
    : false;

  const refreshMonitors = useCallback(async () => {
    try {
      setMonitors(await invoke<MonitorInfo[]>("get_available_monitors"));
    } catch {
      // Keep the last known list; the next poll retries.
    }
  }, []);

  useEffect(() => {
    void refreshMonitors();
    const timer = window.setInterval(() => void refreshMonitors(), 2500);
    return () => window.clearInterval(timer);
  }, [refreshMonitors]);

  const assignMonitor = async (name?: string) => {
    if (!overflow || busy) return;
    setBusy(true);
    try {
      const next = outputs.map((output) => output.id === overflow.id
        ? { ...output, monitor_name: name }
        : output);
      await invoke("outputs_update", { configs: next });
      // Re-applying visibility moves an already visible overflow window.
      if (visible) await invoke("outputs_set_visible", { id: overflow.id, visible: true });
    } catch (error) {
      setBackendError(`Could not assign the overflow monitor: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleVisible = async () => {
    if (!overflow || busy) return;
    setBusy(true);
    try {
      await invoke("outputs_set_visible", { id: overflow.id, visible: !visible });
    } catch (error) {
      setBackendError(`Could not change the overflow display: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  if (!overflow) {
    return <p className="text-[11px] italic text-console-text-subtle">{t("settings.overflow.missing")}</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase text-console-text-muted">
            <Monitor size={13} /> {t("settings.overflow.title")}
          </p>
          <p className="max-w-xl text-[10px] leading-relaxed text-console-text-subtle">{t("settings.overflow.desc")}</p>
        </div>
        <button
          type="button"
          onClick={() => void toggleVisible()}
          disabled={busy}
          className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-[10px] font-black uppercase transition-all disabled:opacity-50 ${
            visible
              ? "border-state-live/40 bg-state-live/10 text-state-live hover:bg-state-live/20"
              : "border-console-border bg-console-surface-raised text-console-text-muted hover:text-console-text"
          }`}
        >
          {visible ? <EyeOff size={12} /> : <Eye size={12} />}
          {visible ? t("settings.overflow.hide") : t("settings.overflow.show")}
        </button>
      </div>

      <div className="border-t border-console-border pt-4">
        <p className="mb-2 text-xs font-bold uppercase text-console-text-muted">{t("settings.outputMonitor")}</p>
        <div className="flex flex-col gap-2">
          <label className="group flex cursor-pointer items-center gap-3">
            <input
              type="radio"
              name="overflow_monitor"
              checked={!overflow.monitor_name}
              onChange={() => void assignMonitor(undefined)}
              disabled={busy}
              className="accent-amber-500"
            />
            <span className="text-xs text-console-text-muted group-hover:text-console-text">{t("settings.overflow.autoMonitor")}</span>
          </label>
          {monitors.map((monitor) => (
            <label key={monitor.name} className="group flex cursor-pointer items-center gap-3">
              <input
                type="radio"
                name="overflow_monitor"
                checked={overflow.monitor_name === monitor.name}
                onChange={() => void assignMonitor(monitor.name)}
                disabled={busy}
                className="accent-amber-500"
              />
              <span className="text-xs text-console-text group-hover:text-white">
                {monitor.name} — {monitor.width}×{monitor.height}
                {monitor.is_primary && <span className="ml-1 text-[10px] text-console-text-subtle">{t("settings.mon.primary")}</span>}
              </span>
            </label>
          ))}
          {monitors.length === 0 && <p className="text-[10px] italic text-console-text-subtle">{t("settings.mon.none")}</p>}
        </div>
      </div>

      <div className="border-t border-console-border pt-4">
        <p className="text-[10px] leading-relaxed text-console-text-subtle">{t("settings.overflow.pro")}</p>
      </div>
    </div>
  );
}
