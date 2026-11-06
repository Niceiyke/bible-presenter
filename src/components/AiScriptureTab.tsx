import React, { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { BrainCircuit, Mic, RotateCcw, Square, WandSparkles } from "lucide-react";
import { useAiScripture, type ScriptureSuggestion } from "../hooks/useAiScripture";
import { useProgramAudio } from "../hooks/useProgramAudio";
import { useAppStore } from "../store";
import type { DisplayItem } from "../types";

interface SemanticDiagnosticCandidate {
  reference: string;
  similarity: number;
  passageStart: number;
  passageEnd: number;
}

interface SemanticDiagnostic {
  state: "matched" | "ambiguous" | "waiting" | "rejected" | "skipped" | "error";
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

interface AiScriptureTabProps {
  onStage: (item: DisplayItem) => Promise<boolean> | void;
}

function referenceOf(suggestion: ScriptureSuggestion): string {
  const { book, chapter, verse, version } = suggestion.verse;
  return `${book} ${chapter}:${verse} · ${version}`;
}

export function AiScriptureTab({ onStage }: AiScriptureTabProps) {
  const { availableVersions, bibleVersion, settings, setToast } = useAppStore();
  const programAudio = useProgramAudio();
  const ai = useAiScripture();
  const [semanticDiagnostic, setSemanticDiagnostic] = useState<SemanticDiagnostic | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [audioDevice, setAudioDevice] = useState(programAudio.device ?? "");
  const enabledVersions = useMemo(
    () => availableVersions.filter((version) => !(settings.disabled_bible_versions ?? []).includes(version)),
    [availableVersions, settings.disabled_bible_versions],
  );
  const [version, setVersion] = useState(bibleVersion || enabledVersions[0] || "");
  const active = ["connecting", "running", "listening"].includes(ai.status.state);
  const autoLiveEnabled = settings.ai_scripture_auto_live === true;

  useEffect(() => {
    let mounted = true;
    let stop: (() => void) | undefined;
    void listen<SemanticDiagnostic>("ai-scripture-diagnostic", (event) => {
      if (mounted) setSemanticDiagnostic(event.payload);
    }).then((unlisten) => {
      if (mounted) stop = unlisten;
      else unlisten();
    });
    return () => {
      mounted = false;
      stop?.();
    };
  }, []);

  useEffect(() => {
    void programAudio.refreshDevices();
  }, [programAudio.refreshDevices]);

  useEffect(() => {
    if (programAudio.device && programAudio.device !== audioDevice) {
      setAudioDevice(programAudio.device);
    } else if (!programAudio.device && audioDevice && programAudio.devices.length > 0 && !programAudio.devices.includes(audioDevice)) {
      setAudioDevice("");
    }
  }, [audioDevice, programAudio.device, programAudio.devices]);

  useEffect(() => {
    if (!enabledVersions.includes(version)) setVersion(bibleVersion || enabledVersions[0] || "");
  }, [bibleVersion, enabledVersions, version]);

  useEffect(() => {
    if (active && ai.status.version && ai.status.version !== version) {
      setVersion(ai.status.version);
    }
  }, [active, ai.status.version, version]);

  const toggleListening = async () => {
    try {
      if (active) await ai.stop();
      else await ai.start(audioDevice, version);
    } catch (error) {
      setToast(`AI Scripture could not start: ${error}`);
    }
  };

  const stageSuggestion = async (suggestion: ScriptureSuggestion) => {
    try {
      const result = await onStage({ type: "Verse", data: suggestion.verse });
      const staged = result !== false;
      ai.recordManualStage(suggestion, staged);
      if (staged) setToast(`${referenceOf(suggestion)} staged. Review it, then use Go Live when ready.`);
    } catch (error) {
      ai.recordManualStage(suggestion, false);
      setToast(`Could not stage ${referenceOf(suggestion)}: ${error}`);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-black text-console-text flex items-center gap-2"><BrainCircuit size={16} className="text-violet-400" /> Live Scripture Assistant</h2>
          <p className="text-[11px] text-console-text-subtle mt-1">Listen for spoken references, direct quotations, “next verse,” and translation commands such as “give me NLT.”</p>
        </div>
        <span className="text-[10px] text-console-text-subtle border border-console-border bg-console-surface-raised rounded-md px-2.5 py-1.5">{ai.mode === "service" ? "Service" : "Operator"} mode · {ai.provider === "deepgram" ? "Deepgram" : "AssemblyAI"}</span>
      </div>

      <section className="rounded-lg border border-console-border bg-console-surface-raised/40 p-3">
        <div className="mb-3 grid gap-2 md:grid-cols-2" role="radiogroup" aria-label="AI Scripture listening mode">
          <button
            type="button"
            role="radio"
            aria-checked={ai.mode === "service"}
            disabled={active}
            onClick={() => ai.setMode("service")}
            className={`rounded-md border px-3 py-2 text-left disabled:opacity-50 ${ai.mode === "service" ? "border-violet-500 bg-violet-500/10" : "border-console-border bg-console-surface"}`}
          >
            <strong className="block text-[11px] text-console-text">Service mode</strong>
            <span className="block mt-0.5 text-[10px] text-console-text-subtle">Continuous sermon listening until the operator presses Stop.</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={ai.mode === "operator"}
            disabled={active}
            onClick={() => ai.setMode("operator")}
            className={`rounded-md border px-3 py-2 text-left disabled:opacity-50 ${ai.mode === "operator" ? "border-emerald-500 bg-emerald-500/10" : "border-console-border bg-console-surface"}`}
          >
            <strong className="block text-[11px] text-console-text">Operator mode</strong>
            <span className="block mt-0.5 text-[10px] text-console-text-subtle">Start on demand; stops after one verified reference, direct quote, or voice command.</span>
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_180px_auto] gap-2 items-end">
          <label className="text-[10px] font-bold text-console-text-subtle uppercase tracking-wide">Audio input
            <div className="mt-1 flex gap-1.5">
              <select value={active ? ai.status.audioDevice ?? audioDevice : audioDevice} onChange={(event) => { const next = event.target.value; setAudioDevice(next); programAudio.setDevice(next || null); }} disabled={active} className="w-full px-2.5 py-2 rounded-md border border-console-border bg-console-surface text-xs text-console-text disabled:opacity-50">
                <option value="">Choose a mixer or microphone…</option>
                {programAudio.devices.map((device) => <option key={device} value={device}>{device}</option>)}
              </select>
              <button type="button" onClick={() => void programAudio.refreshDevices()} disabled={active} title="Refresh microphone list" className="shrink-0 rounded-md border border-console-border bg-console-surface px-2 text-console-text-subtle hover:text-console-text disabled:opacity-50"><RotateCcw size={13} /></button>
            </div>
          </label>
          <label className="text-[10px] font-bold text-console-text-subtle uppercase tracking-wide">Output translation
            <select value={active ? ai.status.version ?? version : version} onChange={(event) => setVersion(event.target.value)} disabled={active} className="mt-1 w-full px-2.5 py-2 rounded-md border border-console-border bg-console-surface text-xs text-console-text disabled:opacity-50">
              {enabledVersions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <button onClick={() => void toggleListening()} disabled={!active && (!audioDevice || !version)} className={`h-[34px] px-4 rounded-md text-[11px] font-black uppercase tracking-wider flex items-center justify-center gap-2 disabled:bg-console-surface-strong disabled:text-console-text-subtle ${active ? "bg-red-700 text-white" : "bg-violet-700 text-white"}`}>
            {active ? <><Square size={11} fill="currentColor" /> Stop</> : <><Mic size={12} /> {ai.mode === "service" ? "Start service" : "Start command"}</>}
          </button>
        </div>
        <div className={`mt-3 flex items-center gap-2 text-[11px] ${ai.status.state === "error" ? "text-state-error" : active ? "text-state-success" : "text-console-text-subtle"}`}>
          <span className={`w-2 h-2 rounded-full ${active ? "bg-state-success animate-pulse" : ai.status.state === "error" ? "bg-state-error" : "bg-console-text-subtle"}`} />
          {ai.status.message}
        </div>
        <p className="mt-2 text-[10px] text-console-text-subtle">The selected audio input is remembered for AI Scripture, recording, and streaming when that device remains available. Provider keys and local paraphrase preparation are managed in Settings → AI Scripture.</p>
        <p className="mt-1 text-[10px] text-console-text-subtle">Voice commands: “next verse,” “previous verse,” “give me NLT,” “switch to King James,” or “next verse in the Amplified.” Command cards remain manual unless Voice commands is selected under Auto Live.</p>
        {ai.mode === "operator" && <p className="mt-1 text-[10px] text-emerald-300">Operator mode is armed for one verified result. It ignores raw speech and possible themes, then stops after a verified reference, direct quote, or command.</p>}
        {autoLiveEnabled && <p className="mt-1 text-[10px] font-bold text-state-error">AI Scripture Auto Live is enabled. Only the categories selected in Settings → AI Scripture will go live automatically.</p>}
        {!active && programAudio.devices.length === 0 && (
          <p className="mt-1 text-[10px] text-state-stage">No audio inputs found - ffmpeg may be missing or no microphone is plugged in. Click refresh after plugging in your mic.</p>
        )}
        {ai.lastCommand && (
          <div className="mt-2 rounded-md border border-violet-500/30 bg-violet-500/10 px-2.5 py-2 text-[10px] text-violet-300">
            {ai.lastCommand.message}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 min-h-[340px]">
        <section className="rounded-lg border border-console-border bg-console-surface-raised/30 flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-console-border flex items-center justify-between"><h3 className="text-[10px] font-black uppercase tracking-widest text-console-text-muted">Live transcript</h3><button onClick={() => { ai.clearSession(); setSemanticDiagnostic(null); }} className="text-[10px] text-console-text-subtle hover:text-console-text flex items-center gap-1"><RotateCcw size={10} /> Clear session</button></div>
          <div className="p-3 flex-1 max-h-[420px] overflow-y-auto custom-scrollbar text-xs leading-relaxed text-console-text select-text">
            {ai.transcript.length === 0 && !ai.interim ? <p className="text-console-text-subtle italic">Final transcript segments will appear here while listening.</p> : <p>{ai.transcript.map((segment) => <React.Fragment key={segment.id}>{segment.text} </React.Fragment>)}{ai.interim && <span className="text-console-text-subtle">{ai.interim.text}</span>}</p>}
          </div>
        </section>

        <section className="rounded-lg border border-console-border bg-console-surface-raised/30 flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-console-border flex items-center justify-between"><h3 className="text-[10px] font-black uppercase tracking-widest text-console-text-muted flex items-center gap-1.5"><WandSparkles size={11} className="text-violet-400" /> Suggestions</h3><span className={`text-[10px] ${autoLiveEnabled ? "text-state-error font-bold" : "text-console-text-subtle"}`}>{autoLiveEnabled ? "Selected categories can auto-live" : "References/quotes 90%+ auto-stage · Commands manual"}</span></div>
          <div className="p-3 flex flex-col gap-2 flex-1 max-h-[420px] overflow-y-auto custom-scrollbar">
            {ai.suggestions.length === 0 ? <p className="text-xs text-console-text-subtle italic">Detected references, close quotations, voice commands, and prepared paraphrase matches will appear here.</p> : ai.suggestions.map((suggestion) => (
              <article key={suggestion.id} className={`rounded-md border bg-console-surface p-3 ${suggestion.detection === "paraphrase" && suggestion.rank === 1 ? "border-state-stage/50" : "border-console-border"}`}>
                <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><strong className="text-xs text-console-text">{referenceOf(suggestion)}</strong><span className={`text-[9px] uppercase font-black tracking-wide px-1.5 py-0.5 rounded ${suggestion.detection === "reference" ? "bg-blue-950 text-blue-400" : suggestion.detection === "quote" ? "bg-violet-950 text-violet-400" : suggestion.detection === "command" ? "bg-emerald-950 text-emerald-400" : "bg-amber-950 text-amber-400"}`}>{suggestion.detection === "reference" ? "Reference" : suggestion.detection === "quote" ? "Direct quote" : suggestion.detection === "command" ? "Voice command" : `Possible theme${suggestion.rank ? ` #${suggestion.rank}` : ""}`}</span><span className="text-[9px] text-console-text-subtle">{Math.round(suggestion.confidence * 100)}%</span></div><p className="mt-2 text-xs text-console-text leading-relaxed select-text">{suggestion.verse.text}</p>{suggestion.detection === "paraphrase" && suggestion.passageStart != null && suggestion.passageEnd != null && suggestion.passageStart !== suggestion.passageEnd && <p className="mt-1.5 text-[10px] text-state-stage">Passage signal: {suggestion.verse.book} {suggestion.verse.chapter}:{suggestion.passageStart}–{suggestion.passageEnd}; Stage uses the strongest verse shown above.</p>}<p className="mt-2 text-[10px] text-console-text-subtle truncate" title={suggestion.evidence}>Heard: “{suggestion.evidence}”</p></div><button onClick={() => void stageSuggestion(suggestion)} className="shrink-0 px-3 py-1.5 rounded-md bg-blue-700 text-white text-[10px] font-black uppercase tracking-wide">Stage</button></div>
              </article>
            ))}
          </div>
        </section>
      </div>

      <div>
        <button onClick={() => setShowDiagnostics((current) => !current)} className="text-[10px] text-console-text-subtle hover:text-console-text font-bold uppercase tracking-wide">{showDiagnostics ? "Hide diagnostics" : "Show diagnostics"}</button>
        {showDiagnostics && <div className="mt-2 rounded-md border border-console-border bg-console-surface p-2.5 text-[10px] text-console-text-subtle">{!semanticDiagnostic ? <p>No semantic retrieval has run in this session.</p> : <div className="flex flex-col gap-1.5"><div className="flex flex-wrap gap-x-3 gap-y-1"><span className={semanticDiagnostic.state === "matched" ? "text-state-success" : semanticDiagnostic.state === "error" ? "text-state-error" : "text-state-stage"}>{semanticDiagnostic.state.toUpperCase()}</span><span>{semanticDiagnostic.latencyMs.toFixed(1)} ms</span><span>{semanticDiagnostic.queryWords} words</span>{semanticDiagnostic.similarity != null && <span>best {semanticDiagnostic.similarity.toFixed(3)}</span>}{semanticDiagnostic.margin != null && <span>margin {semanticDiagnostic.margin.toFixed(3)}</span>}</div><p>{semanticDiagnostic.reason}</p>{semanticDiagnostic.candidates.length > 0 && <ol className="grid gap-1 sm:grid-cols-3">{semanticDiagnostic.candidates.map((candidate, index) => <li key={`${candidate.reference}-${index}`} className="rounded border border-console-border px-2 py-1">{index + 1}. {candidate.reference} · {candidate.similarity.toFixed(3)}</li>)}</ol>}</div>}</div>}
      </div>
    </div>
  );
}
