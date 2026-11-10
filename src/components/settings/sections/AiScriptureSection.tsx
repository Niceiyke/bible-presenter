import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Database, KeyRound, Mic, RotateCcw } from "lucide-react";
import { useAiScripture, type AiProvider } from "../../../hooks/useAiScripture";
import { useProgramAudio } from "../../../hooks/useProgramAudio";
import { useAppStore } from "../../../store";
import type { PresentationSettings } from "../../../types";
import { AiScripturePerformancePanel } from "./AiScripturePerformancePanel";

interface AiKeyStatus {
  configured: boolean;
  provider: string;
}

interface SemanticStatus {
  state: "notPrepared" | "preparing" | "ready" | "error";
  message: string;
  indexed: number;
  total: number;
  model: string;
  diskBytes: number;
  verified: boolean;
}

const INITIAL_STATUS: SemanticStatus = {
  state: "notPrepared",
  message: "Checking local paraphrase model…",
  indexed: 0,
  total: 0,
  model: "BAAI/bge-base-en-v1.5-quantized",
  diskBytes: 0,
  verified: false,
};

const PROVIDERS: Array<{ value: AiProvider; label: string }> = [
  { value: "deepgram", label: "Deepgram" },
  { value: "assemblyai", label: "AssemblyAI" },
];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AiScriptureSection({ onUpdateSettings }: { onUpdateSettings: (settings: PresentationSettings) => Promise<void> | void }) {
  const ai = useAiScripture();
  const programAudio = useProgramAudio();
  const settings = useAppStore((state) => state.settings);
  const [selectedProvider, setSelectedProvider] = useState<AiProvider>(ai.provider);
  const [keyStatus, setKeyStatus] = useState<AiKeyStatus>({ configured: false, provider: ai.provider });
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [semanticStatus, setSemanticStatus] = useState<SemanticStatus>(INITIAL_STATUS);
  const [removingModel, setRemovingModel] = useState(false);
  const active = ["connecting", "running", "listening"].includes(ai.status.state);
  const providerName = selectedProvider === "deepgram" ? "Deepgram" : "AssemblyAI";
  const activeProvider = ai.status.provider as AiProvider;
  const credentialsLocked = active && activeProvider === selectedProvider;

  useEffect(() => {
    setSelectedProvider(ai.provider);
  }, [ai.provider]);

  useEffect(() => {
    void programAudio.refreshDevices();
  }, [programAudio.refreshDevices]);

  useEffect(() => {
    let mounted = true;
    void invoke<AiKeyStatus>("ai_key_status", { provider: selectedProvider })
      .then((next) => mounted && setKeyStatus(next))
      .catch(() => undefined);
    return () => { mounted = false; };
  }, [selectedProvider]);

  useEffect(() => {
    let mounted = true;
    void invoke<SemanticStatus>("ai_semantic_status")
      .then((next) => mounted && setSemanticStatus(next))
      .catch((error) => mounted && setSemanticStatus({ ...INITIAL_STATUS, state: "error", message: `Could not read status: ${error}` }));
    let stop: (() => void) | undefined;
    void listen<SemanticStatus>("ai-semantic-status", (event) => {
      if (mounted) setSemanticStatus(event.payload);
    }).then((unlisten) => {
      if (mounted) stop = unlisten;
      else unlisten();
    });
    return () => {
      mounted = false;
      stop?.();
    };
  }, []);

  const saveKey = async () => {
    setSavingKey(true);
    try {
      setKeyStatus(await invoke<AiKeyStatus>("ai_set_api_key", { provider: selectedProvider, apiKey }));
      setApiKey("");
    } catch (error) {
      window.alert(`Could not save API key: ${error}`);
    } finally {
      setSavingKey(false);
    }
  };

  const clearKey = async () => {
    try {
      await invoke("ai_clear_api_key", { provider: selectedProvider });
      setKeyStatus({ configured: false, provider: selectedProvider });
    } catch (error) {
      window.alert(`Could not remove API key: ${error}`);
    }
  };

  const prepareModel = async () => {
    try {
      setSemanticStatus(await invoke<SemanticStatus>("ai_prepare_semantic"));
    } catch (error) {
      setSemanticStatus({ ...INITIAL_STATUS, state: "error", message: `Could not prepare model: ${error}` });
    }
  };

  const cancelPreparation = async () => {
    setSemanticStatus(await invoke<SemanticStatus>("ai_cancel_semantic"));
  };

  const removeModel = async () => {
    if (!window.confirm("Remove the downloaded local AI model? Normal Scripture search and projection will remain available.")) return;
    setRemovingModel(true);
    try {
      setSemanticStatus(await invoke<SemanticStatus>("ai_remove_semantic"));
    } catch (error) {
      window.alert(`Could not remove the local model: ${error}`);
    } finally {
      setRemovingModel(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <p className="text-xs text-console-text-muted font-bold uppercase mb-1">AI Scripture Assistant</p>
        <p className="text-[10px] text-console-text-subtle">Configure transcription providers and the optional local paraphrase model here. Normal Scripture search never depends on these services.</p>
      </div>

      <section className="rounded-lg border border-console-border bg-console-surface-raised/40 p-3">
        <div className="mb-3 flex items-center gap-1.5"><Mic size={12} className="text-violet-300" /><p className="text-[10px] font-black uppercase tracking-widest text-console-text-muted">AI Scripture microphone</p></div>
        <div className="flex gap-2">
          <select value={programAudio.device ?? ""} onChange={(event) => programAudio.setDevice(event.target.value || null)} disabled={active} className="min-w-0 flex-1 rounded-md border border-console-border bg-console-surface px-2.5 py-2 text-xs text-console-text disabled:opacity-50">
            <option value="">Choose a mixer or microphone…</option>
            {programAudio.devices.map((device) => <option key={device} value={device}>{device}</option>)}
          </select>
          <button type="button" onClick={() => void programAudio.refreshDevices()} disabled={active} title="Refresh microphone list" className="rounded-md border border-console-border bg-console-surface px-2 text-console-text-subtle hover:text-console-text disabled:opacity-50"><RotateCcw size={13} /></button>
        </div>
        <p className="mt-2 text-[10px] text-console-text-subtle">This input is also used for recording and streaming when program audio is enabled.</p>
      </section>

      <section className="rounded-lg border border-console-border bg-console-surface-raised/40 p-3 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-console-text-muted flex items-center gap-1.5"><KeyRound size={12} /> Transcription provider</p>
          <span className={`text-[10px] font-bold ${keyStatus.configured ? "text-state-success" : "text-state-stage"}`}>{keyStatus.configured ? "Configured" : "Required"}</span>
        </div>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Transcription provider">
          {PROVIDERS.map((item) => {
            const selected = selectedProvider === item.value;
            return (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => {
                  if (selected) return;
                  setSelectedProvider(item.value);
                  ai.setProvider(item.value);
                  setKeyStatus({ configured: false, provider: item.value });
                  setApiKey("");
                }}
                className={`px-3 py-2 rounded-md border text-left text-xs font-bold transition-colors ${
                  selected
                    ? "border-action-primary bg-action-primary/15 text-action-primary"
                    : "border-console-border bg-console-surface text-console-text-muted hover:border-console-text-subtle hover:text-console-text"
                }`}
              >
                {item.label}
                <span className="block mt-0.5 text-[9px] font-normal opacity-70">{selected ? "Selected for the next session" : "Use this provider"}</span>
              </button>
            );
          })}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            disabled={credentialsLocked}
            placeholder={keyStatus.configured ? "Enter a replacement key" : `${providerName} API key`}
            className="min-w-0 flex-1 px-2.5 py-2 rounded-md border border-console-border bg-console-surface text-xs text-console-text placeholder:text-console-text-subtle disabled:opacity-50"
          />
          <button onClick={() => void saveKey()} disabled={savingKey || credentialsLocked || apiKey.trim().length < 16} className="px-3 py-2 rounded-md bg-action-primary text-black disabled:bg-console-surface-strong disabled:text-console-text-subtle text-[11px] font-bold">{savingKey ? "Saving…" : "Save key"}</button>
          {keyStatus.configured && <button onClick={() => void clearKey()} disabled={credentialsLocked} className="px-3 py-2 rounded-md border border-console-border text-console-text-muted text-[11px] font-bold disabled:opacity-50">Remove</button>}
        </div>
        <p className="text-[10px] text-console-text-subtle">Stored with Windows DPAPI for the current user. Audio and transcript data are sent only while listening.{active ? ` ${ai.status.provider === selectedProvider ? "Stop listening before replacing or removing the active provider key." : `${ai.status.provider} is currently listening; ${providerName} will be used next time you start.`}` : ""}</p>
      </section>

      <section className={`rounded-lg border p-3 flex flex-col gap-3 ${settings.ai_scripture_auto_live ? "border-state-error/60 bg-state-error/5" : "border-console-border bg-console-surface-raised/40"}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-console-text-muted">AI Scripture Auto Live</p>
            <p className="mt-1 text-[10px] text-console-text-subtle">When enabled, selected verified suggestions can replace the live output without pressing Go Live. It is off by default.</p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-[11px] font-bold text-console-text">
            <input
              type="checkbox"
              checked={settings.ai_scripture_auto_live === true}
              onChange={(event) => {
                if (event.target.checked && !window.confirm("Enable AI Scripture Auto Live? Selected suggestions will change the congregation's live output without an additional Go Live click.")) return;
                onUpdateSettings({ ...settings, ai_scripture_auto_live: event.target.checked });
              }}
              className="accent-red-500"
            />
            Enable Auto Live
          </label>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {[
            ["ai_scripture_auto_live_references", "Direct references", "Final references at 90% confidence or above."],
            ["ai_scripture_auto_live_quotes", "Direct quotations", "Final confirmed quotations at 90% confidence or above."],
            ["ai_scripture_auto_live_paraphrases", "Paraphrase themes", "Only the stable top-ranked local theme suggestion."],
            ["ai_scripture_auto_live_voice_commands", "Voice commands", "Next/previous verse and translation-command cards."],
          ].map(([key, label, description]) => (
            <label key={key} className="flex items-start gap-2 rounded-md border border-console-border bg-console-surface px-2.5 py-2 text-[10px] text-console-text-subtle">
              <input
                type="checkbox"
                disabled={settings.ai_scripture_auto_live !== true}
                checked={settings[key as keyof PresentationSettings] === true}
                onChange={(event) => onUpdateSettings({ ...settings, [key]: event.target.checked })}
                className="mt-0.5 accent-red-500 disabled:opacity-40"
              />
              <span><strong className="block text-[11px] text-console-text">{label}</strong>{description}</span>
            </label>
          ))}
        </div>
        <p className="text-[10px] text-state-stage">Auto Live uses the same normal output path as Send Live. Turning off the master switch immediately restores Stage-only behavior; category choices are retained for the next time it is enabled.</p>
      </section>

      <AiScripturePerformancePanel />

      <section className="rounded-lg border border-console-border bg-console-surface-raised/40 p-3 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-console-text-muted flex items-center gap-1.5"><Database size={12} /> Local paraphrase matching</p>
            <p className={`mt-1 text-[10px] ${semanticStatus.state === "error" ? "text-state-error" : semanticStatus.state === "ready" ? "text-state-success" : "text-console-text-subtle"}`}>{semanticStatus.message}</p>
          </div>
          {semanticStatus.state === "preparing" ? (
            <button onClick={() => void cancelPreparation()} className="px-3 py-1.5 rounded-md border border-state-stage/40 text-state-stage text-[10px] font-black uppercase">Cancel</button>
          ) : (
            <button onClick={() => void prepareModel()} disabled={active || semanticStatus.state === "ready"} className="px-3 py-1.5 rounded-md border border-action-primary/40 text-action-primary text-[10px] font-black uppercase disabled:opacity-40">{semanticStatus.state === "ready" ? "Ready" : semanticStatus.state === "error" ? "Retry" : "Prepare"}</button>
          )}
        </div>
        {semanticStatus.state === "preparing" && semanticStatus.total > 0 && <div className="h-1.5 overflow-hidden rounded-full bg-console-surface-strong"><div className="h-full bg-action-primary" style={{ width: `${Math.min(100, (semanticStatus.indexed / semanticStatus.total) * 100)}%` }} /></div>}
        <p className="text-[10px] text-console-text-subtle">Downloads the pinned local embedding and reranker models plus pre-built meaning indexes for each modern translation (NKJV, ASV, WEB, NIV, AMP); any translation that cannot be downloaded is built locally, which can take about an hour each. KJV reuses the NKJV index. Theme suggestions remain manual unless explicitly selected under Auto Live above.</p>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[9px] text-console-text-subtle">
          <span>{semanticStatus.model} · {formatBytes(semanticStatus.diskBytes)} local storage{semanticStatus.verified ? " · model verified" : ""}</span>
          {semanticStatus.diskBytes > 0 && semanticStatus.state !== "preparing" && <button onClick={() => void removeModel()} disabled={active || removingModel} className="text-console-text-muted font-bold disabled:opacity-40">{removingModel ? "Removing…" : "Remove model"}</button>}
        </div>
      </section>
    </div>
  );
}
