import React from "react";
import { Play, Square, Mic, Trash2, Globe, KeyRound, Radio, MonitorPlay } from "lucide-react";
import { presetFor, applyPreset, PLATFORM_PRESETS } from "./presets";
import type { StreamDestination, StreamPlatform } from "../../types";

export type DestTransportStatus = "idle" | "connecting" | "live" | "error" | "reconnecting";

export interface DestinationCardHandle {
  start: () => Promise<boolean>;
  stop: () => Promise<void>;
}

interface DestinationCardProps {
  destination: StreamDestination;
  /** Transport status reported by the app-scoped `DestinationRuntime`. */
  status: DestTransportStatus;
  bitrateKbps: number;
  error: string | null;
  /** WHIP resource URL (reported by the WHIP transport runtime). */
  resourceUrl: string | null;
  /** Packets written to the backend since the destination started. */
  sentPackets?: number;
  /** Packets dropped by the bounded queue since the destination started. */
  droppedPackets?: number;
  /** Packets currently buffered awaiting the backend writer thread. */
  queuedPackets?: number;
  onChange: (next: StreamDestination) => void;
  onRemove: () => void;
  onStart: () => void;
  onStop: () => void;
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

/**
 * `DestinationCard` — UI-only editor for one streaming destination (WP2 P0-1).
 *
 * The transport hooks that used to live here are owned by the app-scoped
 * `DestinationRuntime` (rendered inside `StreamingProvider`), so this card can
 * unmount when the operator navigates away without stopping an active stream.
 * The card only consumes the runtime's reported status and drives its
 * start/stop through the provider's registered handle.
 */
export function DestinationCard({
  destination: dest,
  status,
  bitrateKbps,
  error,
  resourceUrl,
  sentPackets = 0,
  droppedPackets = 0,
  queuedPackets = 0,
  onChange,
  onRemove,
  onStart,
  onStop,
  blockedReason,
}: DestinationCardProps) {
  const active = status === "live" || status === "connecting" || status === "reconnecting";

  const preset = presetFor(dest.platform);
  const statusLabel =
    status === "live"
      ? "Live"
      : status === "reconnecting"
        ? "Reconnecting…"
        : status === "connecting"
          ? "Connecting…"
          : status === "error"
            ? "Error"
            : "Offline";

  return (
    <div className={`rounded-lg border p-3 flex flex-col gap-2 ${status === "live" ? "border-red-700/60 bg-red-950/10" : "border-slate-700 bg-slate-900/40"}`}>
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
            status === "live"
              ? "bg-red-600/20 border-red-600 text-red-400"
              : status === "reconnecting"
                ? "bg-amber-500/20 border-amber-500 text-amber-400"
                : status === "connecting"
                  ? "bg-amber-500/20 border-amber-500 text-amber-400"
                  : status === "error"
                    ? "bg-red-900/40 border-red-800 text-red-500"
                    : "bg-slate-800 border-slate-700 text-slate-400"
          }`}
        >
          {statusLabel}
        </span>
        {status === "live" && (
          <span className="text-slate-500 font-mono text-[10px]">{formatBitrate(bitrateKbps)}</span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {dest.mode === "ndi" ? (
          <div className="flex items-center gap-2 text-[10px] text-slate-500">
            <MonitorPlay size={11} className="text-slate-500 shrink-0" />
            <span>
              Publishes as <span className="font-mono text-slate-300">Wordlyte – {dest.label || "…"}</span> on the LAN.
            </span>
            <span className="ml-auto px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-400/90 text-[9px] font-bold uppercase tracking-wider"
              title="NDI output is an experimental Phase 8 scaffold: it requires the NDI 6 SDK build and is not yet validated on production machines.">
              Experimental
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
              onClick={onStop}
              className="px-3 py-1 rounded bg-red-600 hover:bg-red-500 text-white text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5"
            >
              <Square size={9} fill="currentColor" /> Stop
            </button>
          ) : (
            <button
              onClick={onStart}
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

      {status === "live" && (
        <div className="flex items-center gap-3 text-[9px] text-slate-500 font-mono">
          <span>sent {sentPackets}</span>
          <span>queued {queuedPackets}</span>
          {droppedPackets > 0 && <span className="text-amber-400">dropped {droppedPackets}</span>}
        </div>
      )}
      {status === "reconnecting" && (
        <p className="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-800/60 rounded px-2 py-1">
          Reconnecting… {error ?? ""}
        </p>
      )}
      {blockedReason && (
        <p className="text-[10px] text-amber-400 bg-amber-900/20 border border-amber-800/60 rounded px-2 py-1">
          {blockedReason}
        </p>
      )}
      {status === "error" && error && (
        <p className="text-[10px] text-red-400 bg-red-900/30 border border-red-900 rounded px-2 py-1">{error}</p>
      )}
      {status === "live" && dest.mode === "whip" && resourceUrl && (
        <p className="text-[10px] text-emerald-500 bg-emerald-900/20 border border-emerald-900/50 rounded px-2 py-1 break-all">
          WHIP resource: {resourceUrl}
        </p>
      )}
      {!active && <p className="text-[10px] text-slate-600">{preset.hint}</p>}
    </div>
  );
}