import React, { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../../store";
import { useT } from "../../../i18n";
import { BackgroundEditor } from "../../BackgroundEditor";
import { MediaPickerModal } from "../../MediaPickerModal";
import { computePreviewBackground, relativizePath } from "../../../utils";
import { THEMES } from "../../../types";
import type { SettingsSectionProps } from "../shared";
import type { BackgroundSetting, ImageBackground } from "../../../types";

export function BackgroundsSection({ onUpdateSettings, onUploadMedia }: SettingsSectionProps) {
  const {
    settings, media,
    showGlobalBgPicker, setShowGlobalBgPicker,
    appDataDir,
  } = useAppStore();
  const t = useT();
  const [previewBg, setPreviewBg] = useState<"dark" | "green" | "checkered">("dark");

  const handlePickBackgroundImage = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
      });
      if (typeof selected !== "string") return;
      const rel = relativizePath(selected, appDataDir);
      onUpdateSettings({ ...settings, background: { type: "Image", value: { path: rel, objectFit: "cover", opacity: 1 } } });
    } catch (err: any) {
      console.error("Failed to set background image:", err);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">{t("settings.bg.output")}</p>
        <div className="flex gap-2 mb-3">
          {(["None", "Color", "Image"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                let bg: BackgroundSetting;
                if (mode === "None") bg = { type: "None" };
                else if (mode === "Color") bg = { type: "Color", value: settings.background.type === "Color" ? (settings.background as any).value : "#1a1a2e" };
                else bg = { type: "Image", value: settings.background.type === "Image" ? (settings.background as any).value : { path: "", objectFit: "cover", opacity: 1 } };
                onUpdateSettings({ ...settings, background: bg });
              }}
              className={`flex-1 py-2 rounded-lg border text-xs font-bold transition-all ${
                settings.background.type === mode
                  ? "border-amber-500 bg-amber-500/10 text-amber-400"
                  : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:bg-slate-800"
              }`}
            >
              {mode === "None" ? t("settings.bg.theme") : mode === "Color" ? t("settings.bg.color") : t("settings.bg.image")}
            </button>
          ))}
        </div>
        {settings.background.type === "Color" && (
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={(settings.background as { type: "Color"; value: string }).value}
              onChange={(e) => onUpdateSettings({ ...settings, background: { type: "Color", value: e.target.value } })}
              className="w-10 h-10 rounded cursor-pointer border border-slate-700 bg-transparent"
            />
            <span className="text-xs text-slate-400 font-mono">
              {(settings.background as { type: "Color"; value: string }).value}
            </span>
          </div>
        )}
        {settings.background.type === "Image" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (media.filter((m) => m.media_type === "Image").length > 0) setShowGlobalBgPicker(true);
                  else handlePickBackgroundImage();
                }}
                className="flex-1 py-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-all"
              >
                {(settings.background as { type: "Image"; value: ImageBackground }).value?.path ? t("settings.bg.changeFromLib") : t("settings.bg.chooseFromLib")}
              </button>
              {(settings.background as { type: "Image"; value: ImageBackground }).value?.path && (
                <button
                  onClick={() => onUpdateSettings({ ...settings, background: { type: "Image", value: { path: "", objectFit: "cover", opacity: 1 } } })}
                  className="text-red-500/70 hover:text-red-400 text-sm font-bold shrink-0"
                  title={t("settings.bg.clearImage")}
                >✕</button>
              )}
            </div>
            {(settings.background as { type: "Image"; value: ImageBackground }).value?.path && (
              <p className="text-[9px] text-slate-600 truncate">
                {(settings.background as { type: "Image"; value: ImageBackground }).value.path.split(/[/\\]/).pop()}
              </p>
            )}
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-slate-500 uppercase font-bold w-10">{t("settings.bg.fit")}</span>
              <div className="flex gap-1 flex-1">
                {(["cover", "contain", "fill"] as const).map((fit) => (
                  <button
                    key={fit}
                    onClick={() => onUpdateSettings({
                      ...settings,
                      background: {
                        type: "Image",
                        value: { ...(settings.background as any).value, objectFit: fit },
                      },
                    })}
                    className={`flex-1 py-1 rounded text-[9px] font-bold capitalize transition-all ${
                      (settings.background as any).value.objectFit === fit
                        ? "border-amber-500 bg-amber-500/10 text-amber-400"
                        : "border-slate-700 bg-slate-800/50 text-slate-500"
                    }`}
                  >
                    {fit === "contain" ? t("settings.bg.fitContain") : fit === "cover" ? t("settings.bg.fitCover") : t("settings.bg.fitFill")}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-slate-500 uppercase font-bold w-10">{t("settings.bg.opacity")}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={(settings.background as any).value.opacity ?? 1}
                onChange={(e) => onUpdateSettings({
                  ...settings,
                  background: {
                    type: "Image",
                    value: { ...(settings.background as any).value, opacity: parseFloat(e.target.value) },
                  },
                })}
                className="flex-1 h-1 appearance-none bg-slate-700 rounded accent-amber-500 cursor-pointer"
              />
              <span className="text-[9px] text-slate-500 w-9 text-right font-mono">{Math.round(((settings.background as any).value.opacity ?? 1) * 100)}%</span>
            </div>
          </div>
        )}
        {showGlobalBgPicker && (
          <MediaPickerModal
            images={media.filter((m) => m.media_type === "Image")}
            onSelect={(path) => onUpdateSettings({ ...settings, background: { type: "Image", value: { path: relativizePath(path, appDataDir), objectFit: (settings.background as any).value?.objectFit ?? "cover", opacity: (settings.background as any).value?.opacity ?? 1 } } })}
            onClose={() => setShowGlobalBgPicker(false)}
            onUpload={onUploadMedia}
          />
        )}
      </div>

      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-1">{t("settings.bg.content")}</p>
        <div className="flex flex-col gap-3 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
          <BackgroundEditor
            label={t("settings.bg.bibleVerses")}
            value={settings.bible_background}
            onChange={(bg) => onUpdateSettings({ ...settings, bible_background: bg })}
            media={media}
            onUploadMedia={onUploadMedia}
          />
          <div className="border-t border-slate-800" />
          <BackgroundEditor
            label={t("settings.bg.media")}
            value={settings.media_background}
            onChange={(bg) => onUpdateSettings({ ...settings, media_background: bg })}
            media={media}
            onUploadMedia={onUploadMedia}
          />
        </div>
      </div>

      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">{t("settings.bg.preview")}</p>
        <div className="flex items-center gap-1 mb-2">
          {([
            ["dark", t("settings.bg.previewDark")],
            ["green", t("settings.bg.previewGreen")],
            ["checkered", t("settings.bg.previewCheckered")],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setPreviewBg(id)}
              className={`px-2 py-1 text-[10px] font-bold rounded ${previewBg === id ? "bg-amber-600 text-black" : "bg-slate-800 text-slate-400"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          className="rounded-xl p-5 flex flex-col items-center text-center gap-3 border border-slate-800 overflow-hidden relative"
          style={{
            ...computePreviewBackground(settings, THEMES[settings.theme]?.colors.background ?? "#000", appDataDir),
            ...(previewBg === "green"
              ? { backgroundColor: "rgba(21,128,61,0.85)" }
              : previewBg === "checkered"
                ? { backgroundColor: "#0f172a", backgroundImage: "linear-gradient(45deg, #334155 25%, transparent 25%), linear-gradient(-45deg, #334155 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #334155 75%), linear-gradient(-45deg, transparent 75%, #334155 75%)", backgroundSize: "40px 40px", backgroundPosition: "0 0, 0 20px, 20px -20px, -20px 0px" }
                : {}),
          }}
        >
          {settings.reference_position === "top" && (
            <p className="text-sm font-bold uppercase tracking-widest" style={{ color: THEMES[settings.theme]?.colors.referenceText }}>
              John 3:16
            </p>
          )}
          <p
            className="text-base font-serif leading-snug"
            style={{
              color: THEMES[settings.theme]?.colors.verseText,
              fontFamily: settings.verse_font_family ?? "Georgia, serif",
              fontSize: `${Math.round((settings.font_size ?? 72) / 4)}px`,
            }}
          >
            For God so loved the world that he gave his one and only Son...
          </p>
          {settings.reference_position === "bottom" && (
            <p
              className="text-sm font-bold uppercase tracking-widest"
              style={{
                color: THEMES[settings.theme]?.colors.referenceText,
                fontFamily: settings.reference_font_family ?? "Arial, sans-serif",
                fontSize: `${Math.round((settings.reference_font_size ?? 36) / 3)}px`,
              }}
            >
              John 3:16
            </p>
          )}
        </div>
        <p className="text-[9px] text-slate-600 mt-1 italic">
          {t("settings.bg.previewDesc")}
        </p>
      </div>
    </div>
  );
}
