import React from "react";
import type { Song } from "../../types";
import { getSongSequence } from "../../utils/song";
import { Button, Modal } from "../ui";

interface SongPreviewModalProps {
  song: Song | null;
  onClose: () => void;
}

/** Read-only lyric preview. Renders the canonical song sequence so the
 *  preview matches playback order. Never stages or broadcasts. */
export function SongPreviewModal({ song, onClose }: SongPreviewModalProps) {
  return (
    <Modal
      open={!!song}
      onClose={onClose}
      title={song?.title ?? "Preview"}
      footer={<Button variant="bare" onClick={onClose}>Close</Button>}
    >
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 custom-scrollbar">
        {song && getSongSequence(song).map((sec, i) => (
          <div key={i} className="bg-console-surface-raised rounded-lg p-3">
            <p className="text-[9px] font-black uppercase text-action-primary mb-1.5">{sec.label}</p>
            {sec.lines.map((line, j) => (
              <p key={j} className="text-[11px] text-console-text leading-snug">{line}</p>
            ))}
          </div>
        ))}
        {song && getSongSequence(song).length === 0 && (
          <p className="text-xs text-console-text-subtle italic text-center py-4">No sections yet.</p>
        )}
      </div>
    </Modal>
  );
}