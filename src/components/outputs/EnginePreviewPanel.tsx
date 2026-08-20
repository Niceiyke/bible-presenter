import React from "react";
import { Loader2, Monitor, MonitorPlay, Wifi, WifiOff } from "lucide-react";
import { useEnginePreview } from "../../hooks/useEnginePreview";

/**
 * Phase C3 — console preview of the engine's winit windows. Shows the latest
 * MJPEG frame the `wordlyte-engine` host rendered for the output and stage
 * windows, pulled over the engine IPC poll. Placeholder states communicate
 * engine status textually (never color alone): waiting for a window, engine
 * offline, or a live frame.
 */
export function EnginePreviewPanel({ enabled }: { enabled: boolean }) {
  const { frames, connected, polling, error } = useEnginePreview(enabled);

  const tile = (label: string, title: string) => {
    const frame = frames[label];
    return (
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[8px] font-black uppercase tracking-widest text-console-text-subtle shrink-0">{title}</span>
          <span className="text-[7px] font-bold text-console-text-subtle ml-auto shrink-0">{frame ? `${frame.width}×${frame.height}` : "—"}</span>
        </div>
        <div className="rounded-md overflow-hidden ring-1 ring-console-border bg-black aspect-video flex items-center justify-center">
          {frame ? (
            <img src={frame.url} alt={`${title} engine preview`} className="w-full h-full object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-1 text-console-text-muted p-2">
              <Monitor size={16} className="opacity-50" />
              <span className="text-[7px] font-bold uppercase tracking-wider text-center">
                {connected ? "waiting for window…" : "engine offline"}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="w-72 p-2 rounded-lg border border-console-border bg-console-surface shadow-xl shadow-black/40">
      <div className="flex items-center gap-1.5 mb-2 px-1">
        <MonitorPlay size={12} className="text-action-primary" />
        <span className="text-[9px] font-black uppercase tracking-widest text-console-text flex-1">Engine preview</span>
        {polling ? (
          <Loader2 size={10} className="animate-spin text-console-text-subtle" />
        ) : (
          <span className="text-[8px] font-bold text-console-text-subtle">idle</span>
        )}
        {connected ? (
          <Wifi size={10} className="text-state-success" />
        ) : (
          <WifiOff size={10} className="text-state-warning" />
        )}
      </div>
      <div className="flex gap-2">
        {tile("output", "Output")}
        {tile("stage", "Stage")}
      </div>
      {error && (
        <p className="mt-1.5 px-1 text-[7px] font-bold text-state-warning truncate" title={error}>
          {error}
        </p>
      )}
    </div>
  );
}