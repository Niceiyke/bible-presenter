import React from "react";
import { BookPlus, ChevronRight, Copy, ListPlus, Pencil, Trash2 } from "lucide-react";
import type { DisplayItem, Song } from "../../types";
import { getSongCounts, getSongPageCount, songNeedsMetadata } from "../../utils/song";
import { setDisplayItemDragData } from "../../utils/dragItem";
import { useAppStore } from "../../store";
import { Button, ContentCard, StatusBadge } from "../ui";
import { useT } from "../../i18n";
import type { SongSource } from "./SongLibraryToolbar";
import { SongLyricThumbnail } from "./SongLyricThumbnail";
import { SongMoreMenu, type SongMoreMenuItem } from "./SongMoreMenu";

export interface SongCardProps {
  song: Song;
  source: SongSource;
  /** Opens the song runner. The runner is the only operating surface. */
  onOpen: () => void;
  /** Adds the whole song (all lyric pages) to the service plan. */
  onAddToPlan: () => void;
  /** Display item used when the card is dragged into the Up Next queue. */
  dragItem?: DisplayItem;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onAddToMySongs?: () => void;
}

/** Compact song row. The library is for finding a song and putting it in the
 *  plan; all previewing and live control happens in the song runner. Keeping
 *  three competing actions on every card made the library feel like a
 *  storefront instead of an operator tool. */
export function SongCard({
  song,
  source,
  onOpen,
  onAddToPlan,
  dragItem,
  onEdit,
  onDuplicate,
  onDelete,
  onAddToMySongs,
}: SongCardProps) {
  const linesPerDisplay = useAppStore((s) => s.ltLinesPerDisplay);
  const counts = getSongCounts(song);
  const pageCount = getSongPageCount(song, song.style, linesPerDisplay);
  const isFullSlide = song.style === "FullSlide";
  const needsMetadata = songNeedsMetadata(song);
  const t = useT();

  const moreItems: SongMoreMenuItem[] = (
    source === "mine"
      ? [
          { label: t("songs.card.edit"), icon: <Pencil size={12} />, onClick: onEdit },
          { label: t("songs.card.duplicate"), icon: <Copy size={12} />, onClick: onDuplicate },
          { label: t("songs.card.delete"), icon: <Trash2 size={12} />, onClick: onDelete, danger: true },
        ]
      : [{ label: t("songs.card.addToMySongs"), icon: <BookPlus size={12} />, onClick: onAddToMySongs }]
  ).filter((i) => i.onClick);

  return (
    <ContentCard className="gap-0 p-2">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className="w-24 shrink-0"
          draggable={!!dragItem}
          title={dragItem ? "Drag to plan" : undefined}
          onDragStart={(event) => dragItem && setDisplayItemDragData(event, dragItem)}
        >
          <button
            type="button"
            onClick={onOpen}
            className="group/preview relative block w-full overflow-hidden rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
            aria-label={`Open ${song.title}`}
          >
            <SongLyricThumbnail song={song} compact />
            <span className="absolute inset-0 flex items-center justify-center bg-black/55 opacity-0 transition-opacity group-hover/preview:opacity-100 group-focus-visible/preview:opacity-100">
              <span className="text-[9px] font-black uppercase tracking-wider text-white">Open</span>
            </span>
          </button>
        </div>

        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)]"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] font-bold text-console-text">{song.title}</span>
            <ChevronRight size={13} className="shrink-0 text-console-text-subtle" />
          </span>
          <span className="mt-0.5 block truncate text-[10px] text-console-text-muted">
            {song.author || "Unknown author"}
            {song.key ? ` · Key: ${song.key}` : ""}
          </span>
          <span className="mt-0.5 block text-[9px] text-console-text-subtle">
            {pageCount} page{pageCount === 1 ? "" : "s"} · {counts.sections} section{counts.sections === 1 ? "" : "s"} · {counts.lines} lyric line{counts.lines === 1 ? "" : "s"}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1">
            <StatusBadge className="gap-1 px-1.5 py-0.5 text-[8px]" tone={isFullSlide ? "design" : "audio"} label={isFullSlide ? t("songs.badge.fullScreen") : t("songs.badge.overlay")} />
            <StatusBadge className="gap-1 px-1.5 py-0.5 text-[8px]" tone="neutral" label={source === "mine" ? t("songs.badge.mySong") : t("songs.badge.hymn")} />
            {needsMetadata && <StatusBadge className="gap-1 px-1.5 py-0.5 text-[8px]" tone="warning" label={t("songs.badge.needsMetadata")} />}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <Button variant="primary" size="md" icon={<ListPlus size={12} />} onClick={onAddToPlan} disabled={pageCount === 0}>
            {t("songs.card.addToPlan")}
          </Button>
          <SongMoreMenu items={moreItems} label={`${t("songs.card.more")} · ${song.title}`} />
        </div>
      </div>
    </ContentCard>
  );
}
