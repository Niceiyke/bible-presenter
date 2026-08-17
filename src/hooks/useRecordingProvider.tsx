import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { useRecorder } from "./useRecorder";
import { ProgramFeedPreview } from "../components/outputs/ProgramFeedPreview";

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
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDeviceId, setAudioDeviceId] = useState("");
  const [audioError, setAudioError] = useState<string | null>(null);

  // Capture the shared audio input (processing off) while enabled. The track
  // is combined into the recorded stream on start and kept alive so a
  // recording survives tab navigation.
  useEffect(() => {
    if (!audioEnabled) {
      audioTrackRef.current?.stop();
      audioTrackRef.current = null;
      setAudioError(null);
      return;
    }
    let cancelled = false;
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (cancelled) return;
        const inputs = devices.filter((d) => d.kind === "audioinput");
        setAudioDevices(inputs);
        setAudioDeviceId((prev) => prev || inputs[0]?.deviceId || "");
      })
      .catch(() => {});
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          deviceId: audioDeviceId ? { exact: audioDeviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      .then((ms) => {
        if (cancelled) {
          ms.getTracks().forEach((t) => t.stop());
          return;
        }
        const t = ms.getAudioTracks()[0] ?? null;
        audioTrackRef.current = t;
        setAudioError(t ? null : "No audio input device was found.");
      })
      .catch((e: any) => {
        if (!cancelled) setAudioError(`Failed to open the audio input: ${e?.message ?? e}`);
      });
    return () => {
      cancelled = true;
      audioTrackRef.current?.stop();
      audioTrackRef.current = null;
    };
  }, [audioEnabled, audioDeviceId]);

  const streamReady = !!stream && stream.getVideoTracks().length > 0;

  const start = useCallback(() => {
    if (recorder.recording || !stream) return;
    const tracks: MediaStreamTrack[] = [...stream.getVideoTracks()];
    if (audioTrackRef.current) tracks.push(audioTrackRef.current);
    const recStream = new MediaStream(tracks);
    void recorder.start(recStream);
  }, [recorder, stream]);

  const stop = useCallback(async () => recorder.stop(), [recorder]);

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
      cancel: recorder.cancel,
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
    [recorder, stream, streamReady, start, stop, audioEnabled, audioDevices, audioDeviceId, audioError, captureWidth, captureHeight, captureFps, setCapture]
  );

  return (
    <RecordingContext.Provider value={value}>
      {children}
      <div
        style={{ position: "fixed", left: -100000, top: 0, width: 1, height: 1, overflow: "hidden", pointerEvents: "none" }}
        aria-hidden
      >
        <ProgramFeedPreview
          geometry={{ width: captureWidth, height: captureHeight }}
          fps={captureFps}
          active={active}
          onStream={setStream}
        />
      </div>
    </RecordingContext.Provider>
  );
}
