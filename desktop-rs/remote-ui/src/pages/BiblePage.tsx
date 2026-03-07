import { useState, useRef, useEffect } from 'react';
import { ws } from '../api/wsClient';
import { useBibleStore } from '../stores/bibleStore';
import { Card, CardLabel, Btn, Pill, Input, Row, Select, VerseResult, VersePreview, Spinner } from '../components/ui';

function QuickBiblePicker() {
  const { books, currentVersion } = useBibleStore();
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

  const handleCvKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
    
    const cmd = isDouble ? 'go_live' : 'stage_item';
    ws.send({ 
      cmd, 
      item: { 
        type: 'Verse', 
        data: { book: lockedBook, chapter, verse, version: currentVersion, text: '' } // Text will be resolved on server
      } 
    });

    if (isDouble) {
      cvInputRef.current?.blur();
      setLockedBook(null);
      setCvText("");
      setBookQuery("");
    } else {
      cvInputRef.current?.select();
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <div className={`flex items-center gap-2 bg-[var(--bg)] border rounded-2xl px-3 py-3 focus-within:ring-2 focus-within:ring-[var(--amber)] transition-all ${suggestions.length > 0 ? "border-[var(--amber)]/50" : "border-[var(--border)]"}`}>
          {lockedBook ? (
            <>
              <span className="flex items-center gap-2 bg-[var(--amber)]/20 text-[var(--amber)] text-xs font-black px-3 py-1 rounded-lg shrink-0 uppercase tracking-wider">
                {lockedBook}
                <button onClick={clearBook} tabIndex={-1} className="ml-1 text-[var(--amber)] hover:text-white leading-none text-lg">×</button>
              </span>
              <input
                ref={cvInputRef}
                value={cvText}
                onFocus={() => setCvText("")}
                onChange={(e) => setCvText(e.target.value)}
                onKeyDown={handleCvKeyDown}
                placeholder="3 16"
                className="flex-1 bg-transparent text-[var(--text)] text-lg font-bold focus:outline-none min-w-0"
              />
            </>
          ) : (
            <input
              ref={bookInputRef}
              value={bookQuery}
              onFocus={() => setBookQuery("")}
              onChange={(e) => setBookQuery(e.target.value)}
              onKeyDown={handleBookKeyDown}
              placeholder="Quick verse (e.g. John 3 16)"
              className="flex-1 bg-transparent text-[var(--text)] text-base font-bold focus:outline-none"
            />
          )}
        </div>
        {suggestions.length > 0 && !lockedBook && (
          <div className="absolute top-full left-0 right-0 mt-2 bg-[var(--panel)] border border-[var(--border)] rounded-2xl shadow-2xl z-[70] overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
            {suggestions.map((book, i) => (
              <button
                key={book}
                onMouseDown={(e) => { e.preventDefault(); confirmBook(book); }}
                className={`w-full text-left px-5 py-4 text-sm font-black uppercase tracking-widest transition-all active:bg-[var(--bg)] ${i === activeSuggIdx ? "bg-[var(--amber)]/20 text-[var(--amber)]" : "text-[var(--muted)]"}`}
              >
                {book}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function BiblePage() {
  const {
    versions, currentVersion, setCurrentVersion,
    books, selectedBook, setSelectedBook,
    chapters, selectedChapter, setSelectedChapter,
    verses, selectedVerse,
    navVerse, setNavVerse,
    searchResults, setSearchResults, searchMode, setSearchMode,
  } = useBibleStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [searchIdx, setSearchIdx] = useState(-1);
  const [searching, setSearching] = useState(false);

  function onVersionChange(v: string) {
    setCurrentVersion(v);
    ws.send({ cmd: 'get_books', version: v });
  }

  function onBookChange(book: string) {
    setSelectedBook(book);
    setSelectedChapter(0);
    setNavVerse(null);
    ws.send({ cmd: 'get_chapters', book, version: currentVersion });
  }

  function onChapterChange(ch: number) {
    setSelectedChapter(ch);
    ws.send({ cmd: 'get_verses', book: selectedBook, chapter: ch, version: currentVersion });
  }

  function onVerseChange(v: number) {
    ws.send({ cmd: 'get_verse', book: selectedBook, chapter: selectedChapter, verse: v, version: currentVersion });
  }

  function doSearch() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchIdx(-1);
    ws.send({ cmd: searchMode === 'hybrid' ? 'search_hybrid' : 'search', query: searchQuery });
  }

  // When new results arrive, clear spinner
  const prevLen = useRef(searchResults.length);
  useEffect(() => {
    if (searching && searchResults.length !== prevLen.current) {
      setSearching(false);
      prevLen.current = searchResults.length;
    }
  }, [searching, searchResults]);

  const selectedSearchVerse = searchIdx >= 0 ? searchResults[searchIdx] : null;

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto flex-1">
      {/* Quick Entry */}
      <Card>
        <CardLabel>Quick Entry</CardLabel>
        <QuickBiblePicker />
      </Card>

      {/* Version */}
      <Card>
        <CardLabel>Version</CardLabel>
        <div className="flex flex-wrap gap-1.5">
          {versions.map(v => (
            <Pill key={v} active={v === currentVersion} onClick={() => onVersionChange(v)}>{v}</Pill>
          ))}
        </div>
      </Card>

      {/* Navigate */}
      <Card>
        <CardLabel>Navigate</CardLabel>
        <Select value={selectedBook} onChange={e => onBookChange(e.target.value)}>
          <option value="">Select book…</option>
          {books.map(b => <option key={b} value={b}>{b}</option>)}
        </Select>
        <Row>
          <Select value={selectedChapter || ''} onChange={e => onChapterChange(Number(e.target.value))} className="flex-1">
            <option value="">Ch</option>
            {chapters.map(c => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Select value={selectedVerse || ''} onChange={e => onVerseChange(Number(e.target.value))} className="flex-1">
            <option value="">Vs</option>
            {verses.map(v => <option key={v} value={v}>{v}</option>)}
          </Select>
        </Row>

        {navVerse && <VersePreview verse={navVerse} />}

        <Row>
          <Btn disabled={!navVerse} className="px-2.5" onClick={() => navVerse && ws.send({ cmd: 'get_prev_verse', book: navVerse.book, chapter: navVerse.chapter, verse: navVerse.verse, version: currentVersion })}>◀</Btn>
          <Btn disabled={!navVerse} className="flex-1" onClick={() => navVerse && ws.send({ cmd: 'stage_item', item: { type: 'Verse', data: navVerse } })}>Stage</Btn>
          <Btn variant="live" disabled={!navVerse} className="flex-1" onClick={() => navVerse && ws.send({ cmd: 'go_live', item: { type: 'Verse', data: navVerse } })}>Go Live</Btn>
          <Btn disabled={!navVerse} className="px-2.5" onClick={() => navVerse && ws.send({ cmd: 'get_next_verse', book: navVerse.book, chapter: navVerse.chapter, verse: navVerse.verse, version: currentVersion })}>▶</Btn>
        </Row>
      </Card>

      {/* Search */}
      <Card>
        <div className="flex justify-between items-center">
          <CardLabel>Search</CardLabel>
          {searchResults.length > 0 && (
            <button 
              onClick={() => { setSearchResults([]); setSearchQuery(''); }}
              className="text-[9px] font-bold text-[var(--muted)] hover:text-red-400 uppercase tracking-widest transition-all"
            >
              Clear
            </button>
          )}
        </div>
        <Row className="gap-1.5">
          <button
            onClick={() => setSearchMode('keyword')}
            className="px-2 py-1 rounded-full text-[10px] font-semibold border transition-all cursor-pointer"
            style={searchMode === 'keyword'
              ? { borderColor: 'var(--amber)', color: 'var(--amber)', background: 'rgba(245,158,11,.1)' }
              : { borderColor: 'var(--border)', color: 'var(--muted)', background: 'transparent' }}
          >Keyword</button>
          <button
            onClick={() => setSearchMode('hybrid')}
            className="px-2 py-1 rounded-full text-[10px] font-semibold border transition-all cursor-pointer"
            style={searchMode === 'hybrid'
              ? { borderColor: 'var(--amber)', color: 'var(--amber)', background: 'rgba(245,158,11,.1)' }
              : { borderColor: 'var(--border)', color: 'var(--muted)', background: 'transparent' }}
          >Semantic</button>
        </Row>
        <Row>
          <Input
            className="flex-1"
            placeholder="Keywords or reference…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && doSearch()}
          />
          <Btn onClick={doSearch}>Search</Btn>
        </Row>

        {searching && (
          <div className="flex items-center justify-center py-4"><Spinner /></div>
        )}

        {!searching && searchResults.length > 0 && (
          <div className="flex flex-col gap-1 max-h-56 overflow-y-auto">
            {searchResults.map((v, i) => (
              <VerseResult key={`${v.book}-${v.chapter}-${v.verse}-${v.version}`} verse={v} selected={i === searchIdx} onClick={() => setSearchIdx(i)} />
            ))}
          </div>
        )}

        {selectedSearchVerse && (
          <Row>
            <Btn variant="live" className="flex-1" onClick={() => ws.send({ cmd: 'go_live', item: { type: 'Verse', data: selectedSearchVerse } })}>Go Live</Btn>
            <Btn className="flex-1" onClick={() => ws.send({ cmd: 'stage_item', item: { type: 'Verse', data: selectedSearchVerse } })}>Stage</Btn>
          </Row>
        )}
      </Card>
    </div>
  );
}
