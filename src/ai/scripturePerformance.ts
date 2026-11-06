import type { AiProvider, ScriptureSuggestion } from "../hooks/useAiScripture";

export type AiSuggestionDetection = ScriptureSuggestion["detection"];

export interface LatencySummary {
  count: number;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface AiScripturePerformance {
  sessionStartedAt: number | null;
  provider: AiProvider | null;
  mode: "service" | "operator" | null;
  finalTranscriptSegments: number;
  interimTranscriptUpdates: number;
  suggestions: number;
  suggestionsByDetection: Record<AiSuggestionDetection, number>;
  staged: number;
  live: number;
  autoStaged: number;
  autoLive: number;
  failedAutoStages: number;
  failedAutoLive: number;
  asrUpdateToDetectionMs: LatencySummary;
  asrUpdateToDetectionByDetection: Record<AiSuggestionDetection, LatencySummary>;
  detectionToOperatorMs: LatencySummary;
  detectionToStageMs: LatencySummary;
  detectionToLiveMs: LatencySummary;
  liveCommandMs: LatencySummary;
  lastUpdatedAt: number | null;
}

export interface PerformanceAccumulator {
  sessionStartedAt: number | null;
  provider: AiProvider | null;
  mode: "service" | "operator" | null;
  finalTranscriptSegments: number;
  interimTranscriptUpdates: number;
  suggestions: number;
  suggestionsByDetection: Record<AiSuggestionDetection, number>;
  staged: number;
  live: number;
  autoStaged: number;
  autoLive: number;
  failedAutoStages: number;
  failedAutoLive: number;
  asrUpdateToDetectionMs: number[];
  asrUpdateToDetectionByDetection: Record<AiSuggestionDetection, number[]>;
  detectionToOperatorMs: number[];
  detectionToStageMs: number[];
  detectionToLiveMs: number[];
  liveCommandMs: number[];
  lastUpdatedAt: number | null;
}

const MAX_SAMPLES = 500;
const PERFORMANCE_STORAGE_KEY = "pref_aiScripturePerformanceV1";

export function createPerformanceAccumulator(): PerformanceAccumulator {
  return {
    sessionStartedAt: null,
    provider: null,
    mode: null,
    finalTranscriptSegments: 0,
    interimTranscriptUpdates: 0,
    suggestions: 0,
    suggestionsByDetection: { reference: 0, quote: 0, paraphrase: 0, command: 0 },
    staged: 0,
    live: 0,
    autoStaged: 0,
    autoLive: 0,
    failedAutoStages: 0,
    failedAutoLive: 0,
    asrUpdateToDetectionMs: [],
    asrUpdateToDetectionByDetection: { reference: [], quote: [], paraphrase: [], command: [] },
    detectionToOperatorMs: [],
    detectionToStageMs: [],
    detectionToLiveMs: [],
    liveCommandMs: [],
    lastUpdatedAt: null,
  };
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function latencySamples(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((sample): sample is number => typeof sample === "number" && Number.isFinite(sample) && sample >= 0)
    .slice(-MAX_SAMPLES)
    .map(Math.round);
}

/**
 * Restores only local aggregate counters/timings. It deliberately excludes
 * audio, transcript text, Scripture references, suggestions, and credentials.
 */
export function loadPerformanceAccumulator(): PerformanceAccumulator {
  const empty = createPerformanceAccumulator();
  try {
    const raw = localStorage.getItem(PERFORMANCE_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<PerformanceAccumulator>;
    if (!parsed || typeof parsed !== "object") return empty;
    const byDetection: Partial<Record<AiSuggestionDetection, unknown>> = parsed.asrUpdateToDetectionByDetection ?? {};
    return {
      ...empty,
      sessionStartedAt: finiteNumber(parsed.sessionStartedAt, 0) || null,
      provider: parsed.provider === "assemblyai" || parsed.provider === "deepgram" ? parsed.provider : null,
      mode: parsed.mode === "operator" || parsed.mode === "service" ? parsed.mode : null,
      finalTranscriptSegments: finiteNumber(parsed.finalTranscriptSegments),
      interimTranscriptUpdates: finiteNumber(parsed.interimTranscriptUpdates),
      suggestions: finiteNumber(parsed.suggestions),
      suggestionsByDetection: {
        reference: finiteNumber(parsed.suggestionsByDetection?.reference),
        quote: finiteNumber(parsed.suggestionsByDetection?.quote),
        paraphrase: finiteNumber(parsed.suggestionsByDetection?.paraphrase),
        command: finiteNumber(parsed.suggestionsByDetection?.command),
      },
      staged: finiteNumber(parsed.staged),
      live: finiteNumber(parsed.live),
      autoStaged: finiteNumber(parsed.autoStaged),
      autoLive: finiteNumber(parsed.autoLive),
      failedAutoStages: finiteNumber(parsed.failedAutoStages),
      failedAutoLive: finiteNumber(parsed.failedAutoLive),
      asrUpdateToDetectionMs: latencySamples(parsed.asrUpdateToDetectionMs),
      asrUpdateToDetectionByDetection: {
        reference: latencySamples(byDetection.reference),
        quote: latencySamples(byDetection.quote),
        paraphrase: latencySamples(byDetection.paraphrase),
        command: latencySamples(byDetection.command),
      },
      detectionToOperatorMs: latencySamples(parsed.detectionToOperatorMs),
      detectionToStageMs: latencySamples(parsed.detectionToStageMs),
      detectionToLiveMs: latencySamples(parsed.detectionToLiveMs),
      liveCommandMs: latencySamples(parsed.liveCommandMs),
      lastUpdatedAt: finiteNumber(parsed.lastUpdatedAt, 0) || null,
    };
  } catch {
    return empty;
  }
}

export function savePerformanceAccumulator(accumulator: PerformanceAccumulator): void {
  try {
    localStorage.setItem(PERFORMANCE_STORAGE_KEY, JSON.stringify(accumulator));
  } catch {
    // Quota/privacy-mode errors must never affect scripture operation.
  }
}

export function clearSavedPerformanceAccumulator(): void {
  try {
    localStorage.removeItem(PERFORMANCE_STORAGE_KEY);
  } catch {
    // See savePerformanceAccumulator.
  }
}

export function addLatencySample(samples: number[], durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  samples.push(Math.round(durationMs));
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

export function summarizeLatency(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) return { count: 0, averageMs: null, p50Ms: null, p95Ms: null, maxMs: null };
  const ordered = [...samples].sort((a, b) => a - b);
  const percentile = (ratio: number) => ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)];
  return {
    count: samples.length,
    averageMs: Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: ordered[ordered.length - 1],
  };
}

export function snapshotPerformance(accumulator: PerformanceAccumulator): AiScripturePerformance {
  return {
    sessionStartedAt: accumulator.sessionStartedAt,
    provider: accumulator.provider,
    mode: accumulator.mode,
    finalTranscriptSegments: accumulator.finalTranscriptSegments,
    interimTranscriptUpdates: accumulator.interimTranscriptUpdates,
    suggestions: accumulator.suggestions,
    suggestionsByDetection: { ...accumulator.suggestionsByDetection },
    staged: accumulator.staged,
    live: accumulator.live,
    autoStaged: accumulator.autoStaged,
    autoLive: accumulator.autoLive,
    failedAutoStages: accumulator.failedAutoStages,
    failedAutoLive: accumulator.failedAutoLive,
    asrUpdateToDetectionMs: summarizeLatency(accumulator.asrUpdateToDetectionMs),
    asrUpdateToDetectionByDetection: {
      reference: summarizeLatency(accumulator.asrUpdateToDetectionByDetection.reference),
      quote: summarizeLatency(accumulator.asrUpdateToDetectionByDetection.quote),
      paraphrase: summarizeLatency(accumulator.asrUpdateToDetectionByDetection.paraphrase),
      command: summarizeLatency(accumulator.asrUpdateToDetectionByDetection.command),
    },
    detectionToOperatorMs: summarizeLatency(accumulator.detectionToOperatorMs),
    detectionToStageMs: summarizeLatency(accumulator.detectionToStageMs),
    detectionToLiveMs: summarizeLatency(accumulator.detectionToLiveMs),
    liveCommandMs: summarizeLatency(accumulator.liveCommandMs),
    lastUpdatedAt: accumulator.lastUpdatedAt,
  };
}

export function formatLatency(ms: number | null): string {
  if (ms == null) return "—";
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(2)} s`;
}
