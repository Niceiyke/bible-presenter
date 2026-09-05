import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { tierCapabilities } from "../system/tiers";

/**
 * Live progress of a native recording, mirrored from the backend
 * `recording_status` command (camelCase serde in `commands/recordings.rs`).
 */
export interface NativeRecordingStatus {
  active: boolean;
  width: number;
  height: number;
  fps: number;
  /** Frames written to ffmpeg, not just captured. */
  framesWritten: number;
  /** Bytes written to disk so far. */
  bytesWritten: number;
  /** Unix ms of wall-clock start, for the elapsed timer. */
  startedMs: number;
  error: string | null;
  /** Whether program audio is attached and being muxed into the recording. */
  audioAttached: boolean;
}

/**
 * `RecordingProvider` — App-level owner of the native recording surface (Phase
 * 5). The backend owns the whole pipeline: it captures the dedicated off-screen
 * `capture` window (which renders the same program DOM surface as the audience
 * `output` window) via Windows Graphics Capture and streams the pixels to
 * ffmpeg on disk, so recording works even when the projection window is closed
 * and a recording survives navigating away from the Recordings tab — the
 * provider merely controls and reports that backend session. There is no
 * frontend compositor, canvas, or MediaRecorder in this path; the Recorder
 * preview renders the same store-driven `ProgramSurfacePreview` as the Cockpit.
 */
interface RecordingContextValue {
  recording: boolean;
  /** Elapsed recording time in seconds. */
  elapsed: number;
  /** The last saved file name (after a completed save). */
  lastSaved: string | null;
  /** Error from the last start/stop, or the backend's live error. */
  error: string | null;
  /** Latest mirrored recording status (null until first poll). */
  status: NativeRecordingStatus | null;
  start: (enableAudio?: boolean) => Promise<void>;
  stop: () => Promise<string | null>;
  cancel: () => void;
  /** Capture resolution/fps for the recording. */
  captureWidth: number;
  captureHeight: number;
  captureFps: number;
  /** Persist a new capture resolution/fps to the `record-main` output. */
  setCapture: (width: number, height: number, fps: number) => Promise<void>;
}

const RecordingContext = createContext<RecordingContextValue | null>(null);

export function useRecording(): RecordingContextValue {
  const ctx = useContext(RecordingContext);
  if (!ctx) throw new Error("useRecording must be used within RecordingProvider");
  return ctx;
}

export function RecordingProvider({ children }: { children: ReactNode }) {
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

  const [status, setStatus] = useState<NativeRecordingStatus | null>(null);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recording = status?.active ?? false;

  // Recover state on mount (e.g. a recording left running if the app was
  // rebuilt/restarted the backend) and reconcile any backend-side change.
  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<NativeRecordingStatus>("recording_status"));
    } catch (e: any) {
      console.error("recording_status failed:", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while recording so elapsed/bytes/frames stay live and a backend-side
  // stop (ffmpeg crash) is reflected immediately.
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => void refresh(), 500);
    return () => clearInterval(id);
  }, [recording, refresh]);

  // Elapsed wall-clock time from the backend's start anchor.
  const startedRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!recording) return;
    startedRef.current = status?.startedMs ?? Date.now();
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [recording, status?.startedMs]);
  const elapsed = recording ? Math.max(0, (now - (status?.startedMs ?? now)) / 1000) : 0;

  const start = useCallback(async (enableAudio?: boolean) => {
    if (recording) return;
    if (license && license.status === "active" && !tierCapabilities(license.tier).recording) {
      setToast("Recording is a Pro feature. Upgrade in Settings → License.");
      return;
    }
    setError(null);
    try {
      const s = await invoke<NativeRecordingStatus>("recording_start", {
        width: captureWidth,
        height: captureHeight,
        fps: captureFps,
        enableAudio: !!enableAudio,
      });
      setStatus(s);
      setLastSaved(null);
    } catch (e: any) {
      setError(`Failed to start recording: ${e?.message ?? e}`);
    }
  }, [recording, license, captureWidth, captureHeight, captureFps, setToast]);

  const stop = useCallback(async (): Promise<string | null> => {
    if (!recording) return null;
    try {
      const saved = await invoke<{ name: string; size: number; modified: number }>("recording_stop_active");
      setStatus((s) => (s ? { ...s, active: false } : s));
      setLastSaved(saved.name);
      setError(null);
      return saved.name;
    } catch (e: any) {
      setError(`Failed to stop recording: ${e?.message ?? e}`);
      setStatus((s) => (s ? { ...s, active: false } : s));
      return null;
    }
  }, [recording]);

  const cancel = useCallback(() => {
    if (!recording) return;
    setError(null);
    void invoke<void>("recording_abort")
      .then(() => setStatus((s) => (s ? { ...s, active: false } : s)))
      .catch((e: any) => setError(`Failed to abort recording: ${e?.message ?? e}`));
  }, [recording]);

  const value = useMemo<RecordingContextValue>(
    () => ({
      recording,
      elapsed,
      lastSaved,
      error: error ?? status?.error ?? null,
      status,
      start,
      stop,
      cancel,
      captureWidth,
      captureHeight,
      captureFps,
      setCapture,
    }),
    [recording, elapsed, lastSaved, error, status, start, stop, cancel, captureWidth, captureHeight, captureFps, setCapture]
  );

  return <RecordingContext.Provider value={value}>{children}</RecordingContext.Provider>;
}
