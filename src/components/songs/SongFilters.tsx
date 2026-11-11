import React from "react";
import { Filter, X } from "lucide-react";
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

/** Search stays visible because it is the only control most operators need.
 *  Output-mode and metadata filters live behind one compact Filters button so
 *  the library does not open with two unexplained "All" chips. */
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
  const [open, setOpen] = React.useState(false);
  const activeFilters = (mode !== "all" ? 1 : 0) + (metadata !== "all" ? 1 : 0);

  const clear = () => {
    onMode("all");
    onMetadata("all");
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-console-border bg-console-surface/45 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          className="min-w-[220px] flex-1"
          placeholder={source === "mine" ? t("songs.search.mine") : t("songs.search.library")}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[10px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]",
            activeFilters > 0
              ? "border-action-primary/40 bg-action-primary/10 text-action-primary"
              : "border-console-border bg-console-surface-raised text-console-text-muted hover:text-console-text",
          )}
        >
          <Filter size={12} />
          {t("songs.filter.filters")}
          {activeFilters > 0 && <span className="rounded bg-action-primary px-1 text-[9px] font-black text-black">{activeFilters}</span>}
        </button>
      </div>

      {open && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-console-border bg-console-canvas/60 p-2">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black uppercase tracking-wide text-console-text-subtle">{t("songs.filter.modeLabel")}</span>
            <div className="flex items-center gap-0.5 rounded-lg border border-console-border bg-console-surface-raised/40 p-0.5" role="group" aria-label={t("songs.filter.mode")}>
              <button className={chip(mode === "all")} aria-pressed={mode === "all"} onClick={() => onMode("all")}>{t("songs.filter.all")}</button>
              <button className={chip(mode === "full")} aria-pressed={mode === "full"} onClick={() => onMode("full")}>{t("songs.filter.full")}</button>
              <button className={chip(mode === "overlay")} aria-pressed={mode === "overlay"} onClick={() => onMode("overlay")}>{t("songs.filter.overlay")}</button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-black uppercase tracking-wide text-console-text-subtle">{t("songs.filter.metadataLabel")}</span>
            <div className="flex items-center gap-0.5 rounded-lg border border-console-border bg-console-surface-raised/40 p-0.5" role="group" aria-label={t("songs.filter.metadata")}>
              <button className={chip(metadata === "all")} aria-pressed={metadata === "all"} onClick={() => onMetadata("all")}>{t("songs.filter.all")}</button>
              <button className={chip(metadata === "needs-metadata")} aria-pressed={metadata === "needs-metadata"} onClick={() => onMetadata("needs-metadata")}>{t("songs.filter.needsMetadata")}</button>
            </div>
          </div>
          {activeFilters > 0 && (
            <button type="button" onClick={clear} className="ml-auto inline-flex h-8 items-center gap-1 rounded-md px-2 text-[10px] font-bold text-console-text-subtle hover:text-console-text">
              <X size={11} /> {t("songs.clearFilters")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
