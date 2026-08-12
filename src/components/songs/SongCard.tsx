import React from "react";
import type { StatusTone } from "../ui";
import type { Song } from "../../types";
import { getSongCounts } from "../../utils/song";
import { Button, ContentCard, ContentCardActions, StatusBadge } from "../ui";

export interface SongCardProps {
  song: Song;
  source: "mine" | "library";
  onPreview: () => void;
  onStage?: () => void;
  onLive?: () => void;
  onAddToSchedule?: () => void;
  onUseLyrics?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onImport?: () => void;
}

/** One shared song card surface for My Songs and Hymn Library. The five-word
 *  action vocabulary (Preview / Stage / Go Live / Service / Edit / Delete) is
 *  identical; source only changes which secondary actions apply. */
export function SongCard({
  song,
  source,
  onPreview,
  onStage,
  onLive,
  onAddToSchedule,
  onUseLyrics,
  onEdit,
  onDelete,
  onImport,
}: SongCardProps) {
  const counts = getSongCounts(song);
  const slideCount = counts.sequence;
  const lineCount = counts.lines;
  const isFullSlide = song.style === "FullSlide";
  const meta = isFullSlide
    ? {
        tone: "design" as StatusTone,
        label: "Full Slide",
        info: `${slideCount} slide${slideCount === 1 ? "" : "s"} · ${lineCount} lines`,
      }
    : {
        tone: "audio" as StatusTone,
        label: "Lower Third",
        info: `${slideCount} line${slideCount === 1 ? "" : "s"} · ${lineCount} lyric lines`,
      };

  return (
    <ContentCard className="p-3 gap-1">
      <div className="flex justify-between items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-console-text truncate">{song.title}</p>
          {song.author && <p className="text-[10px] text-console-text-muted truncate">{song.author}</p>}
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <StatusBadge tone={meta.tone} label={meta.label} />
            <span className="text-[10px] text-console-text-subtle">{meta.info}</span>
          </div>
        </div>
        {source === "mine" ? (
          <ContentCardActions
            dense
            onPreview={isFullSlide ? undefined : onPreview}
            onStage={isFullSlide ? onStage : undefined}
            onLive={isFullSlide ? onLive : undefined}
            onAddToSchedule={onAddToSchedule}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ) : (
          <div className="flex gap-1 shrink-0">
            <Button variant="ghost" size="sm" onClick={onPreview}>Preview</Button>
            <Button variant="primary" size="sm" onClick={onImport}>Import</Button>
          </div>
        )}
      </div>
      {source === "mine" && !isFullSlide && (
        <div className="flex items-center gap-1.5 mt-1">
          <Button variant="success" size="sm" onClick={onUseLyrics}>Use (lyrics mode)</Button>
        </div>
      )}
    </ContentCard>
  );
}