import { useLiveStore } from '../stores/liveStore';
import type { DisplayItem } from '../api/types';

function itemLabel(item: DisplayItem): string {
  switch (item.type) {
    case 'Verse': {
      const d = item.data;
      const snippet = d.text.length > 60 ? d.text.slice(0, 60) + '…' : d.text;
      return `${d.book} ${d.chapter}:${d.verse} — ${snippet}`;
    }
    case 'Song':        return `${item.data.title} · ${item.data.section_label}`;
    case 'Media':       return item.data.name;
    case 'Timer':       return item.data.label ?? item.data.timer_type;
    case 'CustomSlide': return `${item.data.presentation_name} · slide ${item.data.slide_index + 1}`;
    default:            return item.type;
  }
}

/** Compact live strip — shown on non-dashboard tabs */
export function NowLiveBanner() {
  const liveItem = useLiveStore(s => s.liveItem);
  const transcription = useLiveStore(s => s.transcription);
  const lastChangedBy = useLiveStore(s => s.lastChangedBy);

  if (!liveItem && !transcription) return null;

  return (
    <div className="flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
      {liveItem && (
        <div className="flex items-center gap-2 px-4 py-2"
          style={{ background: 'rgba(34,197,94,0.06)' }}>
          <span className="w-1.5 h-1.5 rounded-full shrink-0 anim-pulse-dot" style={{ background: 'var(--green)' }} />
          <span className="text-[10px] font-black uppercase tracking-widest shrink-0" style={{ color: 'var(--green)' }}>Live</span>
          <span className="text-xs truncate flex-1" style={{ color: 'var(--text)' }}>{itemLabel(liveItem)}</span>
          {lastChangedBy && (
            <span className="text-[9px] shrink-0" style={{ color: 'var(--muted)' }}>by {lastChangedBy}</span>
          )}
        </div>
      )}
      {transcription && (
        <div className="flex items-center gap-2 px-4 py-1.5" style={{ background: 'rgba(245,158,11,0.05)' }}>
          <span className="text-[10px] shrink-0" style={{ color: 'var(--amber)' }}>🎙</span>
          <span className="text-xs truncate italic" style={{ color: 'var(--amber)' }}>{transcription}</span>
        </div>
      )}
    </div>
  );
}
