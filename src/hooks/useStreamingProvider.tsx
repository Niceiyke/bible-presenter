import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { useSystemDiagnostics } from "../system/SystemDiagnosticsContext";
import { tierCapabilities } from "../system/tiers";
import { reportOutputState, setOutputVisible, STREAM_OUTPUT_ID } from "./outputRuntime";
import { useAudioGraph } from "./useAudioGraphProvider";
import { suggestedBitrateKbps } from "./useRtmpEncoder";
import {
  getProgramEncoderSnapshot,
  startProgramEncoder,
  stopProgramEncoder,
  subscribeProgramEncoder,
  type ProgramEncoderSnapshot,
} from "../system/programEncoder";
import { ProgramFeedPreview } from "../components/outputs/ProgramFeedPreview";
import { makeDestination, newDestinationId } from "../components/streaming/presets";
import type {
  DestinationCardHandle,
  DestTransportStatus,
} from "../components/streaming/DestinationCard";
import type { OutputPhase, StreamDestination, StreamPlatform } from "../types";

/**
 * `StreamingProvider` — App-level owner of the streaming hub pipeline (Phase 4).
 *
 * Mirrors `RecordingProvider`: the Streaming workspace unmounts when the
 * operator navigates away, which used to kill the in-tab compositor and any
 * in-flight stream. Lifting the hidden `ProgramFeedPreview` compositor, the
 * destination set, the shared audio input, and the master transport here keeps
 * the stream alive for the whole broadcast even after the operator leaves the
 * page — a workspace switch can never stop an active stream.
 *
 * The provider also owns the surface's lifecycle through the OutputManager:
 * Go Live persists the operator intent first (`outputs_set_visible`), then
 * reports `starting` → `live` (or `failed`) via `report_output_state`, and Stop
 * All reports `stopping` → `stopped`. It never touches the presentation engine,
 * so a failed stream can never change live program state.
 */

export interface CardStatus {
  status: DestTransportStatus;
  bitrateKbps: number;
}

interface StreamingContextValue {
  destinations: StreamDestination[];
  statuses: Record<string, CardStatus>;
  saving: boolean;
  /** The live composited program stream (video +, when enabled, audio). */
  stream: MediaStream | null;
  streamReady: boolean;
  anyBusy: boolean;
  liveCount: number;
  captureWidth: number;
  captureHeight: number;
  captureFps: number;
  streamBitrateKbps: number;
  setCapture: (width: number, height: number, fps: number) => Promise<void>;
  updateDestination: (next: StreamDestination) => void;
  removeDestination: (id: string) => void;
  addDestination: (platform: StreamPlatform) => void;
  registerHandle: (id: string, handle: DestinationCardHandle | null) => void;
  reportStatus: (id: string, status: DestTransportStatus, bitrateKbps: number) => void;
  goLive: () => Promise<void>;
  stopAll: () => Promise<void>;
  getSourceTracks: () => { video: MediaStreamTrack | null; audio: MediaStreamTrack | null };
  audioEnabled: boolean;
  setAudioEnabled: (v: boolean) => void;
  audioDevices: MediaDeviceInfo[];
  audioDeviceId: string;
  setAudioDeviceId: (id: string) => void;
  audioError: string | null;
  audioUnavailableReason: string | null;
  /** Shared program encoder status (Phase 7) — operator-visible lifecycle. */
  encoder: ProgramEncoderSnapshot;
  streamingBlocked: boolean;
  sharedAudioBlocked: boolean;
  rtmpBlockedReason: string | null;
  ndiBlockedReason: string | null;
  destCapReached: boolean;
  enabledCount: number;
}

const StreamingContext = createContext<StreamingContextValue | null>(null);

export function useStreaming(): StreamingContextValue {
  const ctx = useContext(StreamingContext);
  if (!ctx) throw new Error("useStreaming must be used within StreamingProvider");
  return ctx;
}

export function StreamingProvider({ children }: { children: ReactNode }) {
  const tabActive = useAppStore((s) => s.activeTab === "streaming");
  const license = useAppStore((s) => s.license);
  const setToast = useAppStore((s) => s.setToast);
  const outputs = useAppStore((s) => s.outputs);
  const setOutputs = useAppStore((s) => s.setOutputs);

  // Capability gating (Phase 7): RTMP needs WebCodecs H.264 + ffmpeg; shared
  // audio needs at least one input device.
  const { checks } = useSystemDiagnostics();
  const capabilities = checks?.capabilities;
  const rtmpBlockedReason = capabilities && !capabilities.rtmpAvailable ? capabilities.rtmpReason : null;
  const ndiBlockedReason = capabilities && !capabilities.ndiAvailable ? capabilities.ndiReason : null;
  const audioUnavailableReason = capabilities && !capabilities.audioAvailable ? capabilities.audioReason : null;

  // Tier gating: streaming is Pro+, NDI is Pro+, shared audio is Premium.
  const streamCaps = tierCapabilities(license?.tier);
  const streamingBlocked = !!license && license.status === "active" && !streamCaps.streaming;

  const output = outputs.find((o) => o.id === STREAM_OUTPUT_ID);

  const captureWidth = output?.geometry.width ?? 1920;
  const captureHeight = output?.geometry.height ?? 1080;
  const captureFps = output?.capture_fps ?? 30;
  // RTMP/NDI encode the compositor feed once at the master capture settings;
  // derive a sensible bitrate from the chosen resolution/fps.
  const streamBitrateKbps = suggestedBitrateKbps(captureWidth, captureHeight, captureFps);

  const [destinations, setDestinations] = useState<StreamDestination[]>([]);
  const [statuses, setStatuses] = useState<Record<string, CardStatus>>({});
  const cardHandles = useRef<Map<string, DestinationCardHandle>>(new Map());
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [saving, setSaving] = useState(false);
  const [masterActive, setMasterActive] = useState(false);

  // Shared audio graph (Phase 6): recording and streaming draw their program
  // audio from ONE app-level capture, so every destination shares a single
  // input track (cloned per transport) and mute/volume is one shared policy.
  const audio = useAudioGraph();
  const audioEnabled = audio.enabled;
  const setAudioEnabled = audio.setEnabled;
  const audioDevices = audio.devices;
  const audioDeviceId = audio.deviceId;
  const setAudioDeviceId = audio.setDeviceId;
  const audioError = audio.error;
  const programAudioTrack = audio.programTrack;
  // Shared audio gating lives in the audio graph provider (Premium); expose the
  // same flag for the tab's messaging.
  const sharedAudioBlocked = audio.blocked;

  // Shared program encoder status (Phase 7) for operator visibility.
  const encoder = useSyncExternalStore(subscribeProgramEncoder, getProgramEncoderSnapshot, getProgramEncoderSnapshot);

  const persistCapture = useCallback(
    async (width: number, height: number, fps: number) => {
      const updated = outputs.map((o) =>
        o.id === STREAM_OUTPUT_ID ? { ...o, geometry: { width, height }, capture_fps: fps } : o
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

  const persistDestinations = useCallback(
    async (next: StreamDestination[]) => {
      setSaving(true);
      try {
        const updated = outputs.map((o) =>
          o.id === STREAM_OUTPUT_ID ? { ...o, stream_destinations: next } : o
        );
        await invoke("outputs_update", { configs: updated });
        setOutputs(updated);
      } catch (e: any) {
        console.error("outputs_update failed:", e);
      } finally {
        setSaving(false);
      }
    },
    [outputs, setOutputs]
  );

  // Report the stream surface's lifecycle phase to the OutputManager (Phase 4).
  // Never touches the presentation engine.
  const report = useCallback((phase: OutputPhase, reason?: string) => {
    void reportOutputState({
      id: STREAM_OUTPUT_ID,
      visible: phase === "starting" || phase === "live" || phase === "stopping",
      rendering: phase === "live",
      fps: captureFps,
      error: reason,
      phase,
      reason,
    });
  }, [captureFps]);

  const updateDestination = useCallback(
    (next: StreamDestination) => {
      setDestinations((prev) => {
        const updated = prev.map((d) => (d.id === next.id ? next : d));
        persistDestinations(updated);
        return updated;
      });
    },
    [persistDestinations]
  );

  const removeDestination = useCallback(
    (id: string) => {
      const handle = cardHandles.current.get(id);
      if (handle) void handle.stop();
      setStatuses((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setDestinations((prev) => {
        const updated = prev.filter((d) => d.id !== id);
        persistDestinations(updated);
        return updated;
      });
    },
    [persistDestinations]
  );

  const addDestination = useCallback(
    (platform: StreamPlatform) => {
      if (streamingBlocked) {
        setToast("Streaming is a Pro feature. Upgrade in Settings → License.");
        return;
      }
      setDestinations((prev) => {
        if (prev.length >= streamCaps.streamingDestinations) {
          setToast(
            streamCaps.streamingDestinations > 0
              ? `Your plan supports ${streamCaps.streamingDestinations} simultaneous destination${streamCaps.streamingDestinations === 1 ? "" : "s"}. Upgrade for more.`
              : "Streaming is a Pro feature. Upgrade in Settings → License."
          );
          return prev;
        }
        const updated = [...prev, makeDestination(platform, newDestinationId())];
        persistDestinations(updated);
        return updated;
      });
    },
    [persistDestinations, streamingBlocked, streamCaps]
  );

  // Hydrate destinations from the persisted stream-main config, seeding from
  // the legacy single-destination `streaming` field when present.
  useEffect(() => {
    if (!output) return;
    const stored = output.stream_destinations;
    if (stored && stored.length > 0) {
      setDestinations(stored);
      return;
    }
    if (output.streaming?.url) {
      const legacy: StreamDestination = {
        id: newDestinationId(),
        label: output.streaming.mode === "rtmp" ? "Custom RTMP" : "Custom WHIP",
        platform: output.streaming.mode === "rtmp" ? "custom-rtmp" : "custom-whip",
        mode: output.streaming.mode === "rtmp" ? "rtmp" : "whip",
        url: output.streaming.url,
        stream_key: output.streaming.stream_key,
        enabled: true,
        audio: true,
      };
      setDestinations([legacy]);
      void persistDestinations([legacy]);
    }
  }, [output, persistDestinations]);

  const handleStream = useCallback((s: MediaStream | null) => setStream(s), []);

  const streamReady = !!stream && stream.getVideoTracks().length > 0;

  const getSourceTracks = useCallback(
    () => ({ video: stream?.getVideoTracks()[0] ?? null, audio: programAudioTrack }),
    [stream, programAudioTrack]
  );

  const handleStatus = useCallback((id: string, status: DestTransportStatus, bitrateKbps: number) => {
    setStatuses((prev) => ({ ...prev, [id]: { status, bitrateKbps } }));
  }, []);

  const registerHandle = useCallback((id: string, handle: DestinationCardHandle | null) => {
    if (handle) cardHandles.current.set(id, handle);
    else cardHandles.current.delete(id);
  }, []);

  const goLive = useCallback(async () => {
    if (!streamReady) return;
    if (streamingBlocked) {
      setToast("Streaming is a Pro feature. Upgrade in Settings → License.");
      return;
    }
    const enabled = destinations.filter((d) => d.enabled);
    // Enforce the plan's destination cap on the shared-encoder path too (defense
    // in depth beyond the Add button).
    if (enabled.length > streamCaps.streamingDestinations) {
      report("failed", `Your plan supports ${streamCaps.streamingDestinations} simultaneous destination${streamCaps.streamingDestinations === 1 ? "" : "s"}.`);
      return;
    }
    await persistDestinations(destinations);
    // Persist the operator intent FIRST; a failed write must not leave disk
    // and the reported runtime phase diverged.
    try {
      await setOutputVisible(STREAM_OUTPUT_ID, true);
    } catch (e: any) {
      report("failed", `Could not enable the stream output: ${e?.message ?? e}`);
      setToast("Failed to go live — the output config could not be saved.");
      return;
    }
    report("starting");
    setMasterActive(true);

    // Phase 7: start ONE shared program encoder for the master visual profile
    // (RTMP/NDI destinations subscribe to its packets) before starting any
    // transport, so N destinations share one video encoder.
    const needsEncoder = enabled.some((d) => d.mode === "rtmp" || d.mode === "ndi");
    if (needsEncoder && stream) {
      const track = stream.getVideoTracks()[0];
      if (track) {
        const ok = await startProgramEncoder(track, {
          width: captureWidth,
          height: captureHeight,
          fps: captureFps,
          bitrateKbps: streamBitrateKbps,
        });
        if (!ok) {
          report("failed", `Encoder failed to start: ${getProgramEncoderSnapshot().error ?? "unknown"}`);
          setMasterActive(false);
          await setOutputVisible(STREAM_OUTPUT_ID, false).catch((e: any) => {
            console.error("outputs_set_visible failed after encoder error:", e);
          });
          return;
        }
      }
    }

    for (const d of enabled) {
      if (d.mode === "rtmp" && rtmpBlockedReason) continue;
      if (d.mode === "ndi" && ndiBlockedReason) continue;
      const handle = cardHandles.current.get(d.id);
      if (handle) void handle.start();
    }
  }, [streamReady, streamingBlocked, setToast, persistDestinations, destinations, rtmpBlockedReason, ndiBlockedReason, report, streamCaps, stream, captureWidth, captureHeight, captureFps, streamBitrateKbps]);

  const stopAll = useCallback(async () => {
    if (!masterActive) return;
    report("stopping");
    for (const d of destinations) {
      const handle = cardHandles.current.get(d.id);
      if (handle) await handle.stop();
    }
    stopProgramEncoder();
    setMasterActive(false);
    await setOutputVisible(STREAM_OUTPUT_ID, false).catch((e: any) => {
      console.error("outputs_set_visible failed after stop:", e);
    });
    report("stopped");
  }, [masterActive, destinations, report]);

  // Derive the live/failed phase from per-destination transport statuses once
  // the master transport is active (all-error => failed, otherwise live).
  const enabledIds = destinations.filter((d) => d.enabled).map((d) => d.id);
  useEffect(() => {
    if (!masterActive) return;
    if (enabledIds.length === 0) return;
    const anyUp = enabledIds.some((id) => {
      const s = statuses[id];
      return s && (s.status === "live" || s.status === "connecting");
    });
    const allError = enabledIds.every((id) => {
      const s = statuses[id];
      return s && s.status === "error";
    });
    if (allError) {
      report("failed", "All enabled destinations failed to connect.");
    } else if (anyUp) {
      report("live");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterActive, statuses, enabledIds.join(",")]);

  const liveCount = Object.values(statuses).filter((s) => s.status === "live").length;
  const anyBusy = Object.values(statuses).some((s) => s.status === "live" || s.status === "connecting");
  const enabledCount = destinations.filter((d) => d.enabled).length;
  const destCapReached = destinations.length >= streamCaps.streamingDestinations;

  // Keep the compositor running while the tab is visible OR a stream is active,
  // so leaving the page mid-broadcast does not end the capture.
  const active = tabActive || masterActive;

  const value = useMemo<StreamingContextValue>(
    () => ({
      destinations,
      statuses,
      saving,
      stream,
      streamReady,
      anyBusy,
      liveCount,
      captureWidth,
      captureHeight,
      captureFps,
      streamBitrateKbps,
      setCapture: persistCapture,
      updateDestination,
      removeDestination,
      addDestination,
      registerHandle,
      reportStatus: handleStatus,
      goLive,
      stopAll,
      getSourceTracks,
      audioEnabled,
      setAudioEnabled,
      audioDevices,
      audioDeviceId,
      setAudioDeviceId,
      audioError,
      audioUnavailableReason,
      encoder,
      streamingBlocked,
      sharedAudioBlocked,
      rtmpBlockedReason,
      ndiBlockedReason,
      destCapReached,
      enabledCount,
    }),
    [destinations, statuses, saving, stream, streamReady, anyBusy, liveCount, captureWidth, captureHeight, captureFps, streamBitrateKbps, persistCapture, updateDestination, removeDestination, addDestination, registerHandle, handleStatus, goLive, stopAll, getSourceTracks, audioEnabled, setAudioEnabled, audioDevices, audioDeviceId, setAudioDeviceId, audioError, audioUnavailableReason, encoder, streamingBlocked, sharedAudioBlocked, rtmpBlockedReason, ndiBlockedReason, destCapReached, enabledCount]
  );

  return (
    <StreamingContext.Provider value={value}>
      {children}
      <div
        style={{ position: "fixed", left: -100000, top: 0, width: 1, height: 1, overflow: "hidden", pointerEvents: "none" }}
        aria-hidden
      >
        <ProgramFeedPreview
          geometry={{ width: captureWidth, height: captureHeight }}
          fps={captureFps}
          active={active}
          onStream={handleStream}
        />
      </div>
    </StreamingContext.Provider>
  );
}