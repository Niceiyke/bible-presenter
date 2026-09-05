import { Globe, KeyRound, Radio, Trash2 } from "lucide-react";
import { PLATFORM_PRESETS, applyPreset, presetFor } from "./presets";
import type { StreamDestination, StreamPlatform } from "../../types";
import type { DestDisplayStatus } from "../../hooks/useNativeRtmpBroadcast";

export type { DestDisplayStatus };

interface DestinationCardProps {
  destination: StreamDestination;
  onChange: (next: StreamDestination) => void;
  onRemove: () => void;
  /** Backend per-destination state (from `stream_rtmp_status`). */
  status: DestDisplayStatus;
  /** When set, RTMP is unavailable (e.g. ffmpeg missing) — Go Live is gated. */
  blockedReason?: string | null;
  /** True while the master broadcast is live (edits disabled). */
  live: boolean;
}

const STATUS_LABEL: Record<DestDisplayStatus, string> = {
  idle: "Offline",
  live: "Live",
  error: "Error",
};

const STATUS_BADGE: Record<DestDisplayStatus, string> = {
  idle: "bg-slate-800 border-slate-700 text-slate-400",
  live: "bg-red-600/20 border-red-600 text-red-400",
  error: "bg-red-900/40 border-red-800 text-red-500",
};

/**
 * One RTMP destination in the Streaming Hub. It is config-only: the transport
 * is the master backend broadcast (`stream_rtmp_start`/`stream_rtmp_stop` on
 * the whole hub), so there is no per-card Go Live — every enabled destination
 * joins the single capture fan-out together. Status visually reflects the
 * backend poller.
 */
export function DestinationCard({
  destination: dest,
  onChange,
  onRemove,
  status,
  blockedReason,
  live,
}: DestinationCardProps) {
  const preset = presetFor(dest.platform);

  return (
    <div
      className={`rounded-lg border p-3 flex flex-col gap-2 ${
        status === "live" ? "border-red-700/60 bg-red-950/10" : "border-slate-700 bg-slate-900/40"
      }`}
    >
      <div className="flex items-center gap-2">
        <Radio size={11} className="text-slate-500" />
        <select
          value={dest.platform}
          onChange={(e) => onChange(applyPreset(dest, e.target.value as StreamPlatform))}
          disabled={live}
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
          disabled={live}
          placeholder="Label"
          className="px-2 py-1 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs focus:outline-none focus:border-slate-500 w-32"
        />
        <span
          className={`ml-auto px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${STATUS_BADGE[status]}`}
        >
          {STATUS_LABEL[status]}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Globe size={11} className="text-slate-500 shrink-0" />
        <input
          value={dest.url}
          onChange={(e) => onChange({ ...dest, url: e.target.value })}
          placeholder="rtmp://ingest.server/live"
          spellCheck={false}
          disabled={live}
          className="flex-1 px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs font-mono focus:outline-none focus:border-slate-500"
        />
      </div>
      <div className="flex items-center gap-2">
        <KeyRound size={11} className="text-slate-500 shrink-0" />
        <input
          value={dest.stream_key ?? ""}
          onChange={(e) => onChange({ ...dest, stream_key: e.target.value })}
          placeholder="Stream key"
          spellCheck={false}
          type="password"
          disabled={live}
          className="flex-1 px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-slate-200 text-xs font-mono focus:outline-none focus:border-slate-500"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={dest.enabled}
            onChange={(e) => onChange({ ...dest, enabled: e.target.checked })}
            disabled={live}
            className="accent-cyan-500"
          />
          Master Go Live
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onRemove}
            disabled={live}
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
      <p className="text-[10px] text-slate-600">
        {status === "live"
          ? "This destination is actively streaming the broadcast feed."
          : blockedReason
            ? "Go Live is unavailable until this destination's requirements are met."
            : `Transport is the master broadcast — Go Live All starts every enabled destination together. ${preset.hint}`}
      </p>
    </div>
  );
}
