import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../store";
import { BackgroundEditor } from "../BackgroundEditor";
import { MediaPickerModal } from "../MediaPickerModal";
import { computePreviewBackground, relativizePath } from "../../utils";
import { THEMES, FONTS } from "../../types";
import type { PresentationSettings, BackgroundSetting, ImageBackground, MonitorInfo } from "../../types";
import { Eye, Palette, Type, Hash, Image as ImageIcon, Layers, Monitor } from "lucide-react";

interface DisplaySectionProps {
  onUpdateSettings: (s: PresentationSettings) => void;
  onUploadMedia: () => Promise<void>;
}

interface SettingsCardProps {
  id: string;
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
}

function SettingsCard({ id, icon, title, hint, children }: SettingsCardProps) {
  return (
    <section id={id} className="rounded-2xl p-5 surface-card scroll-mt-24">
      <header className="flex items-start gap-2.5 mb-4">
        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500/25 to-violet-600/25 border border-white/[0.08] flex items-center justify-center text-indigo-300 shrink-0">
          {icon}
        </div>
        <div className="min-w-0">
          <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest truncate">{title}</h3>
          {hint && <p className="text-[9px] text-slate-600 mt-0.5 leading-snug max-w-[520px]">{hint}</p>}
        </div>
      </header>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

const NAV_SECTIONS: { id: string; label: string }[] = [
  { id: "live-preview", label: "Preview" },
  { id: "theme", label: "Theme" },
  { id: "scripture", label: "Scripture" },
  { id: "reference", label: "Reference" },
  { id: "logo", label: "Logo" },
  { id: "backgrounds", label: "Backgrounds" },
  { id: "environment", label: "Environment" },
];

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

  const jumpTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="flex flex-col gap-4">

      {/* Sticky quick-nav */}
      <div className="sticky top-0 z-30 -mx-5 px-5 py-2.5 bg-[#020617]/85 backdrop-blur-xl border-b border-white/[0.06] flex items-center gap-1.5 overflow-x-auto">
        {NAV_SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => jumpTo(s.id)}
            className="px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider rounded-md text-slate-400 hover:text-white hover:bg-white/[0.08] transition-all active:scale-95 whitespace-nowrap"
          >
            {s.label}
          </button>
        ))}
        <span className="flex-1" />
        <button
          onClick={() => onUpdateSettings({ ...settings, is_blanked: !settings.is_blanked })}
          className={`px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-wider transition-all border active:scale-95 whitespace-nowrap ${
            settings.is_blanked
              ? "bg-red-500 border-red-500 text-white shadow-lg shadow-red-500/30"
              : "bg-white/[0.04] border border-white/[0.08] text-slate-400 hover:border-white/[0.16] hover:text-slate-200"
          }`}
        >
          {settings.is_blanked ? "Screen Blanked" : "Blank Screen"}
        </button>
      </div>

      {/* 01 — Live Preview */}
      <SettingsCard
        id="live-preview"
        icon={<Eye size={14} />}
        title="Live Preview"
        hint="Renders with the active theme, reference position, and verse type."
      >
        <div
          className="rounded-xl p-5 flex flex-col items-center text-center gap-3 border border-white/[0.1] shadow-float"
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
      </SettingsCard>

      {/* 02 — Theme & Transitions */}
      <SettingsCard
        id="theme"
        icon={<Palette size={14} />}
        title="Theme & Transitions"
        hint="Appearance presets and how slides change between them."
      >
        <div>
          <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Theme</p>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(THEMES).map(([key, { label, colors }]) => (
              <button
                key={key}
                onClick={() => onUpdateSettings({ ...settings, theme: key, custom_theme_colors: undefined })}
                className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs font-bold text-left transition-all ${
                  settings.theme === key && !settings.custom_theme_colors
                    ? "border-indigo-400/60 bg-indigo-500/15 text-indigo-300"
                    : "border-white/[0.08] bg-white/[0.03] text-slate-400 hover:border-white/[0.16] hover:bg-white/[0.06]"
                }`}
              >
                <span className="w-5 h-5 rounded-sm shrink-0 border border-white/10" style={{ backgroundColor: colors.background }} />
                <span className="truncate">{label}</span>
                {settings.theme === key && !settings.custom_theme_colors && <span className="ml-auto text-amber-500">✓</span>}
              </button>
            ))}
          </div>

          <details className="group mt-3">
            <summary className="text-[10px] text-slate-500 uppercase font-bold cursor-pointer select-none hover:text-slate-400 mb-2 list-none flex items-center gap-1">
              <span className="group-open:rotate-90 transition-transform">▸</span> Theme Overrides
            </summary>
            <div className="p-3 bg-white/[0.03] border border-white/[0.08] rounded-lg flex flex-col gap-3 mt-2">
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
          <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Slide Transition</p>
          <div className="flex flex-wrap gap-2 mb-2">
            {(["fade", "slide-up", "slide-left", "zoom", "none"] as const).map((t) => (
              <button
                key={t}
                onClick={() => onUpdateSettings({ ...settings, slide_transition: t })}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                  (settings.slide_transition ?? "fade") === t
                    ? "bg-amber-500 border-amber-500 text-black"
                    : "bg-white/[0.04] border border-white/[0.08] text-slate-400 hover:border-white/[0.16] hover:text-slate-200"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          {(settings.slide_transition ?? "fade") !== "none" && (
            <div className="flex justify-between items-center mb-1">
              <span className="text-[9px] text-slate-500 uppercase font-bold">Duration</span>
              <span className="text-xs font-mono text-amber-500">{(settings.slide_transition_duration ?? 0.4).toFixed(1)}s</span>
            </div>
          )}
          {(settings.slide_transition ?? "fade") !== "none" && (
            <input
              type="range" min="0.1" max="2.0" step="0.1"
              value={settings.slide_transition_duration ?? 0.4}
              onChange={(e) => onUpdateSettings({ ...settings, slide_transition_duration: parseFloat(e.target.value) })}
              className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-indigo-400"
            />
          )}
        </div>
      </SettingsCard>

      {/* 03 — Scripture */}
      <SettingsCard
        id="scripture"
        icon={<Type size={14} />}
        title="Scripture & Auto-Split"
        hint="Verse typography for the main slide, long-verse splitting, and divine-word highlighting."
      >
        <div>
          <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Verse Font</p>
          <div className="flex justify-between items-center mb-1">
            <span className="text-[10px] text-slate-500 uppercase font-bold">Font Size</span>
            <span className="text-xs font-mono text-amber-500">{settings.font_size}pt</span>
          </div>
          <input
            type="range" min="24" max="144" step="2"
            value={settings.font_size}
            onChange={(e) => onUpdateSettings({ ...settings, font_size: parseInt(e.target.value) })}
            className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-indigo-400 mb-3"
          />
          <select
            value={settings.verse_font_family ?? "Georgia, serif"}
            onChange={(e) => onUpdateSettings({ ...settings, verse_font_family: e.target.value })}
            className="w-full bg-white/[0.04] border border-white/[0.08] text-slate-300 text-xs rounded-lg px-2 py-2 cursor-pointer focus:outline-none focus:border-indigo-400/70"
            style={{ fontFamily: settings.verse_font_family ?? "Georgia, serif" }}
          >
            {FONTS.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
            ))}
          </select>
        </div>

        <div className="border-t border-white/[0.06] pt-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] text-slate-300 font-bold uppercase">Enable Auto-Split</span>
              <span className="text-[9px] text-slate-600">Divide long verses into multiple slides</span>
            </div>
            <button
              onClick={() => onUpdateSettings({ ...settings, auto_split_verses: !settings.auto_split_verses })}
              className={`w-10 h-5 rounded-full relative transition-all ${settings.auto_split_verses ? "bg-gradient-to-r from-amber-400 to-amber-600 shadow-lg shadow-amber-500/30" : "bg-white/10"}`}
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
                className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-indigo-400 mb-1"
              />
              <div className="flex justify-between">
                <span className="text-[9px] text-slate-600">Short slides</span>
                <span className="text-[9px] text-slate-600">Long slides</span>
              </div>
            </>
          )}
        </div>

        <div className="border-t border-white/[0.06] pt-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] text-slate-300 font-bold uppercase">Highlight Divine Words</span>
              <span className="text-[9px] text-slate-600">Automatically style words spoken by Christ or divine titles</span>
            </div>
            <button
              onClick={() => onUpdateSettings({ ...settings, highlight_divine_words: !settings.highlight_divine_words })}
              className={`w-10 h-6 rounded-full relative transition-all ${settings.highlight_divine_words ? "bg-gradient-to-r from-amber-400 to-amber-600 shadow-lg shadow-amber-500/30" : "bg-white/10"}`}
            >
              <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${settings.highlight_divine_words ? "left-6" : "left-1"}`} />
            </button>
          </div>

          {settings.highlight_divine_words && (
            <div className="flex items-center gap-3 p-3 bg-white/[0.03] border border-white/[0.08] rounded-lg">
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
      </SettingsCard>

      {/* 04 — Reference & Version Tags */}
      <SettingsCard
        id="reference"
        icon={<Hash size={14} />}
        title="Reference & Version Tags"
        hint="Styling for the &quot;John 3:16&quot; caption and the live &quot;(KJV)&quot; tag on Bible slides."
      >
        <div>
          <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Reference Position</p>
          <div className="flex gap-2 mb-3">
            {(["top", "bottom"] as const).map((pos) => (
              <button
                key={pos}
                onClick={() => onUpdateSettings({ ...settings, reference_position: pos })}
                className={`flex-1 py-3 rounded-lg border text-xs font-bold transition-all ${
                  settings.reference_position === pos
                    ? "border-indigo-400/60 bg-indigo-500/15 text-indigo-300"
                    : "border-white/[0.08] bg-white/[0.03] text-slate-400 hover:border-white/[0.16] hover:bg-white/[0.06]"
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
            className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-indigo-400 mb-3"
          />
          <div className="flex justify-between items-center mb-1.5">
            <span className="text-[10px] text-slate-500 uppercase font-bold">Color</span>
            <span className="text-[10px] text-slate-500">(empty = use theme color)</span>
          </div>
          <div className="flex items-center gap-3 mb-3">
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
          <select
            value={settings.reference_font_family ?? "Arial, sans-serif"}
            onChange={(e) => onUpdateSettings({ ...settings, reference_font_family: e.target.value })}
            className="w-full bg-white/[0.04] border border-white/[0.08] text-slate-300 text-xs rounded-lg px-2 py-2 cursor-pointer focus:outline-none focus:border-indigo-400/70"
            style={{ fontFamily: settings.reference_font_family ?? "Arial, sans-serif" }}
          >
            {FONTS.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
            ))}
          </select>

          <details className="group mt-3">
            <summary className="text-[10px] text-slate-500 uppercase font-bold cursor-pointer select-none hover:text-slate-400 mb-2 list-none flex items-center gap-1">
              <span className="group-open:rotate-90 transition-transform">▸</span> Chapter:Verse Number Styling
            </summary>
            <div className="p-3 bg-white/[0.03] border border-white/[0.08] rounded-lg flex flex-col gap-3 mt-2">
              <p className="text-[9px] text-slate-600 italic">Override styling for the &quot;3:16&quot; part only. Leave blank to inherit from reference.</p>
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
                  className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-indigo-400"
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
                  className="w-full bg-white/[0.04] border border-white/[0.08] text-slate-300 text-xs rounded-lg px-2 py-2 cursor-pointer focus:outline-none focus:border-indigo-400/70"
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

        <div className="border-t border-white/[0.06] pt-4">
          <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Version Tag Styling (e.g. (KJV))</p>
          <div className="flex justify-between items-center mb-1">
            <span className="text-[10px] text-slate-500 uppercase font-bold">Font Size</span>
            <span className="text-xs font-mono text-amber-500">{settings.version_font_size ?? 24}pt</span>
          </div>
          <input
            type="range" min="10" max="72" step="2"
            value={settings.version_font_size ?? 24}
            onChange={(e) => onUpdateSettings({ ...settings, version_font_size: parseInt(e.target.value) })}
            className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-indigo-400 mb-3"
          />
          <div className="flex justify-between items-center mb-1.5">
            <span className="text-[10px] text-slate-500 uppercase font-bold">Color</span>
            <span className="text-[10px] text-slate-500">(empty = semi-transparent)</span>
          </div>
          <div className="flex items-center gap-3 mb-3">
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
          <select
            value={settings.version_font_family ?? "Arial, sans-serif"}
            onChange={(e) => onUpdateSettings({ ...settings, version_font_family: e.target.value })}
            className="w-full bg-white/[0.04] border border-white/[0.08] text-slate-300 text-xs rounded-lg px-2 py-2 cursor-pointer focus:outline-none focus:border-indigo-400/70"
            style={{ fontFamily: settings.version_font_family ?? "Arial, sans-serif" }}
          >
            {FONTS.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
            ))}
          </select>
        </div>
      </SettingsCard>

      {/* 05 — Corner Logo */}
      <SettingsCard
        id="logo"
        icon={<ImageIcon size={14} />}
        title="Corner Logo"
        hint="Splash / corner watermark shown on output slides."
      >
        <div className="flex flex-col gap-2">
          <button
            onClick={() => {
              if (media.filter((m) => m.media_type === "Image").length > 0) {
                setShowLogoPicker(true);
              } else {
                handlePickLogo();
              }
            }}
            className="w-full py-2 rounded-lg border border-white/[0.08] bg-white/[0.06] hover:bg-white/[0.1] text-slate-300 text-xs font-bold transition-all active:scale-[0.98]"
          >
            {settings.logo_path ? "Change Logo..." : "Choose Logo..."}
          </button>
          {settings.logo_path && (
            <div className="flex items-center justify-between bg-black/40 p-2 rounded border border-white/[0.06]">
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
      </SettingsCard>

      {/* 06 — Backgrounds */}
      <SettingsCard
        id="backgrounds"
        icon={<Layers size={14} />}
        title="Output & Content Backgrounds"
        hint="Gradient/colour behind the whole output, plus per-content-type fills."
      >
        <div>
          <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Output Background</p>
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
                    ? "border-indigo-400/60 bg-indigo-500/15 text-indigo-300"
                    : "border-white/[0.08] bg-white/[0.03] text-slate-400 hover:border-white/[0.16] hover:bg-white/[0.06]"
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
                className="w-10 h-10 rounded cursor-pointer border border-white/[0.08] bg-transparent"
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
                  className="flex-1 py-2 rounded-lg border border-white/[0.08] bg-white/[0.06] hover:bg-white/[0.1] text-slate-300 text-xs font-bold transition-all"
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
                          ? "border-indigo-400/60 bg-indigo-500/15 text-indigo-300"
                          : "border-white/[0.08] bg-white/[0.03] text-slate-500 hover:border-white/[0.16]"
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
                  className="flex-1 h-1 appearance-none bg-white/[0.12] rounded accent-indigo-400 cursor-pointer"
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

        <div className="border-t border-white/[0.06] pt-4 flex flex-col gap-3">
          <p className="text-[10px] text-slate-500 uppercase font-bold">Content Backgrounds</p>
          <BackgroundEditor
            label="Bible Verses"
            value={settings.bible_background}
            onChange={(bg) => onUpdateSettings({ ...settings, bible_background: bg })}
            mediaImages={media.filter((m) => m.media_type === "Image")}
            onUploadMedia={onUploadMedia}
          />
          <div className="border-t border-white/[0.08]" />
          <BackgroundEditor
            label="Media (Image / Video)"
            value={settings.media_background}
            onChange={(bg) => onUpdateSettings({ ...settings, media_background: bg })}
            mediaImages={media.filter((m) => m.media_type === "Image")}
            onUploadMedia={onUploadMedia}
          />
        </div>
      </SettingsCard>

      {/* 07 — Environment */}
      <SettingsCard
        id="environment"
        icon={<Monitor size={14} />}
        title="Output Environment"
        hint="Which monitor receives the live output, the stage monitor mode, and operator behaviour."
      >
        {monitors.length > 0 && (
          <div>
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-2">Output Device</p>
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="radio"
                  name="preferred_monitor"
                  checked={!settings.preferred_monitor}
                  onChange={() => onUpdateSettings({ ...settings, preferred_monitor: undefined })}
                  className="accent-indigo-400"
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
                    className="accent-indigo-400"
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

        <div className="border-t border-white/[0.06] pt-4">
          <div className="flex items-center justify-between mb-2">
            <div>
              <span className="text-[10px] text-slate-300 font-bold uppercase">Stage Display</span>
              <p className="text-[9px] text-slate-600 mt-0.5">Second monitor for performers</p>
            </div>
            <button
              onClick={() => invoke("toggle_stage_window")}
              className="px-3 py-1.5 text-[10px] font-black uppercase bg-white/[0.06] hover:bg-white/[0.1] text-slate-300 border border-white/[0.08] rounded-lg transition-colors"
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
              className="accent-indigo-400 w-4 h-4"
            />
          </label>
        </div>

        <div className="border-t border-white/[0.06] pt-4">
          <div className="flex items-center justify-between mb-2">
            <div>
              <span className="text-[10px] text-slate-300 font-bold uppercase">Bible Versions</span>
              <p className="text-[9px] text-slate-600 mt-0.5">Enable / disable available translation tags.</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {availableVersions.map(v => (
              <button
                key={v}
                onClick={() => toggleVersion(v)}
                className={`px-2.5 py-1 rounded-lg border text-[9px] font-bold transition-all active:scale-95 ${
                  !(settings.disabled_bible_versions || []).includes(v)
                    ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                    : "bg-white/[0.03] border-white/[0.08] text-slate-500 hover:border-white/[0.16]"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-white/[0.06] pt-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-slate-300 font-bold uppercase">Operator Behaviour</span>
          </div>
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <div>
              <span className="text-xs text-slate-300 font-medium">Auto-hide background logo when going live</span>
              <p className="text-[10px] text-slate-600">Clears the pre-service splash automatically on first slide. Turn off to keep it visible.</p>
            </div>
            <input
              type="checkbox"
              checked={settings.auto_clear_background_logo ?? true}
              onChange={(e) => onUpdateSettings({ ...settings, auto_clear_background_logo: e.target.checked })}
              className="accent-indigo-400 w-4 h-4"
            />
          </label>
        </div>
      </SettingsCard>
    </div>
  );
}