import React from "react";
import { Radio, Play, Square, Plus, MonitorPlay } from "lucide-react";
import { useStreaming } from "../hooks/useStreamingProvider";
import { DestinationCard } from "./streaming/DestinationCard";
import { PLATFORM_PRESETS } from "./streaming/presets";
import { CAPTURE_RESOLUTIONS, CAPTURE_FPS_OPTIONS } from "../types";
import { ProgramFeedPreview } from "./outputs/ProgramFeedPreview";

/**
 * `StreamerTab` — Phase D Streaming Hub.
 *
 * A thin view over the App-level `StreamingProvider`, which persists the
 * destination set and drives the engine sidecar's shared encoder + mux-only
 * ffmpeg publishes. Because the engine owns the pipeline, a broadcast survives
 * navigating to another workspace; the tab only previews the live program (a
 * canvas verification surface) and drives the controls.
 *
 * Each destination is an RTMP platform preset (YouTube, Facebook, Twitch,
 * Custom RTMP). WHIP/NDI presets remain configurable but their Go Live is
 * blocked — they move to the engine in a later phase. Audio moves to the
 * engine in a later phase too; the shared audio graph stays mounted for
 * operator monitoring only.
 *
 * Master Go Live starts every enabled RTMP destination at once; Stop All
 * tears them all down. The surface's lifecycle is reported to the OutputManager
 * (`starting`/`live`/`failed`/`stopping`/`stopped`) so every window agrees on
 * the stream's phase.
 */
export function StreamerTab() {
  const {
    destinations, statuses, saving,
    anyBusy, liveCount,
    captureWidth, captureHeight, captureFps, streamBitrateKbps, setCapture,
    updateDestination, removeDestination, addDestination,
    startDestination, stopDestination, goLive, stopAll,
    streamingBlocked, rtmpBlockedReason, transportUnavailable, enginePhaseBlockedReason, destCapReached, enabledCount,
  } = useStreaming();

  const enabledBlocked = destinations.some(
    (d) =>
      (d.enabled && d.mode === "rtmp" && (!!rtmpBlockedReason || transportUnavailable || !d.url.trim())) ||
      (d.enabled && d.mode !== "rtmp" && !!enginePhaseBlockedReason)
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
        {/* Program preview + master transport */}
        <div className="flex flex-col gap-2">
          <div className="relative rounded-lg overflow-hidden border border-slate-700 bg-black" style={{ aspectRatio: "16/9" }}>
            <ProgramFeedPreview
              className="absolute inset-0 w-full h-full"
              config={undefined}
              geometry={{ width: captureWidth, height: captureHeight }}
              fps={captureFps}
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
                onClick={() => void stopAll()}
                className="flex-1 py-2.5 rounded-md bg-red-600 hover:bg-red-500 text-white text-xs font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
              >
                <Square size={11} fill="currentColor" /> Stop All
              </button>
            ) : (
              <button
                onClick={() => void goLive()}
                disabled={enabledCount === 0 || enabledBlocked || streamingBlocked || transportUnavailable}
                title={
                  streamingBlocked
                    ? "Streaming is a Pro feature"
                    : transportUnavailable
                      ? "The engine sidecar is not running"
                      : enabledCount === 0
                        ? "Enable at least one destination"
                        : enabledBlocked
                          ? rtmpBlockedReason ?? enginePhaseBlockedReason ?? "A required service is unavailable"
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

          {transportUnavailable && (
            <p className="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-800/60 rounded px-2 py-1.5">
              The engine sidecar is not running — streaming is unavailable.
            </p>
          )}

          {rtmpBlockedReason && (
            <p className="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-800/60 rounded px-2 py-1.5">
              RTMP destinations are disabled: {rtmpBlockedReason}
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
              Engine encodes at ~{Math.round(streamBitrateKbps / 1000 * 10) / 10} Mbps (libx264, veryfast).
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
              No destinations yet. Add YouTube, Facebook Live, Twitch, or a custom RTMP endpoint — the engine's shared
              encoder streams to every enabled destination at once.
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
                sentPackets={s?.sentPackets ?? 0}
                droppedPackets={s?.droppedPackets ?? 0}
                queuedPackets={s?.queuedPackets ?? 0}
                onChange={updateDestination}
                onRemove={() => void removeDestination(d.id)}
                onStart={() => void startDestination(d.id)}
                onStop={() => void stopDestination(d.id)}
                blockedReason={
                  d.mode === "rtmp"
                    ? rtmpBlockedReason ?? (transportUnavailable ? "The engine sidecar is not running." : null)
                    : enginePhaseBlockedReason
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
        The engine encodes the compositor once with libx264 (H.264 Annex-B) and muxes it per destination with ffmpeg
        (`-c copy`, no re-encode). WHIP and NDI destinations move to the engine in a later phase; audio capture moves to
        the engine too.
      </p>
    </div>
  );
}