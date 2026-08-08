import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../store";
import { BackgroundEditor } from "../BackgroundEditor";
import { MediaPickerModal } from "../MediaPickerModal";
import { computePreviewBackground, relativizePath } from "../../utils";
import { THEMES, FONTS } from "../../types";
import type { PresentationSettings, BackgroundSetting, ImageBackground, MonitorInfo } from "../../types";

interface DisplaySectionProps {
  onUpdateSettings: (s: PresentationSettings) => void;
  onUploadMedia: () => Promise<void>;
}

export function DisplaySection({ onUpdateSettings, onUploadMedia }: DisplaySectionProps) {
  const {
    settings,
    media,
    showLogoPicker, setShowLogoPicker,
    showGlobalBgPicker, setShowGlobalBgPicker,
    appDataDir,
    availableVersions,
  } = useAppStore();

  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  useEffect(() => {
    invoke<MonitorInfo[]>("get_available_monitors").then(setMonitors).catch(() => {});
  }, []);

  const toggleVersion = (v: string) => {
    const disabled = settings.disabled_bible_versions || [];
    const next = disabled.includes(v)
      ? disabled.filter(x => x !== v)
      : [...disabled, v];
    onUpdateSettings({ ...settings, disabled_bible_versions: next });
  };

  const handlePickLogo = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
      });
      if (typeof selected !== "string") return;
      const rel = relativizePath(selected, appDataDir);
      onUpdateSettings({ ...settings, logo_path: rel });
    } catch (err: any) {
      console.error("Failed to set logo:", err);
    }
  };

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
      <div className="flex justify-between items-center">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Output Settings</h2>
        <button
          onClick={() => onUpdateSettings({ ...settings, is_blanked: !settings.is_blanked })}
          className={`px-4 py-2 rounded-lg text-xs font-black transition-all border ${
            settings.is_blanked
              ? "bg-red-500 border-red-500 text-white"
              : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"
          }`}
        >
          {settings.is_blanked ? "SCREEN BLANKED" : "BLANK SCREEN"}
        </button>
      </div>

      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Scripture Verse</p>
        <div className="flex justify-between items-center mb-1">
          <span className="text-[10px] text-slate-500 uppercase font-bold">Font Size</span>
          <span className="text-xs font-mono text-amber-500">{settings.font_size}pt</span>
        </div>
        <input
          type="range" min="24" max="144" step="2"
          value={settings.font_size}
          onChange={(e) => onUpdateSettings({ ...settings, font_size: parseInt(e.target.value) })}
          className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500 mb-3"
        />
        <div className="flex justify-between items-center mb-1">
          <span className="text-[10px] text-slate-500 uppercase font-bold">Font Family</span>
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
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Slide Transition</p>
        <div className="flex flex-wrap gap-2 mb-3">
          {(["fade", "slide-up", "slide-left", "zoom", "none"] as const).map((t) => (
            <button
              key={t}
              onClick={() => onUpdateSettings({ ...settings, slide_transition: t })}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                (settings.slide_transition ?? "fade") === t
                  ? "bg-amber-500 border-amber-500 text-black"
                  : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        {(settings.slide_transition ?? "fade") !== "none" && (
          <div className="flex justify-between items-center mb-1">
            <span className="text-[10px] text-slate-500 uppercase font-bold">Duration</span>
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

      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Theme</p>
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
            <span className="group-open:rotate-90 transition-transform">▸</span> Theme Overrides
          </summary>
          <div className="p-3 bg-slate-900/50 border border-slate-800 rounded-lg flex flex-col gap-3 mt-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-400 uppercase font-bold">Background</span>
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
              <span className="text-[10px] text-slate-400 uppercase font-bold">Verse Text</span>
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
              <span className="text-[10px] text-slate-400 uppercase font-bold">Reference Text</span>
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
                Reset to Theme Defaults
              </button>
            )}
          </div>
        </details>
      </div>

      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Corner Logo</p>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => {
              if (media.filter((m) => m.media_type === "Image").length > 0) {
                setShowLogoPicker(true);
              } else {
                handlePickLogo();
              }
            }}
            className="w-full py-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-all"
          >
            {settings.logo_path ? "Change Logo..." : "Choose Logo..."}
          </button>
          {settings.logo_path && (
            <div className="flex items-center justify-between bg-slate-900/50 p-2 rounded border border-slate-800">
              <span className="text-[9px] text-slate-500 truncate max-w-[180px]">
                {settings.logo_path.split(/[/\\]/).pop()}
              </span>
              <button
                onClick={() => onUpdateSettings({ ...settings, logo_path: undefined })}
                className="text-red-500/70 hover:text-red-400 text-[10px] font-bold"
              >Clear</button>
            </div>
          )}
        </div>
        {showLogoPicker && (
          <MediaPickerModal
            images={media.filter((m) => m.media_type === "Image")}
            onSelect={(path) => onUpdateSettings({ ...settings, logo_path: relativizePath(path, appDataDir) })}
            onClose={() => setShowLogoPicker(false)}
            onUpload={onUploadMedia}
          />
        )}
      </div>

      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Scripture Reference</p>
        <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Position</p>
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
              {pos === "top" ? "▲  Top" : "▼  Bottom"}
            </button>
          ))}
        </div>
        <div className="flex justify-between items-center mb-1">
          <span className="text-[10px] text-slate-500 uppercase font-bold">Font Size</span>
          <span className="text-xs font-mono text-amber-500">{settings.reference_font_size ?? 36}pt</span>
        </div>
        <input
          type="range" min="12" max="96" step="2"
          value={settings.reference_font_size ?? 36}
          onChange={(e) => onUpdateSettings({ ...settings, reference_font_size: parseInt(e.target.value) })}
          className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500 mb-4"
        />
        <div className="flex justify-between items-center mb-2">
          <span className="text-[10px] text-slate-500 uppercase font-bold">Color</span>
          <span className="text-[10px] text-slate-500">(empty = use theme color)</span>
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
            {settings.reference_color && settings.reference_color !== "" ? settings.reference_color : "theme default"}
          </span>
          {settings.reference_color && settings.reference_color !== "" && (
            <button
              onClick={() => onUpdateSettings({ ...settings, reference_color: "" })}
              className="ml-auto text-[10px] text-red-400 hover:text-red-300 font-bold"
            >
              Reset
            </button>
          )}
        </div>
        <div className="flex justify-between items-center mb-1">
          <span className="text-[10px] text-slate-500 uppercase font-bold">Font Family</span>
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

        {/* Chapter:Verse number sub-styling */}
        <details className="group mt-4">
          <summary className="text-[10px] text-slate-500 uppercase font-bold cursor-pointer select-none hover:text-slate-400 mb-2 list-none flex items-center gap-1">
            <span className="group-open:rotate-90 transition-transform">▸</span> Chapter:Verse Number Styling
          </summary>
          <div className="p-3 bg-slate-900/50 border border-slate-800 rounded-lg flex flex-col gap-3 mt-2">
            <p className="text-[9px] text-slate-600 italic">Override styling for the "3:16" part only. Leave blank to inherit from reference.</p>
            <div>
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] text-slate-500 uppercase font-bold">Font Size</span>
                <span className="text-xs font-mono text-amber-500">
                  {settings.chapter_verse_font_size != null ? `${settings.chapter_verse_font_size}pt` : "inherit"}
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
                  Reset to inherit
                </button>
              )}
            </div>
            <div>
              <span className="text-[10px] text-slate-500 uppercase font-bold block mb-1">Font Family</span>
              <select
                value={settings.chapter_verse_font_family ?? ""}
                onChange={(e) => onUpdateSettings({ ...settings, chapter_verse_font_family: e.target.value || undefined })}
                className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-2 cursor-pointer focus:outline-none focus:border-amber-500"
                style={{ fontFamily: settings.chapter_verse_font_family ?? "inherit" }}
              >
                <option value="">(inherit from reference)</option>
                {FONTS.map((f) => (
                  <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-slate-500 uppercase font-bold">Color</span>
                <span className="text-[10px] text-slate-500">(empty = inherit)</span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={settings.chapter_verse_color && settings.chapter_verse_color !== "" ? settings.chapter_verse_color : "#f59e0b"}
                  onChange={(e) => onUpdateSettings({ ...settings, chapter_verse_color: e.target.value })}
                  className="w-10 h-8 rounded cursor-pointer bg-transparent border-0"
                />
                <span className="text-xs font-mono text-slate-300">
                  {settings.chapter_verse_color && settings.chapter_verse_color !== "" ? settings.chapter_verse_color : "inherit"}
                </span>
                {settings.chapter_verse_color && settings.chapter_verse_color !== "" && (
                  <button
                    onClick={() => onUpdateSettings({ ...settings, chapter_verse_color: "" })}
                    className="ml-auto text-[10px] text-red-400 hover:text-red-300 font-bold"
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          </div>
        </details>
      </div>

      <div className="border-t border-slate-800 pt-4">
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Scripture Auto-Split</p>
        <div className="flex items-center justify-between mb-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-slate-300 font-bold uppercase">Enable Auto-Split</span>
            <span className="text-[9px] text-slate-600">Divide long verses into multiple slides</span>
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
              <span className="text-[10px] text-slate-500 uppercase font-bold">Split Threshold</span>
              <span className="text-xs font-mono text-amber-500">{settings.verse_split_threshold} chars</span>
            </div>
            <input
              type="range" min="100" max="500" step="10"
              value={settings.verse_split_threshold}
              onChange={(e) => onUpdateSettings({ ...settings, verse_split_threshold: parseInt(e.target.value) })}
              className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500 mb-1"
            />
            <div className="flex justify-between">
              <span className="text-[9px] text-slate-600">Short slides</span>
              <span className="text-[9px] text-slate-600">Long slides</span>
            </div>
          </>
        )}
      </div>

      <div className="border-t border-slate-800 pt-4">
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Dynamic Verse Styling</p>
        <div className="flex items-center justify-between mb-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-slate-300 font-bold uppercase">Highlight Divine Words</span>
            <span className="text-[9px] text-slate-600">Automatically style words spoken by Christ or divine titles</span>
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
            <span className="text-[10px] text-slate-400 uppercase font-bold">Highlight Color</span>
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

      <div className="border-t border-slate-800 pt-4">
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Bible Versions</p>
        <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Enable / Disable</p>
        <div className="flex flex-wrap gap-2 mb-4">
          {availableVersions.map(v => (
            <button
              key={v}
              onClick={() => toggleVersion(v)}
              className={`px-3 py-1.5 rounded-lg border text-[10px] font-bold transition-all ${
                !(settings.disabled_bible_versions || []).includes(v)
                  ? "bg-green-600 border-green-500 text-white"
                  : "bg-slate-800 border-slate-700 text-slate-500"
              }`}
            >
              {v} {!(settings.disabled_bible_versions || []).includes(v) ? '✓' : '✕'}
            </button>
          ))}
        </div>

        <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Version Tag Styling (e.g. (KJV))</p>
        <div className="flex justify-between items-center mb-1">
          <span className="text-[10px] text-slate-500 uppercase font-bold">Font Size</span>
          <span className="text-xs font-mono text-amber-500">{settings.version_font_size ?? 24}pt</span>
        </div>
        <input
          type="range" min="10" max="72" step="2"
          value={settings.version_font_size ?? 24}
          onChange={(e) => onUpdateSettings({ ...settings, version_font_size: parseInt(e.target.value) })}
          className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500 mb-4"
        />

        <div className="flex justify-between items-center mb-2">
          <span className="text-[10px] text-slate-500 uppercase font-bold">Color</span>
          <span className="text-[10px] text-slate-500">(empty = semi-transparent)</span>
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
            {settings.version_color && settings.version_color !== "" ? settings.version_color : "default opacity"}
          </span>
          {settings.version_color && settings.version_color !== "" && (
            <button
              onClick={() => onUpdateSettings({ ...settings, version_color: "" })}
              className="ml-auto text-[10px] text-red-400 hover:text-red-300 font-bold"
            >
              Reset
            </button>
          )}
        </div>

        <div className="flex justify-between items-center mb-1">
          <span className="text-[10px] text-slate-500 uppercase font-bold">Font Family</span>
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

      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Output Background</p>
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
              {mode === "None" ? "Theme" : mode}
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
                {(settings.background as { type: "Image"; value: ImageBackground }).value?.path ? "Change from Library..." : "Choose from Library..."}
              </button>
              {(settings.background as { type: "Image"; value: ImageBackground }).value?.path && (
                <button
                  onClick={() => onUpdateSettings({ ...settings, background: { type: "Image", value: { path: "", objectFit: "cover", opacity: 1 } } })}
                  className="text-red-500/70 hover:text-red-400 text-sm font-bold shrink-0"
                  title="Clear image"
                >✕</button>
              )}
            </div>
            {(settings.background as { type: "Image"; value: ImageBackground }).value?.path && (
              <p className="text-[9px] text-slate-600 truncate">
                {(settings.background as { type: "Image"; value: ImageBackground }).value.path.split(/[/\\]/).pop()}
              </p>
            )}
            {/* Fit + opacity for the global output image background */}
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-slate-500 uppercase font-bold w-10">Fit</span>
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
                    {fit === "contain" ? "Fit" : fit === "cover" ? "Crop" : "Stretch"}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-slate-500 uppercase font-bold w-10">Opacity</span>
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
        <p className="text-xs text-slate-400 font-bold uppercase mb-1">Content Backgrounds</p>
        <div className="flex flex-col gap-3 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
          <BackgroundEditor
            label="Bible Verses"
            value={settings.bible_background}
            onChange={(bg) => onUpdateSettings({ ...settings, bible_background: bg })}
            mediaImages={media.filter((m) => m.media_type === "Image")}
            onUploadMedia={onUploadMedia}

          />
          <div className="border-t border-slate-800" />
          <BackgroundEditor
            label="Media (Image / Video)"
            value={settings.media_background}
            onChange={(bg) => onUpdateSettings({ ...settings, media_background: bg })}
            mediaImages={media.filter((m) => m.media_type === "Image")}
            onUploadMedia={onUploadMedia}

          />
        </div>
      </div>

      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Preview</p>
        <div
          className="rounded-xl p-5 flex flex-col items-center text-center gap-3 border border-slate-800"
          style={computePreviewBackground(settings, THEMES[settings.theme]?.colors.background ?? "#000", appDataDir)}
        >
          {settings.reference_position === "top" && (
            <p className="text-sm font-bold uppercase tracking-widest" style={{ color: THEMES[settings.theme]?.colors.referenceText }}>
              John 3:16
            </p>
          )}
          <p className="text-base font-serif leading-snug" style={{ color: THEMES[settings.theme]?.colors.verseText }}>
            For God so loved the world that he gave his one and only Son...
          </p>
          {settings.reference_position === "bottom" && (
            <p className="text-sm font-bold uppercase tracking-widest" style={{ color: THEMES[settings.theme]?.colors.referenceText }}>
              John 3:16
            </p>
          )}
        </div>
      </div>

      {monitors.length > 0 && (
        <div className="border-t border-slate-800 pt-5">
          <p className="text-xs text-slate-400 font-bold uppercase mb-3">Output Monitor</p>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-3 cursor-pointer group">
              <input
                type="radio"
                name="preferred_monitor"
                checked={!settings.preferred_monitor}
                onChange={() => onUpdateSettings({ ...settings, preferred_monitor: undefined })}
                className="accent-amber-500"
              />
              <span className="text-xs text-slate-400 group-hover:text-slate-300">Auto (first secondary)</span>
            </label>
            {monitors.map((m) => (
              <label key={m.name} className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="radio"
                  name="preferred_monitor"
                  checked={settings.preferred_monitor === m.name}
                  onChange={() => onUpdateSettings({ ...settings, preferred_monitor: m.name })}
                  className="accent-amber-500"
                />
                <span className="text-xs text-slate-300 group-hover:text-white">
                  {m.name} — {m.width}×{m.height}
                  {m.is_primary && <span className="ml-1 text-[10px] text-slate-500">(Primary)</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-slate-800 pt-5">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Stage Display</h2>
            <p className="text-[10px] text-slate-600 mt-0.5">Second monitor for performers</p>
          </div>
          <button
            onClick={() => invoke("toggle_stage_window")}
            className="px-3 py-1.5 text-[10px] font-black uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
          >
            Toggle
          </button>
        </div>
        <label className="flex items-center justify-between gap-3 cursor-pointer mt-3">
          <div>
            <span className="text-xs text-slate-300 font-medium">Use active theme on stage monitor</span>
            <p className="text-[10px] text-slate-600">When off, stage uses a fixed dark palette.</p>
          </div>
          <input
            type="checkbox"
            checked={settings.stage_uses_theme ?? false}
            onChange={(e) => onUpdateSettings({ ...settings, stage_uses_theme: e.target.checked })}
            className="accent-amber-500 w-4 h-4"
          />
        </label>
      </div>

      <div className="border-t border-slate-800 pt-5">
        <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Operator Behaviour</h2>
        <label className="flex items-center justify-between gap-3 cursor-pointer">
          <div>
            <span className="text-xs text-slate-300 font-medium">Auto-hide background logo when going live</span>
            <p className="text-[10px] text-slate-600">Clears the pre-service splash automatically on first slide. Turn off to keep it visible.</p>
          </div>
          <input
            type="checkbox"
            checked={settings.auto_clear_background_logo ?? true}
            onChange={(e) => onUpdateSettings({ ...settings, auto_clear_background_logo: e.target.checked })}
            className="accent-amber-500 w-4 h-4"
          />
        </label>
      </div>
    </div>
  );
}
