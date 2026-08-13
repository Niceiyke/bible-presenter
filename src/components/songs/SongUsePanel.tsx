import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Music2, Eye, Radio, ListPlus, ChevronLeft, ChevronRight, EyeOff } from "lucide-react";
import type { Song, DisplayItem, SongSlideData, SongStyle } from "../../types";
import {
  buildSongDisplayItem,
  getSongSequence,
  flattenSongForLowerThird,
} from "../../utils/song";
import { ltBuildLyricsPayload } from "../../utils";
import { useAppStore } from "../../store";
import { useT } from "../../i18n";
import { Button, Modal } from "../ui";
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
 *  workflow. Mode selection (full-screen lyrics / lyrics overlay), a sequence
 *  review with current + next preview, and safe Preview / Stage / Go Live /
 *  Add to Service / Previous / Next / Hide actions. All item creation flows
 *  through `buildSongDisplayItem`; all staging/live actions flow through the
 *  `useItemActions` callbacks passed from SongsTab. Preview never broadcasts.
 *  The selected song + mode are pushed into shared lower-third store state so
 *  the LowerThirdTab mirrors the selection (Phase 7). */
export function SongUsePanel({ song, source, onClose, onStage, onLive, onAddToSchedule }: SongUsePanelProps) {
  const {
    ltTemplate, setLtSongId, setLtMode, setLtLineIndex,
    ltVisible, setLtVisible, busyActions, setBackendError,
    settings,
  } = useAppStore();
  const t = useT();

  const [mode, setMode] = useState<SongStyle>((song?.style as SongStyle) ?? "LowerThird");
  const [index, setIndex] = useState(0);

  const sequence = useMemo(() => (song ? getSongSequence(song) : []), [song]);
  const clamped = Math.max(0, Math.min(index, sequence.length - 1));
  const current = sequence[clamped];
  const next = sequence[clamped + 1] ?? null;

  // Reset position + sync shared lower-third state whenever a new song opens.
  useEffect(() => {
    if (!song) return;
    setIndex(0);
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

  const previewData: SongSlideData | null = song
    ? {
        song_id: song.id,
        title: song.title,
        author: song.author,
        section_label: current?.label ?? "",
        lines: current?.lines ?? [],
        slide_index: clamped,
        total_slides: sequence.length,
        style: mode,
        font: song.font,
        font_size: song.font_size,
        font_weight: song.font_weight,
        color: song.color,
      }
    : null;

  const flatLines = useMemo(() => flattenSongForLowerThird(song), [song]);
  const overlayPayload = ltBuildLyricsPayload(flatLines, Math.min(clamped, Math.max(0, flatLines.length - 1)), 2);
  const overlayData = overlayPayload ?? {
    kind: "Lyrics" as const,
    data: {
      line1: current?.lines[0] ?? "",
      line2: current?.lines[1],
      section_label: current?.label ?? "",
    },
  };

  const position = `${current?.label ?? "—"} · ${clamped + 1} of ${sequence.length || 1}`;

  return (
    <Modal
      open={!!song}
      onClose={onClose}
      title={song ? `${t("songs.use.title")} · ${song.title}` : t("songs.use.title")}
      maxWidth="max-w-3xl"
      maxHeightClass="max-h-[92vh]"
      footer={
        <>
          <Button variant="bare" size="md" onClick={onClose}>{t("songs.use.close")}</Button>
          {mode === "LowerThird" && (
            <Button
              variant="live"
              size="md"
              icon={<EyeOff size={13} />}
              onClick={handleHide}
              disabled={!ltVisible}
            >
              {t("songs.use.hideOverlay")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="md"
            icon={<ListPlus size={13} />}
            onClick={() => song && onAddToSchedule(item(0))}
          >
            {t("songs.use.addToService")}
          </Button>
          <Button
            variant="stage"
            size="md"
            onClick={() => song && onStage(item(clamped))}
            loading={stageBusy}
            disabled={!song || liveBusy}
          >
            {t("songs.use.stage")}
          </Button>
          <Button
            variant="primary"
            size="md"
            icon={<Radio size={13} />}
            onClick={() => song && onLive(item(clamped))}
            loading={liveBusy}
            disabled={!song || stageBusy}
          >
            {t("songs.use.goLive")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        {/* Mode selector */}
        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">{t("songs.use.outputMode")}</p>
          <div className="flex bg-console-surface-raised border border-console-border rounded-lg p-0.5 w-fit">
            {(["LowerThird", "FullSlide"] as SongStyle[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={`h-9 px-3 text-[11px] font-bold rounded-md transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${
                  mode === m
                    ? "bg-console-surface-strong text-action-primary"
                    : "text-console-text-subtle hover:text-console-text"
                }`}
              >
                {m === "FullSlide" ? t("songs.use.fullScreen") : t("songs.use.lyricsOverlay")}
              </button>
            ))}
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          {/* Current preview */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">{t("songs.use.current")}</p>
              <p className="text-[10px] text-console-text-subtle tabular-nums truncate">{position}</p>
            </div>
            <div className="relative w-full aspect-video rounded-lg overflow-hidden bg-slate-950 border border-console-border">
              {previewData && (
                mode === "FullSlide" ? (
                  <SongPreviewBox
                    data={previewData}
                    showSectionLabel={!!settings.show_song_section_labels}
                    fill
                  />
                ) : (
                  <div className="absolute inset-0" aria-hidden>
                    <LowerThirdOverlay data={overlayData as any} template={ltTemplate} />
                  </div>
                )
              )}
            </div>
          </div>

          {/* Up Next preview */}
          <div className="flex flex-col gap-1.5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-console-text-subtle">{t("songs.use.upNext")}</p>
            <div className="relative w-full aspect-video rounded-lg overflow-hidden bg-slate-950 border border-console-border">
              {next ? (
                mode === "FullSlide" ? (
                  <SongPreviewBox
                    data={{
                      song_id: song?.id ?? "",
                      title: song?.title ?? "",
                      author: song?.author,
                      section_label: next.label,
                      lines: next.lines,
                      slide_index: clamped + 1,
                      total_slides: sequence.length,
                      style: mode,
                    }}
                    showSectionLabel={!!settings.show_song_section_labels}
                    fill
                  />
                ) : (
                  <div className="absolute inset-0" aria-hidden>
                    <LowerThirdOverlay
                      data={{
                        kind: "Lyrics",
                        data: {
                          line1: next.lines[0] ?? "",
                          line2: next.lines[1],
                          section_label: next.label,
                        },
                      } as any}
                      template={ltTemplate}
                    />
                  </div>
                )
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <p className="text-[10px] text-console-text-subtle italic">{t("songs.editor.endOfArrangement")}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Sequence review + navigation */}
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="md" icon={<ChevronLeft size={14} />} onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={clamped <= 0}>
            {t("songs.use.previous")}
          </Button>
          <ol className="flex flex-wrap gap-1 justify-center max-w-[60%]">
            {sequence.map((sec, i) => (
              <li key={`${sec.id ?? sec.label}-${i}`}>
                <button
                  onClick={() => setIndex(i)}
                  aria-pressed={i === clamped}
                  aria-label={`Go to ${sec.label}, section ${i + 1} of ${sequence.length}`}
                  className={`h-7 px-2 text-[10px] font-bold rounded-md border transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)] ${
                    i === clamped
                      ? "bg-action-primary/15 border-action-primary/50 text-action-primary"
                      : "bg-console-surface-raised border-console-border text-console-text-subtle hover:text-console-text"
                  }`}
                >
                  {i + 1}
                </button>
              </li>
            ))}
          </ol>
          <Button variant="ghost" size="md" onClick={() => setIndex((i) => Math.min(sequence.length - 1, i + 1))} disabled={clamped >= sequence.length - 1}>
            {t("songs.use.nextLbl")} <ChevronRight size={14} />
          </Button>
        </div>

        <div className="flex items-center gap-1.5 text-[10px] text-console-text-subtle pt-1">
          <Music2 size={11} />
          <span>
            {t("songs.use.previewHint")}
          </span>
        </div>
      </div>
    </Modal>
  );
}