import React from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import type { PresentationIssue } from "../../../presentations/diagnostics";

export function PreflightPanel({ issues, onSelect, onClose }: { issues: PresentationIssue[]; onSelect: (issue: PresentationIssue) => void; onClose: () => void }) {
  return (
    <div className="absolute bottom-20 left-5 z-[90] w-80 overflow-hidden rounded-2xl border border-console-border-strong bg-console-surface/95 shadow-2xl shadow-black/50 backdrop-blur-xl">
      <header className="flex items-center gap-2 border-b border-console-border bg-gradient-to-r from-state-warning/15 to-transparent px-3 py-3">
        {issues.length ? <AlertTriangle size={15} className="text-state-warning" /> : <CheckCircle2 size={15} className="text-state-success" />}
        <div className="flex-1"><p className="text-[10px] font-black uppercase tracking-wider text-console-text">Live preflight</p><p className="text-[8px] text-console-text-subtle">{issues.length ? `${issues.length} items need review` : "Presentation ready"}</p></div>
        <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-console-text-subtle hover:bg-console-surface-strong" aria-label="Close preflight"><X size={13} /></button>
      </header>
      <div className="custom-scrollbar max-h-72 overflow-y-auto p-2">
        {issues.length === 0 ? <p className="p-4 text-center text-[10px] leading-relaxed text-console-text-muted">No blank slides, unsafe geometry, missing media, small text, or dense text detected.</p> : issues.map((issue, index) => (
          <button key={`${issue.code}-${issue.slideIndex}-${issue.elementId ?? index}`} onClick={() => onSelect(issue)} className="mb-1 flex w-full items-start gap-2 rounded-xl border border-transparent p-2.5 text-left hover:border-console-border hover:bg-console-surface-raised">
            <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${issue.severity === "error" ? "bg-state-error" : "bg-state-warning"}`} />
            <span className="flex-1 text-[10px] leading-relaxed text-console-text-muted">{issue.message}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
