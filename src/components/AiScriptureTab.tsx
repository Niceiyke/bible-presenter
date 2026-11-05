import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { BrainCircuit, Database, KeyRound, Mic, RotateCcw, ShieldCheck, Square, WandSparkles } from "lucide-react";
import { useAiScripture, type ScriptureSuggestion } from "../hooks/useAiScripture";
import { useProgramAudio } from "../hooks/useProgramAudio";
import { useAppStore } from "../store";
import type { DisplayItem } from "../types";

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

interface SemanticDiagnosticCandidate {
  reference: string;
  similarity: number;
  passageStart: number;
  passageEnd: number;
}

interface SemanticDiagnostic {
  state: "matched" | "ambiguous" | "rejected" | "skipped" | "error";
  reason: string;
  queryWords: number;
  contextSegments: number;
  similarity: number | null;
  margin: number | null;
  minimumSimilarity: number;
  minimumMargin: number;
  latencyMs: number;
  candidates: SemanticDiagnosticCandidate[];
}

const INITIAL_SEMANTIC_STATUS: SemanticStatus = {
  state: "notPrepared",
  message: "Checking local paraphrase model…",
  indexed: 0,
  total: 0,
  model: "BAAI/bge-small-en-v1.5-quantized",
  diskBytes: 0,
  verified: false,
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface AiScriptureTabProps {
  onStage: (item: DisplayItem) => Promise<boolean>;
}

function referenceOf(suggestion: ScriptureSuggestion): string {
  const { book, chapter, verse, version } = suggestion.verse;
  return `${book} ${chapter}:${verse} · ${version}`;
}

export function AiScriptureTab({ onStage }: AiScriptureTabProps) {
  const { availableVersions, bibleVersion, settings, setToast } = useAppStore();
  const programAudio = useProgramAudio();
  const ai = useAiScripture();
  const [keyStatus, setKeyStatus] = useState<AiKeyStatus>({ configured: false, provider: "deepgram" });
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [semanticStatus, setSemanticStatus] = useState<SemanticStatus>(INITIAL_SEMANTIC_STATUS);
  const [semanticDiagnostic, setSemanticDiagnostic] = useState<SemanticDiagnostic | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [removingModel, setRemovingModel] = useState(false);
  const [audioDevice, setAudioDevice] = useState(programAudio.device ?? "");
  const enabledVersions = useMemo(
    () => availableVersions.filter((version) => !(settings.disabled_bible_versions ?? []).includes(version)),
    [availableVersions, settings.disabled_bible_versions],
  );
  const [version, setVersion] = useState(bibleVersion || enabledVersions[0] || "");
  const active = ai.status.state === "connecting" || ai.status.state === "running" || ai.status.state === "listening";

  useEffect(() => {
    void invoke<AiKeyStatus>("ai_key_status")
      .then(setKeyStatus)
      .catch((error) => setToast(`Could not read AI credentials: ${error}`));
  }, [setToast]);

  useEffect(() => {
    let mounted = true;
    const unlisteners: Array<() => void> = [];
    void invoke<SemanticStatus>("ai_semantic_status")
      .then((status) => mounted && setSemanticStatus(status))
      .catch((error) => mounted && setSemanticStatus({
        ...INITIAL_SEMANTIC_STATUS,
        state: "error",
        message: `Could not read paraphrase status: ${error}`,
      }));
    void Promise.all([
      listen<SemanticStatus>("ai-semantic-status", (event) => {
        if (mounted) setSemanticStatus(event.payload);
      }),
      listen<SemanticDiagnostic>("ai-scripture-diagnostic", (event) => {
        if (mounted) setSemanticDiagnostic(event.payload);
      }),
    ]).then((stops) => {
      if (mounted) unlisteners.push(...stops);
      else stops.forEach((stop) => stop());
    });
    return () => {
      mounted = false;
      unlisteners.forEach((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (!audioDevice && programAudio.device) setAudioDevice(programAudio.device);
  }, [audioDevice, programAudio.device]);

  useEffect(() => {
    if (!enabledVersions.includes(version)) setVersion(bibleVersion || enabledVersions[0] || "");
  }, [bibleVersion, enabledVersions, version]);

  const saveKey = async () => {
    setSavingKey(true);
    try {
      const next = await invoke<AiKeyStatus>("ai_set_api_key", { apiKey });
      setKeyStatus(next);
      setApiKey("");
      setToast("Deepgram API key saved securely for this Windows user.");
    } catch (error) {
      setToast(`Could not save API key: ${error}`);
    } finally {
      setSavingKey(false);
    }
  };

  const clearKey = async () => {
    try {
      await invoke("ai_clear_api_key");
      setKeyStatus({ configured: false, provider: "deepgram" });
      setToast("Deepgram API key removed.");
    } catch (error) {
      setToast(`Could not remove API key: ${error}`);
    }
  };

  const prepareParaphrases = async () => {
    try {
      const status = await invoke<SemanticStatus>("ai_prepare_semantic");
      setSemanticStatus(status);
    } catch (error) {
      setToast(`Could not prepare local paraphrase matching: ${error}`);
    }
  };

  const cancelParaphrases = async () => {
    try {
      setSemanticStatus(await invoke<SemanticStatus>("ai_cancel_semantic"));
    } catch (error) {
      setToast(`Could not cancel paraphrase preparation: ${error}`);
    }
  };

  const removeParaphrases = async () => {
    if (!window.confirm("Remove the downloaded local AI model? The bundled Bible meaning index and normal projection will remain available.")) return;
    setRemovingModel(true);
    try {
      setSemanticStatus(await invoke<SemanticStatus>("ai_remove_semantic"));
      setSemanticDiagnostic(null);
      setToast("Local paraphrase model removed.");
    } catch (error) {
      setToast(`Could not remove the local paraphrase model: ${error}`);
    } finally {
      setRemovingModel(false);
    }
  };

  const toggleListening = async () => {
    try {
      if (active) {
        await ai.stop();
      } else {
        await ai.start(audioDevice, version);
      }
    } catch (error) {
      setToast(`AI Scripture could not start: ${error}`);
    }
  };

  const stageSuggestion = async (suggestion: ScriptureSuggestion) => {
    const staged = await onStage({ type: "Verse", data: suggestion.verse });
    if (staged) setToast(`${referenceOf(suggestion)} staged. Review it, then use Go Live when ready.`);
  };

  return (
    <div className="flex flex-col gap-4 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-black text-slate-100 flex items-center gap-2">
            <BrainCircuit size={16} className="text-violet-400" /> AI Scripture Assistant
          </h2>
          <p className="text-[11px] text-slate-500 mt-1">
            English sermon transcription with references, direct quotations, and local paraphrase suggestions.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-emerald-400 border border-emerald-900/70 bg-emerald-950/30 rounded-md px-2.5 py-1.5">
          <ShieldCheck size={12} /> 90%+ suggestions auto-stage; the operator controls Go Live.
        </div>
      </div>

      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
            <KeyRound size={12} /> Deepgram beta credentials
          </h3>
          <span className={`text-[10px] font-bold ${keyStatus.configured ? "text-emerald-400" : "text-amber-400"}`}>
            {keyStatus.configured ? "Configured" : "Required"}
          </span>
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            disabled={active}
            placeholder={keyStatus.configured ? "Enter a replacement key" : "Deepgram API key"}
            className="min-w-0 flex-1 px-2.5 py-2 rounded-md border border-slate-700 bg-slate-950 text-xs text-slate-200 placeholder:text-slate-600 disabled:opacity-50"
          />
          <button
            onClick={saveKey}
            disabled={savingKey || active || apiKey.trim().length < 16}
            className="px-3 py-2 rounded-md bg-violet-700 hover:bg-violet-600 disabled:bg-slate-800 disabled:text-slate-600 text-white text-[11px] font-bold"
          >
            {savingKey ? "Saving…" : "Save key"}
          </button>
          {keyStatus.configured && (
            <button
              onClick={clearKey}
              disabled={active}
              className="px-3 py-2 rounded-md border border-slate-700 hover:bg-slate-800 disabled:opacity-50 text-slate-400 text-[11px] font-bold"
            >
              Remove
            </button>
          )}
        </div>
        <p className="text-[10px] text-slate-600">
          Stored with Windows DPAPI for the current user. Audio and transcript data are sent to Deepgram only while listening.
        </p>
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
              <Database size={12} /> Local paraphrase matching
            </h3>
            <p className={`mt-1 text-[10px] ${semanticStatus.state === "error" ? "text-red-400" : semanticStatus.state === "ready" ? "text-emerald-400" : "text-slate-500"}`}>
              {semanticStatus.message}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {semanticStatus.state === "preparing" ? (
              <button
                onClick={() => void cancelParaphrases()}
                className="shrink-0 px-3 py-1.5 rounded-md border border-amber-800 bg-amber-950/40 hover:bg-amber-900/50 text-amber-300 text-[10px] font-black uppercase tracking-wide"
              >
                Cancel
              </button>
            ) : (
              <button
                onClick={() => void prepareParaphrases()}
                disabled={active || semanticStatus.state === "ready"}
                className="shrink-0 px-3 py-1.5 rounded-md border border-violet-800 bg-violet-950/40 hover:bg-violet-900/50 disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-600 text-violet-300 text-[10px] font-black uppercase tracking-wide"
              >
                {semanticStatus.state === "ready" ? "Ready" : semanticStatus.state === "error" ? "Retry" : "Prepare"}
              </button>
            )}
            {semanticStatus.diskBytes > 0 && semanticStatus.state !== "preparing" && (
              <button
                onClick={() => void removeParaphrases()}
                disabled={active || removingModel}
                className="shrink-0 px-2.5 py-1.5 rounded-md border border-slate-700 hover:bg-slate-800 disabled:opacity-40 text-slate-400 text-[10px] font-bold"
              >
                {removingModel ? "Removing…" : "Remove model"}
              </button>
            )}
          </div>
        </div>
        {semanticStatus.state === "preparing" && semanticStatus.total > 0 && (
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-800" aria-label="Paraphrase index progress">
            <div
              className="h-full bg-violet-600 transition-[width]"
              style={{ width: `${Math.min(100, (semanticStatus.indexed / semanticStatus.total) * 100)}%` }}
            />
          </div>
        )}
        <p className="text-[10px] text-slate-600">
          Preparation downloads a small MIT-licensed model once and loads Wordlyte's compact Bible meaning index. Up to three passage-aware themes may appear; all remain manual-only and sermon text stays local.
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[9px] text-slate-600">
          <span>{semanticStatus.model} · {formatBytes(semanticStatus.diskBytes)} local storage{semanticStatus.verified ? " · integrity verified" : ""}</span>
          <button
            onClick={() => setShowDiagnostics((current) => !current)}
            className="text-slate-500 hover:text-slate-300 font-bold uppercase tracking-wide"
          >
            {showDiagnostics ? "Hide diagnostics" : "Show diagnostics"}
          </button>
        </div>
        {showDiagnostics && (
          <div className="rounded-md border border-slate-800 bg-slate-950/70 p-2.5 text-[10px] text-slate-500">
            {!semanticDiagnostic ? (
              <p>No semantic retrieval has run in this session.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <span className={semanticDiagnostic.state === "matched" ? "text-emerald-400" : semanticDiagnostic.state === "error" ? "text-red-400" : "text-amber-400"}>
                    {semanticDiagnostic.state.toUpperCase()}
                  </span>
                  <span>{semanticDiagnostic.latencyMs.toFixed(1)} ms</span>
                  <span>{semanticDiagnostic.queryWords} words</span>
                  <span>{semanticDiagnostic.contextSegments} recent segment{semanticDiagnostic.contextSegments === 1 ? "" : "s"}</span>
                  {semanticDiagnostic.similarity != null && <span>best {semanticDiagnostic.similarity.toFixed(3)}</span>}
                  {semanticDiagnostic.margin != null && <span>margin {semanticDiagnostic.margin.toFixed(3)}</span>}
                  <span>gates ≥{semanticDiagnostic.minimumSimilarity.toFixed(3)} / ≥{semanticDiagnostic.minimumMargin.toFixed(3)}</span>
                </div>
                <p>{semanticDiagnostic.reason}</p>
                {semanticDiagnostic.candidates.length > 0 && (
                  <ol className="grid gap-1 sm:grid-cols-3">
                    {semanticDiagnostic.candidates.map((candidate, index) => (
                      <li key={`${candidate.reference}-${index}`} className="rounded border border-slate-800 px-2 py-1">
                        {index + 1}. {candidate.reference} · {candidate.similarity.toFixed(3)}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_180px_auto] gap-2 items-end">
          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
            Audio input
            <select
              value={active ? ai.status.audioDevice ?? audioDevice : audioDevice}
              onChange={(event) => setAudioDevice(event.target.value)}
              disabled={active}
              className="mt-1 w-full px-2.5 py-2 rounded-md border border-slate-700 bg-slate-950 text-xs text-slate-200 disabled:opacity-50"
            >
              <option value="">Choose a mixer or microphone…</option>
              {programAudio.devices.map((device) => <option key={device} value={device}>{device}</option>)}
            </select>
          </label>
          <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">
            Output translation
            <select
              value={active ? ai.status.version ?? version : version}
              onChange={(event) => setVersion(event.target.value)}
              disabled={active}
              className="mt-1 w-full px-2.5 py-2 rounded-md border border-slate-700 bg-slate-950 text-xs text-slate-200 disabled:opacity-50"
            >
              {enabledVersions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <button
            onClick={toggleListening}
            disabled={!active && (!keyStatus.configured || !audioDevice || !version)}
            className={`h-[34px] px-4 rounded-md text-[11px] font-black uppercase tracking-wider flex items-center justify-center gap-2 disabled:bg-slate-800 disabled:text-slate-600 ${
              active ? "bg-red-700 hover:bg-red-600 text-white" : "bg-violet-700 hover:bg-violet-600 text-white"
            }`}
          >
            {active ? <><Square size={11} fill="currentColor" /> Stop</> : <><Mic size={12} /> Start listening</>}
          </button>
        </div>
        <div className={`mt-3 flex items-center gap-2 text-[11px] ${ai.status.state === "error" ? "text-red-400" : active ? "text-emerald-400" : "text-slate-500"}`}>
          <span className={`w-2 h-2 rounded-full ${active ? "bg-emerald-400 animate-pulse" : ai.status.state === "error" ? "bg-red-500" : "bg-slate-700"}`} />
          {ai.status.message}
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 min-h-[340px]">
        <section className="rounded-lg border border-slate-800 bg-slate-900/30 flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
            <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400">Live transcript</h3>
            <button onClick={() => { ai.clearSession(); setSemanticDiagnostic(null); }} className="text-[10px] text-slate-500 hover:text-slate-300 flex items-center gap-1">
              <RotateCcw size={10} /> Clear session
            </button>
          </div>
          <div className="p-3 flex-1 max-h-[420px] overflow-y-auto custom-scrollbar text-xs leading-relaxed text-slate-300 select-text">
            {ai.transcript.length === 0 && !ai.interim ? (
              <p className="text-slate-600 italic">Final transcript segments will appear here while listening.</p>
            ) : (
              <p>
                {ai.transcript.map((segment) => <React.Fragment key={segment.id}>{segment.text} </React.Fragment>)}
                {ai.interim && <span className="text-slate-500">{ai.interim.text}</span>}
              </p>
            )}
          </div>
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-900/30 flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
            <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
              <WandSparkles size={11} className="text-violet-400" /> Suggestions
            </h3>
            <span className="text-[10px] text-slate-600">90%+ auto-stage · Newest first</span>
          </div>
          <div className="p-3 flex flex-col gap-2 flex-1 max-h-[420px] overflow-y-auto custom-scrollbar">
            {ai.suggestions.length === 0 ? (
              <p className="text-xs text-slate-600 italic">Detected references, close quotations, and prepared paraphrase matches will appear here.</p>
            ) : ai.suggestions.map((suggestion) => (
              <article key={suggestion.id} className={`rounded-md border bg-slate-950/70 p-3 ${suggestion.detection === "paraphrase" && suggestion.rank === 1 ? "border-amber-900/80" : "border-slate-800"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <strong className="text-xs text-slate-100">{referenceOf(suggestion)}</strong>
                      <span className={`text-[9px] uppercase font-black tracking-wide px-1.5 py-0.5 rounded ${suggestion.detection === "reference" ? "bg-blue-950 text-blue-400" : suggestion.detection === "quote" ? "bg-violet-950 text-violet-400" : "bg-amber-950 text-amber-400"}`}>
                        {suggestion.detection === "reference" ? "Reference" : suggestion.detection === "quote" ? "Direct quote" : `Possible theme${suggestion.rank ? ` #${suggestion.rank}` : ""}`}
                      </span>
                      <span className="text-[9px] text-slate-600">{Math.round(suggestion.confidence * 100)}%</span>
                    </div>
                    <p className="mt-2 text-xs text-slate-300 leading-relaxed select-text">{suggestion.verse.text}</p>
                    {suggestion.detection === "paraphrase" && suggestion.passageStart != null && suggestion.passageEnd != null && suggestion.passageStart !== suggestion.passageEnd && (
                      <p className="mt-1.5 text-[10px] text-amber-700">
                        Passage signal: {suggestion.verse.book} {suggestion.verse.chapter}:{suggestion.passageStart}–{suggestion.passageEnd}; Stage uses the strongest verse shown above.
                      </p>
                    )}
                    <p className="mt-2 text-[10px] text-slate-600 truncate" title={suggestion.evidence}>Heard: “{suggestion.evidence}”</p>
                  </div>
                  <button
                    onClick={() => void stageSuggestion(suggestion)}
                    className="shrink-0 px-3 py-1.5 rounded-md bg-blue-700 hover:bg-blue-600 text-white text-[10px] font-black uppercase tracking-wide"
                  >
                    Stage
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
