import React from "react";
import { useAppStore } from "../../../store";
import { useT } from "../../../i18n";
import { FONTS } from "../../../types";
import type { SettingsSectionProps } from "../shared";

export function OutputSection({ onUpdateSettings }: SettingsSectionProps) {
  const { settings } = useAppStore();
  const t = useT();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-between items-center">
        <div>
          <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">{t("settings.out.screenBlanking")}</p>
          <p className="text-[10px] text-slate-600 mt-0.5">{t("settings.out.screenBlankingDesc")}</p>
        </div>
        <button
          onClick={() => onUpdateSettings({ ...settings, is_blanked: !settings.is_blanked })}
          className={`px-4 py-2 rounded-lg text-xs font-black transition-all border ${
            settings.is_blanked
              ? "bg-red-500 border-red-500 text-white"
              : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"
          }`}
        >
          {settings.is_blanked ? t("settings.screenBlanked") : t("settings.blankScreen")}
        </button>
      </div>

      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">{t("settings.scriptureVerse")}</p>
        <div className="flex justify-between items-center mb-1">
          <span className="text-[10px] text-slate-500 uppercase font-bold">{t("settings.fontSize")}</span>
          <span className="text-xs font-mono text-amber-500">{settings.font_size}pt</span>
        </div>
        <input
          type="range" min="24" max="144" step="2"
          value={settings.font_size}
          onChange={(e) => onUpdateSettings({ ...settings, font_size: parseInt(e.target.value) })}
          className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500 mb-3"
        />
        <div className="flex justify-between items-center mb-1">
          <span className="text-[10px] text-slate-500 uppercase font-bold">{t("settings.fontFamily")}</span>
        </div>
        <select
          value={settings.verse_font_family ?? "Georgia, serif"}
          onChange={(e) => onUpdateSettings({ ...settings, verse_font_family: e.target.value })}
          className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-2 cursor-pointer focus:outline-none focus:border-amber-500"
          style={{ fontFamily: settings.verse_font_family ?? "Georgia, serif" }}
        >
          {FONTS.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
          ))}
        </select>
      </div>

      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">{t("settings.out.songLabels")}</p>
        <div className="flex items-center justify-between gap-4">
          <p className="text-[10px] text-slate-600">{t("settings.out.songLabelsDesc")}</p>
          <button
            role="switch"
            aria-checked={!!settings.show_song_section_labels}
            onClick={() => onUpdateSettings({ ...settings, show_song_section_labels: !settings.show_song_section_labels })}
            className={`shrink-0 w-10 h-5 rounded-full transition-all border ${
              settings.show_song_section_labels
                ? "bg-amber-500 border-amber-500"
                : "bg-slate-800 border-slate-700"
            }`}
          >
            <span
              className={`block w-4 h-4 rounded-full bg-white transition-transform ${
                settings.show_song_section_labels ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
      </div>

      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">{t("settings.out.refHeight")}</p>
        <div className="flex flex-wrap gap-2 mb-2">
          {([720, 900, 1080, 1440] as const).map((h) => (
            <button
              key={h}
              onClick={() => onUpdateSettings({ ...settings, reference_output_height: h })}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                (settings.reference_output_height ?? 1080) === h
                  ? "bg-amber-500 border-amber-500 text-black"
                  : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"
              }`}
            >
              {h}px
            </button>
          ))}
        </div>
        <p className="text-[10px] text-slate-600 mb-2">{t("settings.out.refHeightDesc")}</p>
        <input
          type="number"
          min={540}
          max={2160}
          step={60}
          value={settings.reference_output_height ?? 1080}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!Number.isNaN(v)) onUpdateSettings({ ...settings, reference_output_height: v });
          }}
          className="w-28 h-9 bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 focus:outline-none focus:border-amber-500"
        />
      </div>

      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">{t("settings.out.slideTransition")}</p>
        <div className="flex flex-wrap gap-2 mb-3">
          {(["fade", "slide-up", "slide-left", "zoom", "none"] as const).map((tr) => (
            <button
              key={tr}
              onClick={() => onUpdateSettings({ ...settings, slide_transition: tr })}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                (settings.slide_transition ?? "fade") === tr
                  ? "bg-amber-500 border-amber-500 text-black"
                  : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"
              }`}
            >
              {tr}
            </button>
          ))}
        </div>
        {(settings.slide_transition ?? "fade") !== "none" && (
          <div className="flex justify-between items-center mb-1">
            <span className="text-[10px] text-slate-500 uppercase font-bold">{t("settings.out.duration")}</span>
            <span className="text-xs font-mono text-amber-500">{(settings.slide_transition_duration ?? 0.4).toFixed(1)}s</span>
          </div>
        )}
        {(settings.slide_transition ?? "fade") !== "none" && (
          <input
            type="range" min="0.1" max="2.0" step="0.1"
            value={settings.slide_transition_duration ?? 0.4}
            onChange={(e) => onUpdateSettings({ ...settings, slide_transition_duration: parseFloat(e.target.value) })}
            className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
          />
        )}
      </div>
    </div>
  );
}
