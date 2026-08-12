import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import type { Song, DisplayItem } from "../types";
import type { ParsedSong } from "../utils/songImporter";
import { buildSongDisplayItem } from "../utils/song";
import { ConfirmModal } from "./ui";
import {
  SongCard,
  SongEditorModal,
  SongFilters,
  SongImportWizard,
  SongLibraryToolbar,
  SongPreviewModal,
  type SongSource,
} from "./songs/index";

interface SongsTabProps {
  onOpenLyricsMode: (songId: string) => void;
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onAddToSchedule: (item: DisplayItem) => void;
}

/** Songs workspace orchestrator. Owns library source/search selection and the
 *  selected-song/preview/use state; delegates forms to `components/songs/` and
 *  only mutates the persistent list after a backend command succeeds. */
export function SongsTab({ onOpenLyricsMode, onStage, onLive, onAddToSchedule }: SongsTabProps) {
  const {
    songs, setSongs,
    hymnLibrary,
    setBackendError,
  } = useAppStore();

  const [source, setSource] = React.useState<SongSource>("mine");
  const [search, setSearch] = React.useState("");
  const [showSongImport, setShowSongImport] = React.useState(false);
  const [editingSong, setEditingSong] = React.useState<Song | null>(null);
  const [deleteSong, setDeleteSong] = React.useState<Song | null>(null);
  const [previewSong, setPreviewSong] = React.useState<Song | null>(null);

  const getSongDisplayItem = (song: Song, flatIndex = 0): DisplayItem =>
    buildSongDisplayItem(song, flatIndex);

  const collection = source === "mine" ? songs : hymnLibrary;
  const filteredSongs = collection.filter((s) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      s.title.toLowerCase().includes(q) ||
      (s.author && s.author.toLowerCase().includes(q))
    );
  });

  const handleImport = async (parsed: ParsedSong) => {
    const song: Song = {
      id: "",
      title: parsed.title || "Untitled",
      author: parsed.author,
      copyright: parsed.copyright,
      ccli: parsed.ccli,
      key: parsed.key,
      sections: parsed.sections.length > 0 ? parsed.sections : [{ label: "Verse 1", lines: [""] }],
      arrangement: [],
      style: "LowerThird",
    };
    const saved = await invoke<Song>("save_song", { song });
    const next = [...songs, saved].sort((a, b) => a.title.localeCompare(b.title));
    setSongs(next);
    emit("songs-sync", next);
    setShowSongImport(false);
  };

  const handleSaveSong = async (draft: Song) => {
    const saved = await invoke<Song>("save_song", { song: draft });
    const idx = songs.findIndex((s) => s.id === saved.id);
    let next;
    if (idx >= 0) { next = [...songs]; next[idx] = saved; }
    else { next = [...songs, saved].sort((a, b) => a.title.localeCompare(b.title)); }
    setSongs(next);
    emit("songs-sync", next);
    setEditingSong(null);
  };

  const handleDelete = async () => {
    if (!deleteSong) return;
    const saved = deleteSong;
    setDeleteSong(null);
    await invoke("delete_song", { id: saved.id });
    const next = songs.filter((s) => s.id !== saved.id);
    setSongs(next);
    emit("songs-sync", next);
  };

  const handleCopyHymn = async (song: Song) => {
    const saved = await invoke<Song>("save_song", { song: { ...song, id: "" } });
    const next = [...songs, saved].sort((a, b) => a.title.localeCompare(b.title));
    setSongs(next);
    emit("songs-sync", next);
    setSource("mine");
  };

  return (
    <div className="flex flex-col gap-4">
      <SongLibraryToolbar
        source={source}
        onChangeSource={setSource}
        onOpenImport={() => setShowSongImport((v) => !v)}
        onNewSong={() => setEditingSong({
          id: "",
          title: "",
          author: "",
          sections: [{ label: "Verse 1", lines: [""] }],
          arrangement: [],
          style: "LowerThird",
        })}
      />

      {showSongImport && source === "mine" && (
        <SongImportWizard
          onImport={async (parsed) => {
            try {
              await handleImport(parsed);
            } catch (err: any) {
              setBackendError(`Import failed: ${err?.message ?? err}`);
              throw err;
            }
          }}
          onCancel={() => setShowSongImport(false)}
        />
      )}

      <SongFilters source={source} search={search} onSearch={setSearch} />

      <div className="flex flex-col gap-2">
        {filteredSongs.map((song) => {
          const slideItem = getSongDisplayItem(song, 0);
          const isMine = source === "mine";
          return (
            <SongCard
              key={song.id}
              song={song}
              source={source}
              onPreview={() => setPreviewSong(song)}
              onStage={isMine && song.style === "FullSlide" ? () => onStage(slideItem) : undefined}
              onLive={isMine && song.style === "FullSlide" ? () => onLive(slideItem) : undefined}
              onAddToSchedule={isMine ? () => onAddToSchedule(slideItem) : undefined}
              onUseLyrics={isMine ? () => onOpenLyricsMode(song.id) : undefined}
              onEdit={isMine ? () => setEditingSong(JSON.parse(JSON.stringify(song))) : undefined}
              onDelete={isMine ? () => setDeleteSong(song) : undefined}
              onImport={!isMine ? () => handleCopyHymn(song) : undefined}
            />
          );
        })}
        {filteredSongs.length === 0 && (
          <p className="text-console-text-subtle text-xs italic text-center py-4">
            {source === "mine"
              ? search
                ? "No songs match your search."
                : "No songs yet. Create one or import lyrics."
              : "No hymns found in library."}
          </p>
        )}
      </div>

      <SongPreviewModal song={previewSong} onClose={() => setPreviewSong(null)} />

      <ConfirmModal
        open={!!deleteSong}
        title={`Delete "${deleteSong?.title ?? ""}"?`}
        description="The song will be removed from your library. This cannot be undone."
        confirmLabel="Delete Song"
        confirmVariant="live"
        onConfirm={async () => {
          try {
            await handleDelete();
          } catch (err: any) {
            setBackendError(`Delete failed: ${err?.message ?? err}`);
          }
        }}
        onClose={() => setDeleteSong(null)}
      />

      <SongEditorModal
        song={editingSong}
        onClose={() => setEditingSong(null)}
        onSave={async (draft) => {
          try {
            await handleSaveSong(draft);
          } catch (err: any) {
            setBackendError(`Save failed: ${err?.message ?? err}`);
            throw err;
          }
        }}
      />
    </div>
  );
}