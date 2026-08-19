import React, { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useAppStore } from "../store";
import { tierCapabilities } from "../system/tiers";
import {
  getAudioGraphSnapshot,
  retryAudio,
  setAudioDeviceId,
  setAudioEnabled,
  setAudioMuted,
  setAudioVolume,
  setMonitorVolume as graphSetMonitorVolume,
  setMonitorMuted as graphSetMonitorMuted,
  subscribeAudioGraph,
  type AudioGraphStatus,
} from "../system/audioGraph";

/**
 * `AudioGraphProvider` — App-level owner of the shared audio graph (Phase 6).
 *
 * Recording and Streaming both draw their program audio from this one graph, so
 * the app holds a single input capture and a single mute/volume policy instead
 * of two independent getUserMedia pipelines. The provider is a thin React shell
 * over the module-level `audioGraph` external store (which survives workspace
 * navigation like the source registry).
 *
 * Shared audio input is a Premium feature: `setEnabled` refuses to turn it on
 * for a non-Premium license (matching the existing StreamerTab gate), and
 * `blocked` tells consumers to show the upgrade messaging.
 */
export type AudioErrorKind = "permission" | "device" | "unknown";

export interface AudioGraphContextValue {
  enabled: boolean;
  devices: MediaDeviceInfo[];
  deviceId: string;
  setDeviceId: (id: string) => void;
  setEnabled: (v: boolean) => void;
  volume: number;
  setVolume: (v: number) => void;
  muted: boolean;
  setMuted: (v: boolean) => void;
  /** The shared post-gain program audio track (recording + streaming). */
  programTrack: MediaStreamTrack | null;
  /** Independent monitor policy (P2-2 / WP8): the raw pre-gain input track for
   *  local operator monitoring. Program mute/volume never affects it. */
  monitorTrack: MediaStreamTrack | null;
  monitorVolume: number;
  setMonitorVolume: (v: number) => void;
  monitorMuted: boolean;
  setMonitorMuted: (v: boolean) => void;
  status: AudioGraphStatus;
  error: string | null;
  retry: () => void;
  /** True when shared audio is gated by the license tier (Premium required). */
  blocked: boolean;
}

const AudioGraphContext = createContext<AudioGraphContextValue | null>(null);

export function useAudioGraph(): AudioGraphContextValue {
  const ctx = useContext(AudioGraphContext);
  if (!ctx) throw new Error("useAudioGraph must be used within AudioGraphProvider");
  return ctx;
}

export function AudioGraphProvider({ children }: { children: ReactNode }) {
  const license = useAppStore((s) => s.license);
  const setToast = useAppStore((s) => s.setToast);
  const snapshot = useSyncExternalStore(subscribeAudioGraph, getAudioGraphSnapshot, getAudioGraphSnapshot);

  const blocked =
    !!license && license.status === "active" && !tierCapabilities(license.tier).sharedAudioInput;

  const setEnabled = useCallback(
    (v: boolean) => {
      if (v && blocked) {
        setToast("Shared audio input is a Premium feature. Upgrade in Settings → License.");
        return;
      }
      setAudioEnabled(v);
    },
    [blocked, setToast]
  );

  const setDeviceId = useCallback((id: string) => setAudioDeviceId(id), []);
  const setVolume = useCallback((v: number) => setAudioVolume(v), []);
  const setMuted = useCallback((m: boolean) => setAudioMuted(m), []);
  const setMonitorVolume = useCallback((v: number) => graphSetMonitorVolume(v), []);
  const setMonitorMuted = useCallback((m: boolean) => graphSetMonitorMuted(m), []);
  const retry = useCallback(() => retryAudio(), []);

  const value = useMemo<AudioGraphContextValue>(
    () => ({
      enabled: snapshot.enabled,
      devices: snapshot.devices,
      deviceId: snapshot.deviceId,
      setDeviceId,
      setEnabled,
      volume: snapshot.volume,
      setVolume,
      muted: snapshot.muted,
      setMuted,
      programTrack: snapshot.programTrack,
      monitorTrack: snapshot.monitorTrack,
      monitorVolume: snapshot.monitorVolume,
      setMonitorVolume,
      monitorMuted: snapshot.monitorMuted,
      setMonitorMuted,
      status: snapshot.status,
      error: snapshot.error,
      retry,
      blocked,
    }),
    [snapshot, setDeviceId, setEnabled, setVolume, setMuted, setMonitorVolume, setMonitorMuted, retry, blocked]
  );

  return <AudioGraphContext.Provider value={value}>{children}</AudioGraphContext.Provider>;
}
