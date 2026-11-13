import React from "react";
import { Edit3, MoreHorizontal, Star } from "lucide-react";
import type { CustomPresentation, CustomSlide, DisplayItem, PresentationSummary } from "../../types";
import { formatPresentationUpdatedAt, type PresentationView } from "../../presentations/library";
import { SlideThumbnail } from "../shared/SlideThumbnail";
import { cn } from "../ui/cn";
import { setDisplayItemDragData } from "../../utils/dragItem";

interface PresentationDeckCardProps {
  summary: PresentationSummary;
  presentation?: CustomPresentation;
  firstSlide?: CustomSlide;
  appDataDir: string | null;
  selected: boolean;
  favorite: boolean;
  view: PresentationView;
  /** First-slide item used when the deck card is dragged into Up Next. */
  dragItem?: DisplayItem;
  onSelect: () => void;
  onEdit: () => void;
  onToggleFavorite: () => void;
}

export function PresentationDeckCard({
  summary,
  presentation,
  firstSlide,
  appDataDir,
  selected,
  favorite,
  view,
  dragItem,
  onSelect,
  onEdit,
  onToggleFavorite,
}: PresentationDeckCardProps) {
  const cover = presentation?.slides[0] ?? firstSlide;
  const activate = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  };

  if (view === "list") {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${summary.name}`}
        aria-pressed={selected}
        onClick={onSelect}
        onKeyDown={activate}
        draggable={!!dragItem}
        title={dragItem ? "Drag to Up Next" : undefined}
        onDragStart={(event) => dragItem && setDisplayItemDragData(event, dragItem)}
        className={cn(
          "group flex min-w-0 items-center gap-3 rounded-xl border bg-console-surface p-2.5 text-left transition-all",
          selected
            ? "border-tool-design/60 bg-tool-design/5 ring-1 ring-tool-design/20"
            : "border-console-border hover:border-console-border-strong hover:bg-console-surface-raised/60",
        )}
      >
        <div className="h-[62px] w-[110px] shrink-0 overflow-hidden rounded-lg border border-white/10 bg-console-canvas shadow-md">
          {cover ? (
            <SlideThumbnail slide={cover} appDataDir={appDataDir} theme={presentation?.theme} className="h-full w-full" />
          ) : (
            <DeckPlaceholder name={summary.name} />
          )}
        </div>
        <DeckMeta summary={summary} className="flex-1" />
        <CardActions favorite={favorite} onEdit={onEdit} onToggleFavorite={onToggleFavorite} />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${summary.name}`}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={activate}
      draggable={!!dragItem}
      title={dragItem ? "Drag to Up Next" : undefined}
      onDragStart={(event) => dragItem && setDisplayItemDragData(event, dragItem)}
      className={cn(
        "group min-w-0 overflow-hidden rounded-xl border bg-console-surface text-left transition-all",
        "hover:-translate-y-0.5 hover:border-console-border-strong hover:shadow-xl hover:shadow-black/25",
        selected && "border-tool-design/70 ring-2 ring-tool-design/20",
      )}
    >
      <div className="relative aspect-video overflow-hidden bg-console-canvas">
        {cover ? (
          <SlideThumbnail slide={cover} appDataDir={appDataDir} theme={presentation?.theme} className="h-full w-full" />
        ) : (
          <DeckPlaceholder name={summary.name} />
        )}
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/70 to-transparent" />
        <div className="absolute bottom-1.5 left-1.5 rounded border border-white/10 bg-black/60 px-1.5 py-0.5 text-[8px] font-bold text-white/85 backdrop-blur-sm">
          {summary.slide_count} {summary.slide_count === 1 ? "slide" : "slides"}
        </div>
        <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <CardActions favorite={favorite} onEdit={onEdit} onToggleFavorite={onToggleFavorite} overlay />
        </div>
      </div>
      <DeckMeta summary={summary} className="p-2.5" />
    </div>
  );
}

function DeckMeta({ summary, className }: { summary: PresentationSummary; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="truncate text-[12px] font-bold text-console-text" title={summary.name}>{summary.name}</p>
      <p className="mt-0.5 truncate text-[9px] text-console-text-subtle">{formatPresentationUpdatedAt(summary.updated_at)}</p>
    </div>
  );
}

function CardActions({
  favorite,
  overlay = false,
  onEdit,
  onToggleFavorite,
}: {
  favorite: boolean;
  overlay?: boolean;
  onEdit: () => void;
  onToggleFavorite: () => void;
}) {
  const buttonClass = overlay
    ? "bg-black/70 text-white/80 hover:bg-black hover:text-white backdrop-blur-sm"
    : "bg-console-surface-raised text-console-text-muted hover:text-console-text";
  return (
    <div className="flex shrink-0 items-center gap-1" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={onToggleFavorite}
        className={cn("flex h-8 w-8 items-center justify-center rounded-lg transition-colors", buttonClass, favorite && "text-action-primary")}
        aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
        title={favorite ? "Remove from favorites" : "Add to favorites"}
      >
        <Star size={13} fill={favorite ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        onClick={onEdit}
        className={cn("flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[10px] font-bold transition-colors", buttonClass)}
        aria-label={`Edit presentation`}
      >
        <Edit3 size={12} /> Edit
      </button>
      {!overlay && <MoreHorizontal size={14} className="mx-1 text-console-text-subtle" aria-hidden />}
    </div>
  );
}

function DeckPlaceholder({ name }: { name: string }) {
  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_20%_20%,rgba(167,139,250,0.24),transparent_40%),linear-gradient(145deg,#192432,#0b0f14)] px-5 text-center">
      <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full border border-tool-design/15" />
      <div className="absolute -bottom-10 -left-7 h-28 w-28 rounded-full border border-action-primary/10" />
      <p className="line-clamp-2 text-sm font-black tracking-tight text-white/85">{name}</p>
    </div>
  );
}
