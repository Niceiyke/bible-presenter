import React from "react";
import { Edit3, ImagePlus, ListPlus, PanelRightClose, Radio, Repeat, RotateCcw, Trash2, Volume2 } from "lucide-react";
import type { DisplayItem, MediaFitMode, MediaItem } from "../types";
import { Button, StatusBadge } from "./ui";
import { MediaThumb, MediaTypeIcon, formatDuration } from "./MediaThumb";

const FIT_OPTIONS: { mode: MediaFitMode; label: string; title: string }[] = [
  { mode: "contain", label: "Fit", title: "Show the entire image" },
  { mode: "cover", label: "Crop", title: "Fill the frame and crop edges" },
  { mode: "fill", label: "Stretch", title: "Fill the frame without preserving the ratio" },
];

interface MediaDetailPanelProps {
  item: MediaItem | null;
  missing: boolean;
  onClose: () => void;
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onAddToSchedule: (item: DisplayItem) => void;
  onEdit: () => void;
  onDelete: () => void;
  onRelink: () => void;
  onSetFit: (mode: MediaFitMode) => void;
  onSetPlayback: (loop: boolean, rate: number, volume: number) => void;
  onSetAsBackgroundLogo: () => void;
}

/** Focused per-item controls keep the media grid fast to scan and use. */
export function MediaDetailPanel({
  item, missing, onClose, onStage, onLive, onAddToSchedule, onEdit, onDelete,
  onRelink, onSetFit, onSetPlayback, onSetAsBackgroundLogo,
}: MediaDetailPanelProps) {
  if (!item) {
    return (
      <aside className="hidden h-full min-h-0 items-center justify-center rounded-2xl border border-dashed border-console-border bg-console-surface/35 p-8 text-center xl:flex">
        <div>
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-tool-design/10 text-tool-design"><ImagePlus size={22} /></div>
          <p className="mt-4 text-sm font-bold text-console-text">Select media</p>
          <p className="mt-1 max-w-[220px] text-[11px] leading-relaxed text-console-text-subtle">Inspect playback and display settings without crowding the media library.</p>
        </div>
      </aside>
    );
  }

  const isAudio = item.media_type === "Audio";
  const hasPlayback = item.media_type === "Video" || isAudio;
  const display = { type: "Media" as const, data: item };

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-console-border bg-console-surface shadow-xl shadow-black/15">
      <div className="shrink-0 border-b border-console-border p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-tool-design/12 text-tool-design"><MediaTypeIcon item={item} /></div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-black text-console-text" title={item.name}>{item.name}</h3>
            <p className="mt-1 text-[10px] text-console-text-subtle">{item.media_type}{item.duration != null ? ` · ${formatDuration(item.duration)}` : ""}</p>
          </div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-console-text-subtle hover:bg-console-surface-raised hover:text-console-text" aria-label="Close media details" title="Close details"><PanelRightClose size={15} /></button>
        </div>
        {missing ? <Button variant="live" size="sm" className="mt-4 w-full" onClick={onRelink}><RotateCcw size={12} /> Relink missing file</Button> : <div className="mt-4 grid grid-cols-3 gap-2">
          <Button variant="stage" size="sm" onClick={() => onStage(display)}>Stage</Button>
          <Button variant="primary" size="sm" onClick={() => onLive(display)}><Radio size={12} /> Live</Button>
          <Button variant="ghost" size="sm" onClick={() => onAddToSchedule(display)}><ListPlus size={12} /> Add to plan</Button>
        </div>}
      </div>

      <div className="custom-scrollbar flex-1 space-y-4 overflow-y-auto p-4">
        <div className="relative aspect-video overflow-hidden rounded-xl border border-console-border bg-console-canvas"><MediaThumb item={item} className="h-full w-full" dimmed={missing} /></div>
        <div className="flex flex-wrap gap-1.5">
          <StatusBadge tone="neutral" label={item.media_type} />
          {item.category && <StatusBadge tone="design" label={item.category} />}
          {item.tags.slice(0, 4).map((tag) => <StatusBadge key={tag} tone="audio" label={tag} />)}
        </div>
        {item.description && <p className="rounded-lg border border-console-border bg-console-canvas/60 p-3 text-[10px] leading-relaxed text-console-text-muted">{item.description}</p>}

        {!isAudio && <section className="rounded-xl border border-console-border bg-console-canvas/60 p-3"><p className="text-[9px] font-black uppercase tracking-[0.14em] text-console-text-muted">Display fit</p><div className="mt-2 grid grid-cols-3 gap-1">{FIT_OPTIONS.map(({ mode, label, title }) => <button key={mode} type="button" title={title} onClick={() => onSetFit(mode)} className={`h-7 rounded text-[9px] font-black ${item.fit_mode === mode || (!item.fit_mode && mode === "contain") ? "bg-tool-design text-console-canvas" : "bg-console-surface-raised text-console-text-muted hover:text-console-text"}`}>{label}</button>)}</div></section>}

        {hasPlayback && <section className="rounded-xl border border-console-border bg-console-canvas/60 p-3"><p className="text-[9px] font-black uppercase tracking-[0.14em] text-console-text-muted">Playback</p><div className="mt-2 flex items-center gap-1.5"><button type="button" onClick={() => onSetPlayback(!(item.loop_playback ?? true), item.playback_rate ?? 1, item.volume ?? 1)} className={`flex h-7 items-center gap-1 rounded px-2 text-[9px] font-bold ${(item.loop_playback ?? true) ? "bg-action-primary/15 text-action-primary" : "bg-console-surface-raised text-console-text-muted"}`}><Repeat size={11} /> {(item.loop_playback ?? true) ? "Loop" : "Once"}</button><select value={item.playback_rate ?? 1} onChange={(event) => onSetPlayback(item.loop_playback ?? true, Number(event.target.value), item.volume ?? 1)} className="h-7 rounded bg-console-surface-raised px-2 text-[9px] text-console-text-muted">{[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}</select><button type="button" onClick={() => onSetPlayback(item.loop_playback ?? true, item.playback_rate ?? 1, (item.volume ?? 1) > 0 ? 0 : 1)} className="flex h-7 items-center gap-1 rounded bg-console-surface-raised px-2 text-[9px] font-bold text-console-text-muted"><Volume2 size={11} /> {(item.volume ?? 1) > 0 ? "Mute" : "Unmute"}</button></div></section>}

        <section className="rounded-xl border border-console-border bg-console-canvas/60 p-3"><p className="text-[9px] font-black uppercase tracking-[0.14em] text-console-text-muted">Branding</p><Button variant="ghost" size="sm" className="mt-2 w-full" onClick={onSetAsBackgroundLogo}>Logo</Button></section>
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-2 border-t border-console-border p-3"><Button variant="ghost" size="sm" onClick={onEdit}><Edit3 size={12} /> Edit</Button><button type="button" onClick={onDelete} className="flex h-8 items-center justify-center gap-1 rounded-md text-[10px] font-bold uppercase tracking-wide text-console-text-subtle hover:bg-state-live-soft hover:text-state-live"><Trash2 size={12} /> Delete</button></div>
    </aside>
  );
}
