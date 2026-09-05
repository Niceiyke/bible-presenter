import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { useSystemDiagnostics } from "../system/SystemDiagnosticsContext";
import { tierCapabilities } from "../system/tiers";
import { wrapAdts } from "./useRtmpEncoder";

/**
 * Program audio (Phase 7) — the shared external-input mix bus.
 *
 * The program (output window + live content) is mixed at the PA/mixer and
 * returned to this app as a line-in / mic feed. `ProgramAudioProvider` captures
 * that input device (audio processing disabled so the PA mix is not mangled),
 * encodes it to AAC-LC with WebCodecs, wraps each frame in an ADTS header, and
 * feeds it to the backend as a second `-f adts` input that ffmpeg muxes
 * (`-c:a copy`, no re-encode) into every active recorder / streaming
 * destination. This is the Phase 7 expansion of the legacy `rtmp_send_audio`
 * loopback transport, factored into one app-level bus.
 *
 * The provider captures ONCE and sends every encoded packet to BOTH
 * `recording_send_audio` and `stream_rtmp_send_audio`. The backend returns
 * success-no-op when no recorder/broadcast session is active, so the tabs never
 * need to coordinate which surface is live — enabling program audio simply arms
 * the bus, and any recorder/streamer started with audio picks the packets up.
 */

const AAC_CODEC = "mp4a.40.2"; // AAC-LC — universal for ffmpeg/RTMP/MP4
const DEFAULT_BITRATE_KBPS = 128;

interface ProgramAudioContextValue {
  /** Master toggle — the external input bus is armed while true. */
  enabled: boolean;
  /** True while the capture + encode loop is actually running. */
  running: boolean;
  /** Enumerated audio input devices for the picker. */
  devices: MediaDeviceInfo[];
  /** Selected input device id (null = system default). */
  deviceId: string | null;
  /** Human-readable failure from the last enable attempt. */
  error: string | null;
  setEnabled: (flag: boolean) => void;
  setDeviceId: (id: string | null) => void;
  refreshDevices: () => Promise<void>;
}

const ProgramAudioContext = createContext<ProgramAudioContextValue | null>(null);

export function useProgramAudio(): ProgramAudioContextValue {
  const ctx = useContext(ProgramAudioContext);
  if (!ctx) throw new Error("useProgramAudio must be used within ProgramAudioProvider");
  return ctx;
}

export function ProgramAudioProvider({ children }: { children: ReactNode }) {
  const license = useAppStore((s) => s.license);
  const setToast = useAppStore((s) => s.setToast);
  const { checks } = useSystemDiagnostics();
  const capabilities = checks?.capabilities;

  const [enabled, setEnabledState] = useState(false);
  const [running, setRunning] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceIdState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enabledRef = useRef(enabled);
  const deviceRef = useRef(deviceId);
  const capabilityRef = useRef(capabilities);
  capabilityRef.current = capabilities;
  // Live count of audio consumers (recorder with audio + streaming destinations
  // with audio). The encoder runs only while this is > 0 so an armed-but-idle
  // bus stops paying for the AAC encode and its per-frame IPC.
  const consumersRef = useRef(0);

  const premium = !!license && license.status === "active" && tierCapabilities(license.tier).sharedAudioInput;
  const refreshDevices = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) {
        setDevices([]);
        return;
      }
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "audioinput"));
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  // Tear everything down cleanly on unmount.
  const cleanup = useCallback(() => {
    enabledRef.current = false;
    setRunning(false);
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  // The capture + encode loop. Runs once per `running` window; the encode
  // output callback closes over the current device/targets and sends the ADTS
  // packet to both the recorder and the streamer (backend no-ops the inactive
  // surface). Stop() on the input track and encoder.close() tear it down.
  useEffect(() => {
    if (!running) return;

    let track: MediaStreamTrack | null = null;
    let stream: MediaStream | null = null;
    let audioEncoder: AudioEncoder | null = null;
    let aborted = false;
    consumersRef.current = 0;
    const pollTimer = window.setInterval(() => {
      invoke<number>("program_audio_consumers")
        .then((n) => {
          consumersRef.current = n;
        })
        .catch(() => {});
    }, 1000);

    const fail = (message: string) => {
      if (aborted) return;
      setError(message);
      setToast(message);
      enabledRef.current = false;
      setEnabledState(false);
    };

    const startAudio = async () => {
      if (typeof AudioEncoder === "undefined" || typeof MediaStreamTrackProcessor === "undefined") {
        fail("WebCodecs audio encoding is not available in this webview.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceRef.current ? { exact: deviceRef.current } : undefined,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
      } catch (e: any) {
        fail(`Failed to open the audio input: ${e?.message ?? e}`);
        return;
      }
      track = stream.getAudioTracks()[0];
      if (!track) {
        fail("No audio input device was found.");
        return;
      }
      const settings = track.getSettings();
      const sampleRate = settings?.sampleRate ?? 48000;
      const channels = settings?.channelCount ?? 2;

      try {
        audioEncoder = new AudioEncoder({
          output: (chunk: EncodedAudioChunk) => {
            const buf = new Uint8Array(chunk.byteLength);
            chunk.copyTo(buf);
            let adts: Uint8Array;
            try {
              adts = wrapAdts(buf, sampleRate, channels);
            } catch {
              return; // unsupported sample rate — skip the frame
            }
            const dataBase64 = bytesToBase64(adts);
            if (!aborted && consumersRef.current > 0) {
              // One fan-out dispatch per frame: the backend routes to the
              // recording's feed and every audio-enabled streaming destination,
              // no-oping surfaces without an active session.
              invoke("program_audio_send", { dataBase64 }).catch(() => {});
            }
          },
          error: (e) => {
            if (!aborted) fail(`Audio encoder error: ${e?.message ?? e}`);
          },
        });
        audioEncoder.configure({
          codec: AAC_CODEC,
          sampleRate,
          numberOfChannels: channels,
          bitrate: DEFAULT_BITRATE_KBPS * 1000,
        });
      } catch (e: any) {
        fail(`Failed to create the audio encoder: ${e?.message ?? e}`);
        return;
      }

      // Drive the encoder from the input track.
      try {
        const processor = new MediaStreamTrackProcessor({ track });
        const reader = processor.readable.getReader();
        const readLoop = async () => {
          try {
            while (!aborted) {
              const { value, done } = await reader.read();
              if (done || !value) break;
              if (consumersRef.current > 0) {
                audioEncoder?.encode(value as AudioData);
              }
              value.close();
            }
          } catch {
            /* track ended / reader released */
          }
        };
        void readLoop();
      } catch {
        fail("Failed to start the audio input processor.");
      }
    };

    void startAudio();

    return () => {
      aborted = true;
      window.clearInterval(pollTimer);
      try {
        audioEncoder?.close();
      } catch {
        /* already closed */
      }
      if (track) {
        try {
          track.stop();
        } catch {
          /* already stopped */
        }
      }
      if (stream) {
        for (const t of stream.getTracks()) t.stop();
      }
    };
  }, [running, setToast]);

  const setEnabled = useCallback(
    (flag: boolean) => {
      if (flag === enabledRef.current) return;
      if (flag) {
        // Premium-gated: shared input is a Premium feature.
        if (license && license.status === "active" && !premium) {
          setToast("Shared audio input is a Premium feature. Upgrade in Settings → License.");
          return;
        }
        if (capabilityRef.current && !capabilityRef.current.audioAvailable) {
          setToast("No audio input device was detected — cannot enable program audio.");
          return;
        }
        setError(null);
      }
      enabledRef.current = flag;
      setEnabledState(flag);
      setRunning(flag);
    },
    [license, premium, setToast]
  );

  const setDeviceId = useCallback((id: string | null) => {
    deviceRef.current = id;
    setDeviceIdState(id);
  }, []);

  const value = useMemo<ProgramAudioContextValue>(
    () => ({ enabled, running, devices, deviceId, error, setEnabled, setDeviceId, refreshDevices }),
    [enabled, running, devices, deviceId, error, setEnabled, setDeviceId, refreshDevices]
  );

  return <ProgramAudioContext.Provider value={value}>{children}</ProgramAudioContext.Provider>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
