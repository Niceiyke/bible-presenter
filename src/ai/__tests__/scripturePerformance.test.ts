import { beforeEach, describe, expect, it } from "vitest";
import {
  addLatencySample,
  clearSavedPerformanceAccumulator,
  createPerformanceAccumulator,
  loadPerformanceAccumulator,
  savePerformanceAccumulator,
  snapshotPerformance,
  summarizeLatency,
} from "../scripturePerformance";

describe("AI Scripture performance metrics", () => {
  beforeEach(() => clearSavedPerformanceAccumulator());

  it("summarizes median, p95, average, and maximum latency", () => {
    expect(summarizeLatency([100, 200, 300, 400, 5_000])).toEqual({
      count: 5,
      averageMs: 1_200,
      p50Ms: 300,
      p95Ms: 5_000,
      maxMs: 5_000,
    });
  });

  it("ignores invalid samples and exposes a privacy-safe snapshot", () => {
    const accumulator = createPerformanceAccumulator();
    addLatencySample(accumulator.detectionToLiveMs, -1);
    addLatencySample(accumulator.detectionToLiveMs, Number.NaN);
    addLatencySample(accumulator.detectionToLiveMs, 432.4);
    accumulator.suggestions = 1;
    accumulator.suggestionsByDetection.reference = 1;

    expect(snapshotPerformance(accumulator)).toMatchObject({
      suggestions: 1,
      suggestionsByDetection: { reference: 1 },
      detectionToLiveMs: { count: 1, p50Ms: 432, maxMs: 432 },
    });
  });

  it("persists only aggregate measurement data across restarts", () => {
    const accumulator = createPerformanceAccumulator();
    accumulator.sessionStartedAt = 1_700_000_000_000;
    accumulator.provider = "deepgram";
    accumulator.mode = "service";
    accumulator.suggestions = 4;
    accumulator.asrUpdateToDetectionMs.push(12, 18);
    accumulator.asrUpdateToDetectionByDetection.reference.push(12, 18);
    savePerformanceAccumulator(accumulator);

    expect(loadPerformanceAccumulator()).toMatchObject({
      sessionStartedAt: 1_700_000_000_000,
      provider: "deepgram",
      mode: "service",
      suggestions: 4,
      asrUpdateToDetectionMs: [12, 18],
    });
  });
});
