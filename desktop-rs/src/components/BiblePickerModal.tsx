import React, { useState, useEffect } from "react";
import { X, Search, Zap, BookOpen, Plus } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { QuickBiblePicker } from "./QuickBiblePicker";
import type { Verse, DisplayItem } from "../types";
import { useAppStore } from "../store";

interface BiblePickerModalProps {
  onSelect: (verse: Verse) => void;
  onClose: () => void;
}

export function BiblePickerModal({ onSelect, onClose }: BiblePickerModalProps) {
  const { bibleVersion, setBibleVersion, availableVersions, books, settings } = useAppStore();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Verse[]>([]);
  const [searchMode, setSearchMode] = useState<"quick" | "semantic">("quick");

  const [searchError, setSearchError] = useState<string | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearchError(null);
    try {
      const results: any = await invoke("search_semantic_query", { query: searchQuery });
      setSearchResults(results);
    } catch (err: any) {
      setSearchError(`Search failed: ${err.message || err || "Unknown error"}`);
      console.error("Search failed:", err);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
        <header className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <BookOpen className="text-amber-500" size={18} />
            <h2 className="text-sm font-black uppercase tracking-widest text-white">Insert Scripture</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-slate-800 rounded-full text-slate-400 hover:text-white transition-all">
            <X size={20} />
          </button>
        </header>

        <div className="p-4 border-b border-slate-800 bg-slate-900/50 flex flex-col gap-4 shrink-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            {availableVersions.filter(v => !(settings.disabled_bible_versions || []).includes(v)).map((v) => (
              <button
                key={v}
                onClick={() => setBibleVersion(v)}
                className={`px-2.5 py-1 rounded-md text-[10px] font-bold transition-all ${
                  bibleVersion === v
                    ? "bg-amber-500 text-black"
                    : "bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-700"
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          <div className="flex gap-2 p-1 bg-slate-950 rounded-lg border border-slate-800 w-fit">
            <button
              onClick={() => setSearchMode("quick")}
              className={`px-4 py-1.5 rounded text-[10px] font-black uppercase transition-all flex items-center gap-1.5 ${
                searchMode === "quick" ? "bg-slate-800 text-amber-500" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              <Zap size={12} /> Quick Entry
            </button>
            <button
              onClick={() => setSearchMode("semantic")}
              className={`px-4 py-1.5 rounded text-[10px] font-black uppercase transition-all flex items-center gap-1.5 ${
                searchMode === "semantic" ? "bg-slate-800 text-amber-500" : "text-slate-500 hover:text-slate-300"
              }`}
            >
              <Search size={12} /> Semantic Search
            </button>
          </div>

          {searchMode === "quick" ? (
            <QuickBiblePicker
              books={books}
              version={bibleVersion}
              onStage={async (item: DisplayItem) => {
                if (item.type === "Verse") onSelect(item.data);
              }}
              onLive={async (item: DisplayItem) => {
                if (item.type === "Verse") onSelect(item.data);
              }}
            />
          ) : (
            <>
              <form onSubmit={handleSearch} className="flex gap-2">
                <input
                  autoFocus
                  type="text"
                  placeholder="Search by topic or reference..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-amber-500"
                />
                <button type="submit" className="bg-amber-500 hover:bg-amber-400 text-black font-bold px-4 py-2 rounded-lg text-xs transition-all">
                  SEARCH
                </button>
              </form>
              {searchError && (
                <p className="text-red-400 text-[10px] mb-2 px-1">{searchError}</p>
              )}
            </>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
          {searchMode === "semantic" && (
            <div className="grid grid-cols-1 gap-2">
              {searchResults.length === 0 && searchQuery && (
                <p className="text-slate-600 text-xs italic text-center py-8">No results found</p>
              )}
              {searchResults.map((v, i) => (
                <button
                  key={i}
                  onClick={() => onSelect(v)}
                  className="p-3 text-left rounded-xl bg-slate-800/40 border border-slate-800 hover:border-amber-500/50 hover:bg-slate-800 transition-all group"
                >
                  <p className="text-amber-500 text-[10px] font-black mb-1 uppercase tracking-wider">
                    {v.book} {v.chapter}:{v.verse} <span className="text-slate-600 ml-1 font-bold">{v.version}</span>
                  </p>
                  <p className="text-slate-300 text-xs leading-relaxed line-clamp-2">{v.text}</p>
                </button>
              ))}
            </div>
          )}

          {searchMode === "quick" && (
            <div className="flex flex-col items-center justify-center py-12 text-slate-700">
              <Zap size={32} className="mb-2 opacity-20" />
              <p className="text-xs italic text-center max-w-[200px]">
                Type reference above and press Enter to select
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
