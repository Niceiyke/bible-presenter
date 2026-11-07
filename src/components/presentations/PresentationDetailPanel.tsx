import React from "react";
import { AlertTriangle, CheckCircle2, Copy, Edit3, FilePlus2, Loader2, PanelRightClose, Presentation, Trash2 } from "lucide-react";
import type { CustomPresentation, CustomSlide, DisplayItem, PresentationSummary } from "../../types";
import { formatPresentationUpdatedAt } from "../../presentations/library";
import { buildCustomSlideItem } from "../../utils";
import { Button } from "../ui";
import { StudioSlideCard } from "../StudioSlideCard";
import { analyzePresentation } from "../../presentations/diagnostics";

interface PresentationDetailPanelProps {
  summary: PresentationSummary | null;
  presentation?: CustomPresentation;
  slides: CustomSlide[];
  appDataDir: string | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onStage?: (item: DisplayItem) => void;
  onLive?: (item: DisplayItem) => void;
  onAddToSchedule?: (item: DisplayItem) => void;
}

export function PresentationDetailPanel({
  summary,
  presentation,
  slides,
  appDataDir,
  loading,
  error,
  onClose,
  onEdit,
  onDuplicate,
  onDelete,
  onStage,
  onLive,
  onAddToSchedule,
}: PresentationDetailPanelProps) {
  const issues = React.useMemo(() => {
    if (!summary || slides.length === 0) return [];
    return analyzePresentation(presentation ?? {
      id: summary.id,
      name: summary.name,
      version: summary.version,
      slides,
    });
  }, [presentation, slides, summary]);

  if (!summary) {
    return (
      <aside className="hidden min-h-[460px] items-center justify-center rounded-2xl border border-dashed border-console-border bg-console-surface/35 p-8 text-center xl:flex">
        <div>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-tool-design/10 text-tool-design">
            <Presentation size={22} />
          </div>
          <p className="mt-4 text-sm font-bold text-console-text">Select a presentation</p>
          <p className="mt-1 max-w-[220px] text-[11px] leading-relaxed text-console-text-subtle">Review slides, rehearse content, and choose exactly what to stage or send live.</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex min-h-[520px] min-w-0 flex-col overflow-hidden rounded-2xl border border-console-border bg-console-surface shadow-xl shadow-black/15">
      <div className="border-b border-console-border p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-tool-design/12 text-tool-design">
            <Presentation size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-black text-console-text" title={summary.name}>{summary.name}</h3>
            <p className="mt-1 text-[10px] text-console-text-subtle">{summary.slide_count} slides · {formatPresentationUpdatedAt(summary.updated_at)}</p>
          </div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-console-text-subtle hover:bg-console-surface-raised hover:text-console-text" aria-label="Close presentation details" title="Close details">
            <PanelRightClose size={15} />
          </button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button variant="primary" size="sm" onClick={onEdit}><Edit3 size={12} /> Open editor</Button>
          <Button variant="ghost" size="sm" onClick={onDuplicate}><Copy size={12} /> Duplicate</Button>
        </div>
        {!loading && !error && slides.length > 0 && (
          <details className="group mt-3 rounded-lg border border-console-border bg-console-canvas/60 open:border-state-warning/30">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[10px] font-bold text-console-text-muted">
              {issues.length === 0 ? <CheckCircle2 size={13} className="text-state-success" /> : <AlertTriangle size={13} className="text-state-warning" />}
              <span className="flex-1">{issues.length === 0 ? "Preflight ready" : `${issues.length} preflight ${issues.length === 1 ? "issue" : "issues"}`}</span>
              <span className="text-[8px] uppercase tracking-wider text-console-text-subtle group-open:hidden">Details</span>
            </summary>
            {issues.length > 0 && (
              <div className="space-y-1 border-t border-console-border/70 px-3 py-2">
                {issues.slice(0, 5).map((issue, index) => (
                  <p key={`${issue.code}-${issue.slideIndex}-${issue.elementId ?? index}`} className={issue.severity === "error" ? "text-[9px] leading-relaxed text-state-error" : "text-[9px] leading-relaxed text-state-warning"}>
                    {issue.message}
                  </p>
                ))}
                {issues.length > 5 && <p className="text-[9px] text-console-text-subtle">+ {issues.length - 5} more issues</p>}
              </div>
            )}
          </details>
        )}
      </div>

      <div className="flex items-center justify-between border-b border-console-border/70 px-4 py-2.5">
        <div>
          <p className="text-[9px] font-black uppercase tracking-[0.16em] text-console-text-muted">Slides</p>
          <p className="mt-0.5 text-[9px] text-console-text-subtle">Click a slide to stage it safely.</p>
        </div>
        <FilePlus2 size={14} className="text-console-text-subtle" />
      </div>

      <div className="custom-scrollbar flex-1 overflow-y-auto p-3">
        {loading && (
          <div className="flex min-h-48 items-center justify-center gap-2 text-[11px] text-console-text-muted">
            <Loader2 size={15} className="animate-spin text-tool-design" /> Loading presentation…
          </div>
        )}
        {!loading && error && (
          <div className="rounded-xl border border-state-error/30 bg-state-live-soft/40 p-4 text-[11px] leading-relaxed text-state-error">{error}</div>
        )}
        {!loading && !error && slides.length > 0 && (
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-1 2xl:grid-cols-2">
            {slides.map((slide, index) => {
              const item = buildCustomSlideItem(
                summary,
                slides,
                index,
                presentation?.theme,
              );
              return (
                <StudioSlideCard
                  key={slide.id}
                  slide={slide}
                  index={index}
                  theme={presentation?.theme}
                  onStage={onStage ? () => onStage(item) : undefined}
                  onLive={onLive ? () => onLive(item) : undefined}
                  onAddToSchedule={onAddToSchedule ? () => onAddToSchedule(item) : undefined}
                  appDataDir={appDataDir}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-console-border p-3">
        <button type="button" onClick={onDelete} className="flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-[10px] font-bold text-console-text-subtle transition-colors hover:bg-state-live-soft hover:text-state-live">
          <Trash2 size={12} /> Delete presentation
        </button>
      </div>
    </aside>
  );
}
