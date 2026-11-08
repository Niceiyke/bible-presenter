import React from "react";
import { Mic, RotateCcw, Send, Square, Zap } from "lucide-react";
import { type ScriptureSuggestion, useAiScripture } from "../hooks/useAiScripture";
import { useProgramAudio } from "../hooks/useProgramAudio";
import { useAppStore } from "../store";
import type { DisplayItem } from "../types";

const METER_BARS = Array.from({ length: 16 }, (_, index) => index);

/** Service-facing AI control. Setup, transcripts, and review live in Settings. */
export function AiScriptureTab({ onStage, onLive }: { onStage: (item: DisplayItem) => Promise<boolean> | void; onLive: (item: DisplayItem) => Promise<boolean> | void }) {
  const ai = useAiScripture();
  const programAudio = useProgramAudio();
  const { bibleVersion, setActiveTab, setToast } = useAppStore();
  const listening = ["connecting", "running", "listening"].includes(ai.status.state);

  const toggleListening = async () => {
    try {
      if (listening) {
        await ai.stop();
        return;
      }
      if (!programAudio.device) {
        setToast("Choose an AI Scripture microphone in Settings before listening.");
        setActiveTab("settings");
        return;
      }
      // The compact service control always starts continuous listening. The
      // command-oriented mode remains an advanced configuration concern.
      ai.setMode("service");
      await ai.start(programAudio.device, bibleVersion);
    } catch (error) {
      setToast(`AI Scripture could not ${listening ? "stop" : "start"}: ${error}`);
    }
  };

  const referenceOf = (suggestion: ScriptureSuggestion) => {
    const start = suggestion.passageStart ?? suggestion.verse.verse;
    const end = suggestion.passageEnd ?? start;
    return `${suggestion.verse.book} ${suggestion.verse.chapter}:${start}${end > start ? `–${end}` : ""}`;
  };
  const confidenceOf = (suggestion: ScriptureSuggestion) => Math.round(Math.min(1, Math.max(0, suggestion.confidence)) * 100);
  const confidenceTone = (confidence: number) => confidence >= 90 ? "text-state-success" : confidence >= 75 ? "text-state-stage" : "text-state-warning";
  const stageSuggestion = async (suggestion: ScriptureSuggestion) => {
    try {
      const staged = await onStage({ type: "Verse", data: suggestion.verse });
      ai.recordManualStage(suggestion, staged !== false);
    } catch (error) {
      ai.recordManualStage(suggestion, false);
      setToast(`Could not stage ${referenceOf(suggestion)}: ${error}`);
    }
  };
  const liveSuggestion = async (suggestion: ScriptureSuggestion) => {
    try {
      await onLive({ type: "Verse", data: suggestion.verse });
    } catch (error) {
      setToast(`Could not take ${referenceOf(suggestion)} live: ${error}`);
    }
  };

  return (
    <div className="rounded-xl border border-violet-400/20 bg-violet-400/[0.035] p-4">
      <div className="flex items-start gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-400/10 text-violet-300"><Mic size={15} /></span>
          <div><h2 className="text-sm font-black text-console-text">Live Scripture Assistant</h2><p className="text-[10px] font-medium text-console-text-subtle">{listening ? "Listening for Scripture references" : "Ready when your service begins"}</p></div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <div className="flex h-11 flex-1 items-end gap-1 rounded-lg border border-console-border bg-console-canvas/65 px-3 py-2" aria-label={listening ? `Audio input level ${Math.round(ai.audioLevel * 100)}%` : "Audio input idle"}>
          {METER_BARS.map((bar) => {
            const threshold = (bar + 1) / METER_BARS.length;
            const lit = listening && ai.audioLevel >= threshold;
            return <span key={bar} className={`min-w-[3px] flex-1 rounded-sm transition-colors ${lit ? (bar > 13 ? "bg-state-live" : bar > 10 ? "bg-state-warning" : "bg-state-success") : "bg-console-border"}`} style={{ height: `${25 + ((bar * 17) % 62)}%` }} />;
          })}
        </div>
        <button onClick={() => void toggleListening()} className={`flex h-11 min-w-40 items-center justify-center gap-2 rounded-lg px-4 text-[10px] font-black uppercase tracking-wider ${listening ? "bg-state-live text-white hover:bg-state-live/85" : "bg-violet-700 text-white hover:bg-violet-600"}`}>
          {listening ? <><Square size={12} fill="currentColor" /> Stop listening</> : <><Mic size={13} /> Start listening</>}
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[9px] font-medium text-console-text-subtle"><span className={`flex items-center gap-1.5 ${listening ? "text-state-success" : ""}`}><span className={`h-1.5 w-1.5 rounded-full ${listening ? "bg-state-success animate-pulse" : "bg-console-text-subtle"}`} />{ai.status.message}</span><span className="truncate">{programAudio.device ?? "No microphone selected"}</span></div>

      <div className="mt-4 border-t border-console-border/80 pt-4">
        <div className="mb-2 flex items-center justify-between gap-2"><span className="text-[9px] font-black uppercase tracking-[0.14em] text-console-text-muted">Live session</span><button onClick={ai.clearSession} title="Clears the live transcript and suggestions; saved sessions are not deleted." className="flex h-7 items-center gap-1 rounded-md border border-console-border bg-console-surface px-2 text-[8px] font-black uppercase tracking-wider text-console-text-muted hover:text-console-text"><RotateCcw size={10} /> Clear view</button></div>
      <div className="grid gap-3 lg:grid-cols-2">
        <section className="min-h-52 rounded-lg border border-console-border bg-console-canvas/45">
          <header className="border-b border-console-border px-3 py-2"><h3 className="text-[9px] font-black uppercase tracking-[0.14em] text-console-text-muted">Live transcription</h3></header>
          <div className="max-h-72 overflow-y-auto p-3 text-[11px] leading-relaxed text-console-text custom-scrollbar select-text">
            {ai.transcript.length === 0 && !ai.interim ? <p className="italic text-console-text-subtle">Transcription will appear while listening.</p> : <p>{ai.transcript.map((segment) => <React.Fragment key={segment.id}>{segment.text} </React.Fragment>)}{ai.interim && <span className="text-console-text-subtle">{ai.interim.text}</span>}</p>}
          </div>
        </section>
        <section className="min-h-52 rounded-lg border border-console-border bg-console-canvas/45">
          <header className="border-b border-console-border px-3 py-2"><h3 className="text-[9px] font-black uppercase tracking-[0.14em] text-console-text-muted">Suggestions</h3></header>
          <div className="max-h-72 space-y-2 overflow-y-auto p-2.5 custom-scrollbar">
            {ai.suggestions.length === 0 ? <p className="p-1 text-[10px] italic text-console-text-subtle">Detected references and close quotations will appear here.</p> : ai.suggestions.slice(0, 8).map((suggestion) => {
              const confidence = confidenceOf(suggestion);
              return <article key={suggestion.id} className="rounded-md border border-console-border bg-console-surface p-2"><div className="flex items-center justify-between gap-2"><span className="truncate text-[10px] font-black text-console-text">{referenceOf(suggestion)}</span><div className="flex shrink-0 items-center gap-1"><span className={`text-[8px] font-black tabular-nums ${confidenceTone(confidence)}`} title={`Detection confidence: ${confidence}%`}>{confidence}%</span><span className="rounded bg-violet-400/10 px-1.5 py-0.5 text-[7px] font-black uppercase text-violet-300">{suggestion.detection}</span></div></div><div className="mt-1 h-0.5 overflow-hidden rounded-full bg-console-border" aria-label={`Detection confidence ${confidence}%`}><span className={`block h-full rounded-full ${confidence >= 90 ? "bg-state-success" : confidence >= 75 ? "bg-state-stage" : "bg-state-warning"}`} style={{ width: `${confidence}%` }} /></div><p className="mt-1.5 line-clamp-2 text-[9px] leading-relaxed text-console-text-muted">{suggestion.verse.text}</p><div className="mt-2 flex gap-1"><button onClick={() => void stageSuggestion(suggestion)} className="flex h-7 items-center gap-1 rounded-md border border-state-stage/30 bg-state-stage/10 px-2 text-[8px] font-black uppercase text-state-stage"><Send size={9} /> Stage</button><button onClick={() => void liveSuggestion(suggestion)} className="flex h-7 items-center gap-1 rounded-md border border-state-live/30 bg-state-live/10 px-2 text-[8px] font-black uppercase text-state-live"><Zap size={9} /> Live</button></div></article>;
            })}
          </div>
        </section>
      </div>
      </div>
    </div>
  );
}
