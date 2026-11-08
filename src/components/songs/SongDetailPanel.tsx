import React from "react";
import { BookPlus, Copy, Edit3, Eye, ListPlus, Music2, PanelRightClose, Play, Trash2 } from "lucide-react";
import type { Song } from "../../types";
import { getSongCounts, getSongSequence, songNeedsMetadata } from "../../utils/song";
import { Button, StatusBadge } from "../ui";
import { SongLyricThumbnail } from "./SongLyricThumbnail";
import type { SongSource } from "./SongLibraryToolbar";

interface SongDetailPanelProps {
  song: Song | null;
  source: SongSource;
  onClose: () => void;
  onOpenCue: () => void;
  onPreview: () => void;
  onAddToSchedule: () => void;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onAddToMySongs?: () => void;
}

/** A focused song inspection surface. Output selection stays in the cue panel
 * so operators review a lyric sequence before staging or sending it live. */
export function SongDetailPanel({
  song,
  source,
  onClose,
  onOpenCue,
  onPreview,
  onAddToSchedule,
  onEdit,
  onDuplicate,
  onDelete,
  onAddToMySongs,
}: SongDetailPanelProps) {
  if (!song) {
    return (
      <aside className="hidden min-h-[480px] items-center justify-center rounded-2xl border border-dashed border-console-border bg-console-surface/35 p-8 text-center xl:flex">
        <div>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-tool-audio/10 text-tool-audio"><Music2 size={22} /></div>
          <p className="mt-4 text-sm font-bold text-console-text">Select a song</p>
          <p className="mt-1 max-w-[230px] text-[11px] leading-relaxed text-console-text-subtle">Review lyrics and arrangement, then open the cue panel to choose exactly what reaches Stage or Live.</p>
        </div>
      </aside>
    );
  }

  const counts = getSongCounts(song);
  const sequence = getSongSequence(song);
  const needsMetadata = songNeedsMetadata(song);
  const modeLabel = song.style === "FullSlide" ? "Full-screen lyrics" : "Lyrics overlay";

  return (
    <aside className="flex min-h-[520px] min-w-0 flex-col overflow-hidden rounded-2xl border border-console-border bg-console-surface shadow-xl shadow-black/15">
      <div className="border-b border-console-border p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-tool-audio/12 text-tool-audio"><Music2 size={18} /></div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-black text-console-text" title={song.title}>{song.title}</h3>
            <p className="mt-1 truncate text-[10px] text-console-text-subtle">{song.author || "Unknown author"}{song.key ? ` · Key ${song.key}` : ""}</p>
          </div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-console-text-subtle hover:bg-console-surface-raised hover:text-console-text" aria-label="Close song details" title="Close details"><PanelRightClose size={15} /></button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <StatusBadge tone={song.style === "FullSlide" ? "design" : "audio"} label={modeLabel} />
          <StatusBadge tone="neutral" label={source === "mine" ? "My song" : "Hymn library"} />
          {needsMetadata && <StatusBadge tone="warning" label="Needs metadata" />}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button variant="primary" size="sm" onClick={onOpenCue}><Play size={12} /> Open cue</Button>
          <Button variant="ghost" size="sm" onClick={onPreview}><Eye size={12} /> Preview</Button>
        </div>
      </div>

      <div className="custom-scrollbar flex-1 overflow-y-auto p-4">
        <SongLyricThumbnail song={song} />
        <div className="mt-4 grid grid-cols-3 gap-2">
          <DetailStat value={counts.sections} label="Sections" />
          <DetailStat value={counts.lines} label="Lines" />
          <DetailStat value={song.arrangement?.length || counts.sections} label="Cues" />
        </div>
        <div className="mt-4 rounded-xl border border-console-border bg-console-canvas/60 p-3">
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-console-text-muted">Arrangement</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {sequence.map((section, index) => (
              <span key={section.id ?? `${section.label}-${index}`} className="rounded-md border border-console-border bg-console-surface px-2 py-1 text-[9px] font-bold text-console-text-muted">{section.label}</span>
            ))}
          </div>
        </div>
        <button type="button" onClick={onAddToSchedule} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-console-border bg-console-canvas py-2 text-[10px] font-bold text-console-text-muted transition-colors hover:border-console-border-strong hover:text-console-text"><ListPlus size={12} /> Add song to service plan</button>
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-console-border p-3">
        {source === "mine" ? <>
          <Button variant="ghost" size="sm" onClick={onEdit}><Edit3 size={12} /> Edit</Button>
          <Button variant="ghost" size="sm" onClick={onDuplicate}><Copy size={12} /> Duplicate</Button>
          <button type="button" onClick={onDelete} className="col-span-2 flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-[10px] font-bold text-console-text-subtle transition-colors hover:bg-state-live-soft hover:text-state-live"><Trash2 size={12} /> Delete song</button>
        </> : <Button variant="ghost" size="sm" className="col-span-2" onClick={onAddToMySongs}><BookPlus size={12} /> Add to My Songs</Button>}
      </div>
    </aside>
  );
}

function DetailStat({ value, label }: { value: number; label: string }) {
  return <div className="rounded-lg border border-console-border bg-console-canvas/60 px-2 py-2 text-center"><p className="text-sm font-black tabular-nums text-console-text">{value}</p><p className="mt-0.5 text-[8px] font-black uppercase tracking-wide text-console-text-subtle">{label}</p></div>;
}
