import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Database, Mic, RotateCcw, ShieldCheck } from "lucide-react";
import { useAiScripture, type AiProvider } from "../../../hooks/useAiScripture";
import { useProgramAudio } from "../../../hooks/useProgramAudio";
import { useAppStore } from "../../../store";
import type { PresentationSettings } from "../../../types";
import { AiScripturePerformancePanel } from "./AiScripturePerformancePanel";

interface ManagedAiStatus {
  available: boolean;
  addonActive: boolean;
  monthlyUnitsRemaining: number;
  topupUnitsRemaining: number;
  availableUnitsRemaining: number;
  standardLlmRequestUnits: number;
  message: string;
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
  message: "Checking on-device theme matching…",
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
  const [managedStatus, setManagedStatus] = useState<ManagedAiStatus | null>(null);
  const [managedLoading, setManagedLoading] = useState(true);
  const [semanticStatus, setSemanticStatus] = useState<SemanticStatus>(INITIAL_STATUS);
  const [removingModel, setRemovingModel] = useState(false);
  const active = ["connecting", "running", "listening"].includes(ai.status.state);

  useEffect(() => {
    setSelectedProvider(ai.provider);
  }, [ai.provider]);

  useEffect(() => {
    void programAudio.refreshDevices();
  }, [programAudio.refreshDevices]);

  const refreshManagedStatus = async () => {
    setManagedLoading(true);
    try {
      setManagedStatus(await invoke<ManagedAiStatus>("ai_presentation_status"));
    } catch (error) {
      setManagedStatus({
        available: false,
        addonActive: false,
        monthlyUnitsRemaining: 0,
        topupUnitsRemaining: 0,
        availableUnitsRemaining: 0,
        standardLlmRequestUnits: 10,
        message: `Could not read AI status: ${error}`,
      });
    } finally {
      setManagedLoading(false);
    }
  };

  useEffect(() => {
    void refreshManagedStatus();
  }, []);

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

  const prepareModel = async () => {
    try {
      setSemanticStatus(await invoke<SemanticStatus>("ai_prepare_semantic"));
    } catch (error) {
      setSemanticStatus({ ...INITIAL_STATUS, state: "error", message: `Could not set up theme matching: ${error}` });
    }
  };

  const cancelPreparation = async () => {
    setSemanticStatus(await invoke<SemanticStatus>("ai_cancel_semantic"));
  };

  const removeModel = async () => {
    if (!window.confirm("Remove the optional on-device theme-matching model? Scripture search and projection will remain available.")) return;
    setRemovingModel(true);
    try {
      setSemanticStatus(await invoke<SemanticStatus>("ai_remove_semantic"));
    } catch (error) {
      window.alert(`Could not remove the theme-matching model: ${error}`);
    } finally {
      setRemovingModel(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <div>
        <p className="text-xs text-console-text-muted font-bold uppercase mb-1">AI Scripture Assistant</p>
        <p className="text-[10px] text-console-text-subtle">Configure AI transcription and optional on-device theme matching here. Scripture search never depends on these services.</p>
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
          <p className="text-[10px] font-black uppercase tracking-widest text-console-text-muted flex items-center gap-1.5"><ShieldCheck size={12} /> AI transcription</p>
          <span className={`text-[10px] font-bold ${managedStatus?.available ? "text-state-success" : "text-state-warning"}`}>
            {managedStatus?.available ? "Ready" : managedStatus?.addonActive ? "Needs Units" : "Add-on required"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Transcription service">
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
                }}
                className={`px-3 py-2 rounded-md border text-left text-xs font-bold transition-colors ${
                  selected
                    ? "border-action-primary bg-action-primary/15 text-action-primary"
                    : "border-console-border bg-console-surface text-console-text-muted hover:border-console-text-subtle hover:text-console-text"
                }`}
              >
                {item.label}
                <span className="block mt-0.5 text-[9px] font-normal opacity-70">{selected ? "Selected for the next session" : "Use this service"}</span>
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border border-console-border bg-console-surface p-2.5">
            <p className="text-[9px] font-bold uppercase tracking-wider text-console-text-subtle">Available Units</p>
            <p className="mt-1 text-lg font-black text-console-text">{managedStatus?.availableUnitsRemaining.toLocaleString() ?? "—"}</p>
          </div>
          <div className="rounded-md border border-console-border bg-console-surface p-2.5">
            <p className="text-[9px] font-bold uppercase tracking-wider text-console-text-subtle">Est. transcription</p>
            <p className="mt-1 text-lg font-black text-console-text">{managedStatus ? `${Math.floor(managedStatus.availableUnitsRemaining).toLocaleString()} min` : "—"}</p>
          </div>
        </div>
        <p className="text-[10px] text-console-text-subtle">
          Live transcription uses 1 AI Unit per minute and is billed in fractional Units for partial minutes. {managedStatus?.available ? "" : managedStatus?.message || "Checking AI Add-on availability…"}
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void refreshManagedStatus()}
            disabled={managedLoading}
            className="inline-flex items-center gap-1.5 rounded-md border border-console-border px-2.5 py-1.5 text-[10px] font-bold text-console-text-muted hover:text-console-text disabled:opacity-50"
          >
            <RotateCcw size={11} className={managedLoading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
        <p className="text-[10px] text-console-text-subtle">Wordlyte securely manages transcription access. Audio is streamed only while listening, and no service keys are stored on this computer.</p>
      </section>

      <section className="rounded-lg border border-console-border bg-console-surface-raised/40 p-3 flex flex-col gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-console-text-muted">Transcript retention &amp; sync</p>
          <p className="mt-1 text-[10px] text-console-text-subtle">Both are on by default. Turn either option off to opt out. Microphone audio is never saved or uploaded.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex cursor-pointer items-start justify-between gap-3 rounded-md border border-console-border bg-console-surface p-2.5">
            <span>
              <span className="block text-[11px] font-bold text-console-text">Keep transcripts on this computer</span>
              <span className="mt-0.5 block text-[9px] leading-relaxed text-console-text-subtle">Saves finalized transcripts and Scripture suggestions locally for review and export.</span>
            </span>
            <input
              type="checkbox"
              checked={settings.transcript_retention_enabled !== false}
              onChange={(event) => void onUpdateSettings({ ...settings, transcript_retention_enabled: event.target.checked })}
              className="mt-0.5 shrink-0 accent-action-primary"
            />
          </label>
          <label className="flex cursor-pointer items-start justify-between gap-3 rounded-md border border-console-border bg-console-surface p-2.5">
            <span>
              <span className="block text-[11px] font-bold text-console-text">Sync transcripts to Dashboard</span>
              <span className="mt-0.5 block text-[9px] leading-relaxed text-console-text-subtle">Uploads finalized transcript text and suggestions after each listening session.</span>
            </span>
            <input
              type="checkbox"
              checked={settings.transcript_sync_enabled !== false}
              onChange={(event) => void onUpdateSettings({ ...settings, transcript_sync_enabled: event.target.checked })}
              className="mt-0.5 shrink-0 accent-action-primary"
            />
          </label>
        </div>
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
            ["ai_scripture_auto_live_paraphrases", "Theme suggestions", "Only the best-matching theme suggestion."],
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
            <p className="text-[10px] font-black uppercase tracking-widest text-console-text-muted flex items-center gap-1.5"><Database size={12} /> On-device theme matching</p>
            <p className={`mt-1 text-[10px] ${semanticStatus.state === "error" ? "text-state-error" : semanticStatus.state === "ready" ? "text-state-success" : "text-console-text-subtle"}`}>{semanticStatus.message}</p>
          </div>
          {semanticStatus.state === "preparing" ? (
            <button onClick={() => void cancelPreparation()} className="px-3 py-1.5 rounded-md border border-state-stage/40 text-state-stage text-[10px] font-black uppercase">Cancel</button>
          ) : (
            <button onClick={() => void prepareModel()} disabled={active || semanticStatus.state === "ready"} className="px-3 py-1.5 rounded-md border border-action-primary/40 text-action-primary text-[10px] font-black uppercase disabled:opacity-40">{semanticStatus.state === "ready" ? "Ready" : semanticStatus.state === "error" ? "Retry" : "Set up"}</button>
          )}
        </div>
        {semanticStatus.state === "preparing" && semanticStatus.total > 0 && <div className="h-1.5 overflow-hidden rounded-full bg-console-surface-strong"><div className="h-full bg-action-primary" style={{ width: `${Math.min(100, (semanticStatus.indexed / semanticStatus.total) * 100)}%` }} /></div>}
        <p className="text-[10px] text-console-text-subtle">Prepares the optional on-device model used to find thematic Scripture matches. This is a one-time download and uses additional disk space. Theme suggestions remain manual unless selected under Auto Live above.</p>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[9px] text-console-text-subtle">
          <span>{formatBytes(semanticStatus.diskBytes)} on-device storage{semanticStatus.verified ? " · Ready" : ""}</span>
          {semanticStatus.diskBytes > 0 && semanticStatus.state !== "preparing" && <button onClick={() => void removeModel()} disabled={active || removingModel} className="text-console-text-muted font-bold disabled:opacity-40">{removingModel ? "Removing…" : "Remove model"}</button>}
        </div>
      </section>
    </div>
  );
}
