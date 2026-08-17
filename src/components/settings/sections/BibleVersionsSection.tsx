import React from "react";
import { useAppStore } from "../../../store";
import { useT } from "../../../i18n";
import { FONTS } from "../../../types";
import { tierCapabilities } from "../../../system/tiers";
import type { SettingsSectionProps } from "../shared";

export function BibleVersionsSection({ onUpdateSettings }: SettingsSectionProps) {
  const { settings, availableVersions, license, setToast } = useAppStore();
  const t = useT();
  const caps = tierCapabilities(license?.tier);
  const disabled = settings.disabled_bible_versions || [];
  const enabledCount = availableVersions.filter(v => !disabled.includes(v)).length;
  const versionCapReached = enabledCount >= caps.maxBibleVersions;

  const toggleVersion = (v: string) => {
    if (disabled.includes(v)) {
      // Enabling this version.
      if (versionCapReached) {
        setToast(
          `The ${caps.maxBibleVersions > 0 ? "Free" : "current"} plan includes ${caps.maxBibleVersions} Bible version${caps.maxBibleVersions === 1 ? "" : "s"}. Upgrade to unlock all versions.`
        );
        return;
      }
      onUpdateSettings({ ...settings, disabled_bible_versions: disabled.filter(x => x !== v) });
    } else {
      onUpdateSettings({ ...settings, disabled_bible_versions: [...disabled, v] });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">{t("settings.ver.title")}</p>
        <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">{t("settings.ver.enableDisable")}</p>
        {caps.maxBibleVersions > 0 && versionCapReached && (
          <p className="text-[10px] text-amber-500 mb-2">
            The Free plan includes {caps.maxBibleVersions} Bible version. Upgrade to unlock all versions.
          </p>
        )}
        <div className="flex flex-wrap gap-2 mb-4">
          {availableVersions.map(v => (
            <button
              key={v}
              onClick={() => toggleVersion(v)}
              disabled={disabled.includes(v) && versionCapReached}
              title={disabled.includes(v) && versionCapReached ? "Upgrade to enable more versions" : undefined}
              className={`px-3 py-1.5 rounded-lg border text-[10px] font-bold transition-all disabled:opacity-40 ${
                !disabled.includes(v)
                  ? "bg-green-600 border-green-500 text-white"
                  : "bg-slate-800 border-slate-700 text-slate-500"
              }`}
            >
              {v} {!disabled.includes(v) ? '✓' : '✕'}
            </button>
          ))}
        </div>

        <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">{t("settings.ver.tagStyling")}</p>
        <div className="flex justify-between items-center mb-1">
          <span className="text-[10px] text-slate-500 uppercase font-bold">{t("settings.fontSize")}</span>
          <span className="text-xs font-mono text-amber-500">{settings.version_font_size ?? 24}pt</span>
        </div>
        <input
          type="range" min="10" max="72" step="2"
          value={settings.version_font_size ?? 24}
          onChange={(e) => onUpdateSettings({ ...settings, version_font_size: parseInt(e.target.value) })}
          className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500 mb-4"
        />

        <div className="flex justify-between items-center mb-2">
          <span className="text-[10px] text-slate-500 uppercase font-bold">{t("settings.sec.color")}</span>
          <span className="text-[10px] text-slate-500">{t("settings.ver.colorEmpty")}</span>
        </div>
        <div className="flex items-center gap-3 mb-4">
          <input
            type="color"
            value={settings.version_color && settings.version_color !== "" ? settings.version_color : "#ffffff"}
            onChange={(e) => onUpdateSettings({ ...settings, version_color: e.target.value })}
            className="w-10 h-8 rounded cursor-pointer bg-transparent border-0"
          />
          <span
            className="text-xs font-mono text-slate-300"
            style={{ color: settings.version_color && settings.version_color !== "" ? settings.version_color : undefined }}
          >
            {settings.version_color && settings.version_color !== "" ? settings.version_color : t("settings.ver.defaultOpacity")}
          </span>
          {settings.version_color && settings.version_color !== "" && (
            <button
              onClick={() => onUpdateSettings({ ...settings, version_color: "" })}
              className="ml-auto text-[10px] text-red-400 hover:text-red-300 font-bold"
            >
              {t("settings.sec.reset")}
            </button>
          )}
        </div>

        <div className="flex justify-between items-center mb-1">
          <span className="text-[10px] text-slate-500 uppercase font-bold">{t("settings.fontFamily")}</span>
        </div>
        <select
          value={settings.version_font_family ?? "Arial, sans-serif"}
          onChange={(e) => onUpdateSettings({ ...settings, version_font_family: e.target.value })}
          className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-2 cursor-pointer focus:outline-none focus:border-amber-500"
          style={{ fontFamily: settings.version_font_family ?? "Arial, sans-serif" }}
        >
          {FONTS.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
