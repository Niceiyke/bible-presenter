import { useEffect, useState } from 'react';
import { ws } from './api/wsClient';
import type { WsEvent } from './api/types';

import { useAuthStore } from './stores/authStore';
import { useLiveStore, type Toast } from './stores/liveStore';
import { useBibleStore } from './stores/bibleStore';
import { useSongsStore } from './stores/songsStore';
import { useScheduleStore } from './stores/scheduleStore';

import { PinScreen } from './components/PinScreen';
import { NowLiveBanner } from './components/NowLiveBanner';
import { BottomNav, type TabId } from './components/BottomNav';

import { DashboardPage } from './pages/DashboardPage';
import { BiblePage } from './pages/BiblePage';
import { LyricsPage } from './pages/LyricsPage';
import { LowerThirdPage } from './pages/LowerThirdPage';
import { MorePage } from './pages/MorePage';

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
          auth.setAuthed(evt.token, evt.key);
          auth.setStatus('connected', 'Connected');
          ws.send({ cmd: 'get_state' });
          ws.send({ cmd: 'get_versions' });
          ws.send({ cmd: 'get_songs' });
          ws.send({ cmd: 'get_media' });
          ws.send({ cmd: 'get_settings_full' });
          ws.send({ cmd: 'get_lt_templates' });
          ws.send({ cmd: 'get_lt_presets' });
          break;
        case 'auth_fail':
          auth.logout();
          auth.setStatus('disconnected', 'Wrong PIN — try again');
          break;
        case 'state':
          live.setLiveItem(evt.live_item);
          if (evt.staged_item !== undefined) live.setStagedItem(evt.staged_item ?? null);
          live.setLtShowing(!!evt.lt);
          if (typeof evt.is_blanked === 'boolean') live.setBlanked(evt.is_blanked);
          if (evt.changed_by) live.setLastChangedBy(evt.changed_by);
          break;
        case 'staged':
          live.setStagedItem(evt.staged_item);
          break;
        case 'proposal_handled':
          live.showToast('Your proposal was handled (accepted or dismissed)', 'info');
          live.setStagedItem(null);
          break;
        case 'operators':
          live.setOperators(evt.operators);
          break;
        case 'remote_proposals':
          // Remote proposals are only relevant to the desktop main operator; ignore on remote UI
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
        case 'lt_templates':
          live.setLtTemplates(evt.templates);
          break;
        case 'lt_presets':
          live.setLtPresets(evt.presets);
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

function ToastBar({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const bg =
    toast.kind === 'warn'  ? 'rgba(245,158,11,0.15)' :
    toast.kind === 'error' ? 'rgba(239,68,68,0.15)'  :
    'rgba(34,197,94,0.12)';
  const border =
    toast.kind === 'warn'  ? 'rgba(245,158,11,0.4)' :
    toast.kind === 'error' ? 'rgba(239,68,68,0.4)'  :
    'rgba(34,197,94,0.35)';
  const color =
    toast.kind === 'warn'  ? 'var(--amber)' :
    toast.kind === 'error' ? 'var(--red)'   :
    'var(--green)';

  return (
    <div
      className="fixed bottom-20 left-4 right-4 z-50 flex items-center justify-between gap-3 px-4 py-3 rounded-2xl anim-fade-up"
      style={{ background: bg, border: `1px solid ${border}` }}
    >
      <span className="text-sm font-semibold" style={{ color }}>{toast.message}</span>
      <button
        onClick={onDismiss}
        className="text-lg leading-none shrink-0 cursor-pointer"
        style={{ color, background: 'none', border: 'none' }}
      >
        ×
      </button>
    </div>
  );
}

export default function App() {
  const authed = useAuthStore(s => s.authed);
  const setStatus = useAuthStore(s => s.setStatus);
  const [activeTab, setActiveTab] = useState<TabId>('live');
  const toast = useLiveStore(s => s.toast);
  const dismissToast = useLiveStore(s => s.dismissToast);

  useWsEvents();

  // Reconnect watchdog
  useEffect(() => {
    const id = setInterval(() => {
      if (!ws.connected) setStatus('connecting', 'Reconnecting…');
    }, 2500);
    return () => clearInterval(id);
  }, [setStatus]);

  if (!authed) return <PinScreen />;

  return (
    <div className="flex flex-col content-h" style={{ background: 'var(--bg)' }}>
      {/* Live status strip on non-dashboard tabs */}
      {activeTab !== 'live' && <NowLiveBanner />}

      {/* Page content */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {activeTab === 'live'  && <DashboardPage />}
        {activeTab === 'bible' && <BiblePage />}
        {activeTab === 'songs' && <LyricsPage />}
        {activeTab === 'lt'    && <LowerThirdPage />}
        {activeTab === 'more'  && <MorePage />}
      </div>

      {/* Bottom nav */}
      <BottomNav activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Toast notification */}
      {toast && <ToastBar toast={toast} onDismiss={dismissToast} />}
    </div>
  );
}
