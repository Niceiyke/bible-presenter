import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen, ChevronUp, ChevronDown, Clock, Plus, Zap,
} from "lucide-react";
import { useAppStore } from "../store";
import { QuickBiblePicker } from "./QuickBiblePicker";
import { displayItemLabel } from "../utils";
import type { DisplayItem } from "../types";

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
    verseHistory,
    historyOpen, setHistoryOpen,
  } = useAppStore();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    try {
      const results: any = await invoke("search_semantic_query", { query: searchQuery });
      setSearchResults(results);
    } catch (err) {
      console.error("Search failed:", err);
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

      {/* Verse History — collapsible */}
      {verseHistory.length > 0 && (
        <>
          <div>
            <button
              onClick={() => setHistoryOpen(!historyOpen)}
              className="w-full flex items-center justify-between text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 hover:text-slate-300 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Clock size={11} />Recent ({verseHistory.length})
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
                  className="overflow-hidden space-y-1"
                >
                  {verseHistory.map((item, i) => (
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
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <hr className="border-slate-800" />
        </>
      )}

      {/* Keyword / semantic search — collapsible */}
      <div className="flex flex-col min-h-0">
        <button
          onClick={() => setBibleOpen((p) => ({ ...p, keywordSearch: !p.keywordSearch }))}
          className="w-full flex items-center justify-between text-xs font-bold text-slate-500 uppercase tracking-widest mb-3 hover:text-slate-300 transition-colors"
        >
          <span className="flex items-center gap-1.5"><Zap size={11} />Semantic Search</span>
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
              <button type="submit" className="bg-amber-500 hover:bg-amber-600 text-black font-bold px-3 py-2 rounded-lg text-sm transition-all">
                Go
              </button>
            </form>

            <div className="space-y-2 overflow-y-auto">
              {searchResults.length === 0 && searchQuery && (
                <p className="text-slate-600 text-xs italic text-center pt-4">No results found</p>
              )}
              {searchResults.map((v, i) => (
                <div key={i} className="p-3 rounded-lg bg-slate-800/50 border border-transparent hover:border-slate-700 transition-all group">
                  <p className="text-amber-500 text-xs font-bold mb-1 uppercase">{v.book} {v.chapter}:{v.verse} <span className="text-slate-500 font-normal normal-case">{v.version}</span></p>
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
