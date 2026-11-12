import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, MessageSquareText, Mic, RotateCcw, Send, Square, Zap, BookOpen } from "lucide-react";
import { type ScriptureSuggestion, useAiScripture } from "../hooks/useAiScripture";
import { useProgramAudio } from "../hooks/useProgramAudio";
import { useAppStore } from "../store";
import { Button, cn } from "./ui";
import type { DisplayItem } from "../types";

const METER_BARS = Array.from({ length: 24 }, (_, index) => index);

function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function evidenceLabelOf(suggestion: ScriptureSuggestion): string {
  const sources = suggestion.evidenceTypes?.length
    ? suggestion.evidenceTypes
    : [suggestion.detection];
  const labels = sources.map((source) => {
    switch (source) {
      case "reference":
        return "Citation";
      case "quote":
        return "Quotation";
      case "paraphrase":
        return "Theme match";
      case "command":
        return "Voice command";
      default:
        return source;
    }
  });
  if (suggestion.detection === "quote" && suggestion.quoteSupport === "loose" && labels.length === 1) {
    return "Possible quotation";
  }
  return labels.join(" + ");
}

/** Service-facing AI control. Setup, transcripts, and review live in Settings. */
export function AiScriptureTab({ onStage, onLive }: { onStage: (item: DisplayItem) => Promise<boolean> | void; onLive: (item: DisplayItem) => Promise<boolean> | void }) {
  const ai = useAiScripture();
  const programAudio = useProgramAudio();
  const { bibleVersion, setActiveTab, setToast, stagedItem, liveItem } = useAppStore();
  const listening = ["connecting", "running", "listening"].includes(ai.status.state);
  const [now, setNow] = useState(() => Date.now());
  const [followTranscript, setFollowTranscript] = useState(true);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const startedAt = ai.sessionStartedAt ?? ai.status.startedAt ?? null;
  const durationSeconds = startedAt == null
    ? 0
    : Math.max(0, ((listening ? now : (ai.sessionEndedAt ?? now)) - startedAt) / 1000);

  useEffect(() => {
    setNow(Date.now());
    if (!listening) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [listening, ai.sessionStartedAt, ai.status.startedAt]);

  const scrollTranscriptToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const element = transcriptRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (followTranscript) scrollTranscriptToBottom();
  }, [ai.transcript, ai.interim, followTranscript, scrollTranscriptToBottom]);

  const handleTranscriptScroll = () => {
    const element = transcriptRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
    setFollowTranscript(nearBottom);
  };

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

  const clearSession = () => {
    ai.clearSession();
    setFollowTranscript(true);
  };

  const referenceOf = (suggestion: ScriptureSuggestion) => {
    const start = suggestion.passageStart ?? suggestion.verse.verse;
    const end = suggestion.passageEnd ?? start;
    return `${suggestion.verse.book} ${suggestion.verse.chapter}:${start}${end > start ? `–${end}` : ""}`;
  };
  const confidenceOf = (suggestion: ScriptureSuggestion) => Math.round(Math.min(1, Math.max(0, suggestion.confidence)) * 100);
  const confidenceTone = (confidence: number) => confidence >= 90 ? "text-state-success" : confidence >= 75 ? "text-state-stage" : "text-state-warning";
  const confidenceBar = (confidence: number) => confidence >= 90 ? "bg-state-success" : confidence >= 75 ? "bg-state-stage" : "bg-state-warning";
  const verseKey = (verse: { book: string; chapter: number; verse: number }) => `${verse.book}|${verse.chapter}|${verse.verse}`;
  const stagedKey = stagedItem?.type === "Verse" ? verseKey(stagedItem.data) : null;
  const liveKey = liveItem?.type === "Verse" ? verseKey(liveItem.data) : null;
  const finalSegments = ai.transcript.length;
  const finalWords = useMemo(
    () => ai.transcript.reduce((total, segment) => (
      total + segment.text.trim().split(/\s+/).filter(Boolean).length
    ), 0),
    [ai.transcript],
  );

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
    <div className="flex flex-col gap-3">
      <section className="relative overflow-hidden rounded-xl border border-violet-400/25 bg-gradient-to-br from-violet-500/[0.10] via-console-surface to-console-surface p-3.5">
        <div aria-hidden className="pointer-events-none absolute -right-10 -top-20 h-44 w-44 rounded-full bg-violet-500/15 blur-3xl" />
        <div className="relative flex flex-wrap items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-400/10 text-violet-200 ring-1 ring-violet-400/20">
            <Mic size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em]",
                listening
                  ? "border-state-success/35 bg-state-success/10 text-state-success"
                  : "border-console-border bg-console-surface px-2 text-console-text-subtle",
              )}>
                <span className={cn("h-1.5 w-1.5 rounded-full", listening ? "bg-state-success animate-pulse" : "bg-console-text-subtle/60")} />
                {listening ? "Live" : "Idle"}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-console-border bg-console-canvas/55 px-2 py-0.5 text-[10px] font-bold tabular-nums text-console-text-muted" title="Transcription duration">
                <Clock size={10} /> {formatElapsed(durationSeconds)}
              </span>
            </div>
            <p className="mt-1.5 text-[12px] font-bold text-console-text">
              {listening ? "Listening for Scripture references" : finalSegments > 0 ? "Transcript ready for review" : "Ready when your service begins"}
            </p>
            <p className="mt-0.5 truncate text-[10px] font-medium text-console-text-subtle">{ai.status.message}</p>
          </div>
          <button
            onClick={() => void toggleListening()}
            className={cn(
              "flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg px-4 text-[11px] font-black uppercase tracking-wide transition-colors",
              listening
                ? "bg-state-live text-white hover:bg-state-live/85"
                : "bg-violet-600 text-white hover:bg-violet-500",
            )}
          >
            {listening ? <><Square size={12} fill="currentColor" /> Stop</> : <><Mic size={13} /> Start listening</>}
          </button>
        </div>
        <div className="relative mt-3 flex items-center gap-2">
          <div className="flex h-10 flex-1 items-end gap-1 rounded-lg border border-console-border bg-console-canvas/65 px-3 py-2" aria-label={listening ? `Audio input level ${Math.round(ai.audioLevel * 100)}%` : "Audio input idle"}>
            {METER_BARS.map((bar) => {
              const threshold = (bar + 1) / METER_BARS.length;
              const lit = listening && ai.audioLevel >= threshold;
              return <span key={bar} className={`min-w-[3px] flex-1 rounded-sm transition-colors ${lit ? (bar > 20 ? "bg-state-live" : bar > 16 ? "bg-state-warning" : "bg-state-success") : "bg-console-border"}`} style={{ height: `${24 + ((bar * 17) % 64)}%` }} />;
            })}
          </div>
        </div>
        <div className="relative mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] font-medium text-console-text-subtle">
          <span className="flex min-w-0 items-center gap-1.5"><span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", listening ? "bg-state-success" : "bg-console-text-subtle/60")} /><span className="truncate">{programAudio.device ?? "No microphone selected"}</span></span>
          <span className="shrink-0 uppercase tracking-wide">{ai.status.provider}{ai.status.version ? ` · ${ai.status.version}` : ""}</span>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-console-border bg-console-canvas/35">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-console-border bg-console-surface/45 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <MessageSquareText size={13} className="shrink-0 text-violet-300" />
            <h3 className="text-[10px] font-black uppercase tracking-[0.14em] text-console-text-muted">Live transcription</h3>
            <span className="text-[9px] font-bold text-console-text-subtle">{finalSegments} segments · {finalWords} words</span>
          </div>
          <div className="flex items-center gap-2">
            {finalSegments > 0 && <button type="button" onClick={clearSession} className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide text-console-text-subtle hover:text-console-text"><RotateCcw size={10} /> Clear</button>}
            {listening && <span className="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wide text-state-success"><span className="h-1.5 w-1.5 rounded-full bg-state-success animate-pulse" />Listening</span>}
          </div>
        </header>
        <div className="relative">
          <div
            ref={transcriptRef}
            onScroll={handleTranscriptScroll}
            className="max-h-64 min-h-28 overflow-y-auto p-3 text-[12.5px] leading-6 text-console-text custom-scrollbar select-text"
          >
            {ai.transcript.length === 0 && !ai.interim ? (
              <p className="italic text-console-text-subtle">Final transcript text will appear here as the preacher speaks.</p>
            ) : (
              <p className="whitespace-pre-wrap">{ai.transcript.map((segment) => <React.Fragment key={segment.id}>{segment.text} </React.Fragment>)}{ai.interim && <span className="text-console-text-subtle">{ai.interim.text}</span>}</p>
            )}
          </div>
          {!followTranscript && (
            <button
              type="button"
              onClick={() => { setFollowTranscript(true); scrollTranscriptToBottom("smooth"); }}
              className="absolute bottom-2 right-2 rounded-md border border-violet-400/30 bg-console-surface px-2.5 py-1 text-[9px] font-black uppercase tracking-wide text-violet-200 shadow-lg hover:bg-console-surface-strong"
            >
              Jump to latest
            </button>
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-console-border bg-console-canvas/35">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-console-border bg-console-surface/45 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <BookOpen size={13} className="shrink-0 text-violet-300" />
            <h3 className="text-[10px] font-black uppercase tracking-[0.14em] text-console-text-muted">Detected Scripture</h3>
            {ai.suggestions.length > 0 && <span className="text-[9px] font-bold text-console-text-subtle">{ai.suggestions.length} detected · newest first</span>}
          </div>
        </header>
        <div className="max-h-[30rem] space-y-2 overflow-y-auto p-2.5 custom-scrollbar">
          {ai.suggestions.length === 0 ? <p className="p-2 text-[11px] italic leading-relaxed text-console-text-subtle">Detected references and close quotations will appear here.</p> : ai.suggestions.map((suggestion) => {
            const confidence = confidenceOf(suggestion);
            const evidenceLabel = evidenceLabelOf(suggestion);
            const key = verseKey(suggestion.verse);
            const isLive = key === liveKey;
            const isStaged = key === stagedKey;
            return <article
              key={suggestion.id}
              className={cn(
                "relative overflow-hidden rounded-lg border p-3 transition-colors",
                isLive
                  ? "border-state-live/45 bg-state-live/[0.06]"
                  : isStaged
                    ? "border-state-stage/45 bg-state-stage/[0.06]"
                    : "border-console-border bg-console-surface hover:border-violet-400/30",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-black text-console-text">{referenceOf(suggestion)}</span>
                    <span className="rounded border border-console-border bg-console-canvas/60 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-console-text-subtle">{suggestion.verse.version}</span>
                    {isLive ? <span className="rounded border border-state-live/35 bg-state-live/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-state-live">On air</span> : isStaged ? <span className="rounded border border-state-stage/35 bg-state-stage/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-state-stage">Staged</span> : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="rounded bg-violet-400/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-300">{evidenceLabel}</span>
                    {suggestion.detection === "quote" && suggestion.quoteSupport === "loose" && <span className="rounded border border-state-warning/30 bg-state-warning/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-state-warning">Review only</span>}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <span className={`text-sm font-black tabular-nums ${confidenceTone(confidence)}`} title={`Detection confidence: ${confidence}%`}>{confidence}%</span>
                  <p className="text-[8px] font-black uppercase tracking-wider text-console-text-subtle">confidence</p>
                </div>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-console-border" aria-label={`Detection confidence ${confidence}%`}><span className={`block h-full rounded-full ${confidenceBar(confidence)}`} style={{ width: `${confidence}%` }} /></div>
              <p className="mt-2.5 whitespace-pre-wrap rounded-md bg-console-canvas/45 px-2.5 py-2 text-[12px] leading-relaxed text-console-text">{suggestion.verse.text}</p>
              {suggestion.citationConflict ? <p className="mt-1.5 text-[10px] font-medium leading-relaxed text-state-warning">{suggestion.citationConflict}</p> : null}
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <Button variant="stage-outline" size="sm" icon={<Send size={11} />} onClick={() => void stageSuggestion(suggestion)}>Stage</Button>
                <Button variant="live-outline" size="sm" icon={<Zap size={11} />} onClick={() => void liveSuggestion(suggestion)} title="Take this verse live immediately, without reviewing it in preview">Go live</Button>
              </div>
            </article>;
          })}
        </div>
      </section>
    </div>
  );
}
