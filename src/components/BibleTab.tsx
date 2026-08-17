import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen, ChevronUp, ChevronDown, Clock, Plus, Zap, List, Copy, Check,
  ChevronLeft, ChevronRight, Eye, Search,
} from "lucide-react";
import { useAppStore } from "../store";
import { QuickBiblePicker } from "./QuickBiblePicker";
import { Button, IconButton, SearchField, EmptyState } from "./ui";
import { displayItemLabel } from "../utils";
import { tierCapabilities } from "../system/tiers";
import type { DisplayItem, Verse } from "../types";

interface BibleTabProps {
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onAddToSchedule: (item: DisplayItem) => void;
}

/** Readable match quality label derived from the normalized bm25 score. */
function matchLabel(score: number | undefined): { label: string; tone: string } | null {
  if (score === undefined) return null;
  if (score >= 0.8) return { label: "Strong match", tone: "bg-state-success/15 text-state-success border-state-success/30" };
  if (score >= 0.6) return { label: "Good match", tone: "bg-action-primary/15 text-action-primary border-action-primary/30" };
  if (score >= 0.4) return { label: "Partial match", tone: "bg-state-stage/15 text-state-stage border-state-stage/30" };
  return { label: "Weak match", tone: "bg-console-surface-strong text-console-text-subtle border-console-border" };
}

export function BibleTab({ onStage, onLive, onAddToSchedule }: BibleTabProps) {
  const {
    bibleVersion, setBibleVersion,
    availableVersions,
    settings,
    books, chapters, verses,
    selectedBook, setSelectedBook,
    selectedChapter, setSelectedChapter,
    selectedVerse, setSelectedVerse,
    searchQuery, setSearchQuery,
    searchResults, setSearchResults,
    searchMethod, setSearchMethod,
    bibleOpen, setBibleOpen,
    recentItems,
    historyOpen, setHistoryOpen,
    stagedItem,
    liveItem,
    nextVerse,
    setToast,
    license,
  } = useAppStore();

  const [historyTab, setHistoryTab] = useState<"bible" | "media" | "presentation">("bible");
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [chapterVerses, setChapterVerses] = useState<Verse[]>([]);
  const [loadingChapter, setLoadingChapter] = useState(false);
  const [activeChapter, setActiveChapter] = useState<{ book: string; chapter: number; version: string } | null>(null);
  const [chapterViewFontSize, setChapterViewFontSize] = useState<number>(() => {
    const stored = localStorage.getItem("pref_chapterViewFontSize");
    return stored ? parseInt(stored, 10) : 11;
  });

  const [copiedId, setCopiedId] = useState<string | null>(null);

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

  const handlePreviewVerse = useCallback((v: Verse) => {
    // Preview navigates the chapter view to the verse's chapter and selects it.
    isSyncingRef.current = true;
    setSelectedBook(v.book);
    setSelectedChapter(v.chapter);
    setSelectedVerse(v.verse);
    setActiveChapter({ book: v.book, chapter: v.chapter, version: v.version });
    setBibleOpen((p) => ({ ...p, chapterView: true }));
    setTimeout(() => { isSyncingRef.current = false; }, 100);
  }, [setSelectedBook, setSelectedChapter, setSelectedVerse, setBibleOpen]);

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

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchError(null);
    try {
      const response: any = await invoke("search_semantic_query", { query: searchQuery, version: bibleVersion });
      setSearchResults(response.results);
      setSearchMethod(response.method);
    } catch (err: any) {
      setSearchError(`Search failed: ${err.message || err || "Unknown error"}`);
      console.error("Search failed:", err);
      setSearchResults([]);
      setSearchMethod("");
    } finally {
      setIsSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchResults([]);
    setSearchMethod("");
    setSearchQuery("");
    setSearchError(null);
  };

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

  const renderResultActions = (v: Verse) => (
    <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-console-border">
      <Button variant="stage" size="sm" icon={<Eye size={12} />} onClick={() => handlePreviewVerse(v)}>Preview</Button>
      <Button variant="ghost" size="sm" onClick={() => onStage({ type: "Verse", data: v })}>Stage</Button>
      <Button variant="primary" size="sm" icon={<Zap size={12} />} onClick={() => onLive({ type: "Verse", data: v })}>Go Live</Button>
      <Button variant="bare" size="sm" icon={<Plus size={12} />} onClick={() => onAddToSchedule({ type: "Verse", data: v })}>Service</Button>
      <IconButton
        label="Copy verse text"
        tone="neutral"
        size={13}
        className="ml-auto h-8 w-8"
        onClick={(e) => copyVerse(v, e as any)}
      >
        {copiedId === `${v.book}-${v.chapter}-${v.verse}-${v.version}` ? <Check size={13} className="text-state-success" /> : <Copy size={13} />}
      </IconButton>
    </div>
  );

  const enabledVersionsAll = availableVersions.filter(v => !(settings.disabled_bible_versions || []).includes(v));
  const versionCap = tierCapabilities(license?.tier).maxBibleVersions;
  const enabledVersions = versionCap < enabledVersionsAll.length
    ? enabledVersionsAll.slice(0, versionCap)
    : enabledVersionsAll;

  return (
    <div className="flex flex-col gap-4">
      {/* Search scope + active versions before searching */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {enabledVersions.map((v) => (
              <button
                key={v}
                onClick={() => { setBibleVersion(v); localStorage.setItem("pref_bibleVersion", v); }}
                className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all ${
                  bibleVersion === v
                    ? "bg-action-primary text-black"
                    : "bg-console-surface-raised text-console-text-muted hover:text-console-text border border-console-border"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-console-text-subtle uppercase tracking-widest font-bold">
            Active: {bibleVersion}
          </span>
        </div>
        <p className="text-[10px] text-console-text-subtle leading-tight">
          Search and reference results are filtered to the active version. Switch versions to search that
          translation.
        </p>
      </div>

      <hr className="border-console-border" />

      {/* Reference / Bible Search — primary workflow */}
      <div className="flex flex-col min-h-0">
        <button
          onClick={() => setBibleOpen((p) => ({ ...p, keywordSearch: !p.keywordSearch }))}
          className="w-full flex items-center justify-between text-xs font-bold text-console-text-muted uppercase tracking-widest mb-3 hover:text-console-text transition-colors"
        >
          <span className="flex items-center gap-1.5"><Search size={11} />Search & Reference</span>
          {bibleOpen.keywordSearch ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {bibleOpen.keywordSearch && (
          <>
            <form onSubmit={handleSearch} className="mb-2 flex gap-2">
              <SearchField
                placeholder='Try "John 3:16", "John 3:16-18", or "Psalm 23"...'
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
              <Button type="submit" loading={isSearching} className="shrink-0">Search</Button>
            </form>
            <p className="text-[9px] text-console-text-subtle mb-2 leading-tight">
              A plain reference (e.g. <span className="text-console-text">John 3:16</span>,
              <span className="text-console-text"> John 3:16-18</span>,
              <span className="text-console-text"> Psalm 23</span>) returns that verse or chapter directly.
              Anything else runs a keyword search within the active version.
            </p>
            {searchError && (
              <p className="text-state-error text-xs mb-2">{searchError}</p>
            )}

            <div className="space-y-2 overflow-y-auto">
              {!isSearching && searchResults.length === 0 && searchQuery && !searchError && (
                <EmptyState title="No results found" description="Check the reference or try different wording." />
              )}
              {searchResults.length > 0 && searchMethod && (
                <div className="flex items-center justify-between mb-2 px-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-[9px] font-black px-2 py-0.5 rounded uppercase tracking-widest ${
                      searchMethod === "reference" ? "bg-action-primary/20 text-action-primary border border-action-primary/30" :
                      "bg-console-surface-strong text-console-text-muted border border-console-border"
                    }`}>
                      {searchMethod === "reference" ? "Reference Match" : "Keyword Match"}
                    </span>
                    <span className="text-[9px] text-console-text-subtle font-bold uppercase tracking-tighter">
                      {searchResults.length} result{searchResults.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <button
                    onClick={clearSearch}
                    className="text-[9px] font-bold text-console-text-muted hover:text-state-error uppercase tracking-widest transition-colors"
                  >
                    Clear Results
                  </button>
                </div>
              )}
              {searchResults.map((v: any) => {
                const ml = matchLabel(v.score);
                return (
                  <div key={`${v.version}-${v.book}-${v.chapter}-${v.verse}`} className="p-3 rounded-lg bg-console-surface-raised border border-console-border hover:border-console-border-strong transition-colors">
                    <div className="flex justify-between items-start mb-1 gap-2">
                      <p className="text-action-primary font-mono text-xs font-bold uppercase">
                        {v.book} {v.chapter}:{v.verse} <span className="text-console-text-muted font-normal normal-case font-sans">{v.version}</span>
                      </p>
                      {ml && (
                        <span className={`text-[9px] font-bold px-2 py-0.5 rounded border uppercase tracking-wider shrink-0 ${ml.tone}`}>
                          {ml.label}
                        </span>
                      )}
                    </div>
                    <p className="text-console-text text-xs mb-1 line-clamp-2">{v.text}</p>
                    {renderResultActions(v)}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <hr className="border-console-border" />

      {/* Quick keyboard entry — collapsible */}
      <div>
        <button
          onClick={() => setBibleOpen((p) => ({ ...p, quickEntry: !p.quickEntry }))}
          className="w-full flex items-center justify-between text-xs font-bold text-console-text-muted uppercase tracking-widest mb-2 hover:text-console-text transition-colors"
        >
          <span className="flex items-center gap-1.5"><Zap size={11} />Quick Entry</span>
          {bibleOpen.quickEntry ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {bibleOpen.quickEntry && (
          <QuickBiblePicker
            books={books}
            version={bibleVersion}
            onStage={async (item) => onStage(item)}
            onLive={async (item) => onLive(item)}
          />
        )}
      </div>

      <hr className="border-console-border" />

      {/* Manual selection — advanced path, collapsible */}
      <div>
        <button
          onClick={() => setBibleOpen((p) => ({ ...p, manualSelection: !p.manualSelection }))}
          className="w-full flex items-center justify-between text-xs font-bold text-console-text-muted uppercase tracking-widest mb-3 hover:text-console-text transition-colors"
        >
          <span className="flex items-center gap-1.5"><BookOpen size={11} />Manual Selection <span className="text-console-text-subtle normal-case font-sans tracking-normal">(advanced)</span></span>
          {bibleOpen.manualSelection ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {bibleOpen.manualSelection && (
          <div className="flex flex-col gap-2">
            <select
              value={selectedBook}
              onChange={(e) => setSelectedBook(e.target.value)}
              className="bg-console-surface-raised border border-console-border rounded-lg px-3 py-2 text-sm text-console-text focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
            >
              <option value="">Select Book</option>
              {books.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>

            <div className="grid grid-cols-2 gap-2">
              <select
                value={selectedChapter}
                onChange={(e) => setSelectedChapter(parseInt(e.target.value))}
                className="bg-console-surface-raised border border-console-border rounded-lg px-3 py-2 text-sm text-console-text focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
              >
                {chapters.map((c) => <option key={c} value={c}>Chap {c}</option>)}
              </select>
              <select
                value={selectedVerse}
                onChange={(e) => setSelectedVerse(parseInt(e.target.value))}
                className="bg-console-surface-raised border border-console-border rounded-lg px-3 py-2 text-sm text-console-text focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
              >
                {verses.map((v) => <option key={v} value={v}>Verse {v}</option>)}
              </select>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              <Button variant="ghost" size="md" disabled={!selectedBook} onClick={handleDisplaySelection}>Stage</Button>
              <Button variant="primary" size="md" disabled={!selectedBook} onClick={handleSendLivePicker}>Go Live</Button>
              <Button variant="bare" size="md" disabled={!selectedBook} icon={<Plus size={12} />} onClick={async () => {
                if (!selectedBook) return;
                const v: any = await invoke("get_verse", {
                  book: selectedBook, chapter: selectedChapter, verse: selectedVerse, version: bibleVersion,
                });
                if (v) onAddToSchedule({ type: "Verse", data: v });
              }}>Queue</Button>
            </div>
          </div>
        )}
      </div>

      <hr className="border-console-border" />

      {/* Chapter View — Active staged chapter */}
      <div className="flex flex-col min-h-0">
        <div className="w-full flex items-center justify-between mb-3 gap-2 flex-wrap">
          <button
            onClick={() => setBibleOpen((p: any) => ({ ...p, chapterView: !p.chapterView }))}
            className="flex items-center gap-1.5 text-xs font-bold text-console-text-muted uppercase tracking-widest hover:text-console-text transition-colors"
          >
            <List size={11} />Chapter View
            {bibleOpen.chapterView ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          {bibleOpen.chapterView && (
            <div className="flex items-center gap-1.5">
              {activeChapter && (
                <div className="flex items-center gap-1 mr-1">
                  <IconButton label="Previous chapter" size={12} className="h-7 w-7" onClick={() => handleChapterNav(-1)}>
                    <ChevronLeft size={13} />
                  </IconButton>
                  <IconButton label="Next chapter" size={12} className="h-7 w-7" onClick={() => handleChapterNav(1)}>
                    <ChevronRight size={13} />
                  </IconButton>
                </div>
              )}
              <button
                onClick={() => {
                  const next = Math.max(8, chapterViewFontSize - 1);
                  setChapterViewFontSize(next);
                  localStorage.setItem("pref_chapterViewFontSize", String(next));
                }}
                className="w-5 h-5 rounded bg-console-surface-raised hover:bg-console-surface-strong text-console-text-muted text-[10px] font-black flex items-center justify-center transition-colors"
                title="Decrease font size"
              >A−</button>
              <span className="text-[9px] font-mono text-console-text-subtle w-5 text-center">{chapterViewFontSize}</span>
              <button
                onClick={() => {
                  const next = Math.min(20, chapterViewFontSize + 1);
                  setChapterViewFontSize(next);
                  localStorage.setItem("pref_chapterViewFontSize", String(next));
                }}
                className="w-5 h-5 rounded bg-console-surface-raised hover:bg-console-surface-strong text-console-text-muted text-[10px] font-black flex items-center justify-center transition-colors"
                title="Increase font size"
              >A+</button>
            </div>
          )}
        </div>
        {bibleOpen.chapterView && (
          <div className="flex-1 flex flex-col min-h-0">
            {activeChapter ? (
              <>
                <div className="flex items-center justify-between mb-2 px-1 gap-2 flex-wrap">
                  <p className="text-[10px] font-mono font-black text-action-primary uppercase">
                    {activeChapter.book} {activeChapter.chapter} ({activeChapter.version})
                  </p>
                  <div className="flex items-center gap-1.5">
                    <Button variant="stage" size="sm" onClick={handleStageNextVerse}>Stage Next Verse</Button>
                    <Button variant="primary" size="sm" icon={<Zap size={12} />} onClick={handleLiveNextVerse}>Go Live Next Verse</Button>
                    {nextVerse && (
                      <button
                        onClick={() => onStage({ type: "Verse", data: nextVerse })}
                        className="text-[9px] font-bold text-state-stage hover:text-state-stage/80 border border-state-stage/30 rounded px-2 py-1 uppercase tracking-widest transition-colors"
                        title="Stage the auto-detected next verse"
                      >
                        Next: {nextVerse.chapter}:{nextVerse.verse}
                      </button>
                    )}
                  </div>
                  {loadingChapter && <span className="text-[10px] text-console-text-subtle animate-pulse">Loading...</span>}
                </div>
                <div className="space-y-1 overflow-y-auto pr-1 custom-scrollbar max-h-[calc(100vh-460px)] min-h-[140px]">
                  {chapterVerses.map((v) => {
                    const isStaged = stagedItem?.type === "Verse" &&
                                     stagedItem.data.book === v.book &&
                                     stagedItem.data.chapter === v.chapter &&
                                     stagedItem.data.verse === v.verse &&
                                     stagedItem.data.version === v.version;
                    const isLive = liveItem?.type === "Verse" &&
                                   liveItem.data.book === v.book &&
                                   liveItem.data.chapter === v.chapter &&
                                   liveItem.data.verse === v.verse &&
                                   liveItem.data.version === v.version;
                    const isSelected = selectedBook === v.book && selectedChapter === v.chapter && selectedVerse === v.verse;
                    return (
                      <div
                        key={`${v.book}-${v.chapter}-${v.verse}`}
                        className={`p-2 rounded border transition-all group relative cursor-pointer ${
                          isStaged
                            ? "bg-state-stage-soft border-state-stage/50"
                            : isLive
                            ? "bg-state-live-soft border-state-live/50"
                            : isSelected
                            ? "bg-console-surface-strong border-console-border-strong"
                            : "bg-console-surface-raised/40 border-transparent hover:border-console-border"
                        }`}
                        onClick={() => { isSyncingRef.current = true; onStage({ type: "Verse", data: v }); setTimeout(() => { isSyncingRef.current = false; }, 100); }}
                      >
                        <div className="flex gap-2 items-start">
                          <span
                            className={`font-mono font-black shrink-0 ${isStaged ? "text-state-stage" : isLive ? "text-state-live" : "text-console-text-subtle"}`}
                            style={{ fontSize: `${Math.max(8, chapterViewFontSize - 1)}px` }}
                          >
                            {v.verse}
                          </span>
                          <p
                            className={`leading-snug flex-1 ${isStaged ? "text-console-text" : isLive ? "text-white font-medium" : "text-console-text-muted group-hover:text-console-text"}`}
                            style={{ fontSize: `${chapterViewFontSize}px` }}
                          >
                            {v.text}
                          </p>
                        </div>
                        <div className="mt-1.5 flex items-center gap-1">
                          <Button variant="bare" size="sm" onClick={(e) => { e.stopPropagation(); onLive({ type: "Verse", data: v }); }}>
                            Go Live
                          </Button>
                          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handlePreviewVerse(v); }}>
                            Preview
                          </Button>
                          <IconButton
                            label="Copy verse text"
                            tone="neutral"
                            size={13}
                            className="h-7 w-7 ml-auto"
                            onClick={(e) => copyVerse(v, e as any)}
                          >
                            {copiedId === `${v.book}-${v.chapter}-${v.verse}-${v.version}` ? <Check size={13} className="text-state-success" /> : <Copy size={13} />}
                          </IconButton>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="text-console-text-subtle text-xs italic text-center py-8 px-4">
                Search a reference to preview its chapter here, or select a verse to view it.
              </p>
            )}
          </div>
        )}
      </div>

      <hr className="border-console-border" />

      {/* Recent Items — categorical collapsible */}
      {(recentItems.bible.length > 0 || recentItems.media.length > 0 || recentItems.presentation.length > 0) && (
        <>
          <div className="flex flex-col min-h-0">
            <button
              onClick={() => setHistoryOpen(!historyOpen)}
              className="w-full flex items-center justify-between text-xs font-bold text-console-text-muted uppercase tracking-widest mb-2 hover:text-console-text transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Clock size={11} />Recent
              </span>
              {historyOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            <AnimatePresence>
              {historyOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden flex flex-col gap-2"
                >
                  <div className="flex gap-1 bg-console-surface-raised/50 p-0.5 rounded-lg border border-console-border shrink-0">
                    {(["bible", "media", "presentation"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setHistoryTab(t)}
                        className={`flex-1 py-1 rounded text-[9px] font-black uppercase transition-all ${
                          historyTab === t ? "bg-console-surface-strong text-action-primary" : "text-console-text-subtle hover:text-console-text-muted"
                        }`}
                      >
                        {t} ({recentItems[t].length})
                      </button>
                    ))}
                  </div>

                  <div className="space-y-1 overflow-y-auto max-h-[300px] pr-1 custom-scrollbar">
                    {recentItems[historyTab].length === 0 ? (
                      <p className="text-center py-4 text-[10px] text-console-text-subtle italic">No recent {historyTab} items</p>
                    ) : (
                      recentItems[historyTab].map((item, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-console-surface-raised/40 border border-console-border hover:border-console-border-strong transition-all"
                        >
                          <div className="flex-1 min-w-0">
                            {item.type === "Verse" ? (
                              <p className="text-xs truncate">
                                <span className="text-action-primary font-mono font-bold">{item.data.book} {item.data.chapter}:{item.data.verse}</span>
                                <span className="text-console-text-subtle ml-1 text-[10px]">{item.data.version}</span>
                              </p>
                            ) : (
                              <p className="text-xs text-console-text-muted truncate">{displayItemLabel(item)}</p>
                            )}
                          </div>
                          <div className="flex gap-1 shrink-0">
                            <Button variant="ghost" size="sm" onClick={() => onStage(item)}>Stage</Button>
                            <Button variant="primary" size="sm" onClick={() => onLive(item)}>Go</Button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <hr className="border-console-border" />
        </>
      )}
    </div>
  );
}