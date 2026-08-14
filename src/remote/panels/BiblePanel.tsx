import React, { useEffect, useMemo, useState } from "react";
import { Book, Plus, Radio, Search, Send } from "lucide-react";
import type { Verse } from "../../types/verse";
import type { RemoteBibleRef } from "../../types/remote";
import { Btn, Card, Label, Select, TextInput, cx, Spinner } from "../ui";
import type { PanelProps } from "../panelTypes";

function refPayload(v: Verse): RemoteBibleRef {
  return { book: v.book, chapter: v.chapter, verse: v.verse, version: v.version };
}

export function BiblePanel({ client, pushToast }: PanelProps) {
  const { snapshot, command, isHeldBySelf } = client;
  const canScripture = snapshot?.permissions?.scripture ?? false;
  const [version, setVersion] = useState(snapshot?.active_bible_version ?? "");
  const [books, setBooks] = useState<string[]>([]);
  const [book, setBook] = useState("");
  const [chapters, setChapters] = useState<number[]>([]);
  const [chapter, setChapter] = useState(1);
  const [verseNum, setVerseNum] = useState<number>(1);
  const [verses, setVerses] = useState<Verse[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Verse[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingChapter, setLoadingChapter] = useState(false);

  useEffect(() => {
    if (!version) return;
    command<string[]>("bible.books", { version }).then(setBooks).catch(pushToast);
  }, [command, version, pushToast]);

  useEffect(() => {
    if (!book || !version) return;
    command<number[]>("bible.chapters", { book, version }).then((c) => {
      setChapters(c);
      if (!c.includes(chapter)) setChapter(c[0] ?? 1);
    }).catch(pushToast);
  }, [command, book, version, chapter, pushToast]);

  useEffect(() => {
    if (!book || !version) return;
    setLoadingChapter(true);
    command<Verse[]>("bible.chapter", { book, chapter, version })
      .then(setVerses)
      .catch(pushToast)
      .finally(() => setLoadingChapter(false));
  }, [command, book, version, chapter, pushToast]);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const res = await command<{ results: Verse[]; method: string }>("bible.search", { query: query.trim(), version });
      setResults(res.results ?? []);
    } catch (e) {
      pushToast(String((e as Error).message ?? e));
    } finally {
      setSearching(false);
    }
  };

  const stageSelected = (v: Verse) => {
    if (!isHeldBySelf) {
      pushToast("You need control to stage — take control in the header");
      return;
    }
    command("bible.stage", refPayload(v)).catch((e) => pushToast(String((e as Error).message ?? e)));
  };

  const goLiveSelected = (v: Verse) => {
    if (!isHeldBySelf) {
      pushToast("You need control to go live");
      return;
    }
    command("bible.go_live", refPayload(v)).catch((e) => pushToast(String((e as Error).message)));
  };

  const addToService = (v: Verse) => {
    if (!isHeldBySelf) {
      pushToast("You need control to add to the service");
      return;
    }
    command("bible.add_to_service", refPayload(v)).catch((e) => pushToast(String((e as Error).message)));
  };

  const move = (dir: 1 | -1, live: boolean, v: Verse) => {
    if (!isHeldBySelf) {
      pushToast("You need control");
      return;
    }
    const type = live ? (dir === 1 ? "bible.go_live_next" : "bible.go_live_previous") : (dir === 1 ? "bible.stage_next" : "bible.stage_previous");
    command(type, refPayload(v)).catch((e) => pushToast(String((e as Error).message)));
  };

  const selectedVerse = verses.find((v) => v.verse === verseNum) ?? verses[0];

  const versionOptions = useMemo(
    () => (snapshot?.bible_versions ?? []).map((v) => ({ value: v, label: v })),
    [snapshot]
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Version row */}
      <Card>
        <label className="block">
          <Label>Version</Label>
          <Select value={version} options={versionOptions} onChange={(v) => { setVersion(v); setResults([]); }} />
        </label>
      </Card>

      {/* Scripture search */}
      <Card>
        <Label>Search Scripture</Label>
        <div className="flex gap-2">
          <TextInput value={query} onChange={setQuery} placeholder="e.g. John 3:16, love, faith&hellip;" onKeyDown={(e) => e.key === "Enter" && handleSearch()} />
          <Btn variant="primary" onClick={handleSearch} disabled={searching || !query.trim()} className="shrink-0 px-3">
            {searching ? <Spinner /> : <Search size={14} />}
          </Btn>
        </div>
        {results.length > 0 && (
          <div className="mt-2 flex flex-col max-h-40 overflow-y-auto gap-1">
            {results.slice(0, 30).map((v) => (
              <button
                key={`${v.book}-${v.chapter}-${v.verse}-${v.text.slice(0, 12)}`}
                onClick={() => { setBook(v.book); setChapter(v.chapter); setVerseNum(v.verse); setResults([]); }}
                className="text-left text-[11px] text-slate-300 hover:text-white hover:bg-slate-800/70 rounded-md px-2 py-1.5 transition-colors"
              >
                <span className="text-cyan-400 font-semibold mr-1">{v.book} {v.chapter}:{v.verse}</span>
                <span className="text-slate-400">{v.text}</span>
              </button>
            ))}
          </div>
        )}
        {!searching && results.length === 0 && query && (
          <p className="mt-2 text-[11px] text-slate-500">No results — press Enter or tap search.</p>
        )}
      </Card>

      {/* Chapter browser */}
      <Card>
        <Label>Browse</Label>
        {books.length === 0 ? (
          <div className="flex items-center gap-2 text-[11px] text-slate-500"><Spinner /> Loading books…</div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Select value={book} options={books.map((b) => ({ value: b, label: b }))} onChange={(b) => { setBook(b); setResults([]); }} />
            <Select value={String(chapter)} options={chapters.map((c) => ({ value: String(c), label: String(c) }))} onChange={(c) => setChapter(Number(c))} />
          </div>
        )}

        {selectedVerse && !loadingChapter && (
          <div className="mt-3 bg-slate-950/60 border border-slate-800 rounded-lg p-3">
            <p className="text-[12px] text-slate-200 leading-relaxed">
              <span className="text-cyan-300 font-bold">{selectedVerse.book} {selectedVerse.chapter}:{selectedVerse.verse}</span>{" "}
              {selectedVerse.text}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Btn variant="stage" onClick={() => setVerseNum((selectedVerse.verse - 1 + verses.length) || 1)} className="px-2 py-1 text-[11px]">◀ Prev</Btn>
              <Btn variant="stage" onClick={() => setVerseNum(((selectedVerse.verse) % verses.length) + 1)} className="px-2 py-1 text-[11px]">Next ▶</Btn>
              <span className="flex-1" />
              {canScripture ? (
                <>
                  <Btn variant="stage" onClick={() => stageSelected(selectedVerse)} className="px-2 py-1 text-[11px]"><Send size={12} /> Stage</Btn>
                  <Btn variant="live" onClick={() => goLiveSelected(selectedVerse)} className="px-2 py-1 text-[11px]"><Radio size={12} /> Go live</Btn>
                  <Btn variant="default" onClick={() => addToService(selectedVerse)} className="px-2 py-1 text-[11px]" title="Add to active service">
                    <Plus size={12} /> Service
                  </Btn>
                </>
              ) : (
                <p className="text-[10px] text-slate-600">You can read, but you don't have scripture control.</p>
              )}
            </div>
            {canScripture && (
            <div className="mt-2 flex gap-1.5">
              <Btn variant="ghost" onClick={() => move(-1, false, selectedVerse)} className="px-2 py-1 text-[11px]">Stage previous</Btn>
              <Btn variant="ghost" onClick={() => move(1, false, selectedVerse)} className="px-2 py-1 text-[11px]">Stage next</Btn>
              <Btn variant="ghost" onClick={() => move(1, true, selectedVerse)} className="px-2 py-1 text-[11px]">Go live next</Btn>
            </div>
            )}
          </div>
        )}
        {loadingChapter && (
          <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-500"><Spinner /> Loading chapter…</div>
        )}

        <div className="mt-3 flex flex-wrap gap-1.5 max-h-56 overflow-y-auto">
          {verses.map((v) => (
            <button
              key={v.verse}
              onClick={() => setVerseNum(v.verse)}
              className={cx(
                "min-w-[2rem] px-2 py-1 rounded-md text-[11px] border transition-colors",
                v.verse === verseNum
                  ? "bg-cyan-500/20 border-cyan-500 text-cyan-200 font-bold"
                  : "bg-slate-800/50 border-slate-700 text-slate-400 hover:text-white hover:border-slate-500"
              )}
            >
              {v.verse}
            </button>
          ))}
        </div>

        <p className="mt-2 flex items-center gap-1 text-[10px] text-slate-500">
          <Book size={10} /> {books.length} books · tap a number to read, then Stage / Go live from the preview.
        </p>
      </Card>
    </div>
  );
}