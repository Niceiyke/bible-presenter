import { useState } from 'react';
import { ws } from '../api/wsClient';
import { useBibleStore } from '../stores/bibleStore';
import { Card, CardLabel, Btn, Pill, Input, Row, Select, VerseResult, VersePreview, Spinner } from '../components/ui';

export function BiblePage() {
  const {
    versions, currentVersion, setCurrentVersion,
    books, selectedBook, setSelectedBook,
    chapters, selectedChapter, setSelectedChapter,
    verses, selectedVerse,
    navVerse, setNavVerse,
    searchResults, searchMode, setSearchMode,
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
  const prevLen = searchResults.length;
  if (searching && searchResults.length !== prevLen) setSearching(false);

  const selectedSearchVerse = searchIdx >= 0 ? searchResults[searchIdx] : null;

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto flex-1">
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
        <CardLabel>Search</CardLabel>
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
