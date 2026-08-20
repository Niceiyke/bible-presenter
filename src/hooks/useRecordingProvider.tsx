import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { reportOutputState, setOutputVisible } from "./outputRuntime";
import { tierCapabilities } from "../system/tiers";
import { useEngineTransport } from "./useEngineTransport";
import type { OutputPhase } from "../types";

/**
 * `RecordingProvider` — App-level owner of the recorder surface (Phase D).
 *
 * Since Phase D the engine sidecar owns the whole capture → encode → mux
 * pipeline: the recorder is a single mux-only ffmpeg (MP4, `-c copy`) fed from
 * the engine's shared H.264 encoder. This provider is a thin app-scoped owner
 * that persists the operator intent through the OutputManager, starts/stops the
 * engine's recording session, and reconciles the surface's runtime phase from
 * the engine's `recording_status` — so a recording survives navigating away
 * from the Recordings workspace and an unexpected engine failure surfaces as a
 * `failed` phase instead of a silent dead session.
 *
 * The webview no longer captures audio into the recording (audio moves to the
 * engine in a later phase); the shared audio graph stays mounted for operator
 * monitoring only.
 */
interface RecordingContextValue {
  recording: boolean;
  elapsed: number;
  lastSaved: string | null;
  error: string | null;
  /** Whether the engine transport is reachable (sidecar running). */
  transportConnected: boolean;
  /** Capture resolution/fps for the recording compositor. */
  captureWidth: number;
  captureHeight: number;
  captureFps: number;
  /** Persist a new capture resolution/fps to the `record-main` output. */
  setCapture: (width: number, height: number, fps: number) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<string | null>;
}

const RecordingContext = createContext<RecordingContextValue | null>(null);

export function useRecording(): RecordingContextValue {
  const ctx = useContext(RecordingContext);
  if (!ctx) throw new Error("useRecording must be used within RecordingProvider");
  return ctx;
}

function defaultFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `recording-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.mp4`;
}

export function RecordingProvider({ children }: { children: ReactNode }) {
  const tabActive = useAppStore((s) => s.activeTab === "recordings");
  const license = useAppStore((s) => s.license);
  const setToast = useAppStore((s) => s.setToast);
  const outputs = useAppStore((s) => s.outputs);
  const setOutputs = useAppStore((s) => s.setOutputs);

  const recordOutput = outputs.find((o) => o.id === "record-main");
  const captureWidth = recordOutput?.geometry.width ?? 1920;
  const captureHeight = recordOutput?.geometry.height ?? 1080;
  const captureFps = recordOutput?.capture_fps ?? 30;

  const setCapture = useCallback(
    async (width: number, height: number, fps: number) => {
      const updated = outputs.map((o) =>
        o.id === "record-main" ? { ...o, geometry: { width, height }, capture_fps: fps } : o
      );
      try {
        await invoke("outputs_update", { configs: updated });
        setOutputs(updated);
      } catch (e: any) {
        console.error("outputs_update failed:", e);
      }
    },
    [outputs, setOutputs]
  );

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileNameRef = useRef<string>("");
  const startedAtRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const surfaceStarted = useRef(false);
  const stopping = useRef(false);

  // Poll the engine's recording sessions while the tab is open OR a recording
  // is running (so an unexpected engine-side stop is caught even away).
  const transport = useEngineTransport(tabActive || recording);
  const { recording: recordingSessions, connected: transportConnected } = transport;

  // Report the recorder surface's lifecycle phase to the OutputManager (Phase
  // 4). The backend owns `started_at` and broadcasts `output-state-changed`,
  // so every window agrees on the recorder's phase. This path never touches
  // the presentation engine.
  const report = useCallback((phase: OutputPhase, reason?: string) => {
    void reportOutputState({
      id: "record-main",
      visible: phase === "starting" || phase === "live" || phase === "stopping",
      rendering: phase === "live",
      fps: captureFps,
      error: reason,
      phase,
      reason,
    });
  }, [captureFps]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    if (recording) return;
    if (license && license.status === "active" && !tierCapabilities(license.tier).recording) {
      setToast("Recording is a Pro feature. Upgrade in Settings → License.");
      return;
    }
    // Persist the operator intent FIRST; if the write fails the adapter must
    // not report a live phase (disk and runtime would diverge).
    try {
      await setOutputVisible("record-main", true);
    } catch (e: any) {
      report("failed", `Could not enable the recorder output: ${e?.message ?? e}`);
      setToast("Failed to start recording — the output config could not be saved.");
      return;
    }
    report("starting");
    const fileName = defaultFileName();
    fileNameRef.current = fileName;
    try {
      await invoke("recording_start", { fileName, fps: captureFps });
    } catch (e: any) {
      surfaceStarted.current = false;
      report("failed", `Could not start the engine recorder: ${e?.message ?? e}`);
      setError(`Failed to start recording: ${e?.message ?? e}`);
      await setOutputVisible("record-main", false).catch((err: any) => {
        console.error("outputs_set_visible failed after start error:", err);
      });
      return;
    }
    surfaceStarted.current = true;
    setRecording(true);
    setError(null);
    startedAtRef.current = Date.now();
    setElapsed(0);
    clearTimer();
    timerRef.current = setInterval(() => {
      setElapsed((Date.now() - startedAtRef.current) / 1000);
    }, 500);
    report("live");
  }, [recording, license, setToast, report, captureFps, clearTimer]);

  const stop = useCallback(async (): Promise<string | null> => {
    if (!recording) return null;
    stopping.current = true;
    report("stopping");
    const fileName = fileNameRef.current;
    try {
      await invoke("recording_stop", { fileName });
      setLastSaved(fileName);
      setError(null);
    } catch (e: any) {
      setError(`Failed to stop recording: ${e?.message ?? e}`);
      return null;
    } finally {
      clearTimer();
      setElapsed(0);
      setRecording(false);
      surfaceStarted.current = false;
      stopping.current = false;
      await setOutputVisible("record-main", false).catch((err: any) => {
        console.error("outputs_set_visible failed after stop:", err);
      });
      report("stopped");
    }
    return fileName;
  }, [recording, report, clearTimer]);

  // Reconcile the runtime phase with the engine's session table: if the
  // engine's recording session disappears while we believe we are recording,
  // the muxer/encoder died — surface it as `failed` and reset local state.
  useEffect(() => {
    if (!surfaceStarted.current) return;
    const anyRecording = Object.keys(recordingSessions).length > 0;
    if (!anyRecording && !stopping.current) {
      surfaceStarted.current = false;
      clearTimer();
      setElapsed(0);
      setRecording(false);
      setError("Recording ended unexpectedly (the engine's muxer exited).");
      report("failed", "Recording ended unexpectedly (the engine's muxer exited).");
      void setOutputVisible("record-main", false).catch((e: any) => {
        console.error("outputs_set_visible failed after engine stop:", e);
      });
    }
  }, [recordingSessions, report, clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  const value = useMemo<RecordingContextValue>(
    () => ({
      recording,
      elapsed,
      lastSaved,
      error,
      transportConnected,
      captureWidth,
      captureHeight,
      captureFps,
      setCapture,
      start,
      stop,
    }),
    [recording, elapsed, lastSaved, error, transportConnected, captureWidth, captureHeight, captureFps, setCapture, start, stop]
  );

  return <RecordingContext.Provider value={value}>{children}</RecordingContext.Provider>;
}