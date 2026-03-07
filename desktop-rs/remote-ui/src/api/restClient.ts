// Typed REST client — uses Bearer token from sessionStorage.
// Falls back gracefully: if auth fails, clears token.

function getToken() {
  return sessionStorage.getItem('remote_token') ?? '';
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

import type {
  AppState, Verse, Song, MediaItem, Schedule, LtTemplate,
} from './types';

export const api = {
  state:       () => get<AppState>('/api/state'),
  versions:    () => get<string[]>('/api/versions'),
  books:       (version: string) => get<string[]>(`/api/books?version=${encodeURIComponent(version)}`),
  chapters:    (book: string, version: string) =>
                 get<number[]>(`/api/chapters?book=${encodeURIComponent(book)}&version=${encodeURIComponent(version)}`),
  verseCount:  (book: string, chapter: number, version: string) =>
                 get<number[]>(`/api/verse-count?book=${encodeURIComponent(book)}&chapter=${chapter}&version=${encodeURIComponent(version)}`),
  verse:       (book: string, chapter: number, verse: number, version: string) =>
                 get<Verse>(`/api/verse?book=${encodeURIComponent(book)}&chapter=${chapter}&verse=${verse}&version=${encodeURIComponent(version)}`),
  songs:       () => get<Song[]>('/api/songs'),
  media:       () => get<MediaItem[]>('/api/media'),
  schedule:    () => get<Schedule>('/api/schedule'),
  ltTemplates: () => get<LtTemplate[]>('/api/lt-templates'),

  // Commands
  goLive:    (item: unknown) => post<void>('/api/go-live', { item }),
  stageItem: (item: unknown) => post<void>('/api/stage', { item }),
  clearLive: ()              => post<void>('/api/clear-live', {}),
  blankOutput: ()            => post<void>('/api/blank', {}),
  showLt:    (data: unknown, template: unknown) => post<void>('/api/lt/show', { data, template }),
  hideLt:    ()              => post<void>('/api/lt/hide', {}),
  startTimer: ()             => post<void>('/api/timer/start', {}),
  stopTimer:  ()             => post<void>('/api/timer/stop', {}),
  resetTimer: ()             => post<void>('/api/timer/reset', {}),
};
