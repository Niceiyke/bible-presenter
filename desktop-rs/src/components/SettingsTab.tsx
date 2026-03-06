import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { BackgroundEditor } from "./BackgroundEditor";
import { MediaPickerModal } from "./MediaPickerModal";
import { computePreviewBackground, relativizePath } from "../utils";
import { THEMES, FONTS } from "../types";
import type { PresentationSettings, BackgroundSetting, MonitorInfo, StartupStatus } from "../types";
import type { ModelStatus, DownloadProgress, HardwareInfo, TranscriptionConfig } from "../store/slices/modelSlice";

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
    lanUrls,
    remotePin, setRemotePin,
    tailscaleUrl,
    showLogoPicker, setShowLogoPicker,
    showGlobalBgPicker, setShowGlobalBgPicker,
    appDataDir,
    availableVersions,
  } = useAppStore();

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

  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  useEffect(() => {
    invoke<MonitorInfo[]>("get_available_monitors").then(setMonitors).catch(() => {});
  }, []);

  const [remoteClientCount, setRemoteClientCount] = useState(0);
  useEffect(() => {
    const fetchCount = () => invoke<number>("get_remote_client_count").then(setRemoteClientCount).catch(() => {});
    fetchCount();
    const interval = setInterval(fetchCount, 5000);
    return () => clearInterval(interval);
  }, []);

  // Model manager state from store
  const {
    whisperModels, setWhisperModels,
    downloadProgress, setDownloadProgress,
    hardwareInfo, setHardwareInfo,
    transcriptionConfig, setTranscriptionConfig,
    semanticIndexStatus, setSemanticIndexStatus,
    verseIndexStatus, setVerseIndexStatus,
  } = useAppStore();

  // Load model manager data on mount
  useEffect(() => {
    invoke<ModelStatus[]>("list_whisper_models").then(setWhisperModels).catch(() => {});
    invoke<HardwareInfo>("get_hardware_info").then(setHardwareInfo).catch(() => {});
    invoke<TranscriptionConfig>("get_transcription_config").then(setTranscriptionConfig).catch(() => {});
    invoke<any>("get_semantic_index_status").then(setSemanticIndexStatus).catch(() => {});
    invoke<any>("get_verse_index_status").then(setVerseIndexStatus).catch(() => {});
  }, []);

  // Listen for download progress events
  useEffect(() => {
    const unlisten = listen<DownloadProgress>("download-progress", (e) => {
      const p = e.payload;
      console.log("Download progress:", p);
      setDownloadProgress(p.model_id, p.done ? null : p);
      if (p.done && !p.error) {
        if (p.model_id === "semantic_index" || p.model_id === "verse_index" || p.model_id === "bible_db") {
          invoke<any>("get_semantic_index_status").then(setSemanticIndexStatus).catch(() => {});
          invoke<any>("get_verse_index_status").then(setVerseIndexStatus).catch(() => {});
          if (p.model_id === "bible_db") {
            window.location.reload();
          }
        } else if (p.model_id === "core_models") {
          invoke<any>("get_startup_status").then(() => {}).catch(() => {});
          window.location.reload();
        } else {
          invoke<ModelStatus[]>("list_whisper_models").then(setWhisperModels).catch(() => {});
        }
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const handleDownload = (model_id: string) => {
    invoke("download_whisper_model", { model_id }).catch((e: any) => console.error(e));
  };

  const handleDownloadSemanticIndex = () => {
    console.log("Downloading Semantic Index...");
    invoke("download_semantic_index_cmd").catch((e: any) => {
      console.error(e);
      alert("Failed to start download: " + e);
    });
  };

  const handleDownloadVerseIndex = () => {
    console.log("Downloading Verse Index...");
    invoke("download_verse_index_cmd").catch((e: any) => {
      console.error(e);
      alert("Failed to start download: " + e);
    });
  };

  const handleSelect = (filename: string) => {
    invoke("set_active_whisper_model", { filename })
      .then(() => {
        invoke<TranscriptionConfig>("get_transcription_config").then(setTranscriptionConfig).catch(() => {});
        invoke<ModelStatus[]>("list_whisper_models").then(setWhisperModels).catch(() => {});
      })
      .catch((e: any) => console.error(e));
  };

  const handleDeleteModel = (filename: string) => {
    invoke("delete_whisper_model", { filename })
      .then(() => invoke<ModelStatus[]>("list_whisper_models").then(setWhisperModels))
      .catch((e: any) => alert(e));
  };

  const handleGpuToggle = (enabled: boolean) => {
    invoke("set_gpu_enabled", { enabled })
      .then(() => {
        setTranscriptionConfig({ ...transcriptionConfig, use_gpu: enabled });
      })
      .catch((e: any) => console.error(e));
  };

  // Cloud Transcription state
  const [cloudKeyDraft, setCloudKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testMessage, setTestMessage] = useState("");

  useEffect(() => {
    setCloudKeyDraft(transcriptionConfig.cloud_api_key ?? "");
  }, [transcriptionConfig.cloud_api_key]);

  const [cloudHostnameDraft, setCloudHostnameDraft] = useState(
    transcriptionConfig.cloud_hostname ?? ""
  );
  const [cloudModelDraft, setCloudModelDraft] = useState(
    transcriptionConfig.cloud_model ?? ""
  );
  const [cloudLanguageDraft, setCloudLanguageDraft] = useState(
    transcriptionConfig.cloud_language ?? ""
  );

  useEffect(() => {
    setCloudHostnameDraft(transcriptionConfig.cloud_hostname ?? "");
    setCloudModelDraft(transcriptionConfig.cloud_model ?? "");
    setCloudLanguageDraft(transcriptionConfig.cloud_language ?? "");
  }, [transcriptionConfig.cloud_hostname, transcriptionConfig.cloud_model, transcriptionConfig.cloud_language]);

  const handleSaveCloud = (provider: string | null, key: string) => {
    invoke("set_cloud_config", {
      provider,
      api_key: key || null,
      hostname: cloudHostnameDraft || null,
      model: cloudModelDraft || null,
      language: cloudLanguageDraft || null,
      auto_project: transcriptionConfig.auto_project,
      verse_lock_secs: transcriptionConfig.verse_lock_secs,
      confidence_threshold: transcriptionConfig.confidence_threshold,
    })
      .then(() => invoke<TranscriptionConfig>("get_transcription_config").then(setTranscriptionConfig))
      .catch((e: any) => console.error(e));
  };

  const handleSaveStreamingPrefs = () => {
    invoke("set_cloud_config", {
      provider: transcriptionConfig.cloud_provider,
      hostname: cloudHostnameDraft || null,
      model: cloudModelDraft || null,
      language: cloudLanguageDraft || null,
      auto_project: transcriptionConfig.auto_project,
      verse_lock_secs: transcriptionConfig.verse_lock_secs,
      confidence_threshold: transcriptionConfig.confidence_threshold,
    })
      .then(() => invoke<TranscriptionConfig>("get_transcription_config").then(setTranscriptionConfig))
      .catch((e: any) => console.error(e));
  };

  const handleTestCloud = () => {
    const provider = transcriptionConfig.cloud_provider;
    if (!provider || !cloudKeyDraft) return;
    setTestStatus("testing");
    setTestMessage("");
    invoke<string>("test_cloud_connection", { provider, api_key: cloudKeyDraft })
      .then((msg) => { setTestStatus("ok"); setTestMessage(msg); })
      .catch((e: any) => { setTestStatus("fail"); setTestMessage(String(e)); });
  };

  const [startupStatus, setStartupStatus] = useState<StartupStatus | null>(null);
  useEffect(() => {
    invoke<StartupStatus>("get_startup_status").then(setStartupStatus).catch(() => {});
  }, []);

  const handleDownloadBibleDb = () => {
    console.log("Downloading Bible DB...");
    invoke("download_bible_db_cmd").catch((e: any) => {
      console.error(e);
      alert("Failed to start download: " + e);
    });
  };

  const handleDownloadCoreModels = () => {
    console.log("Downloading Core Models...");
    invoke("download_core_search_models_cmd").catch((e: any) => {
      console.error(e);
      alert("Failed to start download: " + e);
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {/* ── Core Bible Assets ─────────────────────────────── */}
      <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 shadow-xl">
        <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
          Required Core Assets
        </h2>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Bible Database & Search Index Card */}
          <div className="p-3 rounded-lg bg-slate-800/50 border border-slate-700/50 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-400 font-bold uppercase">Bible Data & Index</span>
              {startupStatus?.db_ok && semanticIndexStatus?.downloaded && verseIndexStatus?.downloaded ? (
                <span className="text-[9px] font-black bg-emerald-900 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-700">INSTALLED</span>
              ) : (
                <span className="text-[9px] font-black bg-red-900/50 text-red-400 px-1.5 py-0.5 rounded border border-red-800/50 text-xs">MISSING</span>
              )}
            </div>
            <p className="text-[10px] text-slate-500 leading-tight">Contains Scripture texts and the AI search index for context-aware verse discovery.</p>
            {downloadProgress["bible_db"] || downloadProgress["semantic_index"] || downloadProgress["verse_index"] ? (
              <div className="space-y-1">
                <div className="flex justify-between text-[9px] text-slate-400 font-mono">
                  <span>{Math.round((downloadProgress["bible_db"] || downloadProgress["semantic_index"] || downloadProgress["verse_index"]).percent)}%</span>
                  <span>{Math.round((downloadProgress["bible_db"] || downloadProgress["semantic_index"] || downloadProgress["verse_index"]).bytes_downloaded/1024/1024)}MB</span>
                </div>
                <div className="h-1 bg-slate-700 rounded-full overflow-hidden">
                  <div className="h-full bg-amber-500 transition-all" style={{ width: `${(downloadProgress["bible_db"] || downloadProgress["semantic_index"] || downloadProgress["verse_index"]).percent}%` }} />
                </div>
              </div>
            ) : (!startupStatus?.db_ok || !semanticIndexStatus?.downloaded || !verseIndexStatus?.downloaded) && (
              <button
                onClick={handleDownloadBibleDb}
                className="mt-auto w-full py-2 bg-amber-600 hover:bg-amber-500 text-black text-[10px] font-black uppercase rounded-lg transition-all"
              >
                Download Bible Data (~380MB)
              </button>
            )}
          </div>

          {/* AI Neural Search Models Card */}
          <div className="p-3 rounded-lg bg-slate-800/50 border border-slate-700/50 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-400 font-bold uppercase">Neural Search Models</span>
              {startupStatus?.onnx_model_ok && startupStatus?.reranker_ok ? (
                <span className="text-[9px] font-black bg-emerald-900 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-700">INSTALLED</span>
              ) : (
                <span className="text-[9px] font-black bg-slate-800 text-slate-500 px-1.5 py-0.5 rounded border border-slate-700">NOT INSTALLED</span>
              )}
            </div>
            <p className="text-[10px] text-slate-500 leading-tight">Required for high-precision semantic search and "Pastor Paraphrase" detection.</p>
            
            {downloadProgress["core_models"] ? (
              <div className="space-y-1">
                <div className="flex justify-between text-[9px] text-slate-400 font-mono">
                  <span>{Math.round(downloadProgress["core_models"].percent)}%</span>
                  <span>{Math.round(downloadProgress["core_models"].bytes_downloaded/1024/1024)}MB</span>
                </div>
                <div className="h-1 bg-slate-700 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 transition-all" style={{ width: `${downloadProgress["core_models"].percent}%` }} />
                </div>
              </div>
            ) : (!startupStatus?.onnx_model_ok || !startupStatus?.reranker_ok) && (
              <button
                onClick={handleDownloadCoreModels}
                className="mt-auto w-full py-2 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-black uppercase rounded-lg transition-all"
              >
                Download AI Models (~130MB)
              </button>
            )}
          </div>
        </div>
      </div>

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
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">Camera Resolution (Local)</p>
        <div className="flex flex-wrap gap-2 mb-3">
          {(["360p", "480p", "720p", "1080p"] as const).map((r) => (
            <button
              key={r}
              onClick={() => onUpdateSettings({ ...settings, camera_resolution: r })}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                (settings.camera_resolution ?? "720p") === r
                  ? "bg-amber-500 border-amber-500 text-black"
                  : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-slate-600">Lower resolution reduces CPU usage and improves smoothness.</p>
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
      </div>

      <div className="border-t border-slate-800 pt-5">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">Remote Control</h2>
        <div className="flex flex-col gap-4">
          {/* Connected client indicator */}
          <div className="flex items-center gap-2 text-sm">
            <span className={`w-2 h-2 rounded-full shrink-0 ${remoteClientCount > 0 ? "bg-green-500" : "bg-slate-600"}`} />
            <span className="text-[10px] text-slate-400">
              {remoteClientCount > 0 ? `${remoteClientCount} client${remoteClientCount !== 1 ? "s" : ""} connected` : "No clients connected"}
            </span>
          </div>

          <div>
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">LAN URLs</p>
            <div className="flex flex-col gap-2">
              {lanUrls && lanUrls.length > 0 ? (
                lanUrls.map(([name, url]) => (
                  <div key={url} className="flex items-center gap-2">
                    <span className="text-[9px] font-bold text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded uppercase min-w-[40px] text-center">
                      {name}
                    </span>
                    <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-amber-400 font-mono truncate">
                      {url}
                    </code>
                    <button
                      onClick={() => { navigator.clipboard.writeText(url); }}
                      className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
                    >Copy</button>
                  </div>
                ))
              ) : (
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-amber-400 font-mono truncate">
                    {remoteUrl || "http://localhost:7420"}
                  </code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(remoteUrl || "http://localhost:7420"); }}
                    className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
                  >Copy</button>
                </div>
              )}
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
                {(remotePin || "------").split("").map((digit, i) => (
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

      <div className="border-t border-slate-800 pt-5">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">NDI & Standalone Output</h2>
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] text-slate-300 font-bold uppercase">Enable NDI Stream</p>
              <p className="text-[9px] text-slate-600 mt-0.5">Broadcast output over local network</p>
            </div>
            <button
              onClick={() => {
                const nextEnabled = !settings.ndi_enabled;
                onUpdateSettings({ ...settings, ndi_enabled: nextEnabled });
                invoke("toggle_ndi", { enabled: nextEnabled }).catch(() => {});
              }}
              className={`px-3 py-1.5 text-[10px] font-black uppercase rounded-lg transition-all border ${
                settings.ndi_enabled 
                  ? "bg-teal-600 border-teal-500 text-white" 
                  : "bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500"
              }`}
            >
              {settings.ndi_enabled ? "NDI ACTIVE" : "NDI OFF"}
            </button>
          </div>

          <div>
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Remote Server Port</p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={settings.remote_port}
                onChange={(e) => onUpdateSettings({ ...settings, remote_port: parseInt(e.target.value) || 7420 })}
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-amber-400 font-mono"
              />
              <p className="text-[9px] text-slate-600 w-24">Requires restart to take effect</p>
            </div>
          </div>

          <div>
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-1">OBS / Browser Source URL</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-indigo-400 font-mono truncate">
                {remoteUrl ? `${remoteUrl}/output?pin=${remotePin}` : `http://localhost:${settings.remote_port}/output?pin=${remotePin}`}
              </code>
              <button
                onClick={() => { 
                  const url = remoteUrl ? `${remoteUrl}/output?pin=${remotePin}` : `http://localhost:${settings.remote_port}/output?pin=${remotePin}`;
                  navigator.clipboard.writeText(url); 
                }}
                className="px-3 py-2 text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg transition-colors"
              >Copy</button>
            </div>
            <p className="text-[9px] text-slate-600 mt-1">Use this URL in OBS "Browser Source" for a transparent overlay.</p>
          </div>
        </div>
      </div>

      {/* ── Transcription Model Manager ─────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">
            Transcription Model
          </h2>
          {hardwareInfo && (
            <span className="text-[10px] text-slate-500 font-mono bg-slate-800 border border-slate-700 rounded px-2 py-1">
              {hardwareInfo.cpu_cores} cores
              {hardwareInfo.gpu_detected && ` · GPU: ${hardwareInfo.gpu_name ?? "detected"}`}
              {` · ${Math.round(hardwareInfo.total_ram_mb / 1024)}GB RAM`}
            </span>
          )}
        </div>

        {/* ── Cloud Transcription ─────────────────────────────────── */}
        <div className="mb-4 p-3 rounded-lg bg-slate-900/60 border border-slate-700/50">
          <p className="text-[10px] text-slate-400 font-bold uppercase mb-2">Cloud Transcription</p>

          <div className="mb-2">
            <label className="text-[10px] text-slate-500 uppercase font-bold block mb-1">Provider</label>
            <select
              value={transcriptionConfig.cloud_provider ?? ""}
              onChange={(e) => {
                const val = e.target.value || null;
                handleSaveCloud(val, cloudKeyDraft);
              }}
              className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-2 cursor-pointer focus:outline-none focus:border-amber-500"
            >
              <option value="">None (local only)</option>
              <option value="deepgram">Deepgram</option>
              <option value="openai">OpenAI Whisper API</option>
              <option value="assemblyai">AssemblyAI</option>
              <option value="google">Google STT</option>
            </select>
          </div>

          {transcriptionConfig.cloud_provider && (
            <>
              <div className="mb-2">
                <label className="text-[10px] text-slate-500 uppercase font-bold block mb-1">API Key</label>
                <div className="flex gap-2">
                  <input
                    type={showKey ? "text" : "password"}
                    value={cloudKeyDraft}
                    onChange={(e) => setCloudKeyDraft(e.target.value)}
                    placeholder="Paste your API key..."
                    className="flex-1 bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-2 font-mono focus:outline-none focus:border-amber-500"
                  />
                  <button
                    onClick={() => setShowKey(!showKey)}
                    className="px-2 py-1 text-[10px] font-bold uppercase bg-slate-700 hover:bg-slate-600 text-slate-400 border border-slate-600 rounded transition-colors"
                  >
                    {showKey ? "Hide" : "Show"}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 mb-2">
                <button
                  onClick={() => handleSaveCloud(transcriptionConfig.cloud_provider, cloudKeyDraft)}
                  className="px-3 py-1.5 text-[10px] font-bold uppercase bg-amber-600 hover:bg-amber-500 text-black rounded transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={handleTestCloud}
                  disabled={testStatus === "testing"}
                  className="px-3 py-1.5 text-[10px] font-bold uppercase bg-slate-700 hover:bg-slate-600 text-slate-300 border border-slate-600 rounded transition-colors disabled:opacity-50"
                >
                  {testStatus === "testing" ? "Testing..." : "Test Connection"}
                </button>
                {testStatus === "ok" && (
                  <span className="text-[10px] text-emerald-400 font-bold">✓ {testMessage}</span>
                )}
                {testStatus === "fail" && (
                  <span className="text-[10px] text-red-400 font-bold truncate max-w-[180px]" title={testMessage}>
                    ✗ {testMessage}
                  </span>
                )}
              </div>

              {/* Advanced streaming config — hostname / model / language */}
              <details className="mt-2">
                <summary className="text-[10px] text-slate-500 uppercase font-bold cursor-pointer select-none hover:text-slate-400 mb-2">
                  Advanced ▸
                </summary>

                <div className="flex flex-col gap-2 mt-2">
                  <div>
                    <label className="text-[10px] text-slate-500 uppercase font-bold block mb-1">
                      API Hostname
                      <span className="ml-1 text-slate-700 normal-case font-normal">(leave blank for default)</span>
                    </label>
                    <input
                      type="text"
                      value={cloudHostnameDraft}
                      onChange={(e) => setCloudHostnameDraft(e.target.value)}
                      placeholder={
                        transcriptionConfig.cloud_provider === "deepgram"
                          ? "api.deepgram.com"
                          : transcriptionConfig.cloud_provider === "assemblyai"
                          ? "api.assemblyai.com"
                          : "hostname"
                      }
                      className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 font-mono focus:outline-none focus:border-amber-500"
                    />
                  </div>

                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="text-[10px] text-slate-500 uppercase font-bold block mb-1">Model</label>
                      <input
                        type="text"
                        value={cloudModelDraft}
                        onChange={(e) => setCloudModelDraft(e.target.value)}
                        placeholder={
                          transcriptionConfig.cloud_provider === "deepgram" ? "nova-2" :
                          transcriptionConfig.cloud_provider === "openai" ? "whisper-1" : "model"
                        }
                        className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 font-mono focus:outline-none focus:border-amber-500"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-[10px] text-slate-500 uppercase font-bold block mb-1">Language</label>
                      <input
                        type="text"
                        value={cloudLanguageDraft}
                        onChange={(e) => setCloudLanguageDraft(e.target.value)}
                        placeholder="en"
                        className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 font-mono focus:outline-none focus:border-amber-500"
                      />
                    </div>
                  </div>

                  <button
                    onClick={handleSaveStreamingPrefs}
                    className="self-start px-3 py-1.5 text-[10px] font-bold uppercase bg-slate-700 hover:bg-slate-600 text-slate-300 border border-slate-600 rounded transition-colors"
                  >
                    Save Advanced
                  </button>
                </div>
              </details>

              {/* Live Auto-Projection settings */}
              <div className="mt-3 border-t border-slate-800 pt-3 flex flex-col gap-3">
                <p className="text-[10px] text-slate-400 font-bold uppercase">Auto-Projection</p>

                {/* Auto-project toggle */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-slate-300 font-bold uppercase">Auto-Project Detected Verses</p>
                    <p className="text-[9px] text-slate-600 mt-0.5">Project automatically without operator confirmation</p>
                  </div>
                  <button
                    onClick={() => {
                      const next = { ...transcriptionConfig, auto_project: !transcriptionConfig.auto_project };
                      setTranscriptionConfig(next);
                      invoke("set_cloud_config", {
                        provider: next.cloud_provider,
                        auto_project: next.auto_project,
                        verse_lock_secs: next.verse_lock_secs,
                        confidence_threshold: next.confidence_threshold,
                      }).catch(() => {});
                    }}
                    className={`w-10 h-5 rounded-full relative transition-colors ${transcriptionConfig.auto_project ? "bg-amber-500" : "bg-slate-700"}`}
                  >
                    <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${transcriptionConfig.auto_project ? "left-6" : "left-1"}`} />
                  </button>
                </div>

                {transcriptionConfig.auto_project && (
                  <>
                    {/* Verse lock duration */}
                    <div>
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-[10px] text-slate-500 uppercase font-bold">Verse Hold Duration</span>
                        <span className="text-xs font-mono text-amber-500">{transcriptionConfig.verse_lock_secs}s</span>
                      </div>
                      <input
                        type="range" min="2" max="30" step="1"
                        value={transcriptionConfig.verse_lock_secs}
                        onChange={(e) => {
                          const v = parseInt(e.target.value);
                          const next = { ...transcriptionConfig, verse_lock_secs: v };
                          setTranscriptionConfig(next);
                          invoke("set_cloud_config", { provider: next.cloud_provider, verse_lock_secs: v }).catch(() => {});
                        }}
                        className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
                      />
                      <div className="flex justify-between mt-1">
                        <span className="text-[9px] text-slate-600">2s — fast switch</span>
                        <span className="text-[9px] text-slate-600">30s — stable display</span>
                      </div>
                    </div>

                    {/* Confidence threshold */}
                    <div>
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-[10px] text-slate-500 uppercase font-bold">Min Confidence</span>
                        <span className="text-xs font-mono text-amber-500">{Math.round((transcriptionConfig.confidence_threshold ?? 0.55) * 100)}%</span>
                      </div>
                      <input
                        type="range" min="0.3" max="0.95" step="0.05"
                        value={transcriptionConfig.confidence_threshold ?? 0.55}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          const next = { ...transcriptionConfig, confidence_threshold: v };
                          setTranscriptionConfig(next);
                          // Wire through to BibleStore immediately via dedicated command
                          invoke("set_confidence_threshold", { threshold: v }).catch(() => {});
                        }}
                        className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
                      />
                      <div className="flex justify-between mt-1">
                        <span className="text-[9px] text-slate-600">30% — permissive</span>
                        <span className="text-[9px] text-slate-600">95% — strict</span>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <p className="text-[10px] text-slate-600 leading-relaxed mt-2">
                {["deepgram", "assemblyai"].includes(transcriptionConfig.cloud_provider ?? "")
                  ? "Real-time WebSocket streaming. Partials shown live; finals trigger verse detection."
                  : "Audio is sent to "}
                {!["deepgram", "assemblyai"].includes(transcriptionConfig.cloud_provider ?? "") && (
                  <span className="text-slate-500 capitalize">{transcriptionConfig.cloud_provider}</span>
                )}
                {!["deepgram", "assemblyai"].includes(transcriptionConfig.cloud_provider ?? "") &&
                  " for transcription. No local Whisper model is required."}
              </p>
            </>
          )}
        </div>

        {/* No-model warning — suppress when cloud is active */}
        {!transcriptionConfig.active_model && !transcriptionConfig.cloud_provider && (
          <div className="mb-3 px-3 py-2.5 bg-orange-950 border border-orange-700 rounded-lg text-[11px] text-orange-300">
            No Whisper model selected. Download a model below, then click <strong>Use</strong>.
          </div>
        )}

        {/* GPU toggle — only when GPU detected */}
        {hardwareInfo?.gpu_detected && (
          <div className="mb-3 flex items-center justify-between bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5">
            <div>
              <p className="text-xs text-slate-300 font-bold">GPU Acceleration</p>
              <p className="text-[10px] text-slate-500 mt-0.5">Requires session restart</p>
            </div>
            <button
              onClick={() => handleGpuToggle(!transcriptionConfig.use_gpu)}
              className={`w-10 h-5 rounded-full relative transition-colors ${
                transcriptionConfig.use_gpu ? "bg-emerald-500" : "bg-slate-600"
              }`}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                  transcriptionConfig.use_gpu ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        )}

        {/* Model cards */}
        <div className="flex flex-col gap-2">
          {whisperModels.map((model) => {
            const prog = downloadProgress[model.id];
            const isDownloading = !!prog;
            return (
              <div
                key={model.id}
                className={`bg-slate-800 border rounded-lg px-3 py-2.5 ${
                  model.is_active
                    ? "border-amber-500"
                    : model.is_recommended
                    ? "border-emerald-700"
                    : "border-slate-700"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-bold text-slate-200 truncate">
                      {model.display_name}
                    </span>
                    <span className="text-[10px] text-slate-500 shrink-0">
                      {model.size_mb} MB
                    </span>
                    {model.is_recommended && !model.is_active && (
                      <span className="text-[9px] font-black uppercase bg-emerald-900 text-emerald-400 border border-emerald-700 rounded px-1.5 py-0.5 shrink-0">
                        Recommended
                      </span>
                    )}
                    {model.is_active && (
                      <span className="text-[9px] font-black uppercase bg-amber-900 text-amber-400 border border-amber-700 rounded px-1.5 py-0.5 shrink-0">
                        Active
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isDownloading ? (
                      <button
                        onClick={() => invoke("cancel_whisper_download")}
                        className="px-2 py-1 text-[10px] font-bold uppercase bg-red-900 hover:bg-red-800 text-red-300 border border-red-700 rounded transition-colors"
                      >
                        Cancel
                      </button>
                    ) : model.downloaded ? (
                      <>
                        {!model.is_active && (
                          <button
                            onClick={() => handleSelect(model.filename)}
                            className="px-2 py-1 text-[10px] font-bold uppercase bg-slate-700 hover:bg-slate-600 text-slate-300 border border-slate-600 rounded transition-colors"
                          >
                            Use
                          </button>
                        )}
                        {!model.is_active && (
                          <button
                            onClick={() => handleDeleteModel(model.filename)}
                            className="px-2 py-1 text-[10px] font-bold uppercase bg-slate-800 hover:bg-red-900 text-slate-500 hover:text-red-400 border border-slate-700 hover:border-red-700 rounded transition-colors"
                          >
                            Del
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        onClick={() => handleDownload(model.id)}
                        className="px-2 py-1 text-[10px] font-bold uppercase bg-blue-900 hover:bg-blue-800 text-blue-300 border border-blue-700 rounded transition-colors"
                      >
                        Download
                      </button>
                    )}
                  </div>
                </div>

                {/* Download progress bar */}
                {isDownloading && (
                  <div className="mt-2">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[10px] text-slate-400">
                        {Math.round(prog.bytes_downloaded / 1024 / 1024)} /
                        {Math.round(prog.total_bytes / 1024 / 1024)} MB
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">
                        {prog.percent.toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all"
                        style={{ width: `${prog.percent}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Error message */}
                {prog?.error && (
                  <p className="mt-1.5 text-[10px] text-red-400">{prog.error}</p>
                )}
              </div>
            );
          })}
        </div>

        {hardwareInfo && (
          <p className="mt-2 text-[10px] text-slate-600">
            Recommended: <span className="text-slate-500">{hardwareInfo.recommended_model}</span>
            {" "}({hardwareInfo.recommendation_reason})
          </p>
        )}
      </div>
    </div>
  );
}
