import React, { useCallback, useEffect, useRef } from "react";
import { Play, Square, Mic, Trash2, Globe, KeyRound, Radio, MonitorPlay } from "lucide-react";
import { useStreamer } from "../../hooks/useStreamer";
import { useRtmpEncoder } from "../../hooks/useRtmpEncoder";
import { useNdiSender } from "../../hooks/useNdiSender";
import { PLATFORM_PRESETS, presetFor, applyPreset } from "./presets";
import type { StreamDestination, StreamPlatform } from "../../types";

export type DestTransportStatus = "idle" | "connecting" | "live" | "error";

export interface DestinationCardHandle {
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
}

interface DestinationCardProps {
  destination: StreamDestination;
  /** Resolved at start time so edits don't invalidate running transports. */
  getSourceTracks: () => { video: MediaStreamTrack | null; audio: MediaStreamTrack | null };
  onChange: (next: StreamDestination) => void;
  onRemove: () => void;
  onStatus: (id: string, status: DestTransportStatus, bitrateKbps: number) => void;
  onRegister: (id: string, handle: DestinationCardHandle | null) => void;
  /** Capability gate: when set, the transport is unavailable (e.g. RTMP
   *  needs ffmpeg + WebCodecs H.264) — the Go Live button is disabled and the
   *  reason is surfaced on the card. */
  blockedReason?: string | null;
}

function formatBitrate(kbps: number): string {
  if (kbps <= 0) return "—";
  if (kbps < 1000) return `${kbps} kbps`;
  return `${(kbps / 1000).toFixed(2)} Mbps`;
}

export function DestinationCard({
  destination: dest,
  getSourceTracks,
  onChange,
  onRemove,
  onStatus,
  onRegister,
  blockedReason,
}: DestinationCardProps) {
  const rtmp = useRtmpEncoder({ sessionId: dest.id });
  const streamer = useStreamer();
  const ndi = useNdiSender({ sessionId: dest.id });
  const streamRef = useRef<MediaStream | null>(null);

  const live = dest.mode === "rtmp" ? rtmp : dest.mode === "ndi" ? ndi : streamer;
  const active = live.status === "live" || live.status === "connecting";

  const start = useCallback(async (): Promise<boolean> => {
    if (active) return false;
    const { video, audio } = getSourceTracks();
    if (!video) return false;
    const v = video.clone();
    const a = dest.audio ? (audio ? audio.clone() : null) : null;
    const tracks: MediaStreamTrack[] = [v];
    if (a) tracks.push(a);
    const stream = new MediaStream(tracks);
    streamRef.current = stream;
    if (dest.mode === "rtmp") {
      return rtmp.start(stream, dest.url, dest.stream_key || undefined, a);
    }
    if (dest.mode === "ndi") {
      return ndi.start(stream, dest.label);
    }
    return streamer.start(stream, { url: dest.url, token: dest.stream_key });
  }, [active, dest, getSourceTracks, rtmp, ndi, streamer]);

  const stop = useCallback(async () => {
    if (dest.mode === "rtmp") {
      await rtmp.stop();
    } else if (dest.mode === "ndi") {
      await ndi.stop();
    } else {
      await streamer.stop();
    }
    const s = streamRef.current;
    if (s) {
      s.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [dest.mode, rtmp, ndi, streamer]);

  useEffect(() => {
    onRegister(dest.id, { start, stop });
    return () => onRegister(dest.id, null);
  }, [onRegister, dest.id, start, stop]);

  useEffect(() => {
    onStatus(dest.id, live.status, live.bitrateKbps);
  }, [dest.id, live.status, live.bitrateKbps, onStatus]);

  const preset = presetFor(dest.platform);
  const statusLabel =
    live.status === "live"
      ? "Live"
      : live.status === "connecting"
        ? "Connecting…"
        : live.status === "error"
          ? "Error"
          : "Offline";

  return (
    <div className={`rounded-lg border p-3 flex flex-col gap-2 ${live.status === "live" ? "border-red-700/60 bg-red-950/10" : "border-slate-700 bg-slate-900/40"}`}>
      <div className="flex items-center gap-2">
        <Radio size={11} className="text-slate-500" />
        <select
          value={dest.platform}
          onChange={(e) => onChange(applyPreset(dest, e.target.value as StreamPlatform))}
          disabled={active}
          className="px-1.5 py-1 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs focus:outline-none focus:border-slate-500"
        >
          {PLATFORM_PRESETS.map((p) => (
            <option key={p.platform} value={p.platform}>
              {p.label}
            </option>
          ))}
        </select>
        <input
          value={dest.label}
          onChange={(e) => onChange({ ...dest, label: e.target.value })}
          disabled={active}
          placeholder="Label"
          className="px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs focus:outline-none focus:border-slate-500 w-32"
        />
        <span
          className={`ml-auto px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${
            live.status === "live"
              ? "bg-red-600/20 border-red-600 text-red-400"
              : live.status === "connecting"
                ? "bg-amber-500/20 border-amber-500 text-amber-400"
                : live.status === "error"
                  ? "bg-red-900/40 border-red-800 text-red-500"
                  : "bg-slate-800 border-slate-700 text-slate-400"
          }`}
        >
          {statusLabel}
        </span>
        {live.status === "live" && (
          <span className="text-slate-500 font-mono text-[10px]">{formatBitrate(live.bitrateKbps)}</span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {dest.mode === "ndi" ? (
          <div className="flex items-center gap-2 text-[10px] text-slate-500">
            <MonitorPlay size={11} className="text-slate-500 shrink-0" />
            <span>
              Publishes as <span className="font-mono text-slate-300">Wordlyte – {dest.label || "…"}</span> on the LAN.
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Globe size={11} className="text-slate-500 shrink-0" />
            <input
              value={dest.url}
              onChange={(e) => onChange({ ...dest, url: e.target.value })}
              placeholder={preset.mode === "rtmp" ? "rtmp://ingest.server/live" : "https://example.com/whip/stream"}
              spellCheck={false}
              disabled={active}
              className="flex-1 px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs font-mono focus:outline-none focus:border-slate-500"
            />
          </div>
        )}
        {dest.mode === "rtmp" && (
          <div className="flex items-center gap-2">
            <KeyRound size={11} className="text-slate-500 shrink-0" />
            <input
              value={dest.stream_key ?? ""}
              onChange={(e) => onChange({ ...dest, stream_key: e.target.value })}
              placeholder="Stream key"
              spellCheck={false}
              type="password"
              disabled={active}
              className="flex-1 px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs font-mono focus:outline-none focus:border-slate-500"
            />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={dest.enabled}
            onChange={(e) => onChange({ ...dest, enabled: e.target.checked })}
            disabled={active}
            className="accent-cyan-500"
          />
          Master Go Live
        </label>
        <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={dest.audio}
            onChange={(e) => onChange({ ...dest, audio: e.target.checked })}
            disabled={active || dest.mode === "ndi"}
            title={dest.mode === "ndi" ? "NDI audio (AAC in the NDI|HX payload) lands with the SDK phase." : undefined}
            className="accent-cyan-500"
          />
          <Mic size={10} /> Audio
        </label>
        <div className="ml-auto flex items-center gap-2">
          {active ? (
            <button
              onClick={stop}
              className="px-3 py-1 rounded bg-red-600 hover:bg-red-500 text-white text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5"
            >
              <Square size={9} fill="currentColor" /> Stop
            </button>
          ) : (
            <button
              onClick={() => start()}
              disabled={(dest.mode !== "ndi" && !dest.url.trim()) || !!blockedReason}
              title={
                blockedReason
                  ? blockedReason
                  : dest.mode !== "ndi" && !dest.url.trim()
                    ? "Enter an ingest URL first"
                    : "Start this destination"
              }
              className="px-3 py-1 rounded bg-red-700 hover:bg-red-600 disabled:bg-slate-800 disabled:text-slate-500 text-white text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5"
            >
              <Play size={9} /> Go Live
            </button>
          )}
          <button
            onClick={onRemove}
            disabled={active}
            title="Remove destination"
            className="px-2 py-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-900/30 disabled:opacity-40 transition-all"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      {blockedReason && (
        <p className="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-800/60 rounded px-2 py-1">
          {blockedReason}
        </p>
      )}
      {live.status === "error" && live.error && (
        <p className="text-[10px] text-red-400 bg-red-900/30 border border-red-900 rounded px-2 py-1">{live.error}</p>
      )}
      {live.status === "live" && dest.mode === "whip" && streamer.resourceUrl && (
        <p className="text-[10px] text-emerald-500 bg-emerald-900/20 border border-emerald-900/50 rounded px-2 py-1 break-all">
          WHIP resource: {streamer.resourceUrl}
        </p>
      )}
      {!active && <p className="text-[10px] text-slate-600">{preset.hint}</p>}
    </div>
  );
}
