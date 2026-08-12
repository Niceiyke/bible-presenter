import React from "react";
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
      className={`h-10 px-3 rounded-lg text-xs font-bold transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus-ring)] ${
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
    <div className="flex flex-wrap gap-3 items-center justify-between">
      <div className="flex items-center gap-1" role="tablist" aria-label="Song source">
        {tab("mine", "songs.source.mine", mineCount)}
        {tab("library", "songs.source.library", hymnCount)}
      </div>
      {source === "mine" && (
        <div className="flex gap-2">
          <Button variant="ghost" size="md" onClick={onOpenImport}>{t("songs.import")}</Button>
          <Button variant="primary" size="md" onClick={onNewSong}>{t("songs.newSong")}</Button>
        </div>
      )}
    </div>
  );
}