import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Library, Loader2, Music2, RefreshCw } from "lucide-react";
import { useAppStore } from "../store";
import { useT } from "../i18n";
import type { Song, DisplayItem } from "../types";
import type { ParsedSong } from "../utils/songImporter";
import {
  buildSongDisplayItem,
  normalizeSong,
  searchSongs,
  songNeedsMetadata,
} from "../utils/song";
import { Button, ConfirmModal, EmptyState } from "./ui";
import {
  SongCard,
  SongEditorModal,
  SongFilters,
  SongImportWizard,
  SongLibraryToolbar,
  SongPreviewModal,
  SongUsePanel,
  type SongMetadataFilter,
  type SongModeFilter,
  type SongSource,
} from "./songs/index";

interface SongsTabProps {
  onOpenLyricsMode: (songId: string) => void;
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onAddToSchedule: (item: DisplayItem) => void;
}

const cloneSong = (s: Song): Song => JSON.parse(JSON.stringify(s));

/** Songs workspace orchestrator. Owns library source/search/filter state and
 *  the selected/preview/delete state; delegates forms to `components/songs/`
 *  and only mutates the persistent list after a backend command succeeds. */
export function SongsTab({ onOpenLyricsMode, onStage, onLive, onAddToSchedule }: SongsTabProps) {
  const {
    songs, setSongs,
    hymnLibrary, setHymnLibrary,
    isInitialized, backendAvailable,
    setBackendError,
  } = useAppStore();
  const t = useT();

  const [source, setSource] = React.useState<SongSource>("mine");
  const [search, setSearch] = React.useState("");
  const [mode, setMode] = React.useState<SongModeFilter>("all");
  const [metadata, setMetadata] = React.useState<SongMetadataFilter>("all");
  const [showSongImport, setShowSongImport] = React.useState(false);
  const [editingSong, setEditingSong] = React.useState<Song | null>(null);
  const [deleteSong, setDeleteSong] = React.useState<Song | null>(null);
  const [previewSong, setPreviewSong] = React.useState<Song | null>(null);
  const [useSong, setUseSong] = React.useState<Song | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [reloading, setReloading] = React.useState(false);

  const mineCount = songs.length;
  const hymnCount = hymnLibrary.length;

  const collection = source === "mine" ? songs : hymnLibrary;

  const filteredSongs = searchSongs(collection, search).filter((s) => {
    if (mode === "full" && s.style !== "FullSlide") return false;
    if (mode === "overlay" && s.style === "FullSlide") return false;
    if (metadata === "needs-metadata" && !songNeedsMetadata(s)) return false;
    return true;
  });

  const reload = async () => {
    setReloading(true);
    try {
      const [s, h] = await Promise.all([
        invoke<Song[]>("list_songs"),
        invoke<Song[]>("get_hymn_library"),
      ]);
      setSongs(s);
      setHymnLibrary(h);
    } catch (err: any) {
      setBackendError(`Songs failed to load: ${err?.message ?? err}`);
    } finally {
      setReloading(false);
    }
  };

  const handleImport = async (parsed: ParsedSong) => {
    const song: Song = normalizeSong({
      id: "",
      title: parsed.title || "Untitled",
      author: parsed.author,
      copyright: parsed.copyright,
      ccli: parsed.ccli,
      key: parsed.key,
      sections: parsed.sections.length > 0 ? parsed.sections : [{ label: "Verse 1", lines: [""] }],
      arrangement: [],
      style: "LowerThird",
    });
    const saved = await invoke<Song>("save_song", { song });
    const next = [...songs, saved].sort((a, b) => a.title.localeCompare(b.title));
    setSongs(next);
    emit("songs-sync", next);
    setShowSongImport(false);
  };

  const handleSaveSong = async (draft: Song) => {
    const saved = await invoke<Song>("save_song", { song: normalizeSong(draft) });
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

  /** Copy a song (user song duplicate or "Add to My Songs" for a hymn) with a
   *  fresh id so it never overwrites the source. */
  const handleCopySong = async (song: Song) => {
    if (!song.id || busyId) return;
    setBusyId(song.id);
    try {
      const copy = normalizeSong({ ...cloneSong(song), id: "" });
      const saved = await invoke<Song>("save_song", { song: copy });
      const next = [...songs, saved].sort((a, b) => a.title.localeCompare(b.title));
      setSongs(next);
      emit("songs-sync", next);
      setSource("mine");
    } catch (err: any) {
      setBackendError(`Copy failed: ${err?.message ?? err}`);
    } finally {
      setBusyId(null);
    }
  };

  const allowEditing = source === "mine";

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
        mineCount={mineCount}
        hymnCount={hymnCount}
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

      <SongFilters
        source={source}
        search={search}
        onSearch={setSearch}
        mode={mode}
        onMode={setMode}
        metadata={metadata}
        onMetadata={setMetadata}
      />

      {!isInitialized ? (
        <div className="flex items-center justify-center gap-2 py-10 text-console-text-subtle">
          <Loader2 size={16} className="animate-spin" />
          <p className="text-xs text-console-text-muted">{t("songs.loading")}</p>
        </div>
      ) : !backendAvailable ? (
        <EmptyState
          icon={<RefreshCw size={20} />}
          title={t("songs.error.title")}
          description={t("songs.error.desc")}
          action={
            <Button variant="primary" size="md" onClick={reload} loading={reloading}>{t("songs.retry")}</Button>
          }
        />
      ) : filteredSongs.length === 0 ? (
        <EmptyState
          icon={<Music2 size={20} />}
          title={
            search || mode !== "all" || metadata !== "all"
              ? t("songs.empty.match")
              : source === "mine"
              ? t("songs.empty.mine")
              : t("songs.empty.library")
          }
          description={
            search || mode !== "all" || metadata !== "all"
              ? t("songs.empty.matchDesc")
              : source === "mine"
              ? t("songs.empty.mineDesc")
              : t("songs.empty.libraryDesc")
          }
          action={
            search || mode !== "all" || metadata !== "all" ? (
              <Button variant="ghost" size="md" onClick={() => { setSearch(""); setMode("all"); setMetadata("all"); }}>
                {t("songs.clearFilters")}
              </Button>
            ) : source === "mine" ? (
              <div className="flex gap-2">
                <Button variant="primary" size="md" onClick={() =>
                  setEditingSong({
                    id: "",
                    title: "",
                    author: "",
                    sections: [{ label: "Verse 1", lines: [""] }],
                    arrangement: [],
                    style: "LowerThird",
                  })
                }>{t("songs.newSong")}</Button>
                <Button variant="ghost" size="md" onClick={() => setShowSongImport(true)}>{t("songs.import")}</Button>
              </div>
            ) : (
              <Button variant="ghost" size="md" onClick={reload} loading={reloading}>
                <Library size={14} /> {t("songs.reloadHymns")}
              </Button>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filteredSongs.map((song) => (
            <SongCard
              key={song.id}
              song={song}
              source={source}
              onPreview={() => setPreviewSong(song)}
              onUse={() => setUseSong(song)}
              onAddToSchedule={() => onAddToSchedule(buildSongDisplayItem(song, 0))}
              onEdit={allowEditing ? () => setEditingSong(cloneSong(song)) : undefined}
              onDuplicate={allowEditing ? () => handleCopySong(song) : undefined}
              onDelete={allowEditing ? () => setDeleteSong(song) : undefined}
              onAddToMySongs={!allowEditing ? () => handleCopySong(song) : undefined}
            />
          ))}
        </div>
      )}

      <SongPreviewModal song={previewSong} onClose={() => setPreviewSong(null)} />

      <SongUsePanel
        song={useSong}
        source={source}
        onClose={() => setUseSong(null)}
        onStage={(item) => onStage(item)}
        onLive={(item) => onLive(item)}
        onAddToSchedule={(item) => onAddToSchedule(item)}
      />

      <ConfirmModal
        open={!!deleteSong}
        title={t("songs.delete.title").replace("{name}", deleteSong?.title ?? "")}
        description={t("songs.delete.desc")}
        confirmLabel={t("songs.delete.confirm")}
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