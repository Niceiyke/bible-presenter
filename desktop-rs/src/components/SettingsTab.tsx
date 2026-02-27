import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { PresentationSettings, MediaItem, BackgroundSetting } from "../App";

// ─── Local constants ──────────────────────────────────────────────────────────

interface ThemeColors {
  background: string;
  verseText: string;
  referenceText: string;
  waitingText: string;
}

const THEMES: Record<string, { label: string; colors: ThemeColors }> = {
  dark: {
    label: "Classic Dark",
    colors: { background: "#000000", verseText: "#ffffff", referenceText: "#f59e0b", waitingText: "#3f3f46" },
  },
  light: {
    label: "Light",
    colors: { background: "#f8fafc", verseText: "#0f172a", referenceText: "#b45309", waitingText: "#94a3b8" },
  },
  navy: {
    label: "Navy",
    colors: { background: "#0a1628", verseText: "#e2e8f0", referenceText: "#60a5fa", waitingText: "#334155" },
  },
  maroon: {
    label: "Maroon",
    colors: { background: "#1a0505", verseText: "#fef2f2", referenceText: "#f87171", waitingText: "#7f1d1d" },
  },
  forest: {
    label: "Forest",
    colors: { background: "#051a0a", verseText: "#f0fdf4", referenceText: "#4ade80", waitingText: "#14532d" },
  },
  slate: {
    label: "Slate",
    colors: { background: "#1e2a3a", verseText: "#cbd5e1", referenceText: "#94a3b8", waitingText: "#334155" },
  },
};

function computePreviewBackground(settings: PresentationSettings, themeColor: string): React.CSSProperties {
  if (settings.background.type === "Color") {
    return { backgroundColor: settings.background.value };
  }
  if (settings.background.type === "Image") {
    const imgPath = settings.background.value;
    if (imgPath) {
      return {
        backgroundImage: `url(${convertFileSrc(imgPath)})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      };
    }
  }
  return { backgroundColor: themeColor };
}

// ─── Media Picker Modal (local copy) ─────────────────────────────────────────

function MediaPickerModal({
  images,
  onSelect,
  onClose,
  onUpload,
}: {
  images: MediaItem[];
  onSelect: (path: string) => void;
  onClose: () => void;
  onUpload: () => Promise<void>;
}) {
  const [uploading, setUploading] = React.useState(false);

  const handleUpload = async () => {
    setUploading(true);
    try { await onUpload(); } finally { setUploading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-8" style={{ backgroundColor: "rgba(0,0,0,0.75)" }}>
      <div className="bg-slate-900 rounded-xl border border-slate-700 flex flex-col w-full max-w-2xl" style={{ maxHeight: "80vh" }}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 shrink-0">
          <span className="text-sm font-bold text-slate-200">Media Library — Pick Image</span>
          <div className="flex gap-2">
            <button
              onClick={handleUpload}
              disabled={uploading}
              className="text-[10px] bg-amber-500 hover:bg-amber-400 text-black font-bold px-3 py-1.5 rounded transition-all disabled:opacity-50"
            >
              {uploading ? "Uploading..." : "+ Upload New"}
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none px-1">×</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {images.length === 0 ? (
            <p className="text-slate-600 text-xs italic text-center py-12">
              No images in library yet. Click "+ Upload New" to add images.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {images.map((img) => (
                <button
                  key={img.id}
                  onClick={() => { onSelect(img.path); onClose(); }}
                  className="aspect-video rounded-lg overflow-hidden border border-slate-700 hover:border-amber-500 transition-all group relative"
                >
                  <img src={convertFileSrc(img.path)} className="w-full h-full object-cover" alt={img.name} />
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center">
                    <span className="text-white text-[10px] font-bold">SELECT</span>
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5">
                    <p className="text-[8px] text-white truncate">{img.name}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Background Editor (local copy) ──────────────────────────────────────────

function BackgroundEditor({
  label,
  value,
  onChange,
  mediaImages = [],
  onUploadMedia = async () => {},
  cameras = [],
}: {
  label: string;
  value: BackgroundSetting | undefined;
  onChange: (bg: BackgroundSetting) => void;
  mediaImages?: MediaItem[];
  onUploadMedia?: () => Promise<void>;
  cameras?: MediaDeviceInfo[];
}) {
  const [showPicker, setShowPicker] = React.useState(false);
  const current: BackgroundSetting = value ?? { type: "None" };

  return (
    <>
      <div>
        {label && <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mb-1.5">{label}</p>}
        <div className="flex gap-1.5 mb-1.5">
          {(["None", "Color", "Image", "Camera"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                if (mode === "None") onChange({ type: "None" });
                else if (mode === "Color") onChange({ type: "Color", value: current.type === "Color" ? (current as any).value : "#000000" });
                else if (mode === "Image") onChange({ type: "Image", value: current.type === "Image" ? (current as any).value : "" });
                else onChange({ type: "Camera", value: cameras[0]?.deviceId ?? "" });
              }}
              className={`flex-1 py-1 rounded text-[9px] font-bold border transition-all ${
                current.type === mode ? "border-amber-500 bg-amber-500/10 text-amber-400" : "border-slate-700 bg-slate-800/50 text-slate-500 hover:border-slate-600"
              }`}
            >
              {mode === "None" ? "Inherit" : mode}
            </button>
          ))}
        </div>
        {current.type === "Color" && (
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={(current as { type: "Color"; value: string }).value}
              onChange={(e) => onChange({ type: "Color", value: e.target.value })}
              className="w-8 h-8 rounded cursor-pointer border border-slate-700 bg-transparent"
            />
            <span className="text-[9px] font-mono text-slate-500">{(current as { type: "Color"; value: string }).value}</span>
          </div>
        )}
        {current.type === "Image" && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowPicker(true)}
              className="flex-1 py-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 text-[9px] font-bold text-slate-300 transition-all"
            >
              {(current as { type: "Image"; value: string }).value ? "Change from Library..." : "Pick from Library..."}
            </button>
            {(current as { type: "Image"; value: string }).value && (
              <button
                onClick={() => onChange({ type: "Image", value: "" })}
                className="text-red-500/70 hover:text-red-400 text-[10px] font-bold shrink-0"
                title="Clear image"
              >✕</button>
            )}
          </div>
        )}
        {current.type === "Image" && (current as { type: "Image"; value: string }).value && (
          <p className="text-[8px] text-slate-600 truncate mt-1">
            {(current as { type: "Image"; value: string }).value.split(/[/\\]/).pop()}
          </p>
        )}
        {current.type === "Camera" && (
          cameras.length === 0 ? (
            <p className="text-[9px] text-slate-600 italic mt-1">No cameras detected. Visit the Cameras tab to grant access.</p>
          ) : (
            <select
              value={(current as { type: "Camera"; value: string }).value}
              onChange={(e) => onChange({ type: "Camera", value: e.target.value })}
              className="w-full mt-1 bg-slate-800 text-white border border-slate-700 rounded px-2 py-1 text-[9px] focus:outline-none focus:ring-1 focus:ring-amber-500"
            >
              {cameras.map((cam) => (
                <option key={cam.deviceId} value={cam.deviceId}>
                  {cam.label || `Camera ${cam.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          )
        )}
      </div>
      {showPicker && (
        <MediaPickerModal
          images={mediaImages}
          onSelect={(path) => { onChange({ type: "Image", value: path }); }}
          onClose={() => setShowPicker(false)}
          onUpload={onUploadMedia}
        />
      )}
    </>
  );
}

// ─── SettingsTab ──────────────────────────────────────────────────────────────

interface SettingsTabProps {
  onUpdateSettings: (s: PresentationSettings) => void;
  onUpdateTranscriptionWindow: (sec: number) => void;
  onUploadMedia: () => Promise<void>;
}

export default function SettingsTab({
  onUpdateSettings,
  onUpdateTranscriptionWindow,
  onUploadMedia,
}: SettingsTabProps) {
  const {
    settings,
    media,
    cameras,
    transcriptionWindowSec,
    setTranscriptionWindowSec,
    remoteUrl,
    remotePin, setRemotePin,
    tailscaleUrl,
    showLogoPicker, setShowLogoPicker,
    showGlobalBgPicker, setShowGlobalBgPicker,
  } = useAppStore();

  const handlePickLogo = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] }],
      });
      if (!selected) return;
      onUpdateSettings({ ...settings, logo_path: selected as string });
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
      if (!selected) return;
      onUpdateSettings({ ...settings, background: { type: "Image", value: selected as string } });
    } catch (err: any) {
      console.error("Failed to set background image:", err);
    }
  };

  const handleUpdateTranscriptionWindow = (sec: number) => {
    setTranscriptionWindowSec(sec);
    localStorage.setItem("pref_transcriptionWindowSec", String(sec));
    onUpdateTranscriptionWindow(sec);
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

      {/* Font Size */}
      <div>
        <div className="flex justify-between items-center mb-3">
          <p className="text-xs text-slate-400 font-bold uppercase">Verse Font Size</p>
          <span className="text-xs font-mono text-amber-500">{settings.font_size}pt</span>
        </div>
        <input
          type="range" min="24" max="144" step="2"
          value={settings.font_size}
          onChange={(e) => onUpdateSettings({ ...settings, font_size: parseInt(e.target.value) })}
          className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
        />
      </div>

      {/* Slide Transition */}
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

      {/* Transcription window */}
      <div>
        <div className="flex justify-between items-center mb-1">
          <p className="text-xs text-slate-400 font-bold uppercase">Transcription Speed</p>
          <span className="text-xs font-mono text-amber-500">{transcriptionWindowSec.toFixed(1)}s window</span>
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
        <p className="text-[10px] text-slate-600 italic mt-1">Takes effect immediately without restarting the session.</p>
      </div>

      {/* Theme selector */}
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

      {/* Corner Logo */}
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
            onSelect={(path) => onUpdateSettings({ ...settings, logo_path: path })}
            onClose={() => setShowLogoPicker(false)}
            onUpload={onUploadMedia}
          />
        )}
      </div>

      {/* Reference position */}
      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Scripture Reference</p>
        <div className="flex gap-2">
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
        <p className="text-[10px] text-slate-600 italic mt-2">Position of Book Chapter:Verse on the output screen.</p>
      </div>

      {/* Output Background */}
      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Output Background</p>
        <div className="flex gap-2 mb-3">
          {(["None", "Color", "Image"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                let bg: BackgroundSetting;
                if (mode === "None") {
                  bg = { type: "None" };
                } else if (mode === "Color") {
                  bg = { type: "Color", value: settings.background.type === "Color" ? (settings.background as any).value : "#1a1a2e" };
                } else {
                  bg = { type: "Image", value: settings.background.type === "Image" ? (settings.background as any).value : "" };
                }
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
                if (media.filter((m) => m.media_type === "Image").length > 0) {
                  setShowGlobalBgPicker(true);
                } else {
                  handlePickBackgroundImage();
                }
              }}
              className="w-full py-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition-all"
            >
              {(settings.background as { type: "Image"; value: string }).value ? "Change from Library..." : "Choose from Library..."}
            </button>
            {(settings.background as { type: "Image"; value: string }).value && (
              <p className="text-[9px] text-slate-500 truncate">
                {(settings.background as { type: "Image"; value: string }).value.split(/[/\\]/).pop()}
              </p>
            )}
          </div>
        )}
        {showGlobalBgPicker && (
          <MediaPickerModal
            images={media.filter((m) => m.media_type === "Image")}
            onSelect={(path) => onUpdateSettings({ ...settings, background: { type: "Image", value: path } })}
            onClose={() => setShowGlobalBgPicker(false)}
            onUpload={onUploadMedia}
          />
        )}
      </div>

      {/* Per-content-type backgrounds */}
      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-1">Content Backgrounds</p>
        <p className="text-[9px] text-slate-600 italic mb-3">Override the global background for each content type. "Inherit" uses the setting above.</p>
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

      {/* Live preview */}
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
        <p className="text-[10px] text-slate-600 italic mt-2">Changes apply instantly to the output window.</p>
      </div>

      {/* Stage Display */}
      <div className="border-t border-slate-800 pt-5">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Stage Display</h2>
            <p className="text-[10px] text-slate-600 mt-0.5">Second monitor for performers — shows live + next item</p>
          </div>
          <button
            onClick={() => invoke("toggle_stage_window")}
            className="px-3 py-1.5 text-[10px] font-black uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
          >
            Toggle
          </button>
        </div>
      </div>

      {/* Remote Control */}
      <div className="border-t border-slate-800 pt-5">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">Remote Control</h2>
        <div className="flex flex-col gap-4">

          {/* LAN URL */}
          <div>
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">LAN URL <span className="normal-case text-slate-600 font-normal">(same WiFi)</span></p>
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

          {/* Tailscale URL */}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <p className="text-[10px] text-slate-500 uppercase font-bold">Tailscale URL <span className="normal-case text-slate-600 font-normal">(internet)</span></p>
              {tailscaleUrl && (
                <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-green-900/50 text-green-400 border border-green-800">Connected</span>
              )}
            </div>
            {tailscaleUrl ? (
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-green-400 font-mono truncate">
                  {tailscaleUrl}
                </code>
                <button
                  onClick={() => { navigator.clipboard.writeText(tailscaleUrl); }}
                  className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
                >Copy</button>
              </div>
            ) : (
              <p className="text-[11px] text-slate-500 italic">
                Tailscale not detected — install Tailscale on this machine and all operator devices to enable remote access over the internet.
              </p>
            )}
          </div>

          {/* Camera Sender */}
          <div>
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Camera Sender <span className="normal-case text-slate-600 font-normal">(mobile phone as camera)</span></p>
            <div className="flex items-center gap-2 mb-1.5">
              <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-sky-400 font-mono truncate">
                {remoteUrl ? `${remoteUrl}/camera` : "http://localhost:7420/camera"}
              </code>
              <button
                onClick={() => { navigator.clipboard.writeText(remoteUrl ? `${remoteUrl}/camera` : "http://localhost:7420/camera"); }}
                className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
              >Copy</button>
            </div>
            <p className="text-[10px] text-slate-600">Open this URL on a phone (same WiFi), enter the PIN below, and it appears in the LAN Camera tab as an input.</p>
          </div>

          {/* PIN */}
          <div>
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-1.5">PIN <span className="normal-case text-slate-600 font-normal">(persists across restarts)</span></p>
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
                title="Generate a new PIN"
              >↺ New</button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
