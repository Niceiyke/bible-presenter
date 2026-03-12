import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../store";
import type { ModelStatus, DownloadProgress, HardwareInfo, TranscriptionConfig } from "../../store/slices/modelSlice";

export function TranscriptionSection() {
  const {
    whisperModels, setWhisperModels,
    downloadProgress, setDownloadProgress,
    hardwareInfo, setHardwareInfo,
    transcriptionConfig, setTranscriptionConfig,
  } = useAppStore();

  useEffect(() => {
    invoke<ModelStatus[]>("list_whisper_models").then(setWhisperModels).catch(() => {});
    invoke<HardwareInfo>("get_hardware_info").then(setHardwareInfo).catch(() => {});
    invoke<TranscriptionConfig>("get_transcription_config").then(setTranscriptionConfig).catch(() => {});
  }, []);

  useEffect(() => {
    const unlisten = listen<DownloadProgress>("download-progress", (e) => {
      const p = e.payload;
      const nextProgress = (p.done && !p.error) ? null : p;
      setDownloadProgress(p.model_id, nextProgress);

      if (p.done && !p.error) {
        if (p.model_id !== "semantic_index" && p.model_id !== "verse_index" && p.model_id !== "bible_db" && p.model_id !== "core_models") {
          invoke<ModelStatus[]>("list_whisper_models").then(setWhisperModels).catch(() => {});
        }
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const handleDownload = (model_id: string) => {
    invoke("download_whisper_model", { modelId: model_id }).catch((e: any) => console.error(e));
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

  const [cloudKeyDraft, setCloudKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testMessage, setTestMessage] = useState("");

  const [cloudHostnameDraft, setCloudHostnameDraft] = useState(transcriptionConfig.cloud_hostname ?? "");
  const [cloudModelDraft, setCloudModelDraft] = useState(transcriptionConfig.cloud_model ?? "");
  const [cloudRestModelDraft, setCloudRestModelDraft] = useState(transcriptionConfig.cloud_rest_model ?? "");
  const [cloudLanguageDraft, setCloudLanguageDraft] = useState(transcriptionConfig.cloud_language ?? "");

  useEffect(() => {
    setCloudKeyDraft(transcriptionConfig.cloud_api_key ?? "");
  }, [transcriptionConfig.cloud_api_key]);

  useEffect(() => {
    setCloudHostnameDraft(transcriptionConfig.cloud_hostname ?? "");
    setCloudModelDraft(transcriptionConfig.cloud_model ?? "");
    setCloudRestModelDraft(transcriptionConfig.cloud_rest_model ?? "");
    setCloudLanguageDraft(transcriptionConfig.cloud_language ?? "");
  }, [transcriptionConfig.cloud_hostname, transcriptionConfig.cloud_model, transcriptionConfig.cloud_rest_model, transcriptionConfig.cloud_language]);

  const handleSaveCloud = (provider: string | null, key: string) => {
    invoke("set_cloud_config", {
      provider,
      apiKey: key || null,
      hostname: cloudHostnameDraft.trim() || null,
      model: cloudModelDraft.trim() || null,
      restModel: cloudRestModelDraft.trim() || null,
      language: cloudLanguageDraft.trim() || null,
      operatorMode: transcriptionConfig.operator_mode,
      preacherMode: transcriptionConfig.preacher_mode,
      autoProject: transcriptionConfig.auto_project,
      verseLockSecs: transcriptionConfig.verse_lock_secs,
      confidenceThreshold: transcriptionConfig.confidence_threshold,
    })
      .then(() => invoke<TranscriptionConfig>("get_transcription_config").then(setTranscriptionConfig))
      .catch((e: any) => console.error(e));
  };

  const handleSaveStreamingPrefs = () => {
    invoke("set_cloud_config", {
      provider: transcriptionConfig.cloud_provider,
      hostname: cloudHostnameDraft.trim() || null,
      model: cloudModelDraft.trim() || null,
      restModel: cloudRestModelDraft.trim() || null,
      language: cloudLanguageDraft.trim() || null,
      operatorMode: transcriptionConfig.operator_mode,
      preacherMode: transcriptionConfig.preacher_mode,
      autoProject: transcriptionConfig.auto_project,
      verseLockSecs: transcriptionConfig.verse_lock_secs,
      confidenceThreshold: transcriptionConfig.confidence_threshold,
    })
      .then(() => invoke<TranscriptionConfig>("get_transcription_config").then(setTranscriptionConfig))
      .catch((e: any) => console.error(e));
  };

  const handleTestCloud = () => {
    const provider = transcriptionConfig.cloud_provider;
    if (!provider || !cloudKeyDraft) return;
    setTestStatus("testing");
    setTestMessage("");
    invoke<string>("test_cloud_connection", { provider, apiKey: cloudKeyDraft, model: cloudModelDraft.trim() || null })
      .then((msg) => { setTestStatus("ok"); setTestMessage(msg); })
      .catch((e: any) => { setTestStatus("fail"); setTestMessage(String(e)); });
  };

  return (
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

      {/* Cloud Transcription */}
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
                        ? "streaming.assemblyai.com"
                        : "hostname"
                    }
                    className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 font-mono focus:outline-none focus:border-amber-500"
                  />
                </div>

                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="text-[10px] text-slate-500 uppercase font-bold block mb-1">
                      Stream Model <span className="text-slate-600 normal-case font-normal">(preacher WS)</span>
                    </label>
                    <input
                      type="text"
                      value={cloudModelDraft}
                      onChange={(e) => setCloudModelDraft(e.target.value)}
                      placeholder={
                        transcriptionConfig.cloud_provider === "deepgram" ? "nova-2" :
                        transcriptionConfig.cloud_provider === "assemblyai" ? "best" :
                        transcriptionConfig.cloud_provider === "openai" ? "whisper-1" : "model"
                      }
                      className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-lg px-2 py-1.5 font-mono focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-[10px] text-slate-500 uppercase font-bold block mb-1">
                      REST Model <span className="text-slate-600 normal-case font-normal">(operator PTT)</span>
                    </label>
                    <input
                      type="text"
                      value={cloudRestModelDraft}
                      onChange={(e) => setCloudRestModelDraft(e.target.value)}
                      placeholder={
                        transcriptionConfig.cloud_provider === "deepgram" ? "nova-2" :
                        transcriptionConfig.cloud_provider === "assemblyai" ? "universal" :
                        transcriptionConfig.cloud_provider === "openai" ? "whisper-1" : "fallback to stream model"
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
                      autoProject: next.auto_project,
                      verseLockSecs: next.verse_lock_secs,
                      confidenceThreshold: next.confidence_threshold,
                    }).catch(() => {});
                  }}
                  className={`w-10 h-5 rounded-full relative transition-colors ${transcriptionConfig.auto_project ? "bg-amber-500" : "bg-slate-700"}`}
                >
                  <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${transcriptionConfig.auto_project ? "left-6" : "left-1"}`} />
                </button>
              </div>

              {transcriptionConfig.auto_project && (
                <>
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
                        invoke("set_cloud_config", { provider: next.cloud_provider, verseLockSecs: v }).catch(() => {});
                      }}
                      className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
                    />
                    <div className="flex justify-between mt-1">
                      <span className="text-[9px] text-slate-600">2s — fast switch</span>
                      <span className="text-[9px] text-slate-600">30s — stable display</span>
                    </div>
                  </div>

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

      {/* No-model warning */}
      {!transcriptionConfig.active_model && !transcriptionConfig.cloud_provider && (
        <div className="mb-3 px-3 py-2.5 bg-orange-950 border border-orange-700 rounded-lg text-[11px] text-orange-300">
          No Whisper model selected. Download a model below, then click <strong>Use</strong>.
        </div>
      )}

      {/* GPU toggle */}
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
  );
}
