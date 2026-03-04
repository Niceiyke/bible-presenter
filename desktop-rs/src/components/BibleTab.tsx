import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen, ChevronUp, ChevronDown, Clock, Plus, Zap, List,
} from "lucide-react";
import { useAppStore } from "../store";
import { QuickBiblePicker } from "./QuickBiblePicker";
import { displayItemLabel } from "../utils";
import type { DisplayItem, Verse } from "../types";

interface BibleTabProps {
  onStage: (item: DisplayItem) => void;
  onLive: (item: DisplayItem) => void;
  onAddToSchedule: (item: DisplayItem) => void;
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
    bibleOpen, setBibleOpen,
    recentItems,
    historyOpen, setHistoryOpen,
    stagedItem,
  } = useAppStore();

  const [historyTab, setHistoryTab] = useState<"bible" | "media" | "presentation">("bible");
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [chapterVerses, setChapterVerses] = useState<Verse[]>([]);
  const [loadingChapter, setLoadingChapter] = useState(false);
  const [activeChapter, setActiveChapter] = useState<{ book: string; chapter: number; version: string } | null>(null);
  
  // Ref to track if we are programmatically updating dropdowns to avoid loops
  const isSyncingRef = useRef(false);

  // Sync manual dropdowns TO activeChapter
  useEffect(() => {
    if (isSyncingRef.current) return;
    if (selectedBook && selectedChapter) {
      setActiveChapter({ book: selectedBook, chapter: selectedChapter, version: bibleVersion });
    }
  }, [selectedBook, selectedChapter, bibleVersion]);

  const lastSyncedStagedId = useRef<string | null>(null);

  // Sync stagedItem TO activeChapter AND dropdowns
  useEffect(() => {
    if (stagedItem?.type === "Verse") {
      const { book, chapter, verse, version } = stagedItem.data;
      const stagedId = `${book}-${chapter}-${verse}-${version}`;
      
      // Only sync if the staged item has actually changed
      if (stagedId !== lastSyncedStagedId.current) {
        lastSyncedStagedId.current = stagedId;
        
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
    } else if (!stagedItem) {
      lastSyncedStagedId.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagedItem]);

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

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchError(null);
    try {
      const results: any = await invoke("search_semantic_query", { query: searchQuery });
      setSearchResults(results);
    } catch (err: any) {
      setSearchError(`Search failed: ${err.message || err || "Unknown error"}`);
      console.error("Search failed:", err);
    } finally {
      setIsSearching(false);
    }
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
      if (verse) onLive({ type: "Verse", data: verse });
    } catch (err) {
      console.error("handleSendLivePicker:", err);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Version selector */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {availableVersions.filter(v => !(settings.disabled_bible_versions || []).includes(v)).map((v) => (
          <button
            key={v}
            onClick={() => { setBibleVersion(v); localStorage.setItem("pref_bibleVersion", v); }}
            className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all ${
              bibleVersion === v
                ? "bg-amber-500 text-black"
                : "bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-700"
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      <hr className="border-slate-800" />

      {/* Quick keyboard entry — collapsible */}
      <div>
        <button
          onClick={() => setBibleOpen((p) => ({ ...p, quickEntry: !p.quickEntry }))}
          className="w-full flex items-center justify-between text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 hover:text-slate-300 transition-colors"
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

      <hr className="border-slate-800" />

      {/* Manual selection — collapsible */}
      <div>
        <button
          onClick={() => setBibleOpen((p) => ({ ...p, manualSelection: !p.manualSelection }))}
          className="w-full flex items-center justify-between text-xs font-bold text-slate-500 uppercase tracking-widest mb-3 hover:text-slate-300 transition-colors"
        >
          <span className="flex items-center gap-1.5"><BookOpen size={11} />Manual Selection</span>
          {bibleOpen.manualSelection ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {bibleOpen.manualSelection && (
          <div className="flex flex-col gap-2">
            <select
              value={selectedBook}
              onChange={(e) => setSelectedBook(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
            >
              <option value="">Select Book</option>
              {books.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>

            <div className="grid grid-cols-2 gap-2">
              <select
                value={selectedChapter}
                onChange={(e) => setSelectedChapter(parseInt(e.target.value))}
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
              >
                {chapters.map((c) => <option key={c} value={c}>Chap {c}</option>)}
              </select>
              <select
                value={selectedVerse}
                onChange={(e) => setSelectedVerse(parseInt(e.target.value))}
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
              >
                {verses.map((v) => <option key={v} value={v}>Verse {v}</option>)}
              </select>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              <button
                onClick={handleDisplaySelection}
                disabled={!selectedBook}
                className="bg-slate-700 hover:bg-slate-600 text-white font-bold py-2 rounded-lg transition-all text-xs disabled:opacity-30"
              >
                STAGE
              </button>
              <button
                onClick={handleSendLivePicker}
                disabled={!selectedBook}
                className="bg-amber-500 hover:bg-amber-400 text-black font-bold py-2 rounded-lg transition-all text-xs disabled:opacity-30"
              >
                DISPLAY
              </button>
              <button
                onClick={async () => {
                  if (!selectedBook) return;
                  const v: any = await invoke("get_verse", {
                    book: selectedBook, chapter: selectedChapter, verse: selectedVerse, version: bibleVersion,
                  });
                  if (v) onAddToSchedule({ type: "Verse", data: v });
                }}
                disabled={!selectedBook}
                className="bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 border border-amber-500/30 font-bold py-2 rounded-lg transition-all text-xs disabled:opacity-30"
              >
                + QUEUE
              </button>
            </div>
          </div>
        )}
      </div>

      <hr className="border-slate-800" />

      {/* Chapter View — Active staged chapter */}
      <div className="flex flex-col min-h-0">
        <button
          onClick={() => setBibleOpen((p: any) => ({ ...p, chapterView: !p.chapterView }))}
          className="w-full flex items-center justify-between text-xs font-bold text-slate-500 uppercase tracking-widest mb-3 hover:text-slate-300 transition-colors"
        >
          <span className="flex items-center gap-1.5"><List size={11} />Chapter View</span>
          {bibleOpen.chapterView ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {bibleOpen.chapterView && (
          <div className="flex-1 flex flex-col min-h-0">
            {activeChapter ? (
              <>
                <div className="flex items-center justify-between mb-2 px-1">
                  <p className="text-[10px] font-black text-amber-500 uppercase">
                    {activeChapter.book} {activeChapter.chapter} ({activeChapter.version})
                  </p>
                  {loadingChapter && <span className="text-[10px] text-slate-600 animate-pulse">Loading...</span>}
                </div>
                <div className="space-y-1 overflow-y-auto pr-1 custom-scrollbar max-h-[400px]">
                  {chapterVerses.map((v) => {
                    const isStaged = stagedItem?.type === "Verse" && 
                                     stagedItem.data.book === v.book && 
                                     stagedItem.data.chapter === v.chapter && 
                                     stagedItem.data.verse === v.verse &&
                                     stagedItem.data.version === v.version;
                    return (
                      <div
                        key={`${v.book}-${v.chapter}-${v.verse}`}
                        className={`p-2 rounded border transition-all group relative cursor-pointer ${
                          isStaged 
                            ? "bg-amber-500/10 border-amber-500/50" 
                            : "bg-slate-800/40 border-transparent hover:border-slate-700"
                        }`}
                        onClick={() => onStage({ type: "Verse", data: v })}
                      >
                        <div className="flex gap-2">
                          <span className={`text-[10px] font-black shrink-0 ${isStaged ? "text-amber-500" : "text-slate-600"}`}>
                            {v.verse}
                          </span>
                          <p className={`text-[11px] leading-snug ${isStaged ? "text-slate-200" : "text-slate-400 group-hover:text-slate-300"}`}>
                            {v.text}
                          </p>
                        </div>
                        <div className="absolute right-1 bottom-1 opacity-0 group-hover:opacity-100 transition-all flex gap-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); onLive({ type: "Verse", data: v }); }}
                            className="bg-amber-500 hover:bg-amber-400 text-black text-[9px] font-black px-2 py-0.5 rounded shadow-lg"
                          >
                            GO LIVE
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="text-slate-600 text-xs italic text-center py-8 px-4">
                Select a verse to view its chapter here
              </p>
            )}
          </div>
        )}
      </div>

      <hr className="border-slate-800" />

      {/* Recent Items — categorical collapsible */}
      {(recentItems.bible.length > 0 || recentItems.media.length > 0 || recentItems.presentation.length > 0) && (
        <>
          <div>
            <button
              onClick={() => setHistoryOpen(!historyOpen)}
              className="w-full flex items-center justify-between text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 hover:text-slate-300 transition-colors"
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
                  <div className="flex gap-1 bg-slate-900/50 p-0.5 rounded-lg border border-slate-800 shrink-0">
                    {(["bible", "media", "presentation"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setHistoryTab(t)}
                        className={`flex-1 py-1 rounded text-[9px] font-black uppercase transition-all ${
                          historyTab === t ? "bg-slate-700 text-amber-500" : "text-slate-600 hover:text-slate-400"
                        }`}
                      >
                        {t} ({recentItems[t].length})
                      </button>
                    ))}
                  </div>

                  <div className="space-y-1 overflow-y-auto max-h-[300px] pr-1 custom-scrollbar">
                    {recentItems[historyTab].length === 0 ? (
                      <p className="text-center py-4 text-[10px] text-slate-700 italic">No recent {historyTab} items</p>
                    ) : (
                      recentItems[historyTab].map((item, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-slate-800/40 border border-slate-800 group hover:border-slate-700 transition-all"
                        >
                          <div className="flex-1 min-w-0">
                            {item.type === "Verse" ? (
                              <p className="text-xs truncate">
                                <span className="text-amber-500/80 font-bold">{item.data.book} {item.data.chapter}:{item.data.verse}</span>
                                <span className="text-slate-600 ml-1 text-[10px]">{item.data.version}</span>
                              </p>
                            ) : (
                              <p className="text-xs text-slate-400 truncate">{displayItemLabel(item)}</p>
                            )}
                          </div>
                          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                            <button
                              onClick={() => onStage(item)}
                              className="text-[9px] font-bold px-1.5 py-0.5 bg-slate-700 hover:bg-slate-600 text-white rounded transition-all"
                            >
                              STAGE
                            </button>
                            <button
                              onClick={() => onLive(item)}
                              className="text-[9px] font-bold px-1.5 py-0.5 bg-amber-500 hover:bg-amber-400 text-black rounded transition-all"
                            >
                              GO
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <hr className="border-slate-800" />
        </>
      )}

      {/* Keyword / reference / semantic search — collapsible */}
      <div className="flex flex-col min-h-0">
        <button
          onClick={() => setBibleOpen((p) => ({ ...p, keywordSearch: !p.keywordSearch }))}
          className="w-full flex items-center justify-between text-xs font-bold text-slate-500 uppercase tracking-widest mb-3 hover:text-slate-300 transition-colors"
        >
          <span className="flex items-center gap-1.5"><Zap size={11} />Bible Search</span>
          {bibleOpen.keywordSearch ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        {bibleOpen.keywordSearch && (
          <>
            <form onSubmit={handleSearch} className="mb-3 flex gap-2">
              <input
                type="text"
                placeholder="Search all versions..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <button
                type="submit"
                disabled={isSearching}
                className="bg-amber-500 hover:bg-amber-600 text-black font-bold px-3 py-2 rounded-lg text-sm transition-all disabled:opacity-50"
              >
                {isSearching ? "..." : "Go"}
              </button>
            </form>
            {searchError && (
              <p className="text-red-400 text-xs mb-2">{searchError}</p>
            )}

            <div className="space-y-2 overflow-y-auto">
              {!isSearching && searchResults.length === 0 && searchQuery && !searchError && (
                <p className="text-slate-600 text-xs italic text-center pt-4">No results found</p>
              )}
              {searchResults.map((v: any) => (
                <div key={`${v.version}-${v.book}-${v.chapter}-${v.verse}`} className="p-3 rounded-lg bg-slate-800/50 border border-transparent hover:border-slate-700 transition-all group">
                  <div className="flex justify-between items-start mb-1">
                    <p className="text-amber-500 text-xs font-bold uppercase">{v.book} {v.chapter}:{v.verse} <span className="text-slate-500 font-normal normal-case">{v.version}</span></p>
                    {v.score !== undefined && (
                      <div className="flex items-center gap-1">
                        <div className="w-12 h-1 bg-slate-700 rounded-full overflow-hidden">
                          <div 
                            className={`h-full transition-all ${v.score > 0.8 ? "bg-emerald-500" : v.score > 0.6 ? "bg-amber-500" : "bg-red-500"}`}
                            style={{ width: `${v.score * 100}%` }}
                          />
                        </div>
                        <span className="text-[8px] font-mono text-slate-500">{Math.round(v.score * 100)}%</span>
                      </div>
                    )}
                  </div>
                  <p className="text-slate-300 text-xs mb-2 line-clamp-2">{v.text}</p>
                  <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-all">
                    <button onClick={() => onStage({ type: "Verse", data: v })} className="flex-1 bg-slate-600 hover:bg-slate-500 text-white text-[10px] font-bold py-1 rounded transition-all">STAGE</button>
                    <button onClick={() => onLive({ type: "Verse", data: v })} className="flex-1 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-bold py-1 rounded transition-all">DISPLAY</button>
                    <button onClick={() => onAddToSchedule({ type: "Verse", data: v })} className="px-2 bg-slate-700 hover:bg-slate-600 text-amber-500 text-[10px] font-bold py-1 rounded transition-all flex items-center" title="Add to schedule"><Plus size={11} /></button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
