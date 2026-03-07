import { useState, useRef, useEffect } from 'react';
import { Search, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { ws } from '../api/wsClient';
import { useBibleStore } from '../stores/bibleStore';
import { Card, CardLabel, Btn, Pill, Input, Row, Select, VerseResult, VersePreview, Spinner } from '../components/ui';

// ── Quick verse entry ─────────────────────────────────────────────────────────
function QuickBiblePicker() {
  const { books, currentVersion } = useBibleStore();
  const [bookQuery, setBookQuery] = useState('');
  const [lockedBook, setLockedBook] = useState<string | null>(null);
  const [cvText, setCvText] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [activeSuggIdx, setActiveSuggIdx] = useState(0);
  const bookInputRef = useRef<HTMLInputElement>(null);
  const cvInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!bookQuery.trim()) { setSuggestions([]); return; }
    const q = bookQuery.toLowerCase();
    setSuggestions(books.filter(b => b.toLowerCase().includes(q)).slice(0, 6));
    setActiveSuggIdx(0);
  }, [bookQuery, books]);

  const confirmBook = (book: string) => {
    setLockedBook(book); setBookQuery(''); setSuggestions([]);
    setTimeout(() => cvInputRef.current?.focus(), 40);
  };

  const clearBook = () => {
    setLockedBook(null); setCvText(''); setSuggestions([]);
    setTimeout(() => bookInputRef.current?.focus(), 40);
  };

  const handleBookKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveSuggIdx(i => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveSuggIdx(i => Math.max(i - 1, 0)); }
    else if ((e.key === ' ' || e.key === 'Tab' || e.key === 'Enter') && suggestions.length > 0) {
      e.preventDefault(); confirmBook(suggestions[activeSuggIdx]);
    } else if (e.key === 'Escape') { setSuggestions([]); setBookQuery(''); }
  };

  const handleCvKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { clearBook(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!lockedBook) return;
    const parts = cvText.trim().split(/[\s:.]+/);
    const chapter = parseInt(parts[0] || '1');
    const verse = parseInt(parts[1] || '1');
    if (isNaN(chapter) || isNaN(verse)) return;
    ws.send({
      cmd: 'stage_item',
      item: { type: 'Verse', data: { book: lockedBook, chapter, verse, version: currentVersion, text: '' } },
    });
    cvInputRef.current?.select();
  };

  return (
    <div className="relative">
      <div
        className="flex items-center gap-2 rounded-2xl px-3 py-3 focus-within:ring-1 transition-all"
        style={{
          background: 'var(--surface)',
          border: `1px solid ${suggestions.length > 0 ? 'var(--amber)' : 'var(--border)'}`,
        }}
      >
        {lockedBook ? (
          <>
            <span
              className="flex items-center gap-1.5 shrink-0 px-2.5 py-1 rounded-xl text-xs font-black uppercase tracking-wider"
              style={{ background: 'var(--amber-dim)', color: 'var(--amber)', border: '1px solid rgba(245,158,11,0.3)' }}
            >
              {lockedBook}
              <button onClick={clearBook} tabIndex={-1} className="ml-0.5 hover:opacity-70 transition-opacity">
                <X size={12} />
              </button>
            </span>
            <input
              ref={cvInputRef}
              value={cvText}
              onFocus={() => setCvText('')}
              onChange={e => setCvText(e.target.value)}
              onKeyDown={handleCvKeyDown}
              placeholder="ch vs"
              className="flex-1 bg-transparent text-lg font-bold focus:outline-none min-w-0"
              style={{ color: 'var(--text)' }}
            />
          </>
        ) : (
          <input
            ref={bookInputRef}
            value={bookQuery}
            onFocus={() => setBookQuery('')}
            onChange={e => setBookQuery(e.target.value)}
            onKeyDown={handleBookKeyDown}
            placeholder="Quick verse — John 3 16"
            className="flex-1 bg-transparent text-base font-bold focus:outline-none"
            style={{ color: 'var(--text)' }}
          />
        )}
      </div>

      {suggestions.length > 0 && !lockedBook && (
        <div
          className="absolute top-full left-0 right-0 mt-2 rounded-2xl shadow-2xl z-[70] overflow-hidden anim-slide-up"
          style={{ background: 'var(--elevated)', border: '1px solid var(--border-hi)' }}
        >
          {suggestions.map((book, i) => (
            <button
              key={book}
              onMouseDown={e => { e.preventDefault(); confirmBook(book); }}
              className="w-full text-left px-5 py-3.5 text-sm font-black uppercase tracking-widest transition-all active:bg-[var(--bg)] cursor-pointer"
              style={{ color: i === activeSuggIdx ? 'var(--amber)' : 'var(--muted)', background: i === activeSuggIdx ? 'var(--amber-dim)' : 'transparent' }}
            >
              {book}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export function BiblePage() {
  const {
    versions, currentVersion, setCurrentVersion,
    books, selectedBook, setSelectedBook,
    chapters, selectedChapter, setSelectedChapter,
    verses, selectedVerse,
    navVerse, setNavVerse,
    searchResults, setSearchResults,
  } = useBibleStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const prevLen = useRef(searchResults.length);

  function onVersionChange(v: string) {
    setCurrentVersion(v);
    ws.send({ cmd: 'get_books', version: v });
  }
  function onBookChange(book: string) {
    setSelectedBook(book); setSelectedChapter(0); setNavVerse(null);
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
    ws.send({ cmd: 'search_hybrid', query: searchQuery });
  }

  useEffect(() => {
    if (searching && searchResults.length !== prevLen.current) {
      setSearching(false);
      prevLen.current = searchResults.length;
    }
  }, [searching, searchResults]);

  return (
    <div className="flex flex-col gap-3 p-4 overflow-y-auto flex-1">

      {/* Quick entry */}
      <Card>
        <CardLabel>Quick Entry</CardLabel>
        <QuickBiblePicker />
        <p className="text-[10px]" style={{ color: 'var(--muted)' }}>
          Type book → confirm → ch vs · Enter = Stage for main operator
        </p>
      </Card>

      {/* Version selector */}
      {versions.length > 0 && (
        <Card>
          <CardLabel>Version</CardLabel>
          <div className="flex gap-1.5 flex-wrap">
            {versions.map(v => (
              <Pill key={v} active={v === currentVersion} onClick={() => onVersionChange(v)}>{v}</Pill>
            ))}
          </div>
        </Card>
      )}

      {/* Navigate */}
      <Card>
        <CardLabel>Navigate</CardLabel>
        <Select value={selectedBook} onChange={e => onBookChange(e.target.value)}>
          <option value="">Select book…</option>
          {books.map(b => <option key={b} value={b}>{b}</option>)}
        </Select>

        <Row>
          <Select value={selectedChapter || ''} onChange={e => onChapterChange(Number(e.target.value))} className="flex-1">
            <option value="">Chapter</option>
            {chapters.map(c => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Select value={selectedVerse || ''} onChange={e => onVerseChange(Number(e.target.value))} className="flex-1">
            <option value="">Verse</option>
            {verses.map(v => <option key={v} value={v}>{v}</option>)}
          </Select>
        </Row>

        {navVerse && <VersePreview verse={navVerse} />}

        <div className="grid grid-cols-3 gap-2">
          <Btn
            disabled={!navVerse} size="md" className="flex items-center justify-center"
            onClick={() => navVerse && ws.send({ cmd: 'get_prev_verse', book: navVerse.book, chapter: navVerse.chapter, verse: navVerse.verse, version: currentVersion })}
          >
            <ChevronLeft size={18} />
          </Btn>
          <Btn
            variant="stage" disabled={!navVerse}
            onClick={() => navVerse && ws.send({ cmd: 'stage_item', item: { type: 'Verse', data: navVerse } })}
          >
            Stage
          </Btn>
          <Btn
            disabled={!navVerse} size="md" className="flex items-center justify-center"
            onClick={() => navVerse && ws.send({ cmd: 'get_next_verse', book: navVerse.book, chapter: navVerse.chapter, verse: navVerse.verse, version: currentVersion })}
          >
            <ChevronRight size={18} />
          </Btn>
        </div>
      </Card>

      {/* Search */}
      <Card>
        <div className="flex items-center justify-between">
          <CardLabel>Search</CardLabel>
          {searchResults.length > 0 && (
            <button
              onClick={() => { setSearchResults([]); setSearchQuery(''); }}
              className="flex items-center gap-1 text-[10px] font-bold active:opacity-60 cursor-pointer transition-opacity"
              style={{ color: 'var(--muted)' }}
            >
              <X size={11} /> Clear
            </button>
          )}
        </div>

        <Row>
          <div className="flex-1 relative">
            <Input
              placeholder="Ask in natural language…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSearch()}
            />
          </div>
          <Btn onClick={doSearch} disabled={!searchQuery.trim()}>
            <Search size={16} />
          </Btn>
        </Row>

        {searching && (
          <div className="flex items-center justify-center py-6 gap-3">
            <Spinner />
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              Running semantic search…
            </span>
          </div>
        )}

        {!searching && searchResults.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[10px] font-bold" style={{ color: 'var(--muted)' }}>
              {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
              {' · ranked by relevance'}
            </p>
            {searchResults.map((v, i) => (
              <VerseResult
                key={`${v.book}-${v.chapter}-${v.verse}-${v.version}-${i}`}
                verse={v}
                onClick={() => {}}
              />
            ))}
          </div>
        )}

        {!searching && searchQuery && searchResults.length === 0 && (
          <p className="text-xs text-center py-4" style={{ color: 'var(--muted)' }}>No results found</p>
        )}
      </Card>
    </div>
  );
}
