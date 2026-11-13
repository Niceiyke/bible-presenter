import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, MessageSquareText, Mic, RotateCcw, Send, Square, Zap, BookOpen, ThumbsUp, ThumbsDown, Quote, EyeOff } from "lucide-react";
import { type ScriptureSuggestion, useAiScripture } from "../hooks/useAiScripture";
import { useProgramAudio } from "../hooks/useProgramAudio";
import { useAppStore } from "../store";
import { recordScriptureFeedback, type ScriptureFeedbackKind } from "../ai/scriptureFeedback";
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
  const [hiddenSuggestionIds, setHiddenSuggestionIds] = useState<Set<string>>(() => new Set());
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const suggestionsRef = useRef<HTMLDivElement | null>(null);
  const visibleSuggestions = useMemo(
    () => ai.suggestions.filter((suggestion) => !hiddenSuggestionIds.has(suggestion.id)),
    [ai.suggestions, hiddenSuggestionIds],
  );

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

  // New suggestions are prepended. Keep the newest card fully in view instead
  // of leaving the list scrolled into the middle of the previous top card.
  useEffect(() => {
    suggestionsRef.current?.scrollTo({ top: 0 });
  }, [ai.suggestions]);

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
    setHiddenSuggestionIds(new Set());
    setFollowTranscript(true);
  };

  const referenceOf = (suggestion: ScriptureSuggestion) => {
    const start = suggestion.passageStart ?? suggestion.verse.verse;
    const end = suggestion.passageEnd ?? start;
    return `${suggestion.verse.book} ${suggestion.verse.chapter}:${start}${end > start ? `–${end}` : ""}`;
  };
  const confidenceOf = (suggestion: ScriptureSuggestion) => Math.round(Math.min(1, Math.max(0, suggestion.confidence)) * 100);
  const confidenceTone = (confidence: number) => confidence >= 90 ? "text-state-success" : confidence >= 75 ? "text-state-stage" : "text-state-warning";
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
    <div className="flex h-full min-h-0 flex-col gap-3">
      <section className="shrink-0 overflow-hidden rounded-lg border border-violet-400/20 bg-gradient-to-r from-violet-500/[0.08] to-console-surface">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-2.5 py-1.5">
          <span className={cn(
            "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-1.5 text-[8px] font-black uppercase tracking-[0.12em]",
            listening
              ? "border-state-success/35 bg-state-success/10 text-state-success"
              : "border-console-border bg-console-surface text-console-text-subtle",
          )}>
            <span className={cn("h-1.5 w-1.5 rounded-full", listening ? "bg-state-success animate-pulse" : "bg-console-text-subtle/60")} />
            {listening ? "Live" : "Idle"}
          </span>
          <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-console-border bg-console-canvas/55 px-1.5 text-[9px] font-bold tabular-nums text-console-text-muted" title="Transcription duration">
            <Clock size={9} /> {formatElapsed(durationSeconds)}
          </span>
          <span className="hidden min-w-0 max-w-48 flex-1 items-center gap-1 text-[9px] font-medium text-console-text-subtle md:flex">
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", listening ? "bg-state-success" : "bg-console-text-subtle/60")} />
            <span className="truncate">{programAudio.device ?? "No microphone selected"}</span>
          </span>
          <div className="hidden h-5 w-24 items-end gap-[2px] rounded border border-console-border bg-console-canvas/65 px-1.5 py-1 sm:flex" aria-label={listening ? `Audio input level ${Math.round(ai.audioLevel * 100)}%` : "Audio input idle"}>
            {METER_BARS.map((bar) => {
              const threshold = (bar + 1) / METER_BARS.length;
              const lit = listening && ai.audioLevel >= threshold;
              return <span key={bar} className={`min-w-[1px] flex-1 rounded-sm transition-colors ${lit ? (bar > 20 ? "bg-state-live" : bar > 16 ? "bg-state-warning" : "bg-state-success") : "bg-console-border"}`} style={{ height: `${24 + ((bar * 17) % 64)}%` }} />;
            })}
          </div>
          <button
            onClick={() => void toggleListening()}
            title={listening ? "Stop AI Scripture listening" : "Start AI Scripture listening"}
            className={cn(
              "ml-auto flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[10px] font-black uppercase tracking-wide transition-colors",
              listening
                ? "bg-state-live text-white hover:bg-state-live/85"
                : "bg-violet-600 text-white hover:bg-violet-500",
            )}
          >
            {listening ? <><Square size={10} fill="currentColor" /> Stop</> : <><Mic size={11} /> Start</>}
          </button>
        </div>
      </section>

      <div className="grid min-h-0 flex-1 items-stretch gap-3 lg:grid-cols-2">
      <section className="flex min-h-64 min-w-0 flex-col overflow-hidden rounded-lg border border-console-border bg-console-canvas/35">
        <header className="flex items-center justify-between gap-1.5 border-b border-console-border bg-console-surface/45 px-2.5 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <MessageSquareText size={11} className="shrink-0 text-violet-300" />
            <h3 className="shrink-0 text-[9px] font-black uppercase tracking-[0.12em] text-console-text-muted">Live transcription</h3>
            <span className="truncate whitespace-nowrap text-[8px] font-bold text-console-text-subtle">{finalSegments} · {finalWords}w</span>
          </div>
          {finalSegments > 0 && <button type="button" onClick={clearSession} title="Clear transcript and detected Scripture" className="shrink-0 rounded p-0.5 text-console-text-subtle hover:bg-console-surface-strong hover:text-console-text"><RotateCcw size={10} /></button>}
        </header>
        <div className="relative min-h-0 flex-1">
          <div
            ref={transcriptRef}
            onScroll={handleTranscriptScroll}
            className="h-full overflow-y-auto p-2.5 text-[12px] leading-5 text-console-text custom-scrollbar select-text"
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

      <section className="flex min-h-64 min-w-0 flex-col overflow-hidden rounded-lg border border-console-border bg-console-canvas/35">
        <header className="flex items-center justify-between gap-1.5 border-b border-console-border bg-console-surface/45 px-2.5 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <BookOpen size={11} className="shrink-0 text-violet-300" />
            <h3 className="text-[9px] font-black uppercase tracking-[0.12em] text-console-text-muted">Detected Scripture</h3>
            {visibleSuggestions.length > 0 && <span className="text-[8px] font-bold text-console-text-subtle">{visibleSuggestions.length} found</span>}
          </div>
        </header>
        <div ref={suggestionsRef} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-1.5 custom-scrollbar">
          {visibleSuggestions.length === 0 ? <p className="p-2 text-[11px] italic leading-relaxed text-console-text-subtle">Detected references and close quotations will appear here.</p> : visibleSuggestions.map((suggestion) => {
            const confidence = confidenceOf(suggestion);
            const evidenceLabel = evidenceLabelOf(suggestion);
            const key = verseKey(suggestion.verse);
            const isLive = key === liveKey;
            const isStaged = key === stagedKey;
            return <article
              key={suggestion.id}
              className={cn(
                "relative overflow-hidden rounded-md border px-2.5 py-2 transition-colors",
                isLive
                  ? "border-state-live/45 bg-state-live/[0.06]"
                  : isStaged
                    ? "border-state-stage/45 bg-state-stage/[0.06]"
                    : "border-console-border bg-console-surface hover:border-violet-400/30",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                  <span className="text-[12px] font-black text-console-text">{referenceOf(suggestion)}</span>
                  <span className="rounded border border-console-border bg-console-canvas/60 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-console-text-subtle">{suggestion.verse.version}</span>
                  {isLive ? <span className="rounded border border-state-live/35 bg-state-live/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-state-live">On air</span> : isStaged ? <span className="rounded border border-state-stage/35 bg-state-stage/10 px-1 py-px text-[8px] font-black uppercase tracking-wide text-state-stage">Staged</span> : null}
                  <span className="rounded bg-violet-400/10 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-violet-300">{evidenceLabel}</span>
                  {suggestion.detection === "quote" && suggestion.quoteSupport === "loose" && <span className="rounded border border-state-warning/30 bg-state-warning/10 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-state-warning">Review only</span>}
                </div>
                <span className={cn("shrink-0 text-[12px] font-black tabular-nums leading-4", confidenceTone(confidence))} title={`Detection confidence: ${confidence}%`}>{confidence}%</span>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-[11.5px] leading-[1.5] text-console-text">{suggestion.verse.text}</p>
              {suggestion.citationConflict ? <p className="mt-1 text-[10px] font-medium leading-snug text-state-warning">{suggestion.citationConflict}</p> : null}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Button variant="stage-outline" size="xs" icon={<Send size={10} />} onClick={() => void stageSuggestion(suggestion)}>Stage</Button>
                <Button variant="live-outline" size="xs" icon={<Zap size={10} />} onClick={() => void liveSuggestion(suggestion)} title="Take this verse live immediately, without reviewing it in preview">Go live</Button>
                <SuggestionFeedback
                  suggestion={suggestion}
                  onSuppress={() => setHiddenSuggestionIds((current) => new Set(current).add(suggestion.id))}
                />
              </div>
            </article>;
          })}
        </div>
      </section>
      </div>
    </div>
  );
}

function SuggestionFeedback({
  suggestion,
  onSuppress,
}: {
  suggestion: ScriptureSuggestion;
  onSuppress: () => void;
}) {
  const [given, setGiven] = useState<ScriptureFeedbackKind | null>(null);
  const offersNotQuote = suggestion.detection === "quote" || suggestion.evidenceTypes?.includes("quote");
  const buttonClass = (active: boolean) => cn(
    "flex h-6 w-6 items-center justify-center rounded border transition-colors",
    active
      ? "border-tool-design/50 bg-tool-design/15 text-tool-design"
      : "border-console-border text-console-text-subtle hover:text-console-text",
  );
  const give = (kind: ScriptureFeedbackKind) => {
    recordScriptureFeedback(kind, suggestion);
    setGiven(kind);
    if (kind === "suppress") onSuppress();
  };
  return (
    <div className="ml-auto flex items-center gap-1 border-l border-console-border pl-1.5" role="group" aria-label="Suggestion feedback">
      <button type="button" onClick={() => give("correct")} aria-label="Correct verse" title="Correct verse" className={buttonClass(given === "correct")}>
        <ThumbsUp size={10} />
      </button>
      <button type="button" onClick={() => give("wrong")} aria-label="Wrong verse" title="Wrong verse" className={buttonClass(given === "wrong")}>
        <ThumbsDown size={10} />
      </button>
      {offersNotQuote && (
        <button type="button" onClick={() => give("not_quote")} aria-label="Not a quotation" title="Not a quotation" className={buttonClass(given === "not_quote")}>
          <Quote size={10} />
        </button>
      )}
      <button type="button" onClick={() => give("suppress")} aria-label="Do not suggest again" title="Do not suggest again" className={buttonClass(given === "suppress")}>
        <EyeOff size={10} />
      </button>
    </div>
  );
}
