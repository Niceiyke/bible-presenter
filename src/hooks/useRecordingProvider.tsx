import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { useRecorder } from "./useRecorder";
import { reportOutputState, setOutputVisible } from "./outputRuntime";
import { useAudioGraph } from "./useAudioGraphProvider";
import { tierCapabilities } from "../system/tiers";
import { ProgramFeedPreview } from "../components/outputs/ProgramFeedPreview";
import type { OutputPhase } from "../types";

/**
 * `RecordingProvider` — App-level owner of the recorder + compositor pipeline
 * (Phase 3 fix). The Recordings tab unmounts when the operator navigates to
 * another workspace, which used to kill the canvas capture loop and end any
 * in-flight recording. Lifting both the hidden `ProgramFeedPreview` compositor
 * and the recorder here keeps the capture stream alive for the whole
 * recording even after the operator leaves the page (the tab only stops the
 * compositor when neither it is visible nor a recording is running).
 *
 * The provider also owns the shared audio-input capture (mic / line-in /
 * mixer feed, audio processing off — mirroring the streamer). Its track is
 * combined with the compositor's video track before the recording starts, so
 * recordings include sound.
 */
interface RecordingContextValue {
  recording: boolean;
  elapsed: number;
  lastSaved: string | null;
  error: string | null;
  /** The live composited program stream (video +, when enabled, audio). */
  stream: MediaStream | null;
  streamReady: boolean;
  start: () => void;
  stop: () => Promise<string | null>;
  cancel: () => void;
  audioEnabled: boolean;
  setAudioEnabled: (v: boolean) => void;
  audioDevices: MediaDeviceInfo[];
  audioDeviceId: string;
  setAudioDeviceId: (id: string) => void;
  audioError: string | null;
  /** Capture resolution/fps for the recording compositor. */
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
  const recorder = useRecorder();
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

  const [stream, setStream] = useState<MediaStream | null>(null);

  // Shared audio graph (Phase 6): recording and streaming draw their program
  // audio from ONE app-level capture, so we never hold two input pipelines and
  // mute/volume is a single shared policy. The graph's post-gain program track
  // is combined into the recorded stream on start.
  const audio = useAudioGraph();
  const audioEnabled = audio.enabled;
  const setAudioEnabled = audio.setEnabled;
  const audioDevices = audio.devices;
  const audioDeviceId = audio.deviceId;
  const setAudioDeviceId = audio.setDeviceId;
  const audioError = audio.error;

  const streamReady = !!stream && stream.getVideoTracks().length > 0;

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

  // The surface's phase is reconciled from the ACTUAL recorder state (via the
  // effect below) rather than from closures, so a MediaRecorder start failure
  // or a save-time error is never masked by a stale `recorder.error` read.
  const surfaceStarted = useRef(false);
  const stopping = useRef(false);

  const start = useCallback(async () => {
    if (recorder.recording || !stream) return;
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
    const tracks: MediaStreamTrack[] = [...stream.getVideoTracks()];
    if (audio.programTrack) tracks.push(audio.programTrack);
    const recStream = new MediaStream(tracks);
    surfaceStarted.current = true;
    await recorder.start(recStream);
  }, [recorder, stream, license, setToast, report]);

  const stop = useCallback(async (): Promise<string | null> => {
    if (!recorder.recording) return null;
    stopping.current = true;
    report("stopping");
    const name = await recorder.stop();
    return name;
  }, [recorder, report]);

  const cancel = useCallback(() => {
    surfaceStarted.current = false;
    stopping.current = false;
    recorder.cancel();
    void setOutputVisible("record-main", false).catch((e: any) => {
      console.error("outputs_set_visible failed after cancel:", e);
    });
    report("stopped");
  }, [recorder, report]);

  // Reconcile the runtime phase with the actual recorder state once the
  // surface has been started: error → failed, recording → live, clean stop →
  // stopped. This is the single writer of the recorder phase after start, so
  // start/save failures always surface as `failed` with the reason.
  useEffect(() => {
    if (!surfaceStarted.current) return;
    if (recorder.error) {
      surfaceStarted.current = false;
      stopping.current = false;
      report("failed", recorder.error);
      void setOutputVisible("record-main", false).catch((e: any) => {
        console.error("outputs_set_visible failed after recorder error:", e);
      });
      return;
    }
    if (recorder.recording) {
      report("live");
      return;
    }
    if (stopping.current) {
      surfaceStarted.current = false;
      stopping.current = false;
      void setOutputVisible("record-main", false).catch((e: any) => {
        console.error("outputs_set_visible failed after stop:", e);
      });
      report("stopped");
    }
  }, [recorder.error, recorder.recording, report]);

  // Keep the compositor running while the tab is visible OR a recording is in
  // progress, so leaving the page mid-recording does not end the capture.
  const active = tabActive || recorder.recording;

  const value = useMemo<RecordingContextValue>(
    () => ({
      recording: recorder.recording,
      elapsed: recorder.elapsed,
      lastSaved: recorder.lastSaved,
      error: recorder.error,
      stream,
      streamReady,
      start,
      stop,
      cancel,
      audioEnabled,
      setAudioEnabled,
      audioDevices,
      audioDeviceId,
      setAudioDeviceId,
      audioError,
      captureWidth,
      captureHeight,
      captureFps,
      setCapture,
    }),
    [recorder, stream, streamReady, start, stop, cancel, audioEnabled, audioDevices, audioDeviceId, audioError, captureWidth, captureHeight, captureFps, setCapture]
  );

  return (
    <RecordingContext.Provider value={value}>
      {children}
      <div
        style={{ position: "fixed", left: -100000, top: 0, width: 1, height: 1, overflow: "hidden", pointerEvents: "none" }}
        aria-hidden
      >
        <ProgramFeedPreview
          config={recordOutput ?? undefined}
          geometry={{ width: captureWidth, height: captureHeight }}
          fps={captureFps}
          active={active}
          onStream={setStream}
        />
      </div>
    </RecordingContext.Provider>
  );
}
