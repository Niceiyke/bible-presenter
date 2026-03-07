import { useLiveStore } from '../stores/liveStore';
import type { DisplayItem } from '../api/types';

function itemLabel(item: DisplayItem): string {
  switch (item.type) {
    case 'Verse': {
      const d = item.data;
      const snippet = d.text.length > 70 ? d.text.slice(0, 70) + '…' : d.text;
      return `${d.book} ${d.chapter}:${d.verse} (${d.version}) — ${snippet}`;
    }
    case 'Media':       return `🖼 ${item.data.name}`;
    case 'Timer':       return `⏱ ${item.data.label ?? item.data.timer_type}`;
    case 'Song':        return `🎵 ${item.data.title} · ${item.data.section_label}`;
    case 'CustomSlide': return `📑 ${item.data.presentation_name} · slide ${item.data.slide_index + 1}`;
    case 'CameraFeed':  return `📷 ${item.data.label}`;
    default:            return item.type;
  }
}

export function NowLiveBanner() {
  const liveItem = useLiveStore(s => s.liveItem);
  const transcription = useLiveStore(s => s.transcription);

  if (!liveItem && !transcription) return null;

  return (
    <div className="flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
      {liveItem && (
        <div className="px-3 py-2" style={{ background: 'rgba(34,197,94,.08)', borderBottom: transcription ? '1px solid var(--border)' : undefined }}>
          <div className="text-[10px] font-bold tracking-widest uppercase mb-0.5" style={{ color: 'var(--green)' }}>
            ● Now Live
          </div>
          <div className="text-xs truncate" style={{ color: 'var(--text)' }}>
            {itemLabel(liveItem)}
          </div>
        </div>
      )}
      {transcription && (
        <div className="px-3 py-1.5 text-xs truncate" style={{ background: 'rgba(245,158,11,.06)', color: 'var(--amber)' }}>
          🎙 {transcription}
        </div>
      )}
    </div>
  );
}
