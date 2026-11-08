import React from "react";
import { LibraryBig, Music2, Plus, Upload } from "lucide-react";
import { Button } from "../ui";
import { useT } from "../../i18n";

export type SongSource = "mine" | "library";

interface SongLibraryToolbarProps {
  source: SongSource;
  onChangeSource: (s: SongSource) => void;
  onOpenImport: () => void;
  onNewSong: () => void;
  /** Live counts shown next to each source tab so the operator can see at a
   *  glance how many songs and hymns are available. */
  mineCount: number;
  hymnCount: number;
}

/** Source switcher (My Songs / Hymn Library) plus primary library actions.
 *  Two 40px+ action targets per the operator design system; sentence-case
 *  labels. */
export function SongLibraryToolbar({
  source,
  onChangeSource,
  onOpenImport,
  onNewSong,
  mineCount,
  hymnCount,
}: SongLibraryToolbarProps) {
  const t = useT();
  const tab = (s: SongSource, labelKey: string, count: number) => (
    <button
      role="tab"
      aria-selected={source === s}
      onClick={() => onChangeSource(s)}
      className={`h-8 px-2.5 rounded-md text-[10px] font-bold transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)] ${
        source === s
          ? "bg-console-surface-raised text-action-primary border border-action-primary/40"
          : "border border-transparent text-console-text-muted hover:text-console-text hover:bg-console-surface-raised"
      }`}
    >
      <span className="sr-only">{t(labelKey)} tab</span>
      {t(labelKey)}{" "}
      <span className="text-[11px] font-bold tabular-nums text-console-text-subtle">({count})</span>
    </button>
  );

  return (
    <section className="flex flex-wrap items-center gap-2 rounded-xl border border-console-border bg-console-surface/80 px-3 py-2.5 shadow-lg shadow-black/10">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-tool-audio/12 text-tool-audio"><Music2 size={15} /></span>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-black text-console-text">Song library</h1>
          <p className="text-[9px] font-medium text-console-text-subtle">{mineCount} my songs · {hymnCount} hymns</p>
        </div>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <div className="flex items-center gap-0.5 rounded-lg border border-console-border bg-console-canvas/70 p-0.5" role="tablist" aria-label="Song source">
          {tab("mine", "songs.source.mine", mineCount)}
          {tab("library", "songs.source.library", hymnCount)}
        </div>
        {source === "mine" && <>
          <Button variant="ghost" size="sm" onClick={onOpenImport}><Upload size={12} /> {t("songs.import")}</Button>
          <Button variant="primary" size="sm" onClick={onNewSong}><Plus size={12} /> {t("songs.newSong")}</Button>
        </>}
        {source === "library" && <span className="flex h-8 items-center gap-1 rounded-lg border border-console-border bg-console-canvas px-2 text-[9px] font-bold text-console-text-subtle"><LibraryBig size={12} /> Read-only</span>}
      </div>
    </section>
  );
}
