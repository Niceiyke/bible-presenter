import React from "react";
import { ListPlus, Pencil, Copy, Trash2, BookPlus } from "lucide-react";
import type { Song } from "../../types";
import { getSongCounts, songNeedsMetadata } from "../../utils/song";
import { Button, ContentCard, StatusBadge, type StatusTone } from "../ui";
import { useT } from "../../i18n";
import type { SongSource } from "./SongLibraryToolbar";
import { SongLyricThumbnail } from "./SongLyricThumbnail";
import { SongMoreMenu, type SongMoreMenuItem } from "./SongMoreMenu";

export interface SongCardProps {
  song: Song;
  source: SongSource;
  /** Read-only local preview — never stages or broadcasts. */
  onPreview: () => void;
  /** Unity "Use" action. Mode-aware (caller decides stage vs lyrics overlay). */
  onUse: () => void;
  onAddToSchedule: () => void;
  /** Secondary actions. Source decides which are available; the labels of the
   *  primary flow (Preview / Use / Add to Service) never change. */
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onAddToMySongs?: () => void;
}

/** One shared song card surface for My Songs and Hymn Library. Shows a lyric
 *  preview thumbnail, mode/source/readiness badges, and a consistent primary
 *  action row; source only changes which secondary (More) actions apply. */
export function SongCard({
  song,
  source,
  onPreview,
  onUse,
  onAddToSchedule,
  onEdit,
  onDuplicate,
  onDelete,
  onAddToMySongs,
}: SongCardProps) {
  const counts = getSongCounts(song);
  const isFullSlide = song.style === "FullSlide";
  const needsMetadata = songNeedsMetadata(song);
  const t = useT();

  const modeBadge: { tone: StatusTone; label: string } = isFullSlide
    ? { tone: "design", label: t("songs.badge.fullScreen") }
    : { tone: "audio", label: t("songs.badge.overlay") };

  const sectionCount = counts.sections;
  const lineCount = counts.lines;

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
    <ContentCard className="p-3 gap-2">
      <SongLyricThumbnail song={song} />

      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-console-text truncate">{song.title}</p>
          <p className="text-[11px] text-console-text-muted truncate mt-0.5">
            {song.author || "Unknown author"}
            {song.key ? ` · Key: ${song.key}` : ""}
          </p>
          <p className="text-[11px] text-console-text-subtle">
            {sectionCount} section{sectionCount === 1 ? "" : "s"} · {lineCount} lyric line{lineCount === 1 ? "" : "s"}
          </p>
        </div>
        <SongMoreMenu items={moreItems} label={`${t("songs.card.more")} · ${song.title}`} />
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <StatusBadge tone={modeBadge.tone} label={modeBadge.label} />
        <StatusBadge tone="neutral" label={source === "mine" ? t("songs.badge.mySong") : t("songs.badge.hymn")} />
        {needsMetadata && <StatusBadge tone="warning" label={t("songs.badge.needsMetadata")} />}
      </div>

      <div className="flex items-center gap-1.5">
        <Button variant="bare" size="md" onClick={onPreview}>{t("songs.card.preview")}</Button>
        <Button variant="primary" size="md" onClick={onUse}>{t("songs.card.use")}</Button>
        <Button variant="bare" size="md" icon={<ListPlus size={13} />} onClick={onAddToSchedule}>
          {t("songs.card.service")}
        </Button>
      </div>
    </ContentCard>
  );
}