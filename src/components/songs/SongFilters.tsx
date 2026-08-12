import React from "react";
import { cn } from "../ui";
import { SearchField } from "../ui";
import { useT } from "../../i18n";
import type { SongSource } from "./SongLibraryToolbar";

export type SongModeFilter = "all" | "full" | "overlay";
export type SongMetadataFilter = "all" | "needs-metadata";

interface SongFiltersProps {
  source: SongSource;
  search: string;
  onSearch: (v: string) => void;
  mode: SongModeFilter;
  onMode: (v: SongModeFilter) => void;
  metadata: SongMetadataFilter;
  onMetadata: (v: SongMetadataFilter) => void;
}

const chip = (active: boolean) =>
  cn(
    "h-8 px-2.5 text-[10px] font-bold rounded-md border transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]",
    active
      ? "bg-console-surface-raised border-console-border-strong text-console-text"
      : "bg-transparent border-console-border text-console-text-subtle hover:text-console-text",
  );

/** Shared song search + filters. Search covers title, author, lyrics, key,
 *  CCLI, and section labels (via `searchSongs`); the filter chips narrow by
 *  output mode and metadata readiness. */
export function SongFilters({
  source,
  search,
  onSearch,
  mode,
  onMode,
  metadata,
  onMetadata,
}: SongFiltersProps) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2">
      <SearchField
        placeholder={source === "mine" ? t("songs.search.mine") : t("songs.search.library")}
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex items-center gap-0.5 bg-console-surface-raised/40 border border-console-border rounded-lg p-0.5"
          role="group"
          aria-label={t("songs.filter.mode")}
        >
          <button className={chip(mode === "all")} aria-pressed={mode === "all"} onClick={() => onMode("all")}>{t("songs.filter.all")}</button>
          <button className={chip(mode === "full")} aria-pressed={mode === "full"} onClick={() => onMode("full")}>{t("songs.filter.full")}</button>
          <button className={chip(mode === "overlay")} aria-pressed={mode === "overlay"} onClick={() => onMode("overlay")}>{t("songs.filter.overlay")}</button>
        </div>
        <div
          className="flex items-center gap-0.5 bg-console-surface-raised/40 border border-console-border rounded-lg p-0.5"
          role="group"
          aria-label={t("songs.filter.metadata")}
        >
          <button className={chip(metadata === "all")} aria-pressed={metadata === "all"} onClick={() => onMetadata("all")}>{t("songs.filter.all")}</button>
          <button
            className={chip(metadata === "needs-metadata")}
            aria-pressed={metadata === "needs-metadata"}
            onClick={() => onMetadata("needs-metadata")}
          >
            {t("songs.filter.needsMetadata")}
          </button>
        </div>
      </div>
    </div>
  );
}