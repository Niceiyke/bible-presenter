import { ws } from '../api/wsClient';
import { useScheduleStore } from '../stores/scheduleStore';
import { useLiveStore } from '../stores/liveStore';
import { Card, CardLabel, Btn } from '../components/ui';
import type { DisplayItem } from '../api/types';

function itemLabel(item: DisplayItem): string {
  switch (item.type) {
    case 'Verse':       return `📖 ${item.data.book} ${item.data.chapter}:${item.data.verse}`;
    case 'Media':       return `🖼 ${item.data.name}`;
    case 'Timer':       return `⏱ ${item.data.label ?? item.data.timer_type}`;
    case 'Song':        return `🎵 ${item.data.title}`;
    case 'CustomSlide': return `📑 ${item.data.presentation_name}`;
    case 'CameraFeed':  return `📷 ${item.data.label}`;
    default:            return item.type;
  }
}

export function SchedulePage() {
  const { entries } = useScheduleStore();
  const liveItem = useLiveStore(s => s.liveItem);

  function isLive(item: DisplayItem): boolean {
    return !!liveItem && JSON.stringify(liveItem) === JSON.stringify(item);
  }

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto flex-1">
      <Card>
        <div className="flex items-center justify-between">
          <CardLabel>Service Order</CardLabel>
          <Btn className="text-[10px] py-1 px-2.5" onClick={() => ws.send({ cmd: 'get_schedule' })}>↻ Refresh</Btn>
        </div>

        {entries.length === 0 ? (
          <div className="text-xs py-4 text-center" style={{ color: 'var(--muted)' }}>No items in schedule</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {entries.map((entry, i) => {
              const live = isLive(entry.item);
              return (
                <div
                  key={entry.id}
                  className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 cursor-pointer transition-all"
                  style={live
                    ? { border: '1px solid var(--green)', background: 'rgba(34,197,94,.07)' }
                    : { border: '1px solid var(--border)', background: 'var(--bg)' }}
                  onClick={() => {
                    if (window.confirm(`Send "${itemLabel(entry.item)}" live?`)) {
                      ws.send({ cmd: 'go_live', item: entry.item });
                    }
                  }}
                >
                  <span className="text-xs font-bold w-5 text-right flex-shrink-0" style={{ color: 'var(--muted)' }}>{i + 1}</span>
                  <span className="flex-1 text-sm" style={{ color: 'var(--text)' }}>{itemLabel(entry.item)}</span>
                  {live && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-bold uppercase border"
                      style={{ background: 'rgba(34,197,94,.15)', color: 'var(--green)', borderColor: 'var(--green)' }}>
                      Live
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
