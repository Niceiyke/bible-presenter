import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import { FONTS } from "../types";
import type { Song, LyricSection, DisplayItem } from "../types";

interface SongsTabProps {
  onOpenLyricsMode: (songId: string) => void;
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onAddToSchedule: (item: DisplayItem) => void;
}

export function SongsTab({ onOpenLyricsMode, onStage, onLive, onAddToSchedule }: SongsTabProps) {
  const {
    songs, setSongs,
    songSearch, setSongSearch,
    editingSong, setEditingSong,
    songImportText, setSongImportText,
    showSongImport, setShowSongImport,
  } = useAppStore();

  const getSongDisplayItem = (song: Song, flatIndex = 0): DisplayItem => {
    const flat: { label: string; lines: string[] }[] = [];
    if (song.arrangement && song.arrangement.length > 0) {
      for (const label of song.arrangement) {
        const sec = song.sections.find((s) => s.label === label);
        if (sec) flat.push(sec);
      }
    } else {
      flat.push(...song.sections);
    }
    const item = flat[flatIndex] || flat[0];
    return {
      type: "Song",
      data: {
        song_id: song.id,
        title: song.title,
        author: song.author,
        section_label: item.label,
        lines: item.lines,
        slide_index: flatIndex,
        total_slides: flat.length,
        font: song.font,
        font_size: song.font_size,
        font_weight: song.font_weight,
        color: song.color,
      },
    };
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h2 className="text-xs font-bold text-slate-500 uppercase tracking-widest">Songs Library</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setShowSongImport(!showSongImport)}
            className="text-[10px] font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded"
          >Import</button>
          <button
            onClick={() => setEditingSong({ id: "", title: "", author: "", sections: [{ label: "Verse 1", lines: [""] }], arrangement: [], style: "LowerThird" })}
            className="text-[10px] font-bold uppercase bg-amber-600 hover:bg-amber-500 text-white px-2 py-1 rounded"
          >+ New</button>
        </div>
      </div>

      {/* Import text area */}
      {showSongImport && (
        <div className="flex flex-col gap-2 bg-slate-900 border border-slate-700 rounded-xl p-3">
          <p className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">Paste lyrics — every line becomes a new slide</p>
          <textarea
            className="w-full h-32 bg-slate-950 text-slate-200 text-xs rounded-lg p-2 border border-slate-700 resize-none font-mono"
            placeholder={"Line 1\nLine 2\nLine 3..."}
            value={songImportText}
            onChange={(e) => setSongImportText(e.target.value)}
          />
          <div className="flex gap-2">
            <input
              className="flex-1 bg-slate-800 text-slate-200 text-xs rounded px-2 py-1 border border-slate-700"
              placeholder="Song title"
              id="import-song-title"
            />
            <button
              className="text-[10px] font-bold uppercase bg-amber-600 hover:bg-amber-500 text-white px-3 py-1 rounded"
              onClick={async () => {
                const titleEl = document.getElementById("import-song-title") as HTMLInputElement;
                const title = titleEl?.value.trim() || "Untitled";
                const lines = songImportText.split("\n").map(l => l.trim()).filter(l => l !== "");
                const sections: LyricSection[] = lines.map(line => ({ label: "", lines: [line] }));
                
                if (sections.length === 0) return;
                const saved = await invoke<Song>("save_song", { song: { id: "", title, author: "", sections, style: "LowerThird" } });
                const next = [...songs, saved].sort((a, b) => a.title.localeCompare(b.title));
                setSongs(next);
                emit("songs-sync", next);
                setSongImportText("");
                setShowSongImport(false);
              }}
            >Save</button>
          </div>
        </div>
      )}

      {/* Search */}
      <input
        className="w-full bg-slate-800 text-slate-200 text-xs rounded-lg px-3 py-2 border border-slate-700 placeholder-slate-500"
        placeholder="Search songs..."
        value={songSearch}
        onChange={(e) => setSongSearch(e.target.value)}
      />

      {/* Song list */}
      <div className="flex flex-col gap-2">
        {songs.filter((s) => s.title.toLowerCase().includes(songSearch.toLowerCase())).map((song) => (
          <div key={song.id} className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex flex-col gap-1">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-sm font-bold text-slate-200">{song.title}</p>
                {song.author && <p className="text-[10px] text-slate-500">{song.author}</p>}
                <p className="text-[10px] text-slate-600 mt-0.5">{song.sections.length} section{song.sections.length !== 1 ? "s" : ""} · {song.sections.reduce((a, s) => a + s.lines.length, 0)} lines</p>
              </div>
              <div className="flex gap-1">
                {song.style === "FullSlide" ? (
                  <>
                    <button
                      onClick={() => onStage(getSongDisplayItem(song, 0))}
                      className="text-[9px] font-black uppercase bg-amber-600 hover:bg-amber-500 text-white px-2 py-1 rounded"
                    >Stage</button>
                    <button
                      onClick={() => onLive(getSongDisplayItem(song, 0))}
                      className="text-[9px] font-black uppercase bg-red-700 hover:bg-red-600 text-white px-2 py-1 rounded"
                    >Live</button>
                    <button
                      onClick={() => onAddToSchedule(getSongDisplayItem(song, 0))}
                      className="text-[9px] font-black uppercase bg-slate-800 hover:bg-slate-700 text-slate-400 px-2 py-1 rounded border border-slate-700"
                    >+ Queue</button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => onOpenLyricsMode(song.id)}
                      className="text-[9px] font-black uppercase bg-green-700 hover:bg-green-600 text-white px-2 py-1 rounded"
                    >Use</button>
                    <button
                      onClick={() => onAddToSchedule(getSongDisplayItem(song, 0))}
                      className="text-[9px] font-black uppercase bg-slate-800 hover:bg-slate-700 text-slate-400 px-2 py-1 rounded border border-slate-700"
                    >+ Queue</button>
                  </>
                )}
                <button
                  onClick={() => setEditingSong(JSON.parse(JSON.stringify(song)))}
                  className="text-[9px] font-black uppercase bg-slate-700 hover:bg-slate-600 text-slate-300 px-2 py-1 rounded"
                >Edit</button>
                <button
                  onClick={async () => {
                    await invoke("delete_song", { id: song.id });
                    const next = songs.filter((s) => s.id !== song.id);
                    setSongs(next);
                    emit("songs-sync", next);
                  }}
                  className="text-[9px] font-black uppercase bg-red-900/50 hover:bg-red-800 text-red-400 px-2 py-1 rounded"
                >Del</button>
              </div>
            </div>
          </div>
        ))}
        {songs.length === 0 && (
          <p className="text-slate-600 text-xs italic text-center py-4">No songs yet. Create one or import lyrics.</p>
        )}
      </div>

      {/* Song Editor Modal */}
      {editingSong && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
            <div className="flex justify-between items-center p-4 border-b border-slate-800">
              <h3 className="text-sm font-bold text-slate-200">{editingSong.id ? "Edit Song" : "New Song"}</h3>
              <button onClick={() => setEditingSong(null)} className="text-slate-500 hover:text-white text-lg font-bold">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-slate-800 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-700"
                  placeholder="Song title"
                  value={editingSong.title}
                  onChange={(e) => setEditingSong({ ...editingSong, title: e.target.value })}
                />
                <input
                  className="flex-1 bg-slate-800 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-700"
                  placeholder="Author (optional)"
                  value={editingSong.author || ""}
                  onChange={(e) => setEditingSong({ ...editingSong, author: e.target.value })}
                />
                <select
                  className="bg-slate-800 text-slate-200 text-sm rounded-lg px-3 py-2 border border-slate-700 focus:outline-none"
                  value={editingSong.style || "LowerThird"}
                  onChange={(e) => setEditingSong({ ...editingSong, style: e.target.value as any })}
                >
                  <option value="LowerThird">Lower Third</option>
                  <option value="FullSlide">Full Slide (Hymn Style)</option>
                </select>
              </div>
              {editingSong.sections.map((section, si) => (
                <div key={si} className="bg-slate-800/50 border border-slate-700 rounded-xl p-3 flex flex-col gap-2">
                  <div className="flex gap-2 items-center">
                    <input
                      className="flex-1 bg-slate-800 text-slate-200 text-xs rounded px-2 py-1 border border-slate-600 font-bold"
                      value={section.label}
                      onChange={(e) => {
                        const s = [...editingSong.sections];
                        s[si] = { ...s[si], label: e.target.value };
                        setEditingSong({ ...editingSong, sections: s });
                      }}
                    />
                    <button
                      onClick={() => {
                        const s = editingSong.sections.filter((_, i) => i !== si);
                        setEditingSong({ ...editingSong, sections: s });
                      }}
                      className="text-red-500 hover:text-red-300 text-xs font-bold px-1"
                    >✕</button>
                  </div>
                  {section.lines.map((line, li) => (
                    <div key={li} className="flex gap-1">
                      <input
                        className="flex-1 bg-slate-900 text-slate-200 text-xs rounded px-2 py-1 border border-slate-700"
                        value={line}
                        placeholder={`Line ${li + 1}`}
                        onChange={(e) => {
                          const s = [...editingSong.sections];
                          const lines = [...s[si].lines];
                          lines[li] = e.target.value;
                          s[si] = { ...s[si], lines };
                          setEditingSong({ ...editingSong, sections: s });
                        }}
                      />
                      <button
                        onClick={() => {
                          const s = [...editingSong.sections];
                          s[si] = { ...s[si], lines: s[si].lines.filter((_, i) => i !== li) };
                          setEditingSong({ ...editingSong, sections: s });
                        }}
                        className="text-slate-600 hover:text-red-400 text-xs px-1"
                      >✕</button>
                    </div>
                  ))}
                  <button
                    onClick={() => {
                      const s = [...editingSong.sections];
                      s[si] = { ...s[si], lines: [...s[si].lines, ""] };
                      setEditingSong({ ...editingSong, sections: s });
                    }}
                    className="text-[10px] text-slate-500 hover:text-amber-400 font-bold uppercase self-start"
                  >+ Add Line</button>
                </div>
              ))}
              <button
                onClick={() => setEditingSong({ ...editingSong, sections: [...editingSong.sections, { label: `Section ${editingSong.sections.length + 1}`, lines: [""] }] })}
                className="text-[10px] font-bold uppercase text-slate-500 hover:text-amber-400 border border-slate-700 hover:border-amber-500 rounded-lg py-2"
              >+ Add Section</button>

              <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-3 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Song Styling</p>
                  {(editingSong.font || editingSong.font_size || editingSong.font_weight || editingSong.color) && (
                    <button
                      onClick={() => setEditingSong({ ...editingSong, font: undefined, font_size: undefined, font_weight: undefined, color: undefined })}
                      className="text-[9px] font-bold uppercase text-slate-500 hover:text-red-400"
                    >Reset Style</button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-500 uppercase font-bold">Font Family</label>
                    <select
                      className="bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-700 focus:outline-none"
                      value={editingSong.font || ""}
                      onChange={(e) => setEditingSong({ ...editingSong, font: e.target.value || undefined })}
                    >
                      <option value="">Default (Theme)</option>
                      {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-500 uppercase font-bold">Font Size (pt)</label>
                    <input
                      type="number"
                      className="bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-700 focus:outline-none"
                      value={editingSong.font_size || ""}
                      placeholder="Default"
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        setEditingSong({ ...editingSong, font_size: isNaN(val) ? undefined : val });
                      }}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-500 uppercase font-bold">Font Weight</label>
                    <select
                      className="bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-700 focus:outline-none"
                      value={editingSong.font_weight || ""}
                      onChange={(e) => setEditingSong({ ...editingSong, font_weight: e.target.value || undefined })}
                    >
                      <option value="">Default</option>
                      <option value="normal">Normal</option>
                      <option value="bold">Bold</option>
                      <option value="100">Thin (100)</option>
                      <option value="300">Light (300)</option>
                      <option value="500">Medium (500)</option>
                      <option value="700">Bold (700)</option>
                      <option value="900">Black (900)</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-slate-500 uppercase font-bold">Text Color</label>
                    <div className="flex gap-2">
                      <input
                        type="color"
                        className="w-8 h-8 bg-transparent border-none cursor-pointer rounded-lg overflow-hidden"
                        value={editingSong.color || "#ffffff"}
                        onChange={(e) => setEditingSong({ ...editingSong, color: e.target.value })}
                      />
                      <input
                        className="flex-1 bg-slate-800 text-slate-200 text-xs rounded px-2 py-1.5 border border-slate-700 focus:outline-none"
                        value={editingSong.color || ""}
                        placeholder="Default"
                        onChange={(e) => setEditingSong({ ...editingSong, color: e.target.value || undefined })}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Arrangement</p>
                  {(editingSong.arrangement ?? []).length > 0 && (
                    <button
                      onClick={() => setEditingSong({ ...editingSong, arrangement: [] })}
                      className="text-[9px] font-bold uppercase text-slate-500 hover:text-red-400"
                    >Clear</button>
                  )}
                </div>
                <p className="text-[10px] text-slate-600">Order sections for playback (repeat chorus, etc.)</p>
                <div className="flex flex-wrap gap-1.5">
                  {editingSong.sections.map((sec) => (
                    <button
                      key={sec.label}
                      onClick={() => setEditingSong({ ...editingSong, arrangement: [...(editingSong.arrangement ?? []), sec.label] })}
                      className="px-2 py-0.5 text-[10px] font-bold rounded bg-slate-700 hover:bg-amber-700 text-slate-300 hover:text-white border border-slate-600 hover:border-amber-500 transition-all"
                    >+ {sec.label}</button>
                  ))}
                </div>
                {(editingSong.arrangement ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {(editingSong.arrangement ?? []).map((label, i) => (
                      <span
                        key={`${label}-${i}`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded bg-amber-900/50 text-amber-300 border border-amber-700"
                      >
                        {i + 1}. {label}
                        <button
                          onClick={() => {
                            const arr = [...(editingSong.arrangement ?? [])];
                            arr.splice(i, 1);
                            setEditingSong({ ...editingSong, arrangement: arr });
                          }}
                          className="text-amber-500 hover:text-red-400 ml-0.5"
                        >×</button>
                      </span>
                    ))}
                  </div>
                )}
                {(editingSong.arrangement ?? []).length === 0 && (
                  <p className="text-[10px] text-slate-600 italic">Using natural section order</p>
                )}
              </div>
            </div>
            <div className="p-4 border-t border-slate-800 flex justify-end gap-2">
              <button onClick={() => setEditingSong(null)} className="text-xs font-bold uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-lg">Cancel</button>
              <button
                onClick={async () => {
                  const saved = await invoke<Song>("save_song", { song: editingSong });
                  const idx = songs.findIndex((s) => s.id === saved.id);
                  let next;
                  if (idx >= 0) { next = [...songs]; next[idx] = saved; }
                  else { next = [...songs, saved].sort((a, b) => a.title.localeCompare(b.title)); }
                  setSongs(next);
                  emit("songs-sync", next);
                  setEditingSong(null);
                }}
                className="text-xs font-bold uppercase bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded-lg"
              >Save Song</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
