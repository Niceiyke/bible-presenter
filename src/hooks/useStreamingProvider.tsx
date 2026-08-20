import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { useSystemDiagnostics } from "../system/SystemDiagnosticsContext";
import { tierCapabilities } from "../system/tiers";
import { reportOutputState, setOutputVisible, STREAM_OUTPUT_ID } from "./outputRuntime";
import { useEngineTransport } from "./useEngineTransport";
import { makeDestination, newDestinationId } from "../components/streaming/presets";
import type { DestTransportStatus } from "../components/streaming/DestinationCard";
import type { OutputPhase, StreamDestination, StreamPlatform } from "../types";
import type { TransportStatus } from "../types/engine";

/**
 * `StreamingProvider` — App-level owner of the streaming hub (Phase D).
 *
 * The pipeline moved into the `wordlyte-engine` sidecar: one shared H.264
 * ffmpeg encoder, fanned to a mux-only ffmpeg publish per RTMP destination.
 * The provider is a thin app-scoped owner that persists the destination set
 * and capture settings on the `stream-main` output, persists operator intent
 * through the OutputManager (`starting`/`live`/`failed`/`stopping`/`stopped`),
 * drives the engine's `rtmp_start`/`rtmp_stop`, and reconciles per-destination
 * status from the engine's `rtmp_status` poll — so a broadcast survives
 * navigating away from the Streaming workspace and a dead ffmpeg surfaces as
 * `failed` instead of a silent ghost session.
 *
 * It never touches the presentation engine, so a failed stream can never
 * change live program state. Webview audio into the transport moves to the
 * engine in a later phase; WHIP/NDI destinations move too (their Go Live is
 * blocked with a forward-looking reason).
 */

export interface CardStatus {
  status: DestTransportStatus;
  bitrateKbps: number;
  /** Transport error message (engine session failure causes). */
  error?: string | null;
  /** WHIP resource URL — unused in Phase D (WHIP moves to the engine). */
  resourceUrl?: string | null;
  /** Bytes written to the session's muxer since it started. */
  sentPackets?: number;
  /** Bytes dropped by the bounded queue since it started. */
  droppedPackets?: number;
  /** Bytes currently buffered awaiting the session's writer thread. */
  queuedPackets?: number;
  /** 1-based reconnect attempt in progress (0 = not reconnecting). */
  reconnectAttempt?: number;
}

interface StreamingContextValue {
  destinations: StreamDestination[];
  statuses: Record<string, CardStatus>;
  saving: boolean;
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
  startDestination: (id: string) => Promise<boolean>;
  stopDestination: (id: string) => Promise<void>;
  goLive: () => Promise<void>;
  stopAll: () => Promise<void>;
  streamingBlocked: boolean;
  /** ffmpeg missing (bundled or PATH) — RTMP destinations are disabled. */
  rtmpBlockedReason: string | null;
  /** Engine transport unreachable (sidecar down) — no destination can start. */
  transportUnavailable: boolean;
  /** WHIP/NDI destinations can't start in Phase D. */
  enginePhaseBlockedReason: string | null;
  destCapReached: boolean;
  enabledCount: number;
}

const StreamingContext = createContext<StreamingContextValue | null>(null);

export function useStreaming(): StreamingContextValue {
  const ctx = useContext(StreamingContext);
  if (!ctx) throw new Error("useStreaming must be used within StreamingProvider");
  return ctx;
}

const PHASE_BLOCKED_REASON = "WHIP and NDI move to the engine in a later phase — RTMP destinations work now.";

export function StreamingProvider({ children }: { children: ReactNode }) {
  const tabActive = useAppStore((s) => s.activeTab === "streaming");
  const license = useAppStore((s) => s.license);
  const setToast = useAppStore((s) => s.setToast);
  const outputs = useAppStore((s) => s.outputs);
  const setOutputs = useAppStore((s) => s.setOutputs);

  // Capability gating (Phase 7): RTMP needs ffmpeg (the engine encodes).
  const { checks } = useSystemDiagnostics();
  const capabilities = checks?.capabilities;
  const rtmpBlockedReason = capabilities && !capabilities.rtmpAvailable ? capabilities.rtmpReason : null;

  // Tier gating: streaming is Pro+.
  const streamCaps = tierCapabilities(license?.tier);
  const streamingBlocked = !!license && license.status === "active" && !streamCaps.streaming;

  const output = outputs.find((o) => o.id === STREAM_OUTPUT_ID);

  const captureWidth = output?.geometry.width ?? 1920;
  const captureHeight = output?.geometry.height ?? 1080;
  const captureFps = output?.capture_fps ?? 30;
  // The engine encodes at ~0.1 bpp; derive a sensible bitrate reference from
  // the chosen resolution/fps (shown as an informational number only — the
  // engine's libx264 uses its own rate control).
  const streamBitrateKbps = Math.max(1000, Math.min(40000, Math.round((captureWidth * captureHeight * captureFps * 0.1) / 1000 / 500) * 500));

  const [destinations, setDestinations] = useState<StreamDestination[]>([]);
  const [statuses, setStatuses] = useState<Record<string, CardStatus>>({});
  const [saving, setSaving] = useState(false);
  const [masterActive, setMasterActive] = useState(false);
  const liveIdsRef = useRef<Set<string>>(new Set());

  // Poll the engine's RTMP sessions while the tab is open OR a broadcast is
  // active (so an unexpected engine-side stop is caught even away).
  const transport = useEngineTransport(tabActive || masterActive);
  const { rtmp: rtmpSessions, connected: transportConnected } = transport;
  const transportUnavailable = !transportConnected;

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

  // Derive per-destination status from the engine's session table.
  useEffect(() => {
    const next: Record<string, CardStatus> = {};
    for (const d of destinations) {
      if (d.mode !== "rtmp") continue;
      const session: TransportStatus | undefined = rtmpSessions[d.id];
      if (session && session.active) {
        next[d.id] = {
          status: "live",
          bitrateKbps: streamBitrateKbps,
          sentPackets: session.sent,
          droppedPackets: session.dropped,
          queuedPackets: session.queued,
        };
      } else if (liveIdsRef.current.has(d.id)) {
        // A previously-live destination lost its session — the engine's muxer
        // exited (crash / network failure / stop).
        next[d.id] = { status: "error", bitrateKbps: 0, error: "Stream ended (the engine's ffmpeg exited)." };
      } else {
        next[d.id] = { status: "idle", bitrateKbps: 0 };
      }
    }
    setStatuses(next);
  }, [destinations, rtmpSessions, streamBitrateKbps]);

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
    async (id: string) => {
      // Stop the engine session BEFORE persisting the removal, so an active
      // transport is never left orphaned by a config delete.
      await stopDestination(id);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /** Start one destination's engine session (RTMP only this phase). */
  const startDestination = useCallback(
    async (id: string): Promise<boolean> => {
      const d = destinations.find((x) => x.id === id);
      if (!d) return false;
      if (d.mode !== "rtmp") {
        setToast(PHASE_BLOCKED_REASON);
        return false;
      }
      if (d.url.trim() === "") return false;
      try {
        await invoke("rtmp_start", {
          sessionId: d.id,
          serverUrl: d.url,
          streamKey: d.stream_key ?? null,
          withAudio: false,
          fps: captureFps,
        });
        liveIdsRef.current.add(d.id);
        setStatuses((prev) => ({
          ...prev,
          [id]: { status: "live", bitrateKbps: streamBitrateKbps, error: null },
        }));
        return true;
      } catch (e: any) {
        setStatuses((prev) => ({
          ...prev,
          [id]: { status: "error", bitrateKbps: 0, error: e?.message ?? String(e) },
        }));
        return false;
      }
    },
    [destinations, captureFps, streamBitrateKbps, setToast]
  );

  const stopDestination = useCallback(async (id: string): Promise<void> => {
    liveIdsRef.current.delete(id);
    try {
      await invoke("rtmp_stop", { sessionId: id });
    } catch (e: any) {
      console.error("rtmp_stop failed:", e);
    }
  }, []);

  const goLive = useCallback(async () => {
    if (streamingBlocked) {
      setToast("Streaming is a Pro feature. Upgrade in Settings → License.");
      return;
    }
    if (transportUnavailable) {
      setToast("The engine sidecar is not running — streaming is unavailable.");
      return;
    }
    const enabled = destinations.filter((d) => d.enabled);
    // Enforce the plan's destination cap (defense in depth beyond the Add
    // button).
    if (enabled.length > streamCaps.streamingDestinations) {
      report("failed", `Your plan supports ${streamCaps.streamingDestinations} simultaneous destination${streamCaps.streamingDestinations === 1 ? "" : "s"}.`);
      return;
    }
    const rtmpDests = enabled.filter((d) => d.mode === "rtmp");
    if (rtmpDests.length === 0) {
      setToast(PHASE_BLOCKED_REASON);
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
    let started = 0;
    for (const d of rtmpDests) {
      if (await startDestination(d.id)) started += 1;
    }
    if (started > 0) report("live");
    else report("failed", "No destination could connect.");
  }, [streamingBlocked, transportUnavailable, setToast, persistDestinations, destinations, streamCaps, report, startDestination]);

  const stopAll = useCallback(async () => {
    if (!masterActive) return;
    report("stopping");
    for (const d of destinations) {
      if (d.mode === "rtmp") await stopDestination(d.id);
    }
    setMasterActive(false);
    await setOutputVisible(STREAM_OUTPUT_ID, false).catch((e: any) => {
      console.error("outputs_set_visible failed after stop:", e);
    });
    report("stopped");
  }, [masterActive, destinations, report, stopDestination]);

  // Reconcile the master phase: while active, if every enabled RTMP
  // destination errored, the surface is `failed`.
  const enabledRtmpIds = destinations.filter((d) => d.enabled && d.mode === "rtmp").map((d) => d.id);
  useEffect(() => {
    if (!masterActive) return;
    if (enabledRtmpIds.length === 0) return;
    const allError = enabledRtmpIds.every((id) => statuses[id]?.status === "error");
    const anyUp = enabledRtmpIds.some((id) => statuses[id]?.status === "live");
    if (allError) {
      report("failed", "All enabled destinations failed to connect.");
    } else if (anyUp) {
      report("live");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterActive, statuses, enabledRtmpIds.join(",")]);

  const liveCount = Object.values(statuses).filter((s) => s.status === "live").length;
  const anyBusy = Object.values(statuses).some((s) => s.status === "live" || s.status === "connecting");
  const enabledCount = destinations.filter((d) => d.enabled).length;
  const destCapReached = destinations.length >= streamCaps.streamingDestinations;

  const value = useMemo<StreamingContextValue>(
    () => ({
      destinations,
      statuses,
      saving,
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
      startDestination,
      stopDestination,
      goLive,
      stopAll,
      streamingBlocked,
      rtmpBlockedReason,
      transportUnavailable,
      enginePhaseBlockedReason: PHASE_BLOCKED_REASON,
      destCapReached,
      enabledCount,
    }),
    [destinations, statuses, saving, anyBusy, liveCount, captureWidth, captureHeight, captureFps, streamBitrateKbps, persistCapture, updateDestination, removeDestination, addDestination, startDestination, stopDestination, goLive, stopAll, streamingBlocked, rtmpBlockedReason, transportUnavailable, destCapReached, enabledCount]
  );

  return <StreamingContext.Provider value={value}>{children}</StreamingContext.Provider>;
}