import React, { useEffect, useRef } from "react";
import { Radio, Play, Square, Plus, Mic, MonitorPlay } from "lucide-react";
import { useStreaming } from "../hooks/useStreamingProvider";
import { DestinationCard } from "./streaming/DestinationCard";
import { PLATFORM_PRESETS } from "./streaming/presets";
import { CAPTURE_RESOLUTIONS, CAPTURE_FPS_OPTIONS } from "../types";

/**
 * `StreamerTab` — Phase 4/6/6.2 Streaming Hub.
 *
 * A thin view over the App-level `StreamingProvider`, which owns the shared
 * program-feed compositor, the destination set, the shared audio input, and the
 * master transport. Because the pipeline lives at app scope, a broadcast
 * survives navigating to another workspace; the tab only previews the live
 * composited stream (a `<video>` bound to the provider's stream) and drives its
 * controls.
 *
 * Each destination is a platform preset (YouTube, Facebook, Twitch, Custom
 * RTMP / WHIP) with its own ingest endpoint and transport:
 *   - RTMP: WebCodecs H.264 (+ shared AAC audio) piped to a backend
 *     `ffmpeg -c copy` mux-only publish.
 *   - WHIP: WebView2-native WebRTC, sub-second latency.
 *
 * Master Go Live starts every enabled destination at once (the compositor video
 * track is cloned per destination; the shared input audio track is cloned too),
 * and Stop All tears everything down. The surface's lifecycle is reported to
 * the OutputManager (`starting`/`live`/`failed`/`stopping`/`stopped`) so every
 * window agrees on the stream's phase.
 */
export function StreamerTab() {
  const {
    destinations, statuses, saving,
    stream, streamReady, anyBusy, liveCount,
    captureWidth, captureHeight, captureFps, streamBitrateKbps, setCapture,
    updateDestination, removeDestination, addDestination,
    startDestination, stopDestination, goLive, stopAll,
    audioEnabled, setAudioEnabled, audioDevices, audioDeviceId, setAudioDeviceId, audioError, audioUnavailableReason,
    encoder,
    streamingBlocked, sharedAudioBlocked, rtmpBlockedReason, ndiBlockedReason, destCapReached, enabledCount,
  } = useStreaming();

  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);

  const enabledBlocked = destinations.some(
    (d) =>
      (d.enabled && d.mode === "rtmp" && !!rtmpBlockedReason) ||
      (d.enabled && d.mode === "ndi" && !!ndiBlockedReason)
  );

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
            {streamReady ? (
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="absolute inset-0 w-full h-full object-contain"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-slate-600 text-xs">
                Program feed idle — open a live item to preview.
              </div>
            )}
            {liveCount > 0 && (
              <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-1 rounded bg-red-600 text-white text-[10px] font-black uppercase tracking-widest">
                <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> LIVE
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {anyBusy ? (
              <button
                onClick={() => void stopAll()}
                className="flex-1 py-2.5 rounded-md bg-red-600 hover:bg-red-500 text-white text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
              >
                <Square size={11} fill="currentColor" /> Stop All
              </button>
            ) : (
              <button
                onClick={() => void goLive()}
                disabled={!streamReady || enabledCount === 0 || enabledBlocked || streamingBlocked}
                title={
                  streamingBlocked
                    ? "Streaming is a Pro feature"
                    : enabledCount === 0
                      ? "Enable at least one destination"
                      : enabledBlocked
                        ? ndiBlockedReason ?? rtmpBlockedReason ?? "A required service is unavailable"
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

          {streamingBlocked && (
            <p className="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-800/60 rounded px-2 py-1.5">
              Streaming is a Pro feature — upgrade in Settings → License to go live.
            </p>
          )}

          {!streamReady && <p className="text-[10px] text-slate-600">Program feed not ready yet…</p>}

          {encoder.status === "live" && (
            <p className="text-[10px] text-slate-500">
              Shared H.264 encoder: {encoder.activeConsumers} destination{encoder.activeConsumers === 1 ? "" : "s"} ·{" "}
              {encoder.packetsEncoded} packets ·{" "}
              {encoder.packetsDropped > 0 ? (
                <span className="text-amber-400">{encoder.packetsDropped} dropped (queue pressure)</span>
              ) : (
                "0 dropped"
              )}
            </p>
          )}
          {encoder.status === "error" && (
            <p className="text-[10px] text-red-400 bg-red-900/30 border border-red-900 rounded px-2 py-1.5">
              Program encoder failed: {encoder.error ?? "unknown error"}
            </p>
          )}

          {rtmpBlockedReason && (
            <p className="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-800/60 rounded px-2 py-1.5">
              RTMP destinations are disabled: {rtmpBlockedReason}
            </p>
          )}

          {ndiBlockedReason && (
            <p className="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-800/60 rounded px-2 py-1.5">
              NDI destinations are disabled: {ndiBlockedReason}
            </p>
          )}

          {/* Shared audio input */}
          <div className="flex flex-wrap items-center gap-3 p-2 rounded-lg border border-slate-800 bg-slate-900/30">
            <label className="flex items-center gap-2 text-[11px] text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={audioEnabled}
                onChange={(e) => setAudioEnabled(e.target.checked)}
                disabled={anyBusy || sharedAudioBlocked}
                title={sharedAudioBlocked ? "Shared audio input is a Premium feature" : undefined}
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
            {!audioError && sharedAudioBlocked && (
              <span className="text-[10px] text-amber-400">
                Shared audio input is a Premium feature.
              </span>
            )}
            {!audioError && !sharedAudioBlocked && audioUnavailableReason && (
              <span className="text-[10px] text-amber-400">{audioUnavailableReason}</span>
            )}
          </div>

          {/* Capture resolution + fps for the streamed feed */}
          <div className="flex flex-wrap items-center gap-3 p-2 rounded-lg border border-slate-800 bg-slate-900/30">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <MonitorPlay size={11} className="text-slate-500" /> Capture
            </span>
            <select
              value={`${captureWidth}x${captureHeight}`}
              onChange={(e) => {
                const r = CAPTURE_RESOLUTIONS.find((r) => `${r.width}x${r.height}` === e.target.value);
                if (r) void setCapture(r.width, r.height, captureFps);
              }}
              disabled={anyBusy}
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
              onChange={(e) => void setCapture(captureWidth, captureHeight, Number(e.target.value))}
              disabled={anyBusy}
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
              H.264 at ~{Math.round(streamBitrateKbps / 1000 * 10) / 10} Mbps — bitrate auto-derived from resolution/fps.
            </span>
          </div>
        </div>

        {/* Destinations */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Destinations</h3>
            <button
              onClick={() => addDestination("custom-rtmp")}
              disabled={anyBusy || streamingBlocked || destCapReached}
              title={destCapReached && !streamingBlocked ? "Your plan's destination limit reached" : undefined}
              className="flex items-center gap-1 px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 text-[10px] font-bold uppercase tracking-wider border border-slate-700 transition-all"
            >
              <Plus size={10} /> Add
            </button>
          </div>

          {destinations.length === 0 && (
            <p className="text-[11px] text-slate-600 p-3 rounded-lg border border-dashed border-slate-700">
              No destinations yet. Add YouTube, Facebook Live, Twitch, NDI, or a custom RTMP / WHIP endpoint — the
              master transport streams to every enabled destination at once.
            </p>
          )}

          {destinations.map((d) => {
            const s = statuses[d.id];
            return (
              <DestinationCard
                key={d.id}
                destination={d}
                status={s?.status ?? "idle"}
                bitrateKbps={s?.bitrateKbps ?? 0}
                error={s?.error ?? null}
                resourceUrl={s?.resourceUrl ?? null}
                sentPackets={s?.sentPackets ?? 0}
                droppedPackets={s?.droppedPackets ?? 0}
                queuedPackets={s?.queuedPackets ?? 0}
                onChange={updateDestination}
                onRemove={() => void removeDestination(d.id)}
                onStart={() => void startDestination(d.id)}
                onStop={() => void stopDestination(d.id)}
                blockedReason={
                  d.mode === "rtmp" ? rtmpBlockedReason : d.mode === "ndi" ? ndiBlockedReason : null
                }
              />
            );
          })}

          <div className="flex items-center gap-1.5 pt-1">
            {PLATFORM_PRESETS.map((p) => (
              <button
                key={p.platform}
                onClick={() => addDestination(p.platform)}
                disabled={anyBusy || streamingBlocked || destCapReached}
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
        pipe it to a backend ffmpeg mux (`-c copy`, no re-encode). WHIP uses WebRTC for sub-second latency. NDI
        destinations publish the same encode as an NDI|HX source on the LAN (needs the NDI SDK).
      </p>
    </div>
  );
}