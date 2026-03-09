import React, { useEffect, useRef } from "react";
import { useCameraLog } from "../cameraLog";
import type { CameraLogEntry, LogLevel } from "../cameraLog";

const LEVEL_STYLES: Record<LogLevel, string> = {
  debug: "text-zinc-500",
  info:  "text-zinc-300",
  warn:  "text-amber-400",
  error: "text-red-400",
};

const SOURCE_STYLES: Record<string, string> = {
  ws:        "text-blue-400",
  publisher: "text-purple-400",
  relay:     "text-cyan-400",
  manager:   "text-green-400",
  server:    "text-orange-400",
  mobile:    "text-pink-400",
};

function fmt(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}.${String(d.getMilliseconds()).padStart(3,"0")}`;
}

function Row({ entry }: { entry: CameraLogEntry }) {
  const srcStyle = SOURCE_STYLES[entry.source] ?? "text-zinc-400";
  const lvlStyle = LEVEL_STYLES[entry.level];
  return (
    <div className={`flex gap-2 text-[10px] font-mono leading-4 px-2 py-0.5 hover:bg-zinc-800/60 ${entry.level === "error" ? "bg-red-950/20" : entry.level === "warn" ? "bg-amber-950/10" : ""}`}>
      <span className="text-zinc-600 shrink-0 select-none">{fmt(entry.ts)}</span>
      <span className={`${srcStyle} shrink-0 w-16 truncate uppercase text-[9px] font-bold tracking-wider`}>{entry.source}</span>
      <span className={`${lvlStyle} shrink-0 w-10 text-[9px] font-bold uppercase`}>{entry.level}</span>
      <span className="text-zinc-300 break-all">{entry.msg}</span>
    </div>
  );
}

interface Props {
  maxHeight?: number;
}

export function CameraLogPanel({ maxHeight = 240 }: Props) {
  const { entries, clear } = useCameraLog();
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  // Auto-scroll only if already at bottom
  useEffect(() => {
    if (atBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [entries]);

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  return (
    <div className="flex flex-col border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
        <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">System Log</span>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-zinc-600">{entries.length} entries</span>
          <button
            onClick={clear}
            className="text-[9px] text-zinc-500 hover:text-zinc-300 font-bold px-2 py-0.5 rounded border border-zinc-700 hover:border-zinc-500 transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Log lines */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="overflow-y-auto"
        style={{ maxHeight, minHeight: 80 }}
      >
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-16 text-zinc-700 text-[10px]">
            No events yet — events will appear here as cameras connect.
          </div>
        ) : (
          entries.map(e => <Row key={e.id} entry={e} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-3 py-1.5 bg-zinc-900/50 border-t border-zinc-800">
        {Object.entries(SOURCE_STYLES).map(([src, cls]) => (
          <span key={src} className={`text-[8px] font-bold uppercase ${cls}`}>{src}</span>
        ))}
      </div>
    </div>
  );
}
