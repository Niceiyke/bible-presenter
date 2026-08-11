import React from "react";
import { useAppStore } from "../../../store";
import { useT } from "../../../i18n";
import type { SettingsSectionProps } from "../shared";

export function OperatorSection({ onUpdateSettings }: SettingsSectionProps) {
  const { settings } = useAppStore();
  const t = useT();

  return (
    <div className="flex flex-col gap-6">
      <label className="flex items-center justify-between gap-3 cursor-pointer">
        <div>
          <span className="text-xs text-slate-300 font-medium">{t("settings.autoClearLogo")}</span>
          <p className="text-[10px] text-slate-600">{t("settings.autoClearLogoDesc")}</p>
        </div>
        <input
          type="checkbox"
          checked={settings.auto_clear_background_logo ?? true}
          onChange={(e) => onUpdateSettings({ ...settings, auto_clear_background_logo: e.target.checked })}
          className="accent-amber-500 w-4 h-4"
        />
      </label>

      <div className="border-t border-slate-800 pt-4">
        <p className="text-xs text-slate-400 font-bold uppercase mb-2">{t("settings.op.liveWorkflow")}</p>
        <p className="text-[10px] text-slate-600 leading-relaxed">
          {t("settings.op.liveWorkflowDesc")}
        </p>
      </div>
    </div>
  );
}
