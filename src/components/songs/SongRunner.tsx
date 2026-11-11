import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  BookPlus,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  ListPlus,
  Music2,
  Pencil,
  Radio,
  Send,
  Trash2,
} from "lucide-react";
import type { DisplayItem, LowerThirdData, Song, SongSlideData, SongStyle } from "../../types";
import {
  buildSongPageItem,
  getSongPages,
  resolveSongLtTemplate,
} from "../../utils/song";
import { useAppStore } from "../../store";
import { useT } from "../../i18n";
import { Button, StatusBadge } from "../ui";
import { SongPreviewBox } from "./SongPreviewBox";
import { SongOverlayPreview } from "./SongOverlayPreview";
import { SongMoreMenu, type SongMoreMenuItem } from "./SongMoreMenu";
import type { SongSource } from "./SongLibraryToolbar";

interface SongRunnerProps {
  song: Song;
  source: SongSource;
  onClose: () => void;
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onAddToPlan: (style?: SongStyle) => void;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onAddToMySongs?: () => void;
}

/**
 * The single operating surface for a song. It replaces the old detail panel +
 * "Use song" cue grid: one page is previewed at a time, the page strip is the
 * cue list, and Stage / Live / overlay controls all act on that same page.
 */
export function SongRunner({
  song,
  source,
  onClose,
  onStage,
  onLive,
  onAddToPlan,
  onEdit,
  onDuplicate,
  onDelete,
  onAddToMySongs,
}: SongRunnerProps) {
  const {
    stagedItem, liveItem,
    ltVisible, setLtVisible,
    ltLinesPerDisplay, setLtLinesPerDisplay,
    ltAutoAdvance, setLtAutoAdvance,
    ltAutoSeconds, setLtAutoSeconds,
    ltSongId, setLtSongId, setLtLineIndex, setLtAtEnd, setLtMode,
    ltTemplate, ltSavedTemplates, songs, settings,
    busyActions, setBackendError,
  } = useAppStore();
  const t = useT();

  const [mode, setMode] = useState<SongStyle>((song.style as SongStyle) ?? "LowerThird");
  const [pageIndex, setPageIndex] = useState(0);

  useEffect(() => {
    setMode((song.style as SongStyle) ?? "LowerThird");
    setPageIndex(0);
  }, [song.id]);

  useEffect(() => {
    setPageIndex(0);
  }, [mode, ltLinesPerDisplay]);

  const pages = useMemo(
    () => getSongPages(song, { style: mode, linesPerDisplay: ltLinesPerDisplay }),
    [song, mode, ltLinesPerDisplay],
  );
  const pageCount = pages.length;
  const safeIndex = pageCount === 0 ? 0 : Math.max(0, Math.min(pageIndex, pageCount - 1));
  const page = pages[safeIndex];
  const item = useMemo(
    () => buildSongPageItem(song, safeIndex, mode, ltLinesPerDisplay),
    [song, safeIndex, mode, ltLinesPerDisplay],
  );
  const sameSongPage = (candidate: DisplayItem | null, target: DisplayItem) =>
    !!candidate &&
    candidate.type === "Song" &&
    target.type === "Song" &&
    candidate.data.song_id === target.data.song_id &&
    candidate.data.slide_index === target.data.slide_index &&
    (candidate.data.style ?? "LowerThird") === (target.data.style ?? "LowerThird");
  const isStaged = sameSongPage(stagedItem, item);
  const isLive = sameSongPage(liveItem, item);
  const stageBusy = busyActions.includes("stage");
  const liveBusy = busyActions.includes("goLive");

  const overlayTemplate = resolveSongLtTemplate(song.id, songs, ltSavedTemplates, ltTemplate);
  const showOverlayForPage = useCallback(async (index: number) => {
    const target = pages[index];
    if (!target) return;
    const payload: LowerThirdData = {
      kind: "Lyrics",
      data: {
        line1: target.lines[0] ?? "",
        line2: target.lines[1],
        section_label: settings.show_song_section_labels ? target.sectionLabel : undefined,
      },
    };
    try {
      await invoke("show_lower_third", {
        data: payload,
        template: resolveSongLtTemplate(song.id, songs, ltSavedTemplates, ltTemplate),
      });
      setLtVisible(true);
      setLtSongId(song.id);
      setLtLineIndex(target.lineStart);
      setLtAtEnd(false);
      setLtMode("lyrics");
    } catch (err: any) {
      setBackendError(`Show overlay failed: ${err?.message ?? err}`);
    }
  }, [pages, settings.show_song_section_labels, song.id, songs, ltSavedTemplates, ltTemplate, setLtVisible, setLtSongId, setLtLineIndex, setLtAtEnd, setLtMode, setBackendError]);

  const goToPage = useCallback((next: number) => {
    if (pageCount === 0) return;
    const clamped = Math.max(0, Math.min(next, pageCount - 1));
    if (clamped === safeIndex) return;
    setPageIndex(clamped);
    if (mode === "LowerThird" && ltVisible && ltSongId === song.id) {
      void showOverlayForPage(clamped);
    }
  }, [pageCount, safeIndex, mode, ltVisible, ltSongId, song.id, showOverlayForPage]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      // Space on a focused button is its activation key, not a page shortcut.
      if (event.key === " " && tag === "BUTTON") return;
      if (event.key === "ArrowRight" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        goToPage(safeIndex + 1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        goToPage(safeIndex - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        event.stopPropagation();
        goToPage(0);
      } else if (event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        goToPage(pageCount - 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [goToPage, safeIndex, pageCount]);

  const previewData = useMemo((): SongSlideData => ({
    song_id: song.id,
    title: song.title,
    author: song.author,
    section_label: page?.sectionLabel ?? "",
    section_id: page?.sectionId,
    lines: page?.lines ?? [],
    slide_index: safeIndex,
    total_slides: pageCount,
    line_start: page?.lineStart,
    style: mode,
    font: song.font,
    font_size: song.font_size,
    font_weight: song.font_weight,
    color: song.color,
    background: song.background,
    lt_template_id: song.lt_template_id,
  }), [song, page, safeIndex, pageCount, mode]);

  const overlayData: LowerThirdData = {
    kind: "Lyrics",
    data: {
      line1: page?.lines[0] ?? "",
      line2: page?.lines[1],
      section_label: settings.show_song_section_labels ? page?.sectionLabel : undefined,
    },
  };

  const handleToggleOverlay = async () => {
    if (ltVisible) {
      try {
        await invoke("hide_lower_third");
        setLtVisible(false);
      } catch (err: any) {
        setBackendError(`Hide overlay failed: ${err?.message ?? err}`);
      }
      return;
    }
    await showOverlayForPage(safeIndex);
  };

  const moreItems: SongMoreMenuItem[] = (
    source === "mine"
      ? [
          { label: t("songs.card.edit"), icon: <Pencil size={12} />, onClick: onEdit },
          { label: t("songs.card.duplicate"), icon: <Copy size={12} />, onClick: onDuplicate },
          { label: t("songs.card.delete"), icon: <Trash2 size={12} />, onClick: onDelete, danger: true },
        ]
      : [{ label: t("songs.card.addToMySongs"), icon: <BookPlus size={12} />, onClick: onAddToMySongs }]
  ).filter((entry) => entry.onClick);

  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-console-border bg-console-surface shadow-xl shadow-black/15">
      <header className="flex flex-wrap items-center gap-2 border-b border-console-border px-3 py-2.5">
        <button
          type="button"
          onClick={onClose}
          className="flex h-9 items-center gap-1 rounded-lg px-2 text-[10px] font-bold text-console-text-muted transition-colors hover:bg-console-surface-raised hover:text-console-text focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
          aria-label={t("songs.runner.back")}
          title={t("songs.runner.back")}
        >
          <ArrowLeft size={14} /> {t("songs.runner.back")}
        </button>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-tool-audio/12 text-tool-audio">
          <Music2 size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-black text-console-text" title={song.title}>{song.title}</h2>
          <p className="truncate text-[10px] text-console-text-subtle">
            {song.author || "Unknown author"}{song.key ? ` · Key ${song.key}` : ""} · {pageCount} page{pageCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center rounded-lg border border-console-border bg-console-canvas p-0.5" role="group" aria-label={t("songs.runner.mode")}>
          {(["LowerThird", "FullSlide"] as SongStyle[]).map((output) => (
            <button
              key={output}
              type="button"
              onClick={() => setMode(output)}
              aria-pressed={mode === output}
              className={`h-8 rounded-md px-2.5 text-[10px] font-black transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${mode === output ? "bg-console-surface-raised text-action-primary" : "text-console-text-subtle hover:text-console-text"}`}
            >
              {output === "FullSlide" ? t("songs.use.fullScreen") : t("songs.use.lyricsOverlay")}
            </button>
          ))}
        </div>
        <Button variant="stage" size="md" icon={<Send size={13} />} onClick={() => onStage(item)} disabled={stageBusy || liveBusy || pageCount === 0}>
          {t("songs.runner.stagePage")}
        </Button>
        <Button variant="live-outline" size="md" icon={<Radio size={13} />} onClick={() => onLive(item)} disabled={stageBusy || liveBusy || pageCount === 0}>
          {t("songs.runner.livePage")}
        </Button>
        <Button variant="ghost" size="md" icon={<ListPlus size={13} />} onClick={() => onAddToPlan(mode)} disabled={pageCount === 0}>
          {t("songs.card.addToPlan")}
        </Button>
        <SongMoreMenu items={moreItems} label={`${t("songs.card.more")} · ${song.title}`} />
      </header>

      <div className="grid min-h-0 gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)]">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="relative mx-auto aspect-video w-full max-w-[640px] overflow-hidden rounded-xl border border-console-border bg-slate-950">
            {mode === "FullSlide" ? (
              <SongPreviewBox data={previewData} showSectionLabel={!!settings.show_song_section_labels} fill />
            ) : (
              <SongOverlayPreview data={overlayData} template={overlayTemplate} />
            )}
            {pageCount === 0 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-[11px] italic text-console-text-subtle">{t("songs.editor.noSections")}</p>
              </div>
            )}
            <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5">
              {isLive && <StatusBadge tone="live" label={t("songs.runner.live")} />}
              {!isLive && isStaged && <StatusBadge tone="stage" label={t("songs.runner.staged")} />}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="md" icon={<ChevronLeft size={14} />} onClick={() => goToPage(safeIndex - 1)} disabled={safeIndex <= 0}>
              {t("songs.editor.prev")}
            </Button>
            <Button variant="ghost" size="md" onClick={() => goToPage(safeIndex + 1)} disabled={safeIndex >= pageCount - 1}>
              {t("songs.editor.next")} <ChevronRight size={14} />
            </Button>
            <div className="min-w-0 flex-1 text-center text-[10px] font-bold text-console-text-muted">
              {pageCount === 0 ? "No pages" : `${page?.sectionLabel || "Lyrics"} · page ${safeIndex + 1} of ${pageCount}`}
            </div>
          </div>
          <p className="text-[10px] leading-relaxed text-console-text-subtle">
            {t("songs.runner.keyboard")}
          </p>
        </div>

        <aside className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-console-text-muted">{t("songs.runner.pages")}</p>
            <span className="text-[10px] tabular-nums text-console-text-subtle">{safeIndex + 1} / {pageCount}</span>
          </div>
          <div className="custom-scrollbar flex max-h-[250px] flex-col gap-1 overflow-y-auto pr-1">
            {pages.map((entry, index) => {
              const pageItem = buildSongPageItem(song, index, mode, ltLinesPerDisplay);
              const live = sameSongPage(liveItem, pageItem);
              const staged = !live && sameSongPage(stagedItem, pageItem);
              return (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => goToPage(index)}
                  className={`flex min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${index === safeIndex ? "border-action-primary/60 bg-action-primary/10" : "border-transparent hover:border-console-border hover:bg-console-surface-raised"}`}
                >
                  <span className={`w-5 shrink-0 text-[10px] font-black tabular-nums ${index === safeIndex ? "text-action-primary" : "text-console-text-subtle"}`}>{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10px] font-bold text-console-text">{entry.sectionLabel || "Lyrics"}</span>
                    <span className="block truncate text-[9px] text-console-text-subtle">{entry.lines.join(" / ")}</span>
                  </span>
                  {live && <span className="shrink-0 rounded bg-state-live-soft px-1 py-0.5 text-[8px] font-black uppercase text-state-live">Live</span>}
                  {staged && <span className="shrink-0 rounded bg-state-stage-soft px-1 py-0.5 text-[8px] font-black uppercase text-state-stage">Staged</span>}
                </button>
              );
            })}
          </div>

          <div className="rounded-xl border border-console-border bg-console-canvas/60 p-2.5">
            <p className="text-[9px] font-black uppercase tracking-[0.14em] text-console-text-muted">{t("songs.runner.overlay")}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {mode === "LowerThird" ? (
                <Button variant={ltVisible ? "live-outline" : "ghost"} size="sm" icon={ltVisible ? <EyeOff size={12} /> : <Eye size={12} />} onClick={handleToggleOverlay} disabled={pageCount === 0}>
                  {ltVisible ? t("songs.use.hideOverlay") : t("songs.runner.showOverlay")}
                </Button>
              ) : (
                <span className="text-[10px] text-console-text-subtle">Full-screen pages go through Stage / Live.</span>
              )}
            </div>
            {mode === "LowerThird" && (
              <>
                <div className="mt-2 flex items-center gap-1.5">
                  <span className="text-[9px] font-bold uppercase tracking-wide text-console-text-subtle">{t("songs.runner.lines")}</span>
                  {([1, 2] as const).map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setLtLinesPerDisplay(n)}
                      aria-pressed={ltLinesPerDisplay === n}
                      className={`h-7 w-7 rounded-md text-[10px] font-black transition-colors ${ltLinesPerDisplay === n ? "bg-action-primary text-black" : "bg-console-surface-strong text-console-text-muted hover:text-console-text"}`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setLtAutoAdvance(!ltAutoAdvance)}
                    aria-pressed={ltAutoAdvance}
                    className={`h-7 rounded-md px-2 text-[9px] font-black uppercase transition-colors ${ltAutoAdvance ? "bg-action-primary text-black" : "bg-console-surface-strong text-console-text-muted"}`}
                  >
                    Auto {ltAutoAdvance ? "on" : "off"}
                  </button>
                  {ltAutoAdvance && (
                    <>
                      <input
                        type="number"
                        min={1}
                        max={30}
                        value={ltAutoSeconds}
                        onChange={(event) => setLtAutoSeconds(Math.max(1, Math.min(30, Number(event.target.value) || 1)))}
                        className="h-7 w-12 rounded-md border border-console-border bg-console-surface-raised px-1 text-center text-[10px] text-console-text"
                        aria-label={t("songs.runner.autoSeconds")}
                      />
                      <span className="text-[9px] text-console-text-subtle">sec</span>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
