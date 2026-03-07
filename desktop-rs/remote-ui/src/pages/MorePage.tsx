import { useState } from 'react';
import { Search, MonitorOff, Trash2, Image, Video } from 'lucide-react';
import { ws } from '../api/wsClient';
import { useLiveStore } from '../stores/liveStore';
import { useAuthStore } from '../stores/authStore';
import { useScheduleStore } from '../stores/scheduleStore';
import { Card, CardLabel, Input } from '../components/ui';
import type { MediaItem } from '../api/types';

// ── Output controls ────────────────────────────────────────────────────────────
function OutputSection() {
  const { isOutputBlanked, liveItem, ltShowing } = useLiveStore();
  const isViewer = useAuthStore(s => s.role) === 'viewer';

  return (
    <Card>
      <CardLabel>Output Control</CardLabel>

      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => ws.send({ cmd: 'blank_output' })}
          disabled={isViewer}
          className="flex flex-col items-center justify-center gap-2 py-5 rounded-2xl border transition-all active:scale-95 cursor-pointer disabled:opacity-30"
          style={isOutputBlanked
            ? { background: 'var(--amber)', borderColor: 'var(--amber)', color: '#000' }
            : { background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }
          }
        >
          <MonitorOff size={22} />
          <span className="text-xs font-bold">{isOutputBlanked ? 'Unblank' : 'Logo / Blank'}</span>
        </button>

        <button
          onClick={() => ws.send({ cmd: 'clear_live' })}
          disabled={!liveItem || isViewer}
          className="flex flex-col items-center justify-center gap-2 py-5 rounded-2xl border transition-all active:scale-95 disabled:opacity-30 cursor-pointer"
          style={{ background: 'var(--red-dim)', borderColor: 'rgba(239,68,68,0.3)', color: 'var(--red)' }}
        >
          <Trash2 size={22} />
          <span className="text-xs font-bold">Clear Live</span>
        </button>
      </div>

      {ltShowing && (
        <button
          onClick={() => ws.send({ cmd: 'hide_lt' })}
          disabled={isViewer}
          className="w-full py-3.5 rounded-2xl border font-bold text-sm transition-all active:scale-95 cursor-pointer disabled:opacity-30"
          style={{ background: 'var(--red-dim)', borderColor: 'rgba(239,68,68,0.3)', color: 'var(--red)' }}
        >
          Hide Lower Third
        </button>
      )}
    </Card>
  );
}

// ── Media library ──────────────────────────────────────────────────────────────
function MediaSection() {
  const { mediaItems } = useScheduleStore();
  const [filter, setFilter] = useState('');

  const filtered = mediaItems.filter(m =>
    m.name.toLowerCase().includes(filter.toLowerCase()) ||
    (m.category ?? '').toLowerCase().includes(filter.toLowerCase()) ||
    m.tags.some(t => t.toLowerCase().includes(filter.toLowerCase()))
  );

  function MediaRow({ m }: { m: MediaItem }) {
    return (
      <div
        className="flex items-center gap-3 rounded-2xl px-3 py-2.5"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        {/* Thumb */}
        <div
          className="w-12 h-12 rounded-xl shrink-0 overflow-hidden flex items-center justify-center"
          style={{ background: 'var(--elevated)' }}
        >
          {m.media_type === 'Image' ? (
            <img
              src={`/media-thumb/${encodeURIComponent(m.id)}`}
              alt={m.name}
              className="w-full h-full object-cover"
              onError={e => { e.currentTarget.style.display = 'none'; }}
            />
          ) : (
            <Video size={20} style={{ color: 'var(--muted)' }} />
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate" style={{ color: 'var(--text)' }}>{m.name}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
              {m.media_type === 'Image' ? <Image size={10} className="inline" /> : <Video size={10} className="inline" />}
              {' '}{m.media_type}
            </span>
            {m.category && <span className="text-[10px]" style={{ color: 'var(--muted)' }}>· {m.category}</span>}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-1 shrink-0">
          <button
            onClick={() => ws.send({ cmd: 'stage_item', item: { type: 'Media', data: m } })}
            className="px-3 py-1.5 rounded-xl text-[11px] font-black cursor-pointer active:scale-95 transition-all"
            style={{ background: 'var(--amber-dim)', color: 'var(--amber)', border: '1px solid rgba(245,158,11,0.3)' }}
          >
            Stage
          </button>
          <button
            onClick={() => ws.send({ cmd: 'go_live', item: { type: 'Media', data: m } })}
            className="px-3 py-1.5 rounded-xl text-[11px] font-black cursor-pointer active:scale-95 transition-all"
            style={{ background: 'var(--amber)', color: '#000', border: '1px solid var(--amber)' }}
          >
            Live
          </button>
        </div>
      </div>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardLabel>Media Library</CardLabel>
        <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{mediaItems.length} items</span>
      </div>

      <div className="relative">
        <Search size={15} className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--muted)' }} />
        <Input
          placeholder="Search media…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="pl-10"
        />
      </div>

      <div className="flex flex-col gap-2">
        {filtered.length === 0 && (
          <p className="text-xs py-4 text-center" style={{ color: 'var(--muted)' }}>
            {mediaItems.length === 0 ? 'No media loaded' : 'No results'}
          </p>
        )}
        {filtered.map(m => <MediaRow key={m.id} m={m} />)}
      </div>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function MorePage() {
  return (
    <div className="flex flex-col gap-3 p-4 overflow-y-auto flex-1">
      <OutputSection />
      <MediaSection />
    </div>
  );
}
