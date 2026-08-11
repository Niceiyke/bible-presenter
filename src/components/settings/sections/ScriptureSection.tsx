import React from "react";
import { useAppStore } from "../../../store";
import { useT } from "../../../i18n";
import { FONTS } from "../../../types";
import type { SettingsSectionProps } from "../shared";

export function ScriptureSection({ onUpdateSettings }: SettingsSectionProps) {
  const { settings } = useAppStore();
  const t = useT();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">{t("settings.sec.reference")}</p>
        <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">{t("settings.sec.position")}</p>
        <div className="flex gap-2 mb-4">
          {(["top", "bottom"] as const).map((pos) => (
            <button
              key={pos}
              onClick={() => onUpdateSettings({ ...settings, reference_position: pos })}
              className={`flex-1 py-3 rounded-lg border text-xs font-bold transition-all ${
                settings.reference_position === pos
                  ? "border-amber-500 bg-amber-500/10 text-amber-400"
                  : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:bg-slate-800"
              }`}
            >
              {pos === "top" ? t("settings.sec.top") : t("settings.sec.bottom")}
            </button>
          ))}
        </div>
        <div className="flex justify-between items-center mb-1">
          <span className="text-[10px] text-slate-500 uppercase font-bold">{t("settings.fontSize")}</span>
          <span className="text-xs font-mono text-amber-500">{settings.reference_font_size ?? 36}pt</span>
        </div>
        <input
          type="range" min="12" max="96" step="2"
          value={settings.reference_font_size ?? 36}
          onChange={(e) => onUpdateSettings({ ...settings, reference_font_size: parseInt(e.target.value) })}
          className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500 mb-4"
        />
        <div className="flex justify-between items-center mb-2">
          <span className="text-[10px] text-slate-500 uppercase font-bold">{t("settings.sec.color")}</span>
          <span className="text-[10px] text-slate-500">{t("settings.sec.colorEmptyTheme")}</span>
        </div>
        <div className="flex items-center gap-3 mb-4">
          <input
            type="color"
            value={settings.reference_color && settings.reference_color !== "" ? settings.reference_color : "#f59e0b"}
            onChange={(e) => onUpdateSettings({ ...settings, reference_color: e.target.value })}
            className="w-10 h-8 rounded cursor-pointer bg-transparent border-0"
          />
          <span
            className="text-xs font-mono text-slate-300"
            style={{ color: settings.reference_color && settings.reference_color !== "" ? settings.reference_color : undefined }}
          >
            {settings.reference_color && settings.reference_color !== "" ? settings.reference_color : t("settings.sec.themeDefault")}
          </span>
          {settings.reference_color && settings.reference_color !== "" && (
            <button
              onClick={() => onUpdateSettings({ ...settings, reference_color: "" })}
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
          value={settings.reference_font_family ?? "Arial, sans-serif"}
          onChange={(e) => onUpdateSettings({ ...settings, reference_font_family: e.target.value })}
          className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-2 cursor-pointer focus:outline-none focus:border-amber-500"
          style={{ fontFamily: settings.reference_font_family ?? "Arial, sans-serif" }}
        >
          {FONTS.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
          ))}
        </select>

        <details className="group mt-4">
          <summary className="text-[10px] text-slate-500 uppercase font-bold cursor-pointer select-none hover:text-slate-400 mb-2 list-none flex items-center gap-1">
            <span className="group-open:rotate-90 transition-transform">▸</span> {t("settings.sec.cvStyling")}
          </summary>
          <div className="p-3 bg-slate-900/50 border border-slate-800 rounded-lg flex flex-col gap-3 mt-2">
            <p className="text-[9px] text-slate-600 italic">{t("settings.sec.cvDesc")}</p>
            <div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] text-slate-500 uppercase font-bold">{t("settings.fontSize")}</span>
                <span className="text-xs font-mono text-amber-500">
                  {settings.chapter_verse_font_size != null ? `${settings.chapter_verse_font_size}pt` : t("settings.sec.inherit")}
                </span>
              </div>
              <input
                type="range" min="12" max="120" step="2"
                value={settings.chapter_verse_font_size ?? (settings.reference_font_size ?? 36)}
                onChange={(e) => onUpdateSettings({ ...settings, chapter_verse_font_size: parseInt(e.target.value) })}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
              />
              {settings.chapter_verse_font_size != null && (
                <button
                  onClick={() => onUpdateSettings({ ...settings, chapter_verse_font_size: undefined })}
                  className="text-[9px] text-red-400 hover:text-red-300 font-bold uppercase mt-1"
                >
                  {t("settings.sec.resetToInherit")}
                </button>
              )}
            </div>
            <div>
              <span className="text-[10px] text-slate-500 uppercase font-bold block mb-1">{t("settings.fontFamily")}</span>
              <select
                value={settings.chapter_verse_font_family ?? ""}
                onChange={(e) => onUpdateSettings({ ...settings, chapter_verse_font_family: e.target.value || undefined })}
                className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-2 cursor-pointer focus:outline-none focus:border-amber-500"
                style={{ fontFamily: settings.chapter_verse_font_family ?? "inherit" }}
              >
                <option value="">{t("settings.sec.inheritFromRef")}</option>
                {FONTS.map((f) => (
                  <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-slate-500 uppercase font-bold">{t("settings.sec.color")}</span>
                <span className="text-[10px] text-slate-500">{t("settings.sec.colorEmptyInherit")}</span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={settings.chapter_verse_color && settings.chapter_verse_color !== "" ? settings.chapter_verse_color : "#f59e0b"}
                  onChange={(e) => onUpdateSettings({ ...settings, chapter_verse_color: e.target.value })}
                  className="w-10 h-8 rounded cursor-pointer bg-transparent border-0"
                />
                <span className="text-xs font-mono text-slate-300">
                  {settings.chapter_verse_color && settings.chapter_verse_color !== "" ? settings.chapter_verse_color : t("settings.sec.inherit")}
                </span>
                {settings.chapter_verse_color && settings.chapter_verse_color !== "" && (
                  <button
                    onClick={() => onUpdateSettings({ ...settings, chapter_verse_color: "" })}
                    className="ml-auto text-[10px] text-red-400 hover:text-red-300 font-bold"
                  >
                    {t("settings.sec.reset")}
                  </button>
                )}
              </div>
            </div>
          </div>
        </details>
      </div>

      <div className="border-t border-slate-800 pt-4">
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">{t("settings.sec.autoSplit")}</p>
        <div className="flex items-center justify-between mb-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-slate-300 font-bold uppercase">{t("settings.sec.enableAutoSplit")}</span>
            <span className="text-[9px] text-slate-600">{t("settings.sec.autoSplitDesc")}</span>
          </div>
          <button
            onClick={() => onUpdateSettings({ ...settings, auto_split_verses: !settings.auto_split_verses })}
            className={`w-10 h-5 rounded-full relative transition-colors ${settings.auto_split_verses ? "bg-amber-500" : "bg-slate-700"}`}
          >
            <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${settings.auto_split_verses ? "left-6" : "left-1"}`} />
          </button>
        </div>
        {settings.auto_split_verses && (
          <>
            <div className="flex justify-between items-center mb-1">
              <span className="text-[10px] text-slate-500 uppercase font-bold">{t("settings.sec.splitThreshold")}</span>
              <span className="text-xs font-mono text-amber-500">{settings.verse_split_threshold} chars</span>
            </div>
            <input
              type="range" min="100" max="500" step="10"
              value={settings.verse_split_threshold}
              onChange={(e) => onUpdateSettings({ ...settings, verse_split_threshold: parseInt(e.target.value) })}
              className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500 mb-1"
            />
            <div className="flex justify-between">
              <span className="text-[9px] text-slate-600">{t("settings.sec.shortSlides")}</span>
              <span className="text-[9px] text-slate-600">{t("settings.sec.longSlides")}</span>
            </div>
          </>
        )}
      </div>

      <div className="border-t border-slate-800 pt-4">
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">{t("settings.sec.dynamicStyling")}</p>
        <div className="flex items-center justify-between mb-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-slate-300 font-bold uppercase">{t("settings.sec.highlightDivine")}</span>
            <span className="text-[9px] text-slate-600">{t("settings.sec.highlightDivineDesc")}</span>
          </div>
          <button
            onClick={() => onUpdateSettings({ ...settings, highlight_divine_words: !settings.highlight_divine_words })}
            className={`w-10 h-5 rounded-full relative transition-colors ${settings.highlight_divine_words ? "bg-amber-500" : "bg-slate-700"}`}
          >
            <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${settings.highlight_divine_words ? "left-6" : "left-1"}`} />
          </button>
        </div>
        {settings.highlight_divine_words && (
          <div className="flex items-center gap-3 mb-4 p-3 bg-slate-900/50 border border-slate-800 rounded-lg">
            <span className="text-[10px] text-slate-400 uppercase font-bold">{t("settings.sec.highlightColor")}</span>
            <input
              type="color"
              value={settings.highlight_color || "#ef4444"}
              onChange={(e) => onUpdateSettings({ ...settings, highlight_color: e.target.value })}
              className="w-10 h-8 rounded cursor-pointer bg-transparent border-0"
            />
            <span className="text-xs font-mono text-slate-300 ml-auto">
              {settings.highlight_color || "#ef4444"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
