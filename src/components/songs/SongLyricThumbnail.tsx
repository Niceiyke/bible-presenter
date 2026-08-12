import React from "react";
import type { Song, SongSlideData } from "../../types";
import { getSongSequence } from "../../utils/song";
import { SongSlideRenderer } from "../shared/Renderers";

interface SongLyricThumbnailProps {
  song: Song;
}

/** Small 16:9 lyric snapshot for song cards. Renders the first sequence
 *  section through the same `SongSlideRenderer` the output window uses, so the
 *  thumbnail shows exactly what will project. Never stages or broadcasts. */
export function SongLyricThumbnail({ song }: SongLyricThumbnailProps) {
  const sequence = getSongSequence(song);
  const sec = sequence[0];
  const data: SongSlideData = {
    song_id: song.id,
    title: song.title,
    author: song.author,
    section_label: sec?.label ?? "",
    lines: sec?.lines ?? [],
    slide_index: 0,
    total_slides: sequence.length,
    style: song.style,
    font: song.font,
    font_size: song.font_size,
    font_weight: song.font_weight,
    color: song.color,
  };

  return (
    <div className="relative w-full aspect-video rounded-lg overflow-hidden bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 border border-console-border">
      {data.lines.length > 0 ? (
        <div className="absolute inset-0" aria-hidden>
          <SongSlideRenderer data={data} scale={0.24} />
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-[10px] text-console-text-subtle italic">No lyrics yet</p>
        </div>
      )}
    </div>
  );
}