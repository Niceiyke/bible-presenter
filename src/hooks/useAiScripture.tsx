import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Verse } from "../types";

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
  detection: "reference" | "quote";
  confidence: number;
  evidence: string;
  verse: Verse;
  timestamp: number;
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

export function AiScriptureProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AiRuntimeStatus>(STOPPED);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [interim, setInterim] = useState<TranscriptSegment | null>(null);
  const [suggestions, setSuggestions] = useState<ScriptureSuggestion[]>([]);

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
        if (mounted) setSuggestions((current) => [event.payload, ...current].slice(0, 30));
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
  }, []);

  const value = useMemo<AiScriptureContextValue>(
    () => ({ status, transcript, interim, suggestions, start, stop, clearSession }),
    [status, transcript, interim, suggestions, start, stop, clearSession],
  );

  return <AiScriptureContext.Provider value={value}>{children}</AiScriptureContext.Provider>;
}
