import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Radio, Play, Square, Plus, MonitorPlay, Mic } from "lucide-react";
import { useAppStore } from "../store";
import { useSystemDiagnostics } from "../system/SystemDiagnosticsContext";
import { tierCapabilities } from "../system/tiers";
import { ProgramSurfacePreview } from "./outputs/ProgramSurfacePreview";
import { useNativeRtmpBroadcast } from "../hooks/useNativeRtmpBroadcast";
import { useProgramAudio } from "../hooks/useProgramAudio";
import { DestinationCard } from "./streaming/DestinationCard";
import { PLATFORM_PRESETS, makeDestination, newDestinationId } from "./streaming/presets";
import { CAPTURE_RESOLUTIONS, CAPTURE_FPS_OPTIONS } from "../types";
import type { OutputConfig, StreamDestination, StreamPlatform } from "../types";

const STREAM_OUTPUT_ID = "stream-main";

/**
 * `StreamerTab` — Phase 6 Streaming Hub (backend-native).
 *
 * A single backend broadcast captures the dedicated off-screen `capture`
 * window's real pixels (Windows Graphics Capture — the same program DOM
 * surface as the audience `output` window) and fans them out to N ffmpeg
 * processes — one per enabled RTMP destination — each encoding rawvideo ->
 * libx264 -> FLV -> its RTMP ingest. The master Go Live All / Stop All
 * controls the whole broadcast; there is no per-destination independent
 * transport. Program audio (external mic / line-in) is a shared mix bus muxed
 * into every destination.
 *
 * The master preview is `ProgramSurfacePreview`, the same DOM renderer that
 * drives the output window — no second canvas renderer for the operator
 * console. Destinations persist on the `stream-main` output config
 * (`stream_destinations`) through `outputs_update`.
 */
export function StreamerTab() {
  const outputs = useAppStore((s) => s.outputs);
  const setOutputs = useAppStore((s) => s.setOutputs);
  const license = useAppStore((s) => s.license);
  const setToast = useAppStore((s) => s.setToast);

  // Capability gating (Phase 7): backend-native RTMP needs only ffmpeg.
  const { checks } = useSystemDiagnostics();
  const capabilities = checks?.capabilities;
  const rtmpBlockedReason = capabilities && !capabilities.rtmpAvailable ? capabilities.rtmpReason : null;
  const programAudio = useProgramAudio();

  // Tier gating: streaming is Pro+.
  const streamCaps = tierCapabilities(license?.tier);
  const streamingBlocked = !!license && license.status === "active" && !streamCaps.streaming;

  const [destinations, setDestinations] = useState<StreamDestination[]>([]);
  const [saving, setSaving] = useState(false);

  // Master backend broadcast transport + poller.
  const broadcast = useNativeRtmpBroadcast();
  const live = broadcast.status.active;

  const output: OutputConfig | undefined = outputs.find((o) => o.id === STREAM_OUTPUT_ID);
  const outputVisible = output?.visible === true;
  const captureWidth = output?.geometry.width ?? 1920;
  const captureHeight = output?.geometry.height ?? 1080;
  const captureFps = output?.capture_fps ?? 30;

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

  // Hydrate destinations from the persisted stream-main config (RTMP only).
  // Legacy WHIP/NDI destinations from before Phase 6 are dropped.
  useEffect(() => {
    if (!output) return;
    const stored = (output.stream_destinations ?? []).filter((d) => d.mode === "rtmp");
    if (stored.length > 0) {
      setDestinations(stored);
      return;
    }
    if (output.streaming?.mode === "rtmp" && output.streaming.url) {
      const legacy: StreamDestination = {
        id: newDestinationId(),
        label: "Custom RTMP",
        platform: "custom-rtmp",
        mode: "rtmp",
        url: output.streaming.url,
        stream_key: output.streaming.stream_key,
        enabled: true,
        audio: true,
      };
      setDestinations([legacy]);
      void persistDestinations([legacy]);
    }
  }, [output, persistDestinations]);

  const handleGoLive = async () => {
    if (streamingBlocked) {
      setToast("Streaming is a Pro feature. Upgrade in Settings → License.");
      return;
    }
    if (rtmpBlockedReason) {
      setToast(`RTMP is unavailable: ${rtmpBlockedReason}`);
      return;
    }
    await persistDestinations(destinations);
    try {
      await broadcast.goLive(destinations, captureWidth, captureHeight, captureFps, programAudio.enabled);
    } catch (e: any) {
      setToast(`Could not go live: ${e?.message ?? e}`);
    }
  };

  const handleStopAll = async () => {
    try {
      await broadcast.stopAll();
    } catch (e: any) {
      setToast(`Could not stop: ${e?.message ?? e}`);
    }
  };

  const enabledCount = destinations.filter((d) => d.enabled).length;
  const destCapReached = destinations.length >= streamCaps.streamingDestinations;
  const canGoLive = !live && !broadcast.pending && enabledCount > 0 && !rtmpBlockedReason && !streamingBlocked;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
          <Radio size={12} /> Streaming Hub
        </h2>
        <div className="flex items-center gap-2 text-[11px]">
          {live && (
            <span className="px-2 py-0.5 rounded-full border bg-red-600/20 border-red-600 text-red-400 font-bold uppercase tracking-wider">
              Live
            </span>
          )}
          {saving && <span className="text-slate-500 text-[10px]">Saving…</span>}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_1fr] gap-4">
        {/* DOM program preview + master transport */}
        <div className="flex flex-col gap-2">
          <div className="relative rounded-lg overflow-hidden border border-slate-700 bg-black" style={{ aspectRatio: "16/9" }}>
            <ProgramSurfacePreview className="absolute inset-0 w-full h-full" />
            {live && (
              <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded bg-red-600 text-white text-[10px] font-black uppercase tracking-widest">
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> LIVE
                {programAudio.enabled && (
                  <span className="ml-1 px-1 rounded bg-black/40 normal-case font-mono">+ AUD</span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {live || broadcast.pending ? (
              <button
                onClick={handleStopAll}
                disabled={broadcast.pending}
                className="flex-1 py-2.5 rounded-md bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
              >
                <Square size={11} fill="currentColor" /> Stop All
              </button>
            ) : (
              <button
                onClick={handleGoLive}
                disabled={!canGoLive}
                title={
                  streamingBlocked
                    ? "Streaming is a Pro feature"
                    : enabledCount === 0
                      ? "Enable at least one destination"
                      : rtmpBlockedReason
                        ? rtmpBlockedReason
                        : !outputVisible
                          ? "Open the output window first so it can be captured"
                          : "Go live on every enabled destination"
                }
                className="flex-1 py-2.5 rounded-md bg-red-700 hover:bg-red-600 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
              >
                <Play size={11} /> Go Live All
              </button>
            )}
          </div>

          {streamingBlocked && (
            <p className="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-800/60 rounded px-2 py-1.5">
              Streaming is a Pro feature — upgrade in Settings → License to go live.
            </p>
          )}

          {rtmpBlockedReason && (
            <p className="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-800/60 rounded px-2 py-1.5">
              RTMP destinations are disabled: {rtmpBlockedReason}
            </p>
          )}

          {!outputVisible && !rtmpBlockedReason && (
            <p className="text-[10px] text-slate-600">
              The output window is hidden — open it (Windowed Output) so the broadcast can capture its pixels.
            </p>
          )}

          {/* Capture resolution + fps for the streamed feed */}
          <div className="flex flex-wrap items-center gap-3 p-2 rounded-lg border border-slate-800 bg-slate-900/30">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <MonitorPlay size={11} className="text-slate-500" /> Capture
            </span>
            <select
              value={`${captureWidth}x${captureHeight}`}
              onChange={(e) => {
                const r = CAPTURE_RESOLUTIONS.find((r) => `${r.width}x${r.height}` === e.target.value);
                if (r) void persistCapture(r.width, r.height, captureFps);
              }}
              disabled={live || broadcast.pending}
              className="px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-200 text-[11px] focus:outline-none focus:border-slate-500"
              title="Stream resolution"
            >
              {CAPTURE_RESOLUTIONS.map((r) => (
                <option key={r.label} value={`${r.width}x${r.height}`}>
                  {r.label}
                </option>
              ))}
            </select>
            <select
              value={captureFps}
              onChange={(e) => void persistCapture(captureWidth, captureHeight, Number(e.target.value))}
              disabled={live || broadcast.pending}
              className="px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-200 text-[11px] focus:outline-none focus:border-slate-500"
              title="Stream frame rate"
            >
              {CAPTURE_FPS_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
            <span className="text-[10px] text-slate-600">
              The backend encodes the captured window with H.264 (libx264) — one encode per destination.
            </span>
          </div>

          {/* Program audio (external mic / line-in mix bus) */}
          <div className="flex flex-wrap items-center gap-3 p-2 rounded-lg border border-slate-800 bg-slate-900/30">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={programAudio.enabled}
                onChange={(e) => programAudio.setEnabled(e.target.checked)}
                className="accent-amber-500"
              />
              <span className="text-[11px] text-slate-300 flex items-center gap-1.5">
                <Mic size={11} className="text-slate-500" /> Program audio
              </span>
            </label>
            <select
              value={programAudio.deviceId ?? ""}
              onChange={(e) => programAudio.setDeviceId(e.target.value || null)}
              disabled={programAudio.devices.length === 0}
              className="px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-200 text-[11px] focus:outline-none focus:border-slate-500"
              title="External audio input to mux into every stream"
            >
              <option value="">Default input</option>
              {programAudio.devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Input ${d.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
            {programAudio.running && (
              <span className="text-[10px] text-emerald-400">Encoding input…</span>
            )}
            {programAudio.error && (
              <span className="text-[10px] text-red-400">{programAudio.error}</span>
            )}
            <span className="text-[10px] text-slate-600">
              Muxes an external mic / line-in (AAC) into every destination — no re-encode. Premium.
            </span>
          </div>
        </div>

        {/* Destinations */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Destinations</h3>
            <button
              onClick={() => addDestination("custom-rtmp")}
              disabled={live || broadcast.pending || streamingBlocked || destCapReached}
              title={destCapReached && !streamingBlocked ? "Your plan's destination limit reached" : undefined}
              className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 text-[10px] font-bold uppercase tracking-wider border border-slate-700 transition-all"
            >
              <Plus size={10} /> Add
            </button>
          </div>

          {destinations.length === 0 && (
            <p className="text-[11px] text-slate-600 p-3 rounded-lg border border-dashed border-slate-700">
              No destinations yet. Add YouTube, Facebook Live, Twitch, or a custom RTMP endpoint — the master
              transport streams to every enabled destination at once.
            </p>
          )}

          {destinations.map((d) => (
            <DestinationCard
              key={d.id}
              destination={d}
              onChange={updateDestination}
              onRemove={() => removeDestination(d.id)}
              status={broadcast.destStatus[d.id]?.status ?? "idle"}
              blockedReason={rtmpBlockedReason}
              live={live}
            />
          ))}

          <div className="flex items-center gap-1.5 pt-1">
            {PLATFORM_PRESETS.map((p) => (
              <button
                key={p.platform}
                onClick={() => addDestination(p.platform)}
                disabled={live || broadcast.pending || streamingBlocked || destCapReached}
                className="px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider border border-slate-700 bg-slate-800 text-slate-500 hover:text-cyan-400 hover:border-cyan-700 disabled:opacity-40 transition-all"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="text-[10px] text-slate-600">
        One backend broadcast captures the output window and fans the frames out to ffmpeg per destination (H.264 →
        FLV → RTMP). Program audio (external mic / line-in) is muxed as a second AAC input when enabled.
      </p>
    </div>
  );
}
