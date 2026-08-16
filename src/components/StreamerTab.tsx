import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Radio, Play, Square, Plus, Mic } from "lucide-react";
import { useAppStore } from "../store";
import { ProgramFeedPreview } from "./outputs/ProgramFeedPreview";
import { DestinationCard, type DestinationCardHandle, type DestTransportStatus } from "./streaming/DestinationCard";
import { PLATFORM_PRESETS, makeDestination, newDestinationId } from "./streaming/presets";
import type { OutputConfig, StreamDestination, StreamPlatform } from "../types";

const STREAM_OUTPUT_ID = "stream-main";

interface CardStatus {
  status: DestTransportStatus;
  bitrateKbps: number;
}

/**
 * `StreamerTab` — Phase 4/6/6.2 Streaming Hub.
 *
 * A single program-feed compositor fanning out to any number of destinations
 * simultaneously. Each destination is a platform preset (YouTube, Facebook,
 * Twitch, Custom RTMP / WHIP) with its own ingest endpoint and transport:
 *   - RTMP: WebCodecs H.264 (+ shared AAC audio) piped to a backend
 *     `ffmpeg -c copy` mux-only publish.
 *   - WHIP: WebView2-native WebRTC, sub-second latency.
 *
 * Master Go Live starts every enabled destination at once (the compositor video
 * track is cloned per destination; the shared input audio track is cloned too),
 * and Stop All tears everything down. Destinations persist on the `stream-main`
 * output config (`stream_destinations`) through `outputs_update`.
 */
export function StreamerTab() {
  const outputs = useAppStore((s) => s.outputs);
  const setOutputs = useAppStore((s) => s.setOutputs);

  const [destinations, setDestinations] = useState<StreamDestination[]>([]);
  const [statuses, setStatuses] = useState<Record<string, CardStatus>>({});
  const cardHandles = useRef<Map<string, DestinationCardHandle>>(new Map());
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  const [streamReady, setStreamReady] = useState(false);
  const [saving, setSaving] = useState(false);

  // Shared audio input (one source for every destination).
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [audioDeviceId, setAudioDeviceId] = useState("");
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioError, setAudioError] = useState<string | null>(null);

  const output: OutputConfig | undefined = outputs.find((o) => o.id === STREAM_OUTPUT_ID);

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
      setDestinations((prev) => {
        const updated = [...prev, makeDestination(platform, newDestinationId())];
        persistDestinations(updated);
        return updated;
      });
    },
    [persistDestinations]
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

  const handleStream = useCallback((stream: MediaStream | null) => {
    videoTrackRef.current = stream?.getVideoTracks()[0] ?? null;
    setStreamReady(!!videoTrackRef.current);
  }, []);

  const getSourceTracks = useCallback(
    () => ({ video: videoTrackRef.current, audio: audioTrackRef.current }),
    []
  );

  // Capture / release the shared audio input.
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

  const handleStatus = useCallback((id: string, status: DestTransportStatus, bitrateKbps: number) => {
    setStatuses((prev) => ({ ...prev, [id]: { status, bitrateKbps } }));
  }, []);

  const handleRegister = useCallback((id: string, handle: DestinationCardHandle | null) => {
    if (handle) cardHandles.current.set(id, handle);
    else cardHandles.current.delete(id);
  }, []);

  const handleGoLive = async () => {
    if (!streamReady) return;
    await persistDestinations(destinations);
    const enabled = destinations.filter((d) => d.enabled);
    for (const d of enabled) {
      const handle = cardHandles.current.get(d.id);
      if (handle) void handle.start();
    }
  };

  const handleStopAll = async () => {
    for (const d of destinations) {
      const handle = cardHandles.current.get(d.id);
      if (handle) await handle.stop();
    }
  };

  const liveCount = Object.values(statuses).filter((s) => s.status === "live").length;
  const anyBusy = Object.values(statuses).some((s) => s.status === "live" || s.status === "connecting");
  const enabledCount = destinations.filter((d) => d.enabled).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
          <Radio size={12} /> Streaming Hub
        </h2>
        <div className="flex items-center gap-2 text-[11px]">
          {liveCount > 0 && (
            <span className="px-2 py-0.5 rounded-full border bg-red-600/20 border-red-600 text-red-400 font-bold uppercase tracking-wider">
              {liveCount} live
            </span>
          )}
          {saving && <span className="text-slate-500 text-[10px]">Saving…</span>}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_1fr] gap-4">
        {/* Composer preview + master transport */}
        <div className="flex flex-col gap-2">
          <div className="relative rounded-lg overflow-hidden border border-slate-700 bg-black" style={{ aspectRatio: "16/9" }}>
            <ProgramFeedPreview
              geometry={{ width: 1920, height: 1080 }}
              fps={30}
              onStream={handleStream}
              className="absolute inset-0 w-full h-full"
            />
            {liveCount > 0 && (
              <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded bg-red-600 text-white text-[10px] font-black uppercase tracking-widest">
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> LIVE
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {anyBusy ? (
              <button
                onClick={handleStopAll}
                className="flex-1 py-2.5 rounded-md bg-red-600 hover:bg-red-500 text-white text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
              >
                <Square size={11} fill="currentColor" /> Stop All
              </button>
            ) : (
              <button
                onClick={handleGoLive}
                disabled={!streamReady || enabledCount === 0}
                title={
                  enabledCount === 0
                    ? "Enable at least one destination"
                    : !streamReady
                      ? "Program feed not ready"
                      : "Go live on every enabled destination"
                }
                className="flex-1 py-2.5 rounded-md bg-red-700 hover:bg-red-600 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
              >
                <Play size={11} /> Go Live All
              </button>
            )}
          </div>

          {!streamReady && <p className="text-[10px] text-slate-600">Program feed not ready yet…</p>}

          {/* Shared audio input */}
          <div className="flex flex-wrap items-center gap-3 p-2 rounded-lg border border-slate-800 bg-slate-900/30">
            <label className="flex items-center gap-2 text-[11px] text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={audioEnabled}
                onChange={(e) => setAudioEnabled(e.target.checked)}
                disabled={anyBusy}
                className="accent-cyan-500"
              />
              <Mic size={11} className="text-slate-500" /> Shared audio input
            </label>
            {audioEnabled && (
              <>
                <select
                  value={audioDeviceId}
                  onChange={(e) => setAudioDeviceId(e.target.value)}
                  disabled={anyBusy}
                  className="px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-200 text-[11px] focus:outline-none focus:border-slate-500 max-w-[260px]"
                >
                  {audioDevices.length === 0 && <option value="">Default input…</option>}
                  {audioDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Input ${audioDevices.indexOf(d) + 1}`}
                    </option>
                  ))}
                </select>
                <span className="text-[10px] text-slate-600">
                  Mic / line-in / mixer feed — AAC (128 kbps), audio processing off.
                </span>
              </>
            )}
            {audioError && <span className="text-[10px] text-red-400">{audioError}</span>}
          </div>
        </div>

        {/* Destinations */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Destinations</h3>
            <button
              onClick={() => addDestination("custom-rtmp")}
              disabled={anyBusy}
              className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 text-[10px] font-bold uppercase tracking-wider border border-slate-700 transition-all"
            >
              <Plus size={10} /> Add
            </button>
          </div>

          {destinations.length === 0 && (
            <p className="text-[11px] text-slate-600 p-3 rounded-lg border border-dashed border-slate-700">
              No destinations yet. Add YouTube, Facebook Live, Twitch, or a custom RTMP / WHIP endpoint — the master
              transport streams to every enabled destination at once.
            </p>
          )}

          {destinations.map((d) => (
            <DestinationCard
              key={d.id}
              destination={d}
              getSourceTracks={getSourceTracks}
              onChange={updateDestination}
              onRemove={() => removeDestination(d.id)}
              onStatus={handleStatus}
              onRegister={handleRegister}
            />
          ))}

          <div className="flex items-center gap-1.5 pt-1">
            {PLATFORM_PRESETS.map((p) => (
              <button
                key={p.platform}
                onClick={() => addDestination(p.platform)}
                disabled={anyBusy}
                className="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider border border-slate-700 bg-slate-800 text-slate-500 hover:text-cyan-400 hover:border-cyan-700 disabled:opacity-40 transition-all"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="text-[10px] text-slate-600">
        RTMP destinations encode the compositor once with WebCodecs (H.264, hardware-accelerated where available) and
        pipe it to a backend ffmpeg mux (`-c copy`, no re-encode). WHIP uses WebRTC for sub-second latency. ffmpeg must
        be on PATH for RTMP.
      </p>
    </div>
  );
}
