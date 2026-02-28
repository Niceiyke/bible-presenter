import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { BackgroundEditor } from "./BackgroundEditor";
import { MediaPickerModal } from "./MediaPickerModal";
import { computePreviewBackground, relativizePath } from "../utils";
import { THEMES, FONTS } from "../types";
import type { PresentationSettings, BackgroundSetting } from "../types";

interface SettingsTabProps {
  onUpdateSettings: (s: PresentationSettings) => void;
  onUpdateTranscriptionWindow: (sec: number) => void;
  onUpdateVadThreshold: (val: number) => void;
  onUploadMedia: () => Promise<void>;
}

export function SettingsTab({
  onUpdateSettings,
  onUpdateTranscriptionWindow,
  onUpdateVadThreshold,
  onUploadMedia,
}: SettingsTabProps) {
  const {
    settings,
    media,
    cameras,
    transcriptionWindowSec,
    setTranscriptionWindowSec,
    vadThreshold,
    setVadThreshold,
    remoteUrl,
    remotePin, setRemotePin,
    tailscaleUrl,
    showLogoPicker, setShowLogoPicker,
    showGlobalBgPicker, setShowGlobalBgPicker,
    appDataDir,
  } = useAppStore();

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
      onUpdateSettings({ ...settings, background: { type: "Image", value: rel } });
    } catch (err: any) {
      console.error("Failed to set background image:", err);
    }
  };

  const handleUpdateTranscriptionWindow = (sec: number) => {
    setTranscriptionWindowSec(sec);
    localStorage.setItem("pref_transcriptionWindowSec", String(sec));
    onUpdateTranscriptionWindow(sec);
  };

  const handleUpdateVadThreshold = (val: number) => {
    setVadThreshold(val);
    localStorage.setItem("pref_vadThreshold", String(val));
    onUpdateVadThreshold(val);
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
        <div className="flex justify-between items-center mb-1">
          <p className="text-xs text-slate-400 font-bold uppercase">Transcription Window</p>
          <span className="text-xs font-mono text-amber-500">{transcriptionWindowSec.toFixed(1)}s samples</span>
        </div>
        <input
          type="range" min="0.5" max="3.0" step="0.5"
          value={transcriptionWindowSec}
          onChange={(e) => handleUpdateTranscriptionWindow(parseFloat(e.target.value))}
          className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
        />
        <div className="flex justify-between mt-1.5">
          <span className="text-[10px] text-slate-600">0.5s — fast, high CPU</span>
          <span className="text-[10px] text-slate-600">3.0s — slow, low CPU</span>
        </div>
      </div>

      <div>
        <div className="flex justify-between items-center mb-1">
          <p className="text-xs text-slate-400 font-bold uppercase">VAD Sensitivity</p>
          <span className="text-xs font-mono text-amber-500">{(vadThreshold * 1000).toFixed(0)} units</span>
        </div>
        <input
          type="range" min="0.0005" max="0.01" step="0.0005"
          value={vadThreshold}
          onChange={(e) => handleUpdateVadThreshold(parseFloat(e.target.value))}
          className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
        />
        <div className="flex justify-between mt-1.5">
          <span className="text-[10px] text-slate-600">More sensitive</span>
          <span className="text-[10px] text-slate-600">Less sensitive (ignore noise)</span>
        </div>
      </div>

      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Theme</p>
        <div className="grid grid-cols-2 gap-2">
          {Object.entries(THEMES).map(([key, { label, colors }]) => (
            <button
              key={key}
              onClick={() => onUpdateSettings({ ...settings, theme: key })}
              className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs font-bold text-left transition-all ${
                settings.theme === key
                  ? "border-amber-500 bg-amber-500/10 text-amber-400"
                  : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:bg-slate-800"
              }`}
            >
              <span className="w-5 h-5 rounded-sm shrink-0 border border-white/10" style={{ backgroundColor: colors.background }} />
              <span className="truncate">{label}</span>
              {settings.theme === key && <span className="ml-auto text-amber-500">✓</span>}
            </button>
          ))}
        </div>
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
                else bg = { type: "Image", value: settings.background.type === "Image" ? (settings.background as any).value : "" };
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
            <button
              onClick={() => {
                if (media.filter((m) => m.media_type === "Image").length > 0) setShowGlobalBgPicker(true);
                else handlePickBackgroundImage();
              }}
              className="w-full py-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-all"
            >
              {(settings.background as { type: "Image"; value: string }).value ? "Change from Library..." : "Choose from Library..."}
            </button>
          </div>
        )}
        {showGlobalBgPicker && (
          <MediaPickerModal
            images={media.filter((m) => m.media_type === "Image")}
            onSelect={(path) => onUpdateSettings({ ...settings, background: { type: "Image", value: relativizePath(path, appDataDir) } })}
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
            cameras={cameras}
          />
          <div className="border-t border-slate-800" />
          <BackgroundEditor
            label="Presentations (PPTX)"
            value={settings.presentation_background}
            onChange={(bg) => onUpdateSettings({ ...settings, presentation_background: bg })}
            mediaImages={media.filter((m) => m.media_type === "Image")}
            onUploadMedia={onUploadMedia}
            cameras={cameras}
          />
          <div className="border-t border-slate-800" />
          <BackgroundEditor
            label="Media (Image / Video)"
            value={settings.media_background}
            onChange={(bg) => onUpdateSettings({ ...settings, media_background: bg })}
            mediaImages={media.filter((m) => m.media_type === "Image")}
            onUploadMedia={onUploadMedia}
            cameras={cameras}
          />
        </div>
      </div>

      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Preview</p>
        <div
          className="rounded-xl p-5 flex flex-col items-center text-center gap-3 border border-slate-800"
          style={computePreviewBackground(settings, THEMES[settings.theme]?.colors.background ?? "#000")}
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
      </div>

      <div className="border-t border-slate-800 pt-5">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">Remote Control</h2>
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">LAN URL</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-amber-400 font-mono truncate">
                {remoteUrl || "http://localhost:7420"}
              </code>
              <button
                onClick={() => { navigator.clipboard.writeText(remoteUrl || "http://localhost:7420"); }}
                className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
              >Copy</button>
            </div>
          </div>

          {tailscaleUrl && (
            <div>
              <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Tailscale URL</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-teal-400 font-mono truncate">
                  {tailscaleUrl}
                </code>
                <button
                  onClick={() => { navigator.clipboard.writeText(tailscaleUrl); }}
                  className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
                >Copy</button>
              </div>
            </div>
          )}

          <div>
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-1.5">PIN</p>
            <div className="flex items-center gap-3">
              <div className="flex gap-2">
                {(remotePin || "----").split("").map((digit, i) => (
                  <span
                    key={i}
                    className="w-10 h-12 flex items-center justify-center bg-slate-900 border border-slate-700 rounded-lg text-2xl font-black text-white font-mono"
                  >
                    {digit}
                  </span>
                ))}
              </div>
              <button
                onClick={() => { navigator.clipboard.writeText(remotePin); }}
                className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
              >Copy</button>
              <button
                onClick={() => {
                  invoke("regenerate_remote_pin")
                    .then((pin: any) => setRemotePin(pin as string))
                    .catch(() => {});
                }}
                className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-400 border border-slate-700 rounded-lg transition-colors"
              >↺ New</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
