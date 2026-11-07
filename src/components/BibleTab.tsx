import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BookOpen, BrainCircuit, ChevronUp, ChevronDown, Zap, Copy, Check,
  ChevronLeft, ChevronRight,
} from "lucide-react";
import { useAppStore } from "../store";
import { QuickBiblePicker } from "./QuickBiblePicker";
import { Button, IconButton } from "./ui";
import type { DisplayItem, Verse } from "../types";
import { AiScriptureTab } from "./AiScriptureTab";

interface BibleTabProps {
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
}

export function BibleTab({ onStage, onLive }: BibleTabProps) {
  const {
    bibleVersion,
    books, chapters, verses,
    selectedBook, setSelectedBook,
    selectedChapter, setSelectedChapter,
    selectedVerse, setSelectedVerse,
    stagedItem,
    liveItem,
    nextVerse,
    setToast,
  } = useAppStore();

  const [chapterVerses, setChapterVerses] = useState<Verse[]>([]);
  const [loadingChapter, setLoadingChapter] = useState(false);
  const [activeChapter, setActiveChapter] = useState<{ book: string; chapter: number; version: string } | null>(null);
  const [chapterViewFontSize, setChapterViewFontSize] = useState<number>(() => {
    const stored = localStorage.getItem("pref_chapterViewFontSize");
    return stored ? parseInt(stored, 10) : 11;
  });

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);

  // Ref to track if we are programmatically updating dropdowns to avoid loops
  const isSyncingRef = useRef(false);

  const copyVerse = useCallback(async (v: Verse, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      const ref = `${v.book} ${v.chapter}:${v.verse} (${v.version})`;
      await navigator.clipboard.writeText(`${ref} ${v.text}`);
      const id = `${v.book}-${v.chapter}-${v.verse}-${v.version}`;
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch {
      setToast("Copy failed");
    }
  }, [setToast]);

  // Sync manual dropdowns TO activeChapter
  useEffect(() => {
    if (isSyncingRef.current) return;
    if (selectedBook && selectedChapter) {
      setActiveChapter({ book: selectedBook, chapter: selectedChapter, version: bibleVersion });
    }
  }, [selectedBook, selectedChapter, bibleVersion]);

  const lastSyncedLiveId = useRef<string | null>(null);

  // Sync liveItem TO activeChapter AND dropdowns
  useEffect(() => {
    if (liveItem?.type === "Verse") {
      const { book, chapter, verse, version } = liveItem.data;
      const liveId = `${book}-${chapter}-${verse}-${version}`;

      // Only sync if the live item has actually changed
      if (liveId !== lastSyncedLiveId.current) {
        lastSyncedLiveId.current = liveId;

        // Only sync to dropdowns if they actually differ to avoid triggering cascades unnecessarily
        if (book !== selectedBook || chapter !== selectedChapter || verse !== selectedVerse) {
          isSyncingRef.current = true;
          setSelectedBook(book);
          setSelectedChapter(chapter);
          setSelectedVerse(verse);
          // Release after a delay
          setTimeout(() => { isSyncingRef.current = false; }, 100);
        }

        setActiveChapter({ book, chapter, version });
      }
    } else if (!liveItem) {
      lastSyncedLiveId.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveItem]);

  // Load verses when activeChapter changes
  useEffect(() => {
    if (!activeChapter) {
      setChapterVerses([]);
      return;
    }
    const { book, chapter, version } = activeChapter;
    setLoadingChapter(true);
    invoke("get_chapter", { book, chapter, version })
      .then((vs: any) => {
        setChapterVerses(vs);
      })
      .catch(console.error)
      .finally(() => setLoadingChapter(false));
  }, [activeChapter]);

  const handleDisplaySelection = async () => {
    if (!selectedBook) return;
    try {
      const verse: any = await invoke("get_verse", {
        book: selectedBook,
        chapter: selectedChapter,
        verse: selectedVerse,
        version: bibleVersion,
      });
      if (verse) onStage({ type: "Verse", data: verse });
    } catch (err) {
      console.error("handleDisplaySelection:", err);
    }
  };

  const handleSendLivePicker = async () => {
    if (!selectedBook) return;
    try {
      const verse: any = await invoke("get_verse", {
        book: selectedBook,
        chapter: selectedChapter,
        verse: selectedVerse,
        version: bibleVersion,
      });
      if (verse) {
        const item: DisplayItem = { type: "Verse", data: verse };
        onStage(item);
        onLive(item);
      }
    } catch (err) {
      console.error("handleSendLivePicker:", err);
    }
  };

  const handleChapterNav = useCallback((dir: 1 | -1) => {
    if (!activeChapter) return;
    const target = activeChapter.chapter + dir;
    if (target < 1) return;
    const key = `${activeChapter.book}-${activeChapter.chapter}`;
    void invoke("get_chapter", { book: activeChapter.book, chapter: target, version: activeChapter.version })
      .then((vs: any) => {
        if (Array.isArray(vs) && vs.length > 0) {
          const next = { book: activeChapter.book, chapter: target, version: activeChapter.version };
          setActiveChapter(next);
          isSyncingRef.current = true;
          setSelectedBook(activeChapter.book);
          setSelectedChapter(target);
          setSelectedVerse(vs[0].verse);
          setChapterVerses(vs);
          localStorage.setItem(`pref_chapterNav_${key}`, String(target));
          setTimeout(() => { isSyncingRef.current = false; }, 100);
        } else {
          setToast(`No chapter ${target} in ${activeChapter.book}`);
        }
      })
      .catch(() => setToast(`Failed to load chapter ${target}`));
  }, [activeChapter, setSelectedBook, setSelectedChapter, setSelectedVerse, setToast]);

  const handleStageNextVerse = useCallback(async () => {
    if (!activeChapter) return;
    const anchor = (stagedItem?.type === "Verse" && stagedItem.data.book === activeChapter.book
      && stagedItem.data.chapter === activeChapter.chapter) ? stagedItem.data
      : (liveItem?.type === "Verse" && liveItem.data.book === activeChapter.book
        && liveItem.data.chapter === activeChapter.chapter) ? liveItem.data
        : chapterVerses[chapterVerses.length - 1];
    if (!anchor) return;
    try {
      const nv: any = await invoke("get_next_verse", {
        book: activeChapter.book,
        chapter: anchor.chapter,
        verse: anchor.verse,
        version: activeChapter.version,
      });
      if (!nv) { setToast("No next verse"); return; }
      onStage({ type: "Verse", data: nv });
    } catch (err) {
      console.error("Stage next verse:", err);
    }
  }, [activeChapter, stagedItem, liveItem, chapterVerses, onStage, setToast]);

  const handleLiveNextVerse = useCallback(async () => {
    if (!activeChapter) return;
    const anchor = (liveItem?.type === "Verse" && liveItem.data.book === activeChapter.book
      && liveItem.data.chapter === activeChapter.chapter) ? liveItem.data
      : (stagedItem?.type === "Verse" && stagedItem.data.book === activeChapter.book
        && stagedItem.data.chapter === activeChapter.chapter) ? stagedItem.data
        : chapterVerses[chapterVerses.length - 1];
    if (!anchor) return;
    try {
      const nv: any = await invoke("get_next_verse", {
        book: activeChapter.book,
        chapter: anchor.chapter,
        verse: anchor.verse,
        version: activeChapter.version,
      });
      if (!nv) { setToast("No next verse"); return; }
      onLive({ type: "Verse", data: nv });
    } catch (err) {
      console.error("Go live next verse:", err);
    }
  }, [activeChapter, stagedItem, liveItem, chapterVerses, onLive, setToast]);

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(420px,0.85fr)]">
      <div className="min-w-0 space-y-4">
      <div className="grid gap-3 xl:grid-cols-2">
        <section className="rounded-xl border border-console-border bg-console-surface-raised/25 p-3">
          <div className="mb-2 flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-action-primary/10 text-action-primary"><BookOpen size={13} /></span><div><h2 className="text-[10px] font-black uppercase tracking-[0.14em] text-console-text">Quick picker</h2><p className="text-[8px] font-medium text-console-text-subtle">Type a book, then select a verse.</p></div></div>
          <QuickBiblePicker books={books} version={bibleVersion} onStage={async (item) => onStage(item)} onLive={async (item) => onLive(item)} />
        </section>

        <section className="rounded-xl border border-console-border bg-console-surface-raised/25 p-3">
          <div className="mb-2 flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-console-surface-strong text-console-text-muted"><BookOpen size={13} /></span><div><h2 className="text-[10px] font-black uppercase tracking-[0.14em] text-console-text">Manual selection</h2><p className="text-[8px] font-medium text-console-text-subtle">Use exact book, chapter, and verse controls.</p></div></div>
          <div className="grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_auto_auto]"><select value={selectedBook} onChange={(event) => setSelectedBook(event.target.value)} className="min-w-0 rounded-lg border border-console-border bg-console-surface-raised px-3 py-2 text-sm text-console-text"><option value="">Book</option>{books.map((book) => <option key={book} value={book}>{book}</option>)}</select><select value={selectedChapter} onChange={(event) => setSelectedChapter(parseInt(event.target.value))} className="min-w-0 rounded-lg border border-console-border bg-console-surface-raised px-3 py-2 text-sm text-console-text">{chapters.map((chapter) => <option key={chapter} value={chapter}>Chapter {chapter}</option>)}</select><select value={selectedVerse} onChange={(event) => setSelectedVerse(parseInt(event.target.value))} className="min-w-0 rounded-lg border border-console-border bg-console-surface-raised px-3 py-2 text-sm text-console-text">{verses.map((verse) => <option key={verse} value={verse}>Verse {verse}</option>)}</select><Button variant="ghost" size="md" disabled={!selectedBook} onClick={handleDisplaySelection}>Stage</Button><Button variant="primary" size="md" disabled={!selectedBook} onClick={handleSendLivePicker}>Go live</Button></div>
        </section>
      </div>

      <section className="min-w-0 rounded-xl border border-console-border bg-console-surface-raised/25 p-3">
        <header className="mb-2 flex items-center justify-between gap-2">
          <div><h3 className="text-[10px] font-black uppercase tracking-[0.14em] text-console-text">{activeChapter ? `${activeChapter.book} ${activeChapter.chapter}` : "Chapter reader"}</h3><p className="mt-0.5 text-[8px] font-bold text-console-text-subtle">{activeChapter ? "Select a verse to stage it." : "Search a reference to open its chapter."}</p></div>
          {activeChapter && <div className="flex items-center gap-1"><IconButton label="Previous chapter" size={12} className="h-7 w-7" onClick={() => handleChapterNav(-1)}><ChevronLeft size={13} /></IconButton><IconButton label="Next chapter" size={12} className="h-7 w-7" onClick={() => handleChapterNav(1)}><ChevronRight size={13} /></IconButton><button onClick={() => { const next = Math.max(8, chapterViewFontSize - 1); setChapterViewFontSize(next); localStorage.setItem("pref_chapterViewFontSize", String(next)); }} className="h-7 w-7 rounded bg-console-surface hover:bg-console-surface-strong text-[10px] font-black text-console-text-muted">A−</button><button onClick={() => { const next = Math.min(20, chapterViewFontSize + 1); setChapterViewFontSize(next); localStorage.setItem("pref_chapterViewFontSize", String(next)); }} className="h-7 w-7 rounded bg-console-surface hover:bg-console-surface-strong text-[10px] font-black text-console-text-muted">A+</button></div>}
        </header>
        {activeChapter ? <>
          <div className="mb-2 flex flex-wrap items-center gap-1.5"><Button variant="stage" size="sm" onClick={handleStageNextVerse}>Stage next</Button><Button variant="primary" size="sm" icon={<Zap size={12} />} onClick={handleLiveNextVerse}>Go live next</Button>{nextVerse && <button onClick={() => onStage({ type: "Verse", data: nextVerse })} className="rounded border border-state-stage/30 px-2 py-1 text-[8px] font-black uppercase text-state-stage">Next: {nextVerse.chapter}:{nextVerse.verse}</button>}{loadingChapter && <span className="text-[9px] font-bold text-console-text-subtle">Loading…</span>}</div>
          <div className="space-y-1">
            {chapterVerses.map((v) => {
              const isStaged = stagedItem?.type === "Verse" && stagedItem.data.book === v.book && stagedItem.data.chapter === v.chapter && stagedItem.data.verse === v.verse && stagedItem.data.version === v.version;
              const isLive = liveItem?.type === "Verse" && liveItem.data.book === v.book && liveItem.data.chapter === v.chapter && liveItem.data.verse === v.verse && liveItem.data.version === v.version;
              const isSelected = selectedBook === v.book && selectedChapter === v.chapter && selectedVerse === v.verse;
              return <article key={`${v.book}-${v.chapter}-${v.verse}`} onClick={() => { isSyncingRef.current = true; void onStage({ type: "Verse", data: v }); setTimeout(() => { isSyncingRef.current = false; }, 100); }} className={`group cursor-pointer rounded-lg border p-2.5 transition-all ${isStaged ? "border-state-stage/50 bg-state-stage-soft" : isLive ? "border-state-live/50 bg-state-live-soft" : isSelected ? "border-console-border-strong bg-console-surface-strong" : "border-transparent bg-console-canvas/45 hover:border-console-border"}`}>
                <div className="flex gap-2"><span className={`font-mono font-black ${isStaged ? "text-state-stage" : isLive ? "text-state-live" : "text-console-text-subtle"}`} style={{ fontSize: `${Math.max(8, chapterViewFontSize - 1)}px` }}>{v.verse}</span><p className={`flex-1 leading-snug ${isLive ? "font-medium text-white" : "text-console-text-muted group-hover:text-console-text"}`} style={{ fontSize: `${chapterViewFontSize}px` }}>{v.text}</p></div>
                <div className="mt-1.5 flex items-center gap-1"><Button variant="ghost" size="sm" onClick={(event) => { event.stopPropagation(); void onStage({ type: "Verse", data: v }); }}>Stage</Button><Button variant="bare" size="sm" onClick={(event) => { event.stopPropagation(); void onLive({ type: "Verse", data: v }); }}>Go live</Button><IconButton label="Copy verse text" tone="neutral" size={13} className="ml-auto h-7 w-7" onClick={(event) => copyVerse(v, event as any)}>{copiedId === `${v.book}-${v.chapter}-${v.verse}-${v.version}` ? <Check size={13} className="text-state-success" /> : <Copy size={13} />}</IconButton></div>
              </article>;
            })}
          </div>
        </> : <div className="rounded-lg border border-dashed border-console-border px-3 py-8 text-center text-[10px] font-medium text-console-text-subtle">Use Quick Picker or Manual Selection to open a chapter.</div>}
      </section>
      </div>

      <section className="rounded-xl border border-console-border bg-console-canvas/35">
        <button onClick={() => setAssistantOpen((open) => !open)} className="flex w-full items-center justify-between px-3 py-3 text-left"><span className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.14em] text-console-text-muted"><BrainCircuit size={12} className="text-violet-300" />Live Scripture Assistant</span>{assistantOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</button>
        {assistantOpen && <div className="border-t border-console-border p-3"><AiScriptureTab onStage={onStage} onLive={onLive} /></div>}
      </section>
      </div>
    </div>
  );
}
