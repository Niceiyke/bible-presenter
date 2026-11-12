import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Monitor, Play, Square } from "lucide-react";
import { useAppStore } from "../../../store";
import { useT } from "../../../i18n";
import type { SettingsSectionProps } from "../shared";
import type { MonitorInfo } from "../../../types";

export function MonitorsSection({ onUpdateSettings }: SettingsSectionProps) {
  const { settings } = useAppStore();
  const t = useT();
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const monitorsKey = useRef("");

  const refreshMonitors = useCallback(async () => {
    try {
      const list = await invoke<MonitorInfo[]>("get_available_monitors");
      setMonitors(list);
      const key = list
        .map((monitor) => `${monitor.name}:${monitor.width}x${monitor.height}@${monitor.x},${monitor.y}`)
        .sort()
        .join("|");
      // A display was plugged in/removed or its geometry changed. Re-evaluate
      // visible output placement immediately; no app restart or hide/show.
      if (monitorsKey.current && monitorsKey.current !== key) {
        void invoke("outputs_reposition").catch(() => {});
      }
      monitorsKey.current = key;
    } catch {
      // A transient enumeration failure should not clear a working monitor
      // list; the next poll retries.
    }
  }, []);

  useEffect(() => {
    void refreshMonitors();
    const timer = window.setInterval(() => void refreshMonitors(), 2500);
    return () => window.clearInterval(timer);
  }, [refreshMonitors]);

  const chooseMonitor = (name?: string) => {
    void Promise.resolve(onUpdateSettings({ ...settings, preferred_monitor: name })).finally(() => {
      void invoke("outputs_reposition").catch(() => {});
    });
  };

  const runTest = async () => {
    if (testing) {
      await invoke("hide_output_test_pattern");
      setTesting(false);
      return;
    }
    try {
      await invoke("show_output_test_pattern");
      setTesting(true);
    } catch (err) {
      console.error("Monitor test failed:", err);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">{t("settings.outputMonitor")}</p>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-3 cursor-pointer group">
            <input
              type="radio"
              name="preferred_monitor"
              checked={!settings.preferred_monitor}
              onChange={() => chooseMonitor(undefined)}
              className="accent-amber-500"
            />
            <span className="text-xs text-slate-400 group-hover:text-slate-300">{t("settings.autoMonitor")}</span>
          </label>
          {monitors.map((m) => (
            <label key={m.name} className="flex items-center gap-3 cursor-pointer group">
              <input
                type="radio"
                name="preferred_monitor"
                checked={settings.preferred_monitor === m.name}
                onChange={() => chooseMonitor(m.name)}
                className="accent-amber-500"
              />
              <span className="text-xs text-slate-300 group-hover:text-white">
                {m.name} — {m.width}×{m.height}
                {m.is_primary && <span className="ml-1 text-[10px] text-slate-500">{t("settings.mon.primary")}</span>}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="border-t border-slate-800 pt-4">
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="text-xs text-slate-400 font-bold uppercase">{t("settings.mon.test")}</p>
            <p className="text-[10px] text-slate-600 mt-0.5">
              {t("settings.mon.testDesc")}
            </p>
          </div>
          <button
            onClick={runTest}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[10px] font-black uppercase transition-all border ${
              testing
                ? "bg-red-600 border-red-500 text-white"
                : "bg-amber-600 border-amber-500 text-black hover:bg-amber-500"
            }`}
          >
            {testing ? <Square size={12} /> : <Play size={12} />}
            {testing ? t("settings.mon.stopTest") : t("settings.mon.runTest")}
          </button>
        </div>
        {monitors.length === 0 && (
          <p className="text-[10px] text-slate-600 italic">{t("settings.mon.none")}</p>
        )}
      </div>

      <div className="border-t border-slate-800 pt-4">
        <p className="text-[10px] text-slate-500 uppercase font-bold mb-2 flex items-center gap-1">
          <Monitor size={12} /> {t("settings.mon.resNote")}
        </p>
        <p className="text-[10px] text-slate-600 leading-relaxed">
          {t("settings.mon.resDesc")}
        </p>
      </div>
    </div>
  );
}
