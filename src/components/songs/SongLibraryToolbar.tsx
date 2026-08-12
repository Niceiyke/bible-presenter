import React from "react";

export type SongSource = "mine" | "library";

interface SongLibraryToolbarProps {
  source: SongSource;
  onChangeSource: (s: SongSource) => void;
  onOpenImport: () => void;
  onNewSong: () => void;
}

/** Source switcher (My Songs / Hymn Library) plus primary library actions. */
export function SongLibraryToolbar({
  source,
  onChangeSource,
  onOpenImport,
  onNewSong,
}: SongLibraryToolbarProps) {
  return (
    <div className="flex justify-between items-center">
      <div className="flex gap-4 items-center" role="tablist" aria-label="Song source">
        <button
          role="tab"
          aria-selected={source === "mine"}
          onClick={() => onChangeSource("mine")}
          className={`text-xs font-bold uppercase tracking-widest ${source === "mine" ? "text-amber-500 border-b-2 border-amber-500" : "text-slate-500 hover:text-slate-300"}`}
        >
          My Songs
        </button>
        <button
          role="tab"
          aria-selected={source === "library"}
          onClick={() => onChangeSource("library")}
          className={`text-xs font-bold uppercase tracking-widest ${source === "library" ? "text-amber-500 border-b-2 border-amber-500" : "text-slate-500 hover:text-slate-300"}`}
        >
          Hymn Library
        </button>
      </div>
      {source === "mine" && (
        <div className="flex gap-2">
          <button
            onClick={onOpenImport}
            className="text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded"
          >
            Import
          </button>
          <button
            onClick={onNewSong}
            className="text-[10px] font-bold uppercase bg-amber-600 hover:bg-amber-500 text-white px-2 py-1 rounded"
          >
            + New
          </button>
        </div>
      )}
    </div>
  );
}