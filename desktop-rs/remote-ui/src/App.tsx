import { useEffect, useState, useRef } from 'react';
import { ws } from './api/wsClient';
import type { WsEvent } from './api/types';

import { useAuthStore } from './stores/authStore';
import { useLiveStore } from './stores/liveStore';
import { useBibleStore } from './stores/bibleStore';
import { useSongsStore } from './stores/songsStore';
import { useScheduleStore } from './stores/scheduleStore';

import { PinScreen } from './components/PinScreen';
import { NowLiveBanner } from './components/NowLiveBanner';
import { StatusBar } from './components/StatusBar';

import { BiblePage } from './pages/BiblePage';
import { LyricsPage } from './pages/LyricsPage';
import { MediaPage } from './pages/MediaPage';
import { SchedulePage } from './pages/SchedulePage';
import { TimerPage } from './pages/TimerPage';
import { LowerThirdPage } from './pages/LowerThirdPage';
import { ControlPage } from './pages/ControlPage';

type TabId = 'bible' | 'lyrics' | 'media' | 'schedule' | 'timer' | 'lt' | 'control';
const TABS: { id: TabId; label: string }[] = [
  { id: 'bible',    label: 'Bible' },
  { id: 'lyrics',   label: 'Lyrics' },
  { id: 'media',    label: 'Media' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'timer',    label: 'Timer' },
  { id: 'lt',       label: 'Lower Third' },
  { id: 'control',  label: 'Control' },
];

function useWsEvents() {
  const auth = useAuthStore();
  const live = useLiveStore();
  const bible = useBibleStore();
  const songs = useSongsStore();
  const schedule = useScheduleStore();

  useEffect(() => {
    const unsub = ws.subscribe((evt: WsEvent) => {
      switch (evt.type) {
        case 'auth_ok':
          auth.setAuthed(evt.token);
          auth.setStatus('connected', 'Connected to Wordlyte');
          ws.send({ cmd: 'get_state' });
          ws.send({ cmd: 'get_versions' });
          ws.send({ cmd: 'get_songs' });
          ws.send({ cmd: 'get_media' });
          ws.send({ cmd: 'get_settings_full' });
          ws.send({ cmd: 'get_schedule' });
          ws.send({ cmd: 'get_lt_templates' });
          break;
        case 'auth_fail':
          auth.logout();
          auth.setStatus('disconnected', 'Wrong PIN — try again');
          break;
        case 'state':
          live.setLiveItem(evt.live_item);
          live.setLtShowing(!!evt.lt);
          if (typeof evt.is_blanked === 'boolean') live.setBlanked(evt.is_blanked);
          break;
        case 'transcription':
          live.setTranscription(evt.text);
          setTimeout(() => live.setTranscription(''), 8000);
          break;
        case 'lt_update':
          live.setLtShowing(!!evt.payload);
          break;
        case 'settings_update':
          live.setBlanked(evt.is_blanked);
          break;
        case 'settings_full':
          if (typeof evt.settings?.is_blanked === 'boolean') live.setBlanked(evt.settings.is_blanked);
          break;
        case 'versions':
          bible.setVersions(evt.versions);
          if (!bible.currentVersion && evt.versions.length > 0) {
            bible.setCurrentVersion(evt.versions[0]);
            ws.send({ cmd: 'get_books', version: evt.versions[0] });
          }
          break;
        case 'books':
          bible.setBooks(evt.books);
          if (!bible.selectedBook && evt.books.length > 0) {
            bible.setSelectedBook(evt.books[0]);
            ws.send({ cmd: 'get_chapters', book: evt.books[0], version: evt.version });
          }
          break;
        case 'chapters':
          bible.setChapters(evt.chapters);
          if (evt.chapters.length > 0) {
            bible.setSelectedChapter(evt.chapters[0]);
            ws.send({ cmd: 'get_verses', book: bible.selectedBook, chapter: evt.chapters[0], version: bible.currentVersion });
          }
          break;
        case 'verses':
          bible.setVerses(evt.verses);
          if (evt.verses.length > 0) {
            bible.setSelectedVerse(evt.verses[0]);
            ws.send({ cmd: 'get_verse', book: bible.selectedBook, chapter: bible.selectedChapter, verse: evt.verses[0], version: bible.currentVersion });
          }
          break;
        case 'verse_text':
          bible.setNavVerse(evt.verse);
          bible.setSelectedBook(evt.verse.book);
          bible.setSelectedChapter(evt.verse.chapter);
          bible.setSelectedVerse(evt.verse.verse);
          break;
        case 'search_results':
          bible.setSearchResults(evt.results);
          break;
        case 'songs':
          songs.setSongs(evt.songs);
          break;
        case 'media_list':
          schedule.setMediaItems(evt.media_items);
          break;
        case 'schedule':
          schedule.setEntries(evt.schedule?.entries ?? []);
          break;
        case 'lt_templates':
          live.setLtTemplates(evt.templates);
          break;
        case 'error':
          console.warn('[Remote]', evt.message);
          break;
      }
    });
    ws.connect();
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export default function App() {
  const authed = useAuthStore(s => s.authed);
  const setStatus = useAuthStore(s => s.setStatus);
  const isOutputBlanked = useLiveStore(s => s.isOutputBlanked);
  const [activeTab, setActiveTab] = useState<TabId>('bible');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useWsEvents();

  useEffect(() => {
    const id = setInterval(() => {
      if (!ws.connected) setStatus('connecting', 'Reconnecting…');
    }, 2000);
    return () => clearInterval(id);
  }, [setStatus]);

  // Close menu on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!authed) {
    return (
      <div className="flex flex-col h-full">
        <PinScreen />
        <StatusBar />
      </div>
    );
  }

  const activeLabel = TABS.find(t => t.id === activeTab)?.label ?? 'Menu';

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[var(--bg)]">
      {/* Persistent Header */}
      <div className="flex items-center justify-between px-3 py-3 bg-[var(--panel)] border-b border-[var(--border)] shrink-0 shadow-sm z-50">
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg)] text-xs font-black uppercase tracking-widest text-[var(--amber)] active:scale-95 transition-all shadow-sm"
          >
            {activeLabel}
            <span className="text-[10px] opacity-50">▼</span>
          </button>
          
          {menuOpen && (
            <div className="absolute top-full left-0 mt-2 w-56 rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl z-[60] overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
              {TABS.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => {
                    setActiveTab(tab.id);
                    setMenuOpen(false);
                    if (tab.id === 'schedule') ws.send({ cmd: 'get_schedule' });
                  }}
                  className={`w-full text-left px-5 py-4 text-xs font-black uppercase tracking-widest transition-all active:bg-[var(--bg)] ${
                    activeTab === tab.id ? 'text-[var(--amber)] bg-[var(--bg)]' : 'text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => ws.send({ cmd: 'clear_live' })}
            className="px-4 py-2.5 rounded-xl border border-red-500/30 bg-red-500/10 text-red-500 text-[10px] font-black uppercase tracking-wider active:scale-90 transition-all"
          >
            Clear
          </button>
          <button
            onClick={() => ws.send({ cmd: 'blank_output' })}
            className={`px-4 py-2.5 rounded-xl border text-[10px] font-black uppercase tracking-wider active:scale-90 transition-all shadow-sm ${
              isOutputBlanked 
                ? 'border-[var(--amber)] bg-[var(--amber)] text-black' 
                : 'border-[var(--border)] bg-[var(--bg)] text-[var(--muted)]'
            }`}
          >
            {isOutputBlanked ? 'Unblank' : 'Logo'}
          </button>
        </div>
      </div>

      <NowLiveBanner />

      {/* Pages */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'bible'    && <BiblePage />}
        {activeTab === 'lyrics'   && <LyricsPage />}
        {activeTab === 'media'    && <MediaPage />}
        {activeTab === 'schedule' && <SchedulePage />}
        {activeTab === 'timer'    && <TimerPage />}
        {activeTab === 'lt'       && <LowerThirdPage />}
        {activeTab === 'control'  && <ControlPage />}
      </div>

      <StatusBar />
    </div>
  );
}
