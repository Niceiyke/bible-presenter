import { useState, useCallback, useRef } from "react";
import type { CameraSource, TallyState, WsInbound, WsCameraOffer, WsCameraIce } from "../types";
import { useSignaling } from "./useSignaling";
import { usePublisherPc } from "./usePublisherPc";
import { useRelayPc } from "./useRelayPc";

interface UseCameraManagerOptions {
  pin: string | null;
  /** Window label — only "main" acts as operator */
  windowLabel: string;
}

/**
 * Main camera manager hook (operator window only).
 * Composes signaling, publisher PCs, and relay PCs into one clean API.
 */
export function useCameraManager({ pin, windowLabel }: UseCameraManagerOptions) {
  const [sources, setSources] = useState<Map<string, CameraSource>>(new Map());
  const lastProgramRef = useRef<Record<string, string | null>>({ A: null, B: null });
  const sceneCameraHandlersRef = useRef<Map<string, (msg: WsCameraOffer | WsCameraIce) => void>>(new Map());

  // ── helpers ──────────────────────────────────────────────────────────────

  const upsertSource = useCallback((deviceId: string, patch: Partial<CameraSource>) => {
    setSources(prev => {
      const next = new Map(prev);
      const existing = next.get(deviceId);
      if (existing) {
        next.set(deviceId, { ...existing, ...patch });
      } else {
        next.set(deviceId, {
          deviceId,
          deviceName: patch.deviceName ?? deviceId.slice(0, 8),
          tally: "off",
          status: "connecting",
          connectedAt: Date.now(),
          quality: { updatedAtMs: 0 },
          previewStream: null,
          ...patch,
        });
      }
      return next;
    });
  }, []);

  // ── Publisher PCs (mobile → operator preview) ─────────────────────────

  const { handleOffer, addIce: addPublisherIce, attachVideo, getVideoTrack, closePc, closeAll: closeAllPcs } = usePublisherPc(
    (payload) => send(payload),
    // onTrack
    (deviceId, stream) => {
      upsertSource(deviceId, { previewStream: stream, status: "connected" });
    },
    // onStateChange
    (deviceId, state) => {
      const status = (state === "connected" || state === "completed") ? "connected"
        : (state === "failed" || state === "disconnected" || state === "closed") ? "disconnected"
        : "connecting";
      upsertSource(deviceId, { status });
    },
  );

  // ── Relay PCs (operator → output) ─────────────────────────────────────

  const { init: initRelay, handleAnswer: handleRelayAnswer, handleIce: handleRelayIce, setTrack, slotFromDeviceId, closeAll: closeAllRelays } = useRelayPc(
    (payload) => send(payload),
  );

  // ── Signaling ─────────────────────────────────────────────────────────

  const handleMessage = useCallback(async (msg: WsInbound) => {
    const m = msg as any;

    // ── Lifecycle ────────────────────────────────────────────────────────
    if (m.type === "camera_source_connected") {
      upsertSource(m.device_id, { deviceId: m.device_id, deviceName: m.device_name, status: "connecting" });
      return;
    }
    if (m.type === "camera_source_disconnected") {
      closePc(m.device_id);
      setSources(prev => { const next = new Map(prev); next.delete(m.device_id); return next; });
      return;
    }

    // ── Tally ────────────────────────────────────────────────────────────
    if (m.type === "tally_update") {
      upsertSource(m.device_id, { tally: m.tally as TallyState });
      return;
    }

    // ── Output relay answer/ICE ──────────────────────────────────────────
    if (m.cmd === "camera_answer") {
      const slot = slotFromDeviceId(m.device_id);
      if (slot) { await handleRelayAnswer(slot, m.sdp); return; }
    }
    if (m.cmd === "camera_ice" && m.device_id?.startsWith("hub_relay_")) {
      const slot = slotFromDeviceId(m.device_id);
      if (slot) { await handleRelayIce(slot, m.candidate); return; }
    }

    // ── Mobile offer/ICE → preview ────────────────────────────────────────
    if (m.cmd === "camera_offer") {
      const sceneHandler = sceneCameraHandlersRef.current.get(m.device_id);
      if (sceneHandler) { sceneHandler(m); return; }
      upsertSource(m.device_id, { deviceId: m.device_id, deviceName: m.device_name ?? m.device_id.slice(0, 8), status: "connecting" });
      await handleOffer(m.device_id, m.device_name, m.sdp);
      return;
    }
    if (m.cmd === "camera_ice") {
      const sceneHandler = sceneCameraHandlersRef.current.get(m.device_id);
      if (sceneHandler) { sceneHandler(m); return; }
      await addPublisherIce(m.device_id, m.candidate);
      return;
    }

    // ── Output ready: init/reinit relay ───────────────────────────────────
    if (m.cmd === "output_ready") {
      await initRelay("A");
      await initRelay("B");
      return;
    }

    // ── Telemetry ─────────────────────────────────────────────────────────
    if (m.cmd === "camera_telemetry") {
      upsertSource(m.device_id, {
        quality: {
          batteryPct: m.battery,
          resolutionW: m.resolution_w,
          resolutionH: m.resolution_h,
          rttMs: m.rtt_ms,
          bitrateKbps: m.bitrate_kbps,
          updatedAtMs: Date.now(),
        },
      });
      return;
    }
  }, [upsertSource, closePc, slotFromDeviceId, handleRelayAnswer, handleRelayIce, handleOffer, addPublisherIce, initRelay]);

  const { send, wsRef } = useSignaling({
    pin: windowLabel === "main" ? pin : null,
    clientType: "window:main",
    onMessage: handleMessage,
    onConnected: () => {
      send({ cmd: "request_all_offers" });
      initRelay("A");
      initRelay("B");
    },
  });

  // ── Public API ────────────────────────────────────────────────────────

  /** Switch program output to a device (slot A). null = black. */
  const setProgram = useCallback((deviceId: string | null, slot: "A" | "B" = "A") => {
    // Tally: tell server about change
    const prev = lastProgramRef.current[slot];
    if (prev !== deviceId) {
      if (prev) send({ cmd: "camera_disconnect_program", device_id: prev });
      if (deviceId) send({ cmd: "camera_connect_program", device_id: deviceId });
      lastProgramRef.current[slot] = deviceId;
    }
    // Forward track to relay
    const track = deviceId ? getVideoTrack(deviceId) : null;
    setTrack(slot, track);
  }, [send, getVideoTrack, setTrack]);

  /** Attach a <video> element to receive preview for a device. */
  const attachPreview = useCallback((deviceId: string, el: HTMLVideoElement | null) => {
    attachVideo(deviceId, el);
  }, [attachVideo]);

  const registerSceneHandler = useCallback((deviceId: string, handler: (msg: WsCameraOffer | WsCameraIce) => void) => {
    sceneCameraHandlersRef.current.set(deviceId, handler);
  }, []);

  const unregisterSceneHandler = useCallback((deviceId: string) => {
    sceneCameraHandlersRef.current.delete(deviceId);
  }, []);

  return {
    sources,
    attachPreview,
    setProgram,
    wsRef,
    registerSceneHandler,
    unregisterSceneHandler,
  };
}
