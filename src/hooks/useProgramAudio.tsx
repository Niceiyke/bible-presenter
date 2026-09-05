import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Program audio (Phase 7) — native input device selection.
 *
 * The program (output window + live content) is mixed at the PA/mixer and
 * returned to this app as a line-in / mic feed. Instead of capturing and
 * AAC-encoding that feed in the browser (WebCodecs) and shipping it to the
 * backend over fragile per-frame IPC, ffmpeg now captures the chosen input
 * device natively with DirectShow (`-f dshow -i "audio=NAME"`) and encodes it
 * to AAC as one of its own inputs — one process owns both the video pipe and
 * the audio device, so the two demuxers interleave natively and there is no
 * cross-process starvation (the previous loopback path died with `-10053`
 * whenever the browser-side encode stuttered for mediaMTX's readTimeout).
 *
 * This provider is just the device-picker state: it lists the machine's
 * DirectShow audio inputs via the backend `audio_devices` command and holds the
 * operator's selection. The Stringer/Recorder pass that selection down as
 * `audioDevice` to `stream_rtmp_start` / `recording_start`.
 */

interface ProgramAudioContextValue {
  /** Master toggle — while true the selected device rides every stream/recording. */
  enabled: boolean;
  /** Enumerated DirectShow audio input device names for the picker. */
  devices: string[];
  /** Selected device name (null = none / default). */
  device: string | null;
  setEnabled: (flag: boolean) => void;
  setDevice: (name: string | null) => void;
  refreshDevices: () => Promise<void>;
}

const ProgramAudioContext = createContext<ProgramAudioContextValue | null>(null);

export function useProgramAudio(): ProgramAudioContextValue {
  const ctx = useContext(ProgramAudioContext);
  if (!ctx) throw new Error("useProgramAudio must be used within ProgramAudioProvider");
  return ctx;
}

export function ProgramAudioProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);
  const [device, setDeviceState] = useState<string | null>(null);

  const refreshDevices = useCallback(async () => {
    try {
      const names = await invoke<string[]>("audio_devices");
      setDevices(names ?? []);
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  const setEnabled = useCallback((flag: boolean) => {
    setEnabledState(flag);
  }, []);

  const setDevice = useCallback((name: string | null) => {
    setDeviceState(name);
  }, []);

  const value = useMemo<ProgramAudioContextValue>(
    () => ({ enabled, devices, device, setEnabled, setDevice, refreshDevices }),
    [enabled, devices, device, setEnabled, setDevice, refreshDevices]
  );

  return <ProgramAudioContext.Provider value={value}>{children}</ProgramAudioContext.Provider>;
}