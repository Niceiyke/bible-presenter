import React, { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DisplayItem } from "../types";

export function QuickBiblePicker({
  books,
  version,
  onStage,
  onLive,
}: {
  books: string[];
  version: string;
  onStage: (item: DisplayItem) => Promise<void>;
  onLive: (item: DisplayItem) => Promise<void>;
}) {
  const [bookQuery, setBookQuery] = useState("");
  const [lockedBook, setLockedBook] = useState<string | null>(null);
  const [cvText, setCvText] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [activeSuggIdx, setActiveSuggIdx] = useState(0);
  const lastEnterRef = useRef<number>(0);
  const bookInputRef = useRef<HTMLInputElement>(null);
  const cvInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!bookQuery.trim()) { setSuggestions([]); return; }
    const q = bookQuery.toLowerCase();
    setSuggestions(books.filter((b) => b.toLowerCase().includes(q)).slice(0, 7));
    setActiveSuggIdx(0);
  }, [bookQuery, books]);

  const confirmBook = (book: string) => {
    setLockedBook(book);
    setBookQuery("");
    setSuggestions([]);
    setTimeout(() => cvInputRef.current?.focus(), 40);
  };

  const clearBook = () => {
    setLockedBook(null);
    setCvText("");
    setSuggestions([]);
    setTimeout(() => bookInputRef.current?.focus(), 40);
  };

  const handleBookKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveSuggIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveSuggIdx((i) => Math.max(i - 1, 0)); }
    else if ((e.key === " " || e.key === "Tab" || e.key === "Enter") && suggestions.length > 0) {
      e.preventDefault();
      confirmBook(suggestions[activeSuggIdx]);
    } else if (e.key === "Escape") { setSuggestions([]); setBookQuery(""); }
  };

  const handleCvKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { clearBook(); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!lockedBook) return;
    const parts = cvText.trim().split(/[\s:.]+/);
    const chapter = parseInt(parts[0] || "1");
    const verse = parseInt(parts[1] || "1");
    if (isNaN(chapter) || isNaN(verse)) return;
    const now = Date.now();
    const isDouble = now - lastEnterRef.current < 800;
    lastEnterRef.current = now;
    try {
      const v: any = await invoke("get_verse", { book: lockedBook, chapter, verse, version });
      if (!v) return;
      const item: DisplayItem = { type: "Verse", data: v };
      if (isDouble) {
        await onLive(item);
      } else {
        await onStage(item);
      }
    } catch (err) {
      console.error("QuickBiblePicker:", err);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <div className={`flex items-center gap-1.5 bg-slate-800 border rounded-lg px-2 py-1.5 focus-within:ring-1 focus-within:ring-amber-500 transition-all ${suggestions.length > 0 ? "border-amber-500/50" : "border-slate-700"}`}>
          {lockedBook ? (
            <>
              <span className="flex items-center gap-1 bg-amber-500/20 text-amber-400 text-xs font-bold px-2 py-0.5 rounded shrink-0">
                {lockedBook}
                <button onClick={clearBook} tabIndex={-1} className="ml-1 text-amber-600 hover:text-amber-300 leading-none text-sm">×</button>
              </span>
              <input
                ref={cvInputRef}
                value={cvText}
                onChange={(e) => setCvText(e.target.value)}
                onKeyDown={handleCvKeyDown}
                placeholder="3 16  or  3:16"
                className="flex-1 bg-transparent text-slate-200 text-sm focus:outline-none min-w-0"
              />
            </>
          ) : (
            <input
              ref={bookInputRef}
              value={bookQuery}
              onChange={(e) => setBookQuery(e.target.value)}
              onKeyDown={handleBookKeyDown}
              placeholder="Type a book name..."
              className="flex-1 bg-transparent text-slate-200 text-sm focus:outline-none"
            />
          )}
        </div>
        {suggestions.length > 0 && !lockedBook && (
          <div className="absolute top-full left-0 right-0 mt-0.5 bg-slate-800 border border-slate-600 rounded-lg shadow-2xl z-30 overflow-hidden">
            {suggestions.map((book, i) => (
              <button
                key={book}
                onMouseDown={(e) => { e.preventDefault(); confirmBook(book); }}
                className={`w-full text-left px-3 py-2 text-xs transition-all ${i === activeSuggIdx ? "bg-amber-500/20 text-amber-400 font-bold" : "text-slate-300 hover:bg-slate-700"}`}
              >
                {book}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="text-[9px] text-slate-600 leading-tight">
        {lockedBook
          ? "Type chapter+verse (e.g. 3 16) · Enter = stage · Enter×2 = live · Esc = clear"
          : "↑↓ arrows · Space/Tab/Enter = select book"}
      </p>
    </div>
  );
}
