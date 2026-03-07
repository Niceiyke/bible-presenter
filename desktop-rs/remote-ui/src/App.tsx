import { useEffect, useState } from 'react';
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
  const [activeTab, setActiveTab] = useState<TabId>('bible');

  useWsEvents();

  useEffect(() => {
    const id = setInterval(() => {
      if (!ws.connected) setStatus('connecting', 'Reconnecting…');
    }, 2000);
    return () => clearInterval(id);
  }, [setStatus]);

  if (!authed) {
    return (
      <div className="flex flex-col h-full">
        <PinScreen />
        <StatusBar />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <NowLiveBanner />

      {/* Tab bar */}
      <div className="flex flex-shrink-0 overflow-x-auto" style={{ background: 'var(--panel)', borderBottom: '1px solid var(--border)' }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => {
              setActiveTab(tab.id);
              if (tab.id === 'schedule') ws.send({ cmd: 'get_schedule' });
            }}
            style={{
              flexShrink: 0, padding: '12px 10px', background: 'transparent',
              border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
              borderBottom: `2px solid ${activeTab === tab.id ? 'var(--amber)' : 'transparent'}`,
              color: activeTab === tab.id ? 'var(--amber)' : 'var(--muted)',
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

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
