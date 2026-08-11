import React, { useState } from "react";
import { useAppStore } from "../../../store";
import { useT } from "../../../i18n";
import { MediaPickerModal } from "../../MediaPickerModal";
import { relativizePath } from "../../../utils";
import type { SettingsSectionProps } from "../shared";

type BackgroundLogoMode = "off" | "splash" | "persistent" | "corner";
type BrandSource = "text" | "image" | "video";

const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi|m4v)$/i;

function isVideoPath(path: string | undefined): boolean {
  return !!path && VIDEO_RE.test(path);
}

function BrandSourceSelector({ value, onChange, onLabel }: {
  value: BrandSource;
  onChange: (s: BrandSource) => void;
  onLabel: Record<BrandSource, string>;
}) {
  return (
    <div className="flex gap-1.5 mb-2">
      {(["text", "image", "video"] as const).map((s) => (
        <button
          key={s}
          onClick={() => onChange(s)}
          className={`flex-1 py-1.5 rounded text-[10px] font-bold border transition-all capitalize ${
            value === s
              ? "border-amber-500 bg-amber-500/10 text-amber-400"
              : "border-slate-700 bg-slate-800/50 text-slate-500 hover:border-slate-600"
          }`}
        >
          {onLabel[s]}
        </button>
      ))}
    </div>
  );
}

function SourceFileRow({
  path,
  onChange,
  onClear,
  chooseLabel,
  changeLabel,
}: {
  path: string | undefined;
  onChange: () => void;
  onClear: () => void;
  chooseLabel: string;
  changeLabel: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          onClick={onChange}
          className="flex-1 py-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-all"
        >
          {path ? changeLabel : chooseLabel}
        </button>
        {path && (
          <button
            onClick={onClear}
            className="text-red-500/70 hover:text-red-400 text-sm font-bold shrink-0"
            title="Clear"
          >✕</button>
        )}
      </div>
      {path && (
        <p className="text-[9px] text-slate-600 truncate">
          {path.split(/[/\\]/).pop()}
        </p>
      )}
    </div>
  );
}

function ColorRow({ label, value, onChange }: {
  label: string;
  value: string | undefined;
  onChange: (color: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] text-slate-500 uppercase font-bold">{label}</span>
      <input
        type="color"
        value={value ?? "#ffffff"}
        onChange={(e) => onChange(e.target.value)}
        className="w-8 h-8 rounded cursor-pointer border border-slate-700 bg-transparent"
      />
      <span className="text-[9px] font-mono text-slate-500">{value ?? "#ffffff"}</span>
    </div>
  );
}

export function BrandingSection({ onUpdateSettings, onUploadMedia }: SettingsSectionProps) {
  const { settings, media, appDataDir } = useAppStore();
  const t = useT();
  const [cornerPicker, setCornerPicker] = useState<null | "image" | "video">(null);
  const [bgPicker, setBgPicker] = useState<null | "image" | "video">(null);
  const [configMode, setConfigMode] = useState<BackgroundLogoMode | null>(null);

  const bgMode: BackgroundLogoMode =
    settings.show_background_logo
      ? (settings.auto_clear_background_logo ?? true ? "splash" : "persistent")
      : settings.logo_path || settings.logo_text ? "corner"
        : "off";

  const activeMode: BackgroundLogoMode = bgMode !== "off" ? bgMode : (configMode ?? "off");

  const cornerSource: BrandSource =
    settings.logo_text ? "text"
      : isVideoPath(settings.logo_path) ? "video"
        : settings.logo_path ? "image"
          : "text";

  const bgSource: BrandSource =
    settings.background_logo_text ? "text"
      : isVideoPath(settings.background_logo_path) ? "video"
        : settings.background_logo_path ? "image"
          : "text";

  const setCornerSource = (s: BrandSource) => {
    if (s === cornerSource) return;
    if (s === "text") onUpdateSettings({ ...settings, logo_path: undefined });
    else onUpdateSettings({ ...settings, logo_text: undefined });
  };

  const setBgSource = (s: BrandSource) => {
    if (s === bgSource) return;
    if (s === "text") onUpdateSettings({ ...settings, background_logo_path: undefined, show_background_logo: true });
    else onUpdateSettings({ ...settings, background_logo_text: undefined, show_background_logo: true });
  };

  const applyBgMode = (mode: BackgroundLogoMode) => {
    setConfigMode(mode);
    if (mode === "off") {
      onUpdateSettings({
        ...settings,
        show_background_logo: false,
        logo_path: undefined,
        logo_text: undefined,
        background_logo_path: undefined,
        background_logo_text: undefined,
      });
      return;
    }
    if (mode === "corner") {
      onUpdateSettings({ ...settings, show_background_logo: false });
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

  const srcLabels: Record<BrandSource, string> = {
    text: t("settings.branding.text"),
    image: t("settings.branding.image"),
    video: t("settings.branding.video"),
  };

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
                activeMode === m.id
                  ? "border-amber-500 bg-amber-500/10"
                  : "border-slate-700 bg-slate-800/50 hover:border-slate-600 hover:bg-slate-800"
              }`}
            >
              <span className={`mt-0.5 w-3 h-3 rounded-full border shrink-0 ${activeMode === m.id ? "border-amber-500 bg-amber-500" : "border-slate-600"}`} />
              <span className="min-w-0">
                <span className={`block text-xs font-bold ${activeMode === m.id ? "text-amber-400" : "text-slate-300"}`}>{m.label}</span>
                <span className="block text-[10px] text-slate-500 mt-0.5">{m.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {activeMode !== "off" && (
        <div className="border-t border-slate-800 pt-4 flex flex-col gap-3">
          {activeMode === "corner" ? (
            <>
              <p className="text-xs text-slate-400 font-bold uppercase mb-1">{t("settings.branding.cornerTitle")}</p>
              <BrandSourceSelector value={cornerSource} onChange={setCornerSource} onLabel={srcLabels} />
              {cornerSource === "text" ? (
                <div className="flex flex-col gap-2">
                  <input
                    value={settings.logo_text ?? ""}
                    onChange={(e) => onUpdateSettings({ ...settings, logo_text: e.target.value })}
                    placeholder={t("settings.branding.textPlaceholder")}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
                  />
                  <ColorRow
                    label={t("settings.branding.color")}
                    value={settings.logo_text_color}
                    onChange={(c) => onUpdateSettings({ ...settings, logo_text_color: c })}
                  />
                </div>
              ) : (
                <>
                  <SourceFileRow
                    path={settings.logo_path}
                    onChange={() => setCornerPicker(cornerSource)}
                    onClear={() => onUpdateSettings({ ...settings, logo_path: undefined })}
                    chooseLabel={t("settings.branding.chooseFromLib")}
                    changeLabel={t("settings.branding.changeFromLib")}
                  />
                </>
              )}
            </>
          ) : (
            <>
              <p className="text-xs text-slate-400 font-bold uppercase mb-1">
                {activeMode === "splash" ? t("settings.branding.splashTitle") : t("settings.branding.persistentTitle")}
              </p>
              <p className="text-[10px] text-slate-600 mb-1">
                {activeMode === "splash"
                  ? t("settings.branding.splashDesc2")
                  : t("settings.branding.persistentDesc2")}
              </p>
              <BrandSourceSelector value={bgSource} onChange={setBgSource} onLabel={srcLabels} />
              {bgSource === "text" ? (
                <div className="flex flex-col gap-2">
                  <input
                    value={settings.background_logo_text ?? ""}
                    onChange={(e) => onUpdateSettings({ ...settings, background_logo_text: e.target.value })}
                    placeholder={t("settings.branding.textPlaceholder")}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
                  />
                  <ColorRow
                    label={t("settings.branding.color")}
                    value={settings.background_logo_text_color}
                    onChange={(c) => onUpdateSettings({ ...settings, background_logo_text_color: c })}
                  />
                </div>
              ) : (
                <SourceFileRow
                  path={settings.background_logo_path}
                  onChange={() => setBgPicker(bgSource)}
                  onClear={() => onUpdateSettings({ ...settings, background_logo_path: undefined })}
                  chooseLabel={t("settings.branding.chooseFromLib")}
                  changeLabel={t("settings.branding.changeFromLib")}
                />
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
            </>
          )}
        </div>
      )}

      {cornerPicker && (
        <MediaPickerModal
          images={media}
          mode={cornerPicker}
          onSelect={(path) => {
            onUpdateSettings({ ...settings, logo_path: relativizePath(path, appDataDir), logo_text: undefined, show_background_logo: false });
            setCornerPicker(null);
          }}
          onClose={() => setCornerPicker(null)}
          onUpload={onUploadMedia}
        />
      )}
      {bgPicker && (
        <MediaPickerModal
          images={media}
          mode={bgPicker}
          onSelect={(path) => {
            onUpdateSettings({
              ...settings,
              background_logo_path: relativizePath(path, appDataDir),
              background_logo_text: undefined,
              show_background_logo: true,
            });
            setBgPicker(null);
          }}
          onClose={() => setBgPicker(null)}
          onUpload={onUploadMedia}
        />
      )}
    </div>
  );
}
