import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../../store";
import { useT } from "../../../i18n";
import type { SettingsSectionProps } from "../shared";

export function StageSection({ onUpdateSettings }: SettingsSectionProps) {
  const { settings } = useAppStore();
  const t = useT();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest">{t("settings.stageDisplay")}</h2>
          <p className="text-[10px] text-slate-600 mt-0.5">{t("settings.stageSubtitle")}</p>
        </div>
        <button
          onClick={() => invoke("toggle_stage_window")}
          className="px-3 py-1.5 text-[10px] font-black uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
        >
          {t("settings.toggle")}
        </button>
      </div>

      <label className="flex items-center justify-between gap-3 cursor-pointer">
        <div>
          <span className="text-xs text-slate-300 font-medium">{t("settings.stageThemed")}</span>
          <p className="text-[10px] text-slate-600">{t("settings.stageThemedDesc")}</p>
        </div>
        <input
          type="checkbox"
          checked={settings.stage_uses_theme ?? false}
          onChange={(e) => onUpdateSettings({ ...settings, stage_uses_theme: e.target.checked })}
          className="accent-amber-500 w-4 h-4"
        />
      </label>

      <div className="border-t border-slate-800 pt-4">
        <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">{t("settings.stage.what")}</p>
        <ul className="text-[10px] text-slate-600 leading-relaxed space-y-1">
          <li>• {t("settings.stage.nowLiveUpNext")}</li>
          <li>• {t("settings.stage.timerClock")}</li>
          <li>• {t("settings.stage.slidePreviews")}</li>
          <li>• {t("settings.stage.ltOnAir")}</li>
        </ul>
      </div>
    </div>
  );
}
