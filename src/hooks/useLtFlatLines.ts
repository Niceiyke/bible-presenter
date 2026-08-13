import { useMemo } from "react";
import { useAppStore } from "../store";
import { flattenSongForLowerThird } from "../utils/song";

export interface LtFlatLine {
  text: string;
  sectionLabel: string;
}

/**
 * Shared flattened line list for the lower-third source (selected song or
 * quick lyrics). Replaces the triplicated `ltFlatLines` memos in App.tsx,
 * LowerThirdTab.tsx, and LtDesignerTab.tsx.
 */
export function useLtFlatLines(): LtFlatLine[] {
  const songs = useAppStore((s) => s.songs);
  const ltSongId = useAppStore((s) => s.ltSongId);
  const quickLyricsText = useAppStore((s) => s.quickLyricsText);

  return useMemo(() => {
    if (ltSongId === "quick-lyrics") {
      return quickLyricsText
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => ({ text: l.trim(), sectionLabel: "QUICK" }));
    }
    const song = ltSongId ? songs.find((s) => s.id === ltSongId) ?? null : null;
    return flattenSongForLowerThird(song);
  }, [songs, ltSongId, quickLyricsText]);
}