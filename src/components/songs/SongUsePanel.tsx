import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Music2, Radio, ListPlus, EyeOff, Send, X } from "lucide-react";
import type { Song, DisplayItem, SongSlideData, SongStyle } from "../../types";
import {
  buildSongDisplayItem,
  getSongSequence,
} from "../../utils/song";
import { resolveSongLtTemplate } from "../../utils/song";
import { useAppStore } from "../../store";
import { useT } from "../../i18n";
import type { SongSource } from "./SongLibraryToolbar";
import { LowerThirdOverlay } from "../shared/Renderers";
import { SongPreviewBox } from "./SongPreviewBox";

interface SongUsePanelProps {
  song: Song | null;
  source: SongSource;
  onClose: () => void;
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onAddToSchedule: (item: DisplayItem) => void;
}

/** Phase 6 (SONG_SYSTEM_MODERNIZATION_PLAN §10/§5.5): unified "Use Song"
 *  workflow. Mode selection (full-screen lyrics / lyrics overlay), a complete
 *  cue grid, and safe per-cue Stage / Go Live / Add to Service / Hide actions.
 *  All item creation flows
 *  through `buildSongDisplayItem`; all staging/live actions flow through the
 *  `useItemActions` callbacks passed from SongsTab. Preview never broadcasts.
 *  The selected song + mode are pushed into shared lower-third store state so
 *  the LowerThirdTab mirrors the selection (Phase 7). */
export function SongUsePanel({ song, source, onClose, onStage, onLive, onAddToSchedule }: SongUsePanelProps) {
  const {
    ltTemplate, ltSavedTemplates, songs, setLtSongId, setLtMode, setLtLineIndex,
    ltVisible, setLtVisible, busyActions, setBackendError,
    ltLinesPerDisplay,
    settings,
  } = useAppStore();
  const t = useT();

  const [mode, setMode] = useState<SongStyle>((song?.style as SongStyle) ?? "LowerThird");

  const sequence = useMemo(() => (song ? getSongSequence(song) : []), [song]);

  // Sync shared lower-third state whenever a new song opens.
  useEffect(() => {
    if (!song) return;
    setMode((song.style as SongStyle) ?? "LowerThird");
    if (source === "mine") {
      setLtSongId(song.id);
      setLtMode("lyrics");
      setLtLineIndex(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id]);

  const stageBusy = busyActions.includes("stage");
  const liveBusy = busyActions.includes("goLive");

  const item = (i: number): DisplayItem =>
    buildSongDisplayItem(song!, i, mode);

  const handleHide = async () => {
    try {
      await invoke("hide_lower_third");
      setLtVisible(false);
    } catch (err: any) {
      setBackendError(`Hide overlay failed: ${err?.message ?? err}`);
    }
  };

  // Preview with the song's chosen template when it has one.
  const previewLtTemplate = resolveSongLtTemplate(song?.id, songs, ltSavedTemplates, ltTemplate);

  if (!song) return null;

  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-console-border bg-console-surface shadow-xl shadow-black/15">
      <div className="flex flex-wrap items-center gap-2 border-b border-console-border px-3 py-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-tool-audio/12 text-tool-audio"><Music2 size={15} /></div>
        <div className="min-w-0 flex-1">
          <p className="text-[8px] font-black uppercase tracking-[0.16em] text-console-text-muted">Song cue · {sequence.length} sections</p>
          <h2 className="truncate text-sm font-black text-console-text" title={song.title}>{song.title}</h2>
        </div>
        <div className="flex items-center rounded-md border border-console-border bg-console-canvas p-0.5">
          {(["LowerThird", "FullSlide"] as SongStyle[]).map((output) => (
            <button key={output} type="button" onClick={() => setMode(output)} aria-pressed={mode === output} className={`h-6 rounded px-2 text-[8px] font-black transition-colors ${mode === output ? "bg-console-surface-raised text-action-primary" : "text-console-text-subtle hover:text-console-text"}`}>{output === "FullSlide" ? "FULL" : "OVERLAY"}</button>
          ))}
        </div>
        {mode === "LowerThird" && ltVisible && <button type="button" onClick={handleHide} className="flex h-7 items-center gap-1 rounded-md bg-state-live-soft px-2 text-[8px] font-black text-state-live transition-colors hover:bg-state-live hover:text-white" title={t("songs.use.hideOverlay")}><EyeOff size={11} /> HIDE</button>}
        <button type="button" onClick={onClose} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-console-text-subtle transition-colors hover:bg-console-surface-raised hover:text-console-text" aria-label="Close song cue" title="Back to song library"><X size={15} /></button>
      </div>
      <div className="custom-scrollbar flex-1 overflow-y-auto p-3">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {sequence.map((cue, cueIndex) => {
            const previewData: SongSlideData = {
              song_id: song.id,
              title: song.title,
              author: song.author,
              section_label: cue.label,
              lines: cue.lines,
              slide_index: cueIndex,
              total_slides: sequence.length,
              style: mode,
              font: song.font,
              font_size: song.font_size,
              font_weight: song.font_weight,
              color: song.color,
            };
            const overlayData = {
              kind: "Lyrics" as const,
              data: {
                line1: cue.lines[0] ?? "",
                line2: ltLinesPerDisplay === 2 ? cue.lines[1] : undefined,
                section_label: cue.label,
              },
            };
            return (
              <div key={`${cue.id ?? cue.label}-${cueIndex}`} className="flex min-w-0 flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">{cue.label}</p>
                  <p className="shrink-0 text-[10px] tabular-nums text-console-text-subtle">{cueIndex + 1} of {sequence.length}</p>
                </div>
                <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-console-border bg-slate-950">
                  {mode === "FullSlide" ? (
                    <SongPreviewBox data={previewData} showSectionLabel={!!settings.show_song_section_labels} fill />
                  ) : (
                    <div className="absolute inset-0" aria-hidden><LowerThirdOverlay data={overlayData as any} template={previewLtTemplate} /></div>
                  )}
                </div>
                <CueActions
                  onStage={() => onStage(item(cueIndex))}
                  onLive={() => onLive(item(cueIndex))}
                  onAddToSchedule={() => onAddToSchedule(item(cueIndex))}
                  stageBusy={stageBusy}
                  liveBusy={liveBusy}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function CueActions({
  onStage,
  onLive,
  onAddToSchedule,
  stageBusy,
  liveBusy,
}: {
  onStage: () => void;
  onLive: () => void;
  onAddToSchedule: () => void;
  stageBusy: boolean;
  liveBusy: boolean;
}) {
  return (
    <div className="flex h-8 items-center gap-1 border-x border-b border-console-border bg-console-surface px-1 py-1">
      <button type="button" onClick={onStage} disabled={liveBusy || stageBusy} className="flex h-5 flex-1 items-center justify-center gap-1 rounded bg-state-stage px-1.5 text-[7px] font-black text-slate-950 transition-colors hover:bg-state-stage/90 disabled:opacity-40"><Send size={8} /> STAGE</button>
      <button type="button" onClick={onLive} disabled={stageBusy || liveBusy} className="flex h-5 flex-1 items-center justify-center gap-1 rounded bg-action-primary px-1.5 text-[7px] font-black text-black transition-colors hover:bg-action-primary-hover disabled:opacity-40"><Radio size={8} /> LIVE</button>
      <button type="button" onClick={onAddToSchedule} className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-console-surface-raised text-console-text-muted transition-colors hover:bg-console-surface-strong hover:text-console-text" title="Add cue to service plan" aria-label="Add cue to service plan"><ListPlus size={9} /></button>
    </div>
  );
}
