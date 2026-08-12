import React from "react";
import { SearchField } from "../ui";
import type { SongSource } from "./SongLibraryToolbar";

interface SongFiltersProps {
  source: SongSource;
  search: string;
  onSearch: (v: string) => void;
}

/** Shared song search filter. Uses the operator SearchField primitive. */
export function SongFilters({ source, search, onSearch }: SongFiltersProps) {
  return (
    <SearchField
      placeholder={source === "mine" ? "Search my songs..." : "Search hymn library..."}
      value={search}
      onChange={(e) => onSearch(e.target.value)}
    />
  );
}