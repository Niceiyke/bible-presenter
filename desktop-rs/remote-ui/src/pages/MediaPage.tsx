import { useState } from 'react';
import { ws } from '../api/wsClient';
import { useScheduleStore } from '../stores/scheduleStore';
import { Card, CardLabel, Btn, Input, Row } from '../components/ui';
import type { MediaItem } from '../api/types';

export function MediaPage() {
  const { mediaItems } = useScheduleStore();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<MediaItem | null>(null);

  const filtered = mediaItems.filter(m =>
    m.name.toLowerCase().includes(filter.toLowerCase()) ||
    (m.category ?? '').toLowerCase().includes(filter.toLowerCase()) ||
    m.tags.some(t => t.toLowerCase().includes(filter.toLowerCase()))
  );

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto flex-1">
      <Card>
        <CardLabel>Media Library</CardLabel>
        <Input
          placeholder="Search media…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <div className="flex flex-col gap-1.5">
          {filtered.length === 0 && (
            <div className="text-xs py-2" style={{ color: 'var(--muted)' }}>No media found</div>
          )}
          {filtered.map(m => (
            <div
              key={m.id}
              onClick={() => setSelected(m)}
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 cursor-pointer transition-all"
              style={selected?.id === m.id
                ? { border: '1px solid var(--amber)', background: 'rgba(245,158,11,.07)' }
                : { border: '1px solid var(--border)', background: 'var(--bg)' }}
            >
              {/* Thumbnail */}
              {m.media_type === 'Image' ? (
                <img
                  src={`/media-thumb/${encodeURIComponent(m.id)}`}
                  alt={m.name}
                  className="w-12 h-12 object-cover rounded flex-shrink-0"
                  onError={e => { e.currentTarget.style.display = 'none'; }}
                />
              ) : (
                <div className="w-12 h-12 rounded flex-shrink-0 flex items-center justify-center text-xl"
                  style={{ background: '#111', color: 'var(--muted)' }}>▶</div>
              )}

              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text)' }}>{m.name}</div>
                {m.category && <div className="text-xs" style={{ color: 'var(--muted)' }}>{m.category}</div>}
                {m.tags.length > 0 && (
                  <div className="text-xs truncate" style={{ color: 'var(--muted)' }}>{m.tags.join(', ')}</div>
                )}
              </div>

              <div className="flex flex-col gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                <Btn className="text-[10px] py-1 px-2" onClick={() => ws.send({ cmd: 'stage_item', item: { type: m.media_type, data: m } })}>Stage</Btn>
                <Btn variant="live" className="text-[10px] py-1 px-2" onClick={() => ws.send({ cmd: 'go_live', item: { type: m.media_type, data: m } })}>Live</Btn>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {selected && (
        <Card>
          <CardLabel>Selected: {selected.name}</CardLabel>
          <Row>
            <Btn className="flex-1" onClick={() => ws.send({ cmd: 'stage_item', item: { type: selected.media_type, data: selected } })}>Stage</Btn>
            <Btn variant="live" className="flex-1" onClick={() => ws.send({ cmd: 'go_live', item: { type: selected.media_type, data: selected } })}>Go Live</Btn>
          </Row>
        </Card>
      )}
    </div>
  );
}
