import React from "react";
import { useAppStore } from "../../../store";
import { useT } from "../../../i18n";
import { THEMES } from "../../../types";
import type { SettingsSectionProps } from "../shared";

export function ThemeSection({ onUpdateSettings }: SettingsSectionProps) {
  const { settings } = useAppStore();
  const t = useT();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">{t("settings.theme.title")}</p>
        <div className="grid grid-cols-2 gap-2 mb-4">
          {Object.entries(THEMES).map(([key, { label, colors }]) => (
            <button
              key={key}
              onClick={() => onUpdateSettings({ ...settings, theme: key, custom_theme_colors: undefined })}
              className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs font-bold text-left transition-all ${
                settings.theme === key && !settings.custom_theme_colors
                  ? "border-amber-500 bg-amber-500/10 text-amber-400"
                  : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:bg-slate-800"
              }`}
            >
              <span className="w-5 h-5 rounded-sm shrink-0 border border-white/10" style={{ backgroundColor: colors.background }} />
              <span className="truncate">{label}</span>
              {settings.theme === key && !settings.custom_theme_colors && <span className="ml-auto text-amber-500">✓</span>}
            </button>
          ))}
        </div>

        <details className="group">
          <summary className="text-[10px] text-slate-500 uppercase font-bold cursor-pointer select-none hover:text-slate-400 mb-2 list-none flex items-center gap-1">
            <span className="group-open:rotate-90 transition-transform">▸</span> {t("settings.theme.overrides")}
          </summary>
          <div className="p-3 bg-slate-900/50 border border-slate-800 rounded-lg flex flex-col gap-3 mt-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-400 uppercase font-bold">{t("settings.theme.background")}</span>
              <input
                type="color"
                value={settings.custom_theme_colors?.background || THEMES[settings.theme].colors.background}
                onChange={(e) => onUpdateSettings({
                  ...settings,
                  custom_theme_colors: { ...THEMES[settings.theme].colors, ...settings.custom_theme_colors, background: e.target.value }
                })}
                className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-400 uppercase font-bold">{t("settings.theme.verseText")}</span>
              <input
                type="color"
                value={settings.custom_theme_colors?.verseText || THEMES[settings.theme].colors.verseText}
                onChange={(e) => onUpdateSettings({
                  ...settings,
                  custom_theme_colors: { ...THEMES[settings.theme].colors, ...settings.custom_theme_colors, verseText: e.target.value }
                })}
                className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-400 uppercase font-bold">{t("settings.theme.referenceText")}</span>
              <input
                type="color"
                value={settings.custom_theme_colors?.referenceText || THEMES[settings.theme].colors.referenceText}
                onChange={(e) => onUpdateSettings({
                  ...settings,
                  custom_theme_colors: { ...THEMES[settings.theme].colors, ...settings.custom_theme_colors, referenceText: e.target.value }
                })}
                className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
              />
            </div>
            {settings.custom_theme_colors && (
              <button
                onClick={() => onUpdateSettings({ ...settings, custom_theme_colors: undefined })}
                className="text-[9px] text-red-400 hover:text-red-300 font-bold uppercase tracking-widest mt-1"
              >
                {t("settings.theme.resetDefaults")}
              </button>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
