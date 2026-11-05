import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import type { Verse } from "../types";

export const AI_AUTO_STAGE_CONFIDENCE = 0.9;

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
  detection: "reference" | "quote" | "paraphrase";
  confidence: number;
  evidence: string;
  verse: Verse;
  timestamp: number;
}

export function shouldAutoStageSuggestion(suggestion: ScriptureSuggestion): boolean {
  // Paraphrase confidence is deliberately provisional until it is calibrated
  // against a representative sermon corpus. Keep a frontend safety boundary
  // in addition to the backend's 89% cap.
  return suggestion.detection !== "paraphrase"
    && Number.isFinite(suggestion.confidence)
    && suggestion.confidence >= AI_AUTO_STAGE_CONFIDENCE;
}

interface AiScriptureContextValue {
  status: AiRuntimeStatus;
  transcript: TranscriptSegment[];
  interim: TranscriptSegment | null;
  suggestions: ScriptureSuggestion[];
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
}: {
  children: ReactNode;
  onStageVerse: (verse: Verse) => Promise<boolean>;
}) {
  const [status, setStatus] = useState<AiRuntimeStatus>(STOPPED);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [interim, setInterim] = useState<TranscriptSegment | null>(null);
  const [suggestions, setSuggestions] = useState<ScriptureSuggestion[]>([]);
  const onStageVerseRef = useRef(onStageVerse);
  const autoStagedSuggestionIds = useRef(new Set<string>());

  useEffect(() => {
    onStageVerseRef.current = onStageVerse;
  }, [onStageVerse]);

  useEffect(() => {
    let mounted = true;
    const unlisteners: Array<() => void> = [];

    void invoke<AiRuntimeStatus>("ai_status")
      .then((next) => mounted && setStatus(next))
      .catch(() => undefined);

    void Promise.all([
      listen<AiRuntimeStatus>("ai-scripture-status", (event) => {
        if (mounted) setStatus(event.payload);
      }),
      listen<TranscriptSegment>("ai-scripture-transcript", (event) => {
        if (!mounted) return;
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
        setSuggestions((current) => [suggestion, ...current].slice(0, 30));
        if (!shouldAutoStageSuggestion(suggestion) || autoStagedSuggestionIds.current.has(suggestion.id)) return;

        // Event registration can briefly overlap during development remounts.
        // Track IDs before awaiting so one suggestion can never stage twice.
        autoStagedSuggestionIds.current.add(suggestion.id);
        if (autoStagedSuggestionIds.current.size > 100) {
          const oldest = autoStagedSuggestionIds.current.values().next().value;
          if (oldest) autoStagedSuggestionIds.current.delete(oldest);
        }

        void onStageVerseRef.current(suggestion.verse)
          .then((staged) => {
            const reference = `${suggestion.verse.book} ${suggestion.verse.chapter}:${suggestion.verse.verse}`;
            if (staged) {
              useAppStore.getState().setToast(`${reference} auto-staged at ${Math.round(suggestion.confidence * 100)}% confidence. Review it before Go Live.`);
            } else {
              useAppStore.getState().setToast(`${reference} could not be auto-staged. Use Stage to retry.`);
            }
          })
          .catch((error) => {
            useAppStore.getState().setToast(`AI Scripture could not auto-stage: ${error}`);
          });
      }),
    ]).then((next) => {
      if (mounted) unlisteners.push(...next);
      else next.forEach((unlisten) => unlisten());
    });

    return () => {
      mounted = false;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  const start = useCallback(async (audioDevice: string, version: string) => {
    const next = await invoke<AiRuntimeStatus>("ai_start", { audioDevice, version });
    setStatus(next);
  }, []);

  const stop = useCallback(async () => {
    await invoke("ai_stop");
    setStatus(STOPPED);
    setInterim(null);
  }, []);

  const clearSession = useCallback(() => {
    setTranscript([]);
    setInterim(null);
    setSuggestions([]);
    autoStagedSuggestionIds.current.clear();
  }, []);

  const value = useMemo<AiScriptureContextValue>(
    () => ({ status, transcript, interim, suggestions, start, stop, clearSession }),
    [status, transcript, interim, suggestions, start, stop, clearSession],
  );

  return <AiScriptureContext.Provider value={value}>{children}</AiScriptureContext.Provider>;
}
