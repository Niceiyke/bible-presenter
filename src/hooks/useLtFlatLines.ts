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
  const showSectionLabels = useAppStore((s) => !!s.settings.show_song_section_labels);

  return useMemo(() => {
    if (ltSongId === "quick-lyrics") {
      return quickLyricsText
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => ({ text: l.trim(), sectionLabel: "QUICK" }));
    }
    const song = ltSongId ? songs.find((s) => s.id === ltSongId) ?? null : null;
    // The global "Show song section labels" output setting also gates the
    // lower-third overlay: when it is off, section labels never make it into
    // the projected payload (matching the full-screen song renderer).
    if (!showSectionLabels) {
      return flattenSongForLowerThird(song).map((l) => ({ ...l, sectionLabel: "" }));
    }
    return flattenSongForLowerThird(song);
  }, [songs, ltSongId, quickLyricsText, showSectionLabels]);
}