import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import type { PresentationSettings, Verse } from "../types";
import {
  addLatencySample,
  clearSavedPerformanceAccumulator,
  createPerformanceAccumulator,
  loadPerformanceAccumulator,
  savePerformanceAccumulator,
  snapshotPerformance,
  type AiScripturePerformance,
  type PerformanceAccumulator,
} from "../ai/scripturePerformance";

export const AI_AUTO_STAGE_CONFIDENCE = 0.9;
/** Direct references are deterministic enough to act on the backend's interim 89% result. */
export const AI_INTERIM_REFERENCE_CONFIDENCE = 0.89;
const AUTO_ACTION_UPGRADE_DEDUP_MS = 8_000;
export type AiProvider = "deepgram" | "assemblyai";
export type AiListeningMode = "service" | "operator";

export interface AiRuntimeStatus {
  state: "stopped" | "connecting" | "running" | "listening" | "error";
  provider: string;
  audioDevice: string | null;
  version: string | null;
  message: string;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  isFinal: boolean;
  confidence: number;
  timestamp: number;
}

export interface ScriptureSuggestion {
  id: string;
  detection: "reference" | "quote" | "paraphrase" | "command";
  confidence: number;
  evidence: string;
  verse: Verse;
  timestamp: number;
  /** ASR update time used for this verified candidate; no transcript text is retained in metrics. */
  sourceTranscriptTimestamp?: number;
  groupId?: string;
  rank?: number;
  passageStart?: number;
  passageEnd?: number;
  similarity?: number;
  margin?: number;
}

export interface AiVoiceCommandEvent {
  command: "version" | "navigation";
  message: string;
  version: string | null;
  reference: string | null;
  timestamp: number;
}

interface ObservedSuggestion {
  suggestion: ScriptureSuggestion;
  detectedAt: number;
  stageRecorded: boolean;
  liveRecorded: boolean;
  autoLiveRequested: boolean;
}

function verseKey(verse: Verse): string {
  return `${verse.book}:${verse.chapter}:${verse.verse}:${verse.version}`;
}

export function shouldAutoStageSuggestion(suggestion: ScriptureSuggestion): boolean {
  // Paraphrase confidence is deliberately provisional until it is calibrated
  // against a representative sermon corpus. Keep a frontend safety boundary
  // in addition to the backend's 89% cap.
  if (!Number.isFinite(suggestion.confidence)) return false;
  if (suggestion.detection === "reference") {
    return suggestion.confidence >= AI_INTERIM_REFERENCE_CONFIDENCE;
  }
  return suggestion.detection === "quote" && suggestion.confidence >= AI_AUTO_STAGE_CONFIDENCE;
}

/**
 * Auto Live is deliberately a second, explicit opt-in beyond auto-staging.
   * Direct references can act on their deterministic interim threshold, while
   * quotations retain their final/high-confidence eligibility. Paraphrases are only allowed for the confirmed best candidate
 * (rank 1), never its alternative cards. Voice command cards are final-turn,
 * locally verified Bible rows.
 */
export function shouldAutoLiveSuggestion(
  suggestion: ScriptureSuggestion,
  settings: PresentationSettings,
): boolean {
  if (!settings.ai_scripture_auto_live) return false;
  switch (suggestion.detection) {
    case "reference":
      return settings.ai_scripture_auto_live_references === true
        && shouldAutoStageSuggestion(suggestion);
    case "quote":
      return settings.ai_scripture_auto_live_quotes === true
        && shouldAutoStageSuggestion(suggestion);
    case "paraphrase":
      return settings.ai_scripture_auto_live_paraphrases === true
        && suggestion.rank === 1;
    case "command":
      return settings.ai_scripture_auto_live_voice_commands === true;
  }
}

interface AiScriptureContextValue {
  status: AiRuntimeStatus;
  provider: AiProvider;
  setProvider: (provider: AiProvider) => void;
  mode: AiListeningMode;
  setMode: (mode: AiListeningMode) => void;
  transcript: TranscriptSegment[];
  interim: TranscriptSegment | null;
  suggestions: ScriptureSuggestion[];
  /** RMS-normalized level from the active transcription input, from 0 to 1. */
  audioLevel: number;
  lastCommand: AiVoiceCommandEvent | null;
  performance: AiScripturePerformance;
  clearPerformance: () => void;
  /** Records a successful or failed operator-initiated Stage from a suggestion card. */
  recordManualStage: (suggestion: ScriptureSuggestion, staged: boolean) => void;
  start: (audioDevice: string, version: string) => Promise<void>;
  stop: () => Promise<void>;
  clearSession: () => void;
}

const STOPPED: AiRuntimeStatus = {
  state: "stopped",
  provider: "deepgram",
  audioDevice: null,
  version: null,
  message: "AI Scripture is stopped.",
};

const AiScriptureContext = createContext<AiScriptureContextValue | null>(null);

export function useAiScripture(): AiScriptureContextValue {
  const context = useContext(AiScriptureContext);
  if (!context) throw new Error("useAiScripture must be used within AiScriptureProvider");
  return context;
}

export function AiScriptureProvider({
  children,
  onStageVerse,
  onSendLiveVerse,
}: {
  children: ReactNode;
  onStageVerse: (verse: Verse) => Promise<boolean>;
  /** Optional only for isolated previews/tests; the operator app always supplies it. */
  onSendLiveVerse?: (verse: Verse) => Promise<boolean>;
}) {
  const [status, setStatus] = useState<AiRuntimeStatus>(STOPPED);
  const [provider, setProviderState] = useState<AiProvider>(() => (
    localStorage.getItem("pref_aiProvider") === "assemblyai" ? "assemblyai" : "deepgram"
  ));
  const [mode, setModeState] = useState<AiListeningMode>(() => (
    localStorage.getItem("pref_aiListeningMode") === "operator" ? "operator" : "service"
  ));
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [interim, setInterim] = useState<TranscriptSegment | null>(null);
  const [suggestions, setSuggestions] = useState<ScriptureSuggestion[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  const [lastCommand, setLastCommand] = useState<AiVoiceCommandEvent | null>(null);
  const metricsRef = useRef<PerformanceAccumulator>(loadPerformanceAccumulator());
  const [performance, setPerformance] = useState<AiScripturePerformance>(() => snapshotPerformance(metricsRef.current));
  const observedSuggestionsRef = useRef(new Map<string, ObservedSuggestion>());
  const onStageVerseRef = useRef(onStageVerse);
  const onSendLiveVerseRef = useRef(onSendLiveVerse);
  const autoHandledSuggestionIds = useRef(new Set<string>());
  const autoHandledCanonicalActions = useRef(new Map<string, number>());
  const modeRef = useRef(mode);
  const operatorStopRequestedRef = useRef(false);

  const updatePerformance = useCallback((update: (metrics: PerformanceAccumulator) => void) => {
    const metrics = metricsRef.current;
    update(metrics);
    metrics.lastUpdatedAt = Date.now();
    savePerformanceAccumulator(metrics);
    setPerformance(snapshotPerformance(metrics));
  }, []);

  const registerSuggestion = useCallback((suggestion: ScriptureSuggestion) => {
    const receivedAt = Date.now();
    observedSuggestionsRef.current.set(suggestion.id, {
      suggestion,
      detectedAt: suggestion.timestamp,
      stageRecorded: false,
      liveRecorded: false,
      autoLiveRequested: false,
    });
    if (observedSuggestionsRef.current.size > 500) {
      const oldest = observedSuggestionsRef.current.keys().next().value;
      if (oldest) observedSuggestionsRef.current.delete(oldest);
    }
    updatePerformance((metrics) => {
      metrics.suggestions += 1;
      metrics.suggestionsByDetection[suggestion.detection] += 1;
      if (suggestion.sourceTranscriptTimestamp != null) {
        const latency = suggestion.timestamp - suggestion.sourceTranscriptTimestamp;
        addLatencySample(metrics.asrUpdateToDetectionMs, latency);
        addLatencySample(metrics.asrUpdateToDetectionByDetection[suggestion.detection], latency);
      }
      // Backend detection and the desktop UI share the same machine clock.
      // This is dispatch-to-operator latency, not audio/speech duration.
      addLatencySample(metrics.detectionToOperatorMs, receivedAt - suggestion.timestamp);
    });
  }, [updatePerformance]);

  const recordStage = useCallback((suggestion: ScriptureSuggestion, staged: boolean, automatic: boolean) => {
    const observed = observedSuggestionsRef.current.get(suggestion.id);
    if (!staged) {
      if (automatic) updatePerformance((metrics) => { metrics.failedAutoStages += 1; });
      return;
    }
    if (observed?.stageRecorded) return;
    if (observed) observed.stageRecorded = true;
    updatePerformance((metrics) => {
      metrics.staged += 1;
      if (automatic) metrics.autoStaged += 1;
      addLatencySample(metrics.detectionToStageMs, Date.now() - (observed?.detectedAt ?? suggestion.timestamp));
    });
  }, [updatePerformance]);

  const recordManualStage = useCallback((suggestion: ScriptureSuggestion, staged: boolean) => {
    recordStage(suggestion, staged, false);
  }, [recordStage]);

  const clearPerformance = useCallback(() => {
    metricsRef.current = createPerformanceAccumulator();
    observedSuggestionsRef.current.clear();
    clearSavedPerformanceAccumulator();
    setPerformance(snapshotPerformance(metricsRef.current));
  }, []);

  const setProvider = useCallback((next: AiProvider) => {
    setProviderState(next);
    localStorage.setItem("pref_aiProvider", next);
  }, []);

  const setMode = useCallback((next: AiListeningMode) => {
    setModeState(next);
    modeRef.current = next;
    localStorage.setItem("pref_aiListeningMode", next);
  }, []);

  const stop = useCallback(async () => {
    await invoke("ai_stop");
    setStatus(STOPPED);
    setInterim(null);
    setAudioLevel(0);
  }, []);

  const stopOperatorAfterRecognition = useCallback(() => {
    if (modeRef.current !== "operator" || operatorStopRequestedRef.current) return;
    operatorStopRequestedRef.current = true;
    void stop().catch((error) => {
      operatorStopRequestedRef.current = false;
      useAppStore.getState().setToast(`AI Scripture could not stop: ${error}`);
    });
  }, [stop]);

  useEffect(() => {
    onStageVerseRef.current = onStageVerse;
  }, [onStageVerse]);

  useEffect(() => {
    onSendLiveVerseRef.current = onSendLiveVerse;
  }, [onSendLiveVerse]);

  useEffect(() => {
    let mounted = true;
    const unlisteners: Array<() => void> = [];

    void invoke<AiRuntimeStatus>("ai_status")
      .then((next) => mounted && setStatus(next))
      .catch(() => undefined);

    void Promise.all([
      listen<AiRuntimeStatus>("ai-scripture-status", (event) => {
        if (!mounted) return;
        setStatus(event.payload);
        if (!["connecting", "running", "listening"].includes(event.payload.state)) setAudioLevel(0);
      }),
      listen<{ level: number }>("ai-scripture-audio-level", (event) => {
        if (mounted) setAudioLevel(Math.max(0, Math.min(1, event.payload.level || 0)));
      }),
      listen<TranscriptSegment>("ai-scripture-transcript", (event) => {
        if (!mounted) return;
        updatePerformance((metrics) => {
          if (event.payload.isFinal) metrics.finalTranscriptSegments += 1;
          else metrics.interimTranscriptUpdates += 1;
        });
        if (event.payload.isFinal) {
          setInterim(null);
          setTranscript((current) => [...current, event.payload].slice(-100));
        } else {
          setInterim(event.payload);
        }
      }),
      listen<ScriptureSuggestion>("ai-scripture-suggestion", (event) => {
        if (!mounted) return;
        const suggestion = event.payload;
        registerSuggestion(suggestion);
        // AssemblyAI can surface a manual interim match before its formatted
        // final turn. Replace the same canonical card instead of showing an
        // interim/final duplicate; different detection paths remain distinct.
        setSuggestions((current) => [
          suggestion,
          ...current.filter((existing) => !(
            existing.detection === suggestion.detection
            && existing.verse.book === suggestion.verse.book
            && existing.verse.chapter === suggestion.verse.chapter
            && existing.verse.verse === suggestion.verse.verse
          )),
        ].slice(0, 30));
        const settings = useAppStore.getState().settings;
        const autoLive = shouldAutoLiveSuggestion(suggestion, settings) && Boolean(onSendLiveVerseRef.current);
        const autoStage = !autoLive && shouldAutoStageSuggestion(suggestion);
        // Operator mode is command-focused: a verified local Scripture row is
        // enough to finish the short listening session. It never stops merely
        // on raw transcript text or speculative paraphrase retrieval.
        if (suggestion.detection !== "paraphrase") stopOperatorAfterRecognition();
        if ((!autoLive && !autoStage) || autoHandledSuggestionIds.current.has(suggestion.id)) return;

        // A direct reference is deliberately emitted once from interim ASR and
        // again when that turn finalizes. Act on the interim result, then hold
        // the final upgrade long enough to avoid staging/sending the same
        // Scripture twice. A later spoken mention remains eligible.
        const actionKey = `${autoLive ? "live" : "stage"}:${suggestion.detection}:${verseKey(suggestion.verse)}`;
        const now = suggestion.timestamp || Date.now();
        for (const [key, handledAt] of autoHandledCanonicalActions.current) {
          if (now - handledAt > AUTO_ACTION_UPGRADE_DEDUP_MS) autoHandledCanonicalActions.current.delete(key);
        }
        if (autoHandledCanonicalActions.current.has(actionKey)) return;

        // Event registration can briefly overlap during development remounts.
        // Track IDs before awaiting so one suggestion can never be sent twice.
        autoHandledSuggestionIds.current.add(suggestion.id);
        autoHandledCanonicalActions.current.set(actionKey, now);
        if (autoHandledSuggestionIds.current.size > 100) {
          const oldest = autoHandledSuggestionIds.current.values().next().value;
          if (oldest) autoHandledSuggestionIds.current.delete(oldest);
        }

        // Start before invoking the asynchronous action. In particular, this
        // includes any initial verse-split work so the acknowledgement timing
        // is comparable with detected-to-live timing.
        const actionStartedAt = Date.now();
        const action = autoLive && onSendLiveVerseRef.current
          ? onSendLiveVerseRef.current(suggestion.verse)
          : onStageVerseRef.current(suggestion.verse);
        const observed = observedSuggestionsRef.current.get(suggestion.id);
        if (autoLive && observed) observed.autoLiveRequested = true;
        void action
          .then((staged) => {
            if (autoLive) {
              updatePerformance((metrics) => {
                if (!staged) metrics.failedAutoLive += 1;
                else addLatencySample(metrics.liveCommandMs, Date.now() - actionStartedAt);
              });
            } else {
              recordStage(suggestion, staged, true);
            }
            const reference = `${suggestion.verse.book} ${suggestion.verse.chapter}:${suggestion.verse.verse}`;
            if (autoLive && staged) {
              useAppStore.getState().setToast(`${reference} went live automatically via AI Scripture. Review Auto Live settings before continuing.`);
            } else if (staged) {
              useAppStore.getState().setToast(`${reference} auto-staged at ${Math.round(suggestion.confidence * 100)}% confidence. Review it before Go Live.`);
            } else {
              useAppStore.getState().setToast(`${reference} could not be auto-${autoLive ? "sent live" : "staged"}. Use Stage to retry.`);
            }
          })
          .catch((error) => {
            updatePerformance((metrics) => {
              if (autoLive) metrics.failedAutoLive += 1;
              else metrics.failedAutoStages += 1;
            });
            useAppStore.getState().setToast(`AI Scripture could not auto-${autoLive ? "send live" : "stage"}: ${error}`);
          });
      }),
      listen<AiVoiceCommandEvent>("ai-scripture-command", (event) => {
        if (!mounted) return;
        setLastCommand(event.payload);
        if (event.payload.version) {
          useAppStore.getState().setBibleVersion(event.payload.version);
        }
        useAppStore.getState().setToast(event.payload.message);
        stopOperatorAfterRecognition();
      }),
    ]).then((next) => {
      if (mounted) unlisteners.push(...next);
      else next.forEach((unlisten) => unlisten());
    });

    return () => {
      mounted = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [recordStage, registerSuggestion, stopOperatorAfterRecognition, updatePerformance]);

  useEffect(() => useAppStore.subscribe((state, previous) => {
    if (state.liveItem === previous.liveItem || state.liveItem?.type !== "Verse") return;
    const key = verseKey(state.liveItem.data);
    const observed = [...observedSuggestionsRef.current.values()]
      .reverse()
      .find((entry) => !entry.liveRecorded && verseKey(entry.suggestion.verse) === key);
    if (!observed) return;
    observed.liveRecorded = true;
    updatePerformance((metrics) => {
      metrics.live += 1;
      if (observed.autoLiveRequested) metrics.autoLive += 1;
      addLatencySample(metrics.detectionToLiveMs, Date.now() - observed.detectedAt);
    });
  }), [updatePerformance]);

  const start = useCallback(async (audioDevice: string, version: string) => {
    // Operator mode intentionally starts/stops for individual calls, while a
    // Service session may also be stopped and resumed. Keep either mode's
    // same-provider measurement set across those starts so qualification data
    // accumulates until the operator presses Reset.
    const currentMetrics = metricsRef.current;
    if (
      currentMetrics.sessionStartedAt == null
      || currentMetrics.provider !== provider
      || currentMetrics.mode !== modeRef.current
    ) {
      metricsRef.current = createPerformanceAccumulator();
      metricsRef.current.sessionStartedAt = Date.now();
      metricsRef.current.provider = provider;
      metricsRef.current.mode = modeRef.current;
    }
    observedSuggestionsRef.current.clear();
    autoHandledCanonicalActions.current.clear();
    operatorStopRequestedRef.current = false;
    savePerformanceAccumulator(metricsRef.current);
    setPerformance(snapshotPerformance(metricsRef.current));
    const next = await invoke<AiRuntimeStatus>("ai_start", {
      audioDevice,
      version,
      provider,
      mode: modeRef.current,
    });
    setStatus(next);
  }, [provider]);

  const clearSession = useCallback(() => {
    setTranscript([]);
    setInterim(null);
    setSuggestions([]);
    setLastCommand(null);
    autoHandledSuggestionIds.current.clear();
    autoHandledCanonicalActions.current.clear();
  }, []);

  const value = useMemo<AiScriptureContextValue>(
    () => ({ status, provider, setProvider, mode, setMode, transcript, interim, suggestions, audioLevel, lastCommand, performance, clearPerformance, recordManualStage, start, stop, clearSession }),
    [status, provider, setProvider, mode, setMode, transcript, interim, suggestions, audioLevel, lastCommand, performance, clearPerformance, recordManualStage, start, stop, clearSession],
  );

  return <AiScriptureContext.Provider value={value}>{children}</AiScriptureContext.Provider>;
}
