import React, { useState } from "react";
import { ChevronDown, ChevronRight, Music2, Radio, Send } from "lucide-react";
import type { RemoteSongSummary } from "../../types/remote";
import { Btn, Card, Label, TextInput, cx, Spinner } from "../ui";
import type { PanelProps } from "../panelTypes";

export function SongsPanel({ client, pushToast }: PanelProps) {
  const { command, isHeldBySelf } = client;
  const [query, setQuery] = useState("");
  const [includeHymns, setIncludeHymns] = useState(true);
  const [songs, setSongs] = useState<RemoteSongSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const search = async (q = query) => {
    setSearching(true);
    try {
      const res = await command<RemoteSongSummary[]>("songs.search", { query: q ?? "", include_hymns: includeHymns });
      setSongs(res ?? []);
      setSearched(true);
    } catch (e) {
      pushToast(String((e as Error).message ?? e));
    } finally {
      setSearching(false);
    }
  };

  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));

  const serve = (songId: string, index: number, live: boolean) => {
    if (!isHeldBySelf) {
      pushToast("You need control to present a song — take control in the header");
      return;
    }
    const type = live ? "song.go_live" : "song.stage";
    command(type, { song_id: songId, section_index: index }).catch((e) => pushToast(String((e as Error).message ?? e)));
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <Label>Find a song</Label>
        <div className="flex gap-2">
          <TextInput value={query} onChange={setQuery} placeholder="Title, author or lyric…" onKeyDown={(e) => e.key === "Enter" && search()} />
          <Btn variant="primary" onClick={() => search()} disabled={searching} className="shrink-0 px-3">
            {searching ? <Spinner /> : <Music2 size={14} />}
          </Btn>
        </div>
        <label className="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
          <input type="checkbox" checked={includeHymns} onChange={(e) => setIncludeHymns(e.target.checked)} className="accent-amber-500 w-3.5 h-3.5" />
          Include the hymn library
        </label>
      </Card>

      {searched && songs.length === 0 && (
        <Card>
          <p className="text-[11px] text-slate-500">No songs match. Try a different word or enable/disable hymns.</p>
        </Card>
      )}

      <div className="flex flex-col gap-1.5">
        {songs.map((song) => (
          <div key={song.id} className="bg-slate-900/70 border border-slate-800 rounded-xl overflow-hidden">
            <button onClick={() => toggle(song.id)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-slate-800/60">
              {openId === song.id ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-slate-100 font-semibold truncate">{song.title}</p>
                <p className="text-[10px] text-slate-500 truncate">{song.section_labels.join(" · ") || "No sections"}</p>
              </div>
              <span className="shrink-0 flex gap-1">
                <Btn variant="stage" onClick={(e) => { e.stopPropagation(); serve(song.id, 0, false); }} className="px-2 py-1 text-[11px]">
                  <Send size={11} />
                </Btn>
                <Btn variant="live" onClick={(e) => { e.stopPropagation(); serve(song.id, 0, true); }} className="px-2 py-1 text-[11px]">
                  <Radio size={11} />
                </Btn>
              </span>
            </button>
            {openId === song.id && (
              <div className="border-t border-slate-800 px-3 py-2 flex flex-col gap-1 max-h-56 overflow-y-auto">
                {song.section_labels.map((label, i) => (
                  <div key={`${label}-${i}`} className="flex items-center justify-between gap-2">
                    <span className={cx("text-[12px]", i === 0 ? "text-cyan-300 font-semibold" : "text-slate-400")}>
                      {i + 1}. {label}
                    </span>
                    <span className="flex gap-1">
                      <Btn variant="ghost" onClick={() => serve(song.id, i, false)} className="px-2 py-0.5 text-[10px]">Stage</Btn>
                      <Btn variant="ghost" onClick={() => serve(song.id, i, true)} className="px-2 py-0.5 text-[10px] text-red-300">Live</Btn>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {!searched && !searching && (
        <Card>
          <p className="text-[11px] text-slate-500">Search by title, author, musical key, or any lyric line.</p>
        </Card>
      )}
    </div>
  );
}