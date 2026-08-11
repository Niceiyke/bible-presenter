import React, { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../../store";
import { useT } from "../../../i18n";
import { MediaPickerModal } from "../../MediaPickerModal";
import { relativizePath } from "../../../utils";
import type { SettingsSectionProps } from "../shared";

type BackgroundLogoMode = "off" | "splash" | "persistent" | "corner";

export function BrandingSection({ onUpdateSettings, onUploadMedia }: SettingsSectionProps) {
  const {
    settings, media,
    showLogoPicker, setShowLogoPicker,
    appDataDir,
  } = useAppStore();
  const t = useT();
  const [showBgLogoPicker, setShowBgLogoPicker] = useState(false);

  const bgMode: BackgroundLogoMode =
    !settings.show_background_logo && !settings.logo_path ? "off"
      : settings.show_background_logo && settings.background_logo_path && settings.auto_clear_background_logo ? "splash"
        : settings.show_background_logo && settings.background_logo_path ? "persistent"
          : "corner";

  const handlePickLogo = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
      });
      if (typeof selected !== "string") return;
      onUpdateSettings({ ...settings, logo_path: relativizePath(selected, appDataDir) });
    } catch (err: any) {
      console.error("Failed to set logo:", err);
    }
  };

  const handlePickBackgroundLogo = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
      });
      if (typeof selected !== "string") return;
      onUpdateSettings({
        ...settings,
        background_logo_path: relativizePath(selected, appDataDir),
        show_background_logo: true,
      });
    } catch (err: any) {
      console.error("Failed to set background logo:", err);
    }
  };

  const applyBgMode = async (mode: BackgroundLogoMode) => {
    if (mode === "off") {
      onUpdateSettings({ ...settings, show_background_logo: false, logo_path: undefined });
      return;
    }
    if (mode === "corner") {
      // Corner logo: reuse the current background logo path if no corner logo is set.
      const path = settings.logo_path ?? settings.background_logo_path;
      if (!path) {
        if (media.filter((m) => m.media_type === "Image").length > 0) setShowLogoPicker(true);
        else await handlePickLogo();
        return;
      }
      onUpdateSettings({ ...settings, logo_path: path, show_background_logo: false });
      return;
    }
    // splash or persistent: needs a background logo image/video.
    if (!settings.background_logo_path) {
      if (media.filter((m) => m.media_type === "Image").length > 0) setShowBgLogoPicker(true);
      else await handlePickBackgroundLogo();
      return;
    }
    onUpdateSettings({
      ...settings,
      show_background_logo: true,
      auto_clear_background_logo: mode === "splash",
    });
  };

  const MODES: { id: BackgroundLogoMode; label: string; desc: string }[] = [
    { id: "off", label: t("settings.branding.off"), desc: t("settings.branding.offDesc") },
    { id: "splash", label: t("settings.branding.splash"), desc: t("settings.branding.splashDesc") },
    { id: "persistent", label: t("settings.branding.persistent"), desc: t("settings.branding.persistentDesc") },
    { id: "corner", label: t("settings.branding.corner"), desc: t("settings.branding.cornerDesc") },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-2">{t("settings.branding.title")}</p>
        <p className="text-[10px] text-slate-600 mb-3">
          {t("settings.branding.desc")}
        </p>
        <div className="flex flex-col gap-1.5">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => applyBgMode(m.id)}
              className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-left transition-all ${
                bgMode === m.id
                  ? "border-amber-500 bg-amber-500/10"
                  : "border-slate-700 bg-slate-800/50 hover:border-slate-600 hover:bg-slate-800"
              }`}
            >
              <span className={`mt-0.5 w-3 h-3 rounded-full border shrink-0 ${bgMode === m.id ? "border-amber-500 bg-amber-500" : "border-slate-600"}`} />
              <span className="min-w-0">
                <span className={`block text-xs font-bold ${bgMode === m.id ? "text-amber-400" : "text-slate-300"}`}>{m.label}</span>
                <span className="block text-[10px] text-slate-500 mt-0.5">{m.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {bgMode !== "off" && (
        <div className="border-t border-slate-800 pt-4">
          {bgMode === "corner" ? (
            <>
              <p className="text-xs text-slate-400 font-bold uppercase mb-3">{t("settings.branding.cornerTitle")}</p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => {
                    if (media.filter((m) => m.media_type === "Image").length > 0) setShowLogoPicker(true);
                    else handlePickLogo();
                  }}
                  className="w-full py-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-all"
                >
                  {settings.logo_path ? t("settings.branding.changeLogo") : t("settings.branding.chooseLogo")}
                </button>
                {settings.logo_path && (
                  <div className="flex items-center justify-between bg-slate-900/50 p-2 rounded border border-slate-800">
                    <span className="text-[9px] text-slate-500 truncate max-w-[180px]">
                      {settings.logo_path.split(/[/\\]/).pop()}
                    </span>
                    <button
                      onClick={() => applyBgMode("off")}
                      className="text-red-500/70 hover:text-red-400 text-[10px] font-bold"
                    >{t("settings.branding.clear")}</button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-slate-400 font-bold uppercase mb-1">
                {bgMode === "splash" ? t("settings.branding.splashTitle") : t("settings.branding.persistentTitle")}
              </p>
              <p className="text-[10px] text-slate-600 mb-3">
                {bgMode === "splash"
                  ? t("settings.branding.splashDesc2")
                  : t("settings.branding.persistentDesc2")}
              </p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => {
                    if (media.filter((m) => m.media_type === "Image").length > 0) setShowBgLogoPicker(true);
                    else handlePickBackgroundLogo();
                  }}
                  className="w-full py-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-all"
                >
                  {settings.background_logo_path ? t("settings.branding.changeImage") : t("settings.branding.chooseImage")}
                </button>
                {settings.background_logo_path && (
                  <div className="flex items-center justify-between bg-slate-900/50 p-2 rounded border border-slate-800">
                    <span className="text-[9px] text-slate-500 truncate max-w-[180px]">
                      {settings.background_logo_path.split(/[/\\]/).pop()}
                    </span>
                    <button
                      onClick={() => applyBgMode("off")}
                      className="text-red-500/70 hover:text-red-400 text-[10px] font-bold"
                    >{t("settings.branding.clear")}</button>
                  </div>
                )}
                <label className="flex items-center justify-between gap-3 cursor-pointer mt-1">
                  <div>
                    <span className="text-xs text-slate-300 font-medium">{t("settings.branding.autoClear")}</span>
                    <p className="text-[10px] text-slate-600">{t("settings.branding.autoClearDesc")}</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.auto_clear_background_logo ?? true}
                    onChange={(e) => onUpdateSettings({ ...settings, auto_clear_background_logo: e.target.checked })}
                    className="accent-amber-500 w-4 h-4"
                  />
                </label>
              </div>
            </>
          )}
        </div>
      )}

      {showLogoPicker && (
        <MediaPickerModal
          images={media.filter((m) => m.media_type === "Image")}
          onSelect={(path) => onUpdateSettings({ ...settings, logo_path: relativizePath(path, appDataDir), show_background_logo: false })}
          onClose={() => setShowLogoPicker(false)}
          onUpload={onUploadMedia}
        />
      )}
      {showBgLogoPicker && (
        <MediaPickerModal
          images={media.filter((m) => m.media_type === "Image")}
          onSelect={(path) => onUpdateSettings({
            ...settings,
            background_logo_path: relativizePath(path, appDataDir),
            show_background_logo: true,
          })}
          onClose={() => setShowBgLogoPicker(false)}
          onUpload={onUploadMedia}
        />
      )}
    </div>
  );
}
