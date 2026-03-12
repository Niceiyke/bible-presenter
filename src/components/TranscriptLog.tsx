import React, { useRef, useEffect } from "react";

export function TranscriptLog({ segments }: { segments: { text: string; timestamp_ms: number; source: string }[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [segments.length]);
  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="flex items-center justify-between mb-2 shrink-0">
        <span className="text-[9px] font-black uppercase tracking-widest text-slate-600">Transcript Log</span>
        <span className="text-[9px] text-slate-700">{segments.length} segments</span>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar space-y-1 text-sm font-light">
        {segments.length === 0 && (
          <span className="text-slate-700 italic text-xs">No transcription yet — start a session to begin.</span>
        )}
        {segments.map((seg, i) => {
          const isPreacher = seg.source === "preacher";
          return (
            <div key={i} className="flex gap-2 items-start">
              <span className={`shrink-0 text-[9px] font-black uppercase tracking-wider mt-0.5 ${isPreacher ? "text-amber-500" : "text-blue-400"}`}>
                {isPreacher ? "PST" : "OPR"}
              </span>
              <span className="text-slate-300 leading-snug">{seg.text}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
