import { useRef } from 'react';
import { ChevronLeft, ChevronRight, Search, Eye, EyeOff } from 'lucide-react';
import { ws } from '../api/wsClient';
import { useSongsStore } from '../stores/songsStore';
import { useLiveStore } from '../stores/liveStore';
import { Card, CardLabel, Input, Segment } from '../components/ui';

const DEFAULT_TEMPLATE = {
  bgType: 'gradient', bgColor: '#000000', bgOpacity: 85, bgGradientEnd: '#141428',
  bgBlur: false, bgBlurAmount: 8,
  accentSide: 'left', accentColor: '#f59e0b', accentWidth: 4, accentEnabled: true,
  hAlign: 'left', vAlign: 'bottom', offsetX: 48, offsetY: 40,
  widthPct: 60, paddingX: 24, paddingY: 16, borderRadius: 12,
  primaryFont: 'Georgia', primarySize: 36, primaryColor: '#ffffff', primaryBold: true, primaryItalic: false, primaryUppercase: false,
  secondaryFont: 'Arial', secondarySize: 22, secondaryColor: '#f59e0b', secondaryBold: false, secondaryItalic: false, secondaryUppercase: false,
  animation: 'slide-up', animationDuration: 0.5, exitDuration: 0.2,
  variant: 'classic',
  labelVisible: true, labelColor: '#f59e0b', labelSize: 13, labelUppercase: true,
};

export function LyricsPage() {
  const { songs, filter, setFilter, selectedSong, selectSong, flatLines, lineIdx, nextLine, prevLine, linesMode, setLinesMode } = useSongsStore();
  const { ltShowing, ltTemplates, selectedTemplateIdx } = useLiveStore();
  const touchX = useRef(0);
  const touchY = useRef(0);

  const filtered = songs.filter(s =>
    s.title.toLowerCase().includes(filter.toLowerCase()) ||
    (s.author ?? '').toLowerCase().includes(filter.toLowerCase())
  );

  const line1 = flatLines[lineIdx];
  const line2 = linesMode === 2 ? flatLines[lineIdx + 1] : undefined;
  const progress = flatLines.length > 0 ? (lineIdx / Math.max(flatLines.length - 1, 1)) * 100 : 0;

  function getTemplate() {
    if (selectedTemplateIdx !== null && ltTemplates[selectedTemplateIdx]) return ltTemplates[selectedTemplateIdx];
    return DEFAULT_TEMPLATE;
  }

  function showLt() {
    if (!line1) return;
    ws.send({
      cmd: 'show_lt',
      data: { kind: 'Lyrics', line1: line1.text, line2: line2?.text ?? null, section_label: line1.sectionLabel || null },
      template: getTemplate(),
    });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Song list — collapsible when song selected */}
      {!selectedSong ? (
        <div className="flex flex-col gap-3 p-4 overflow-y-auto flex-1">
          <Card>
            <CardLabel>Songs</CardLabel>
            <div className="relative">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--muted)' }} />
              <Input
                placeholder="Search songs…"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                className="pl-10"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              {filtered.length === 0 && (
                <p className="text-xs py-4 text-center" style={{ color: 'var(--muted)' }}>No songs found</p>
              )}
              {filtered.map(s => (
                <button
                  key={s.id}
                  onClick={() => selectSong(s)}
                  className="flex flex-col items-start px-4 py-3.5 rounded-2xl border text-left cursor-pointer transition-all active:scale-[0.98]"
                  style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
                >
                  <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{s.title}</span>
                  {s.author && <span className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{s.author}</span>}
                  <span className="text-[10px] mt-1" style={{ color: 'var(--dim)' }}>
                    {s.sections.length} section{s.sections.length !== 1 ? 's' : ''} · {s.sections.reduce((a, sec) => a + sec.lines.length, 0)} lines
                  </span>
                </button>
              ))}
            </div>
          </Card>
        </div>
      ) : (
        /* ── Lyric controller ─────────────────────────────────────── */
        <div className="flex flex-col h-full">
          {/* Song header */}
          <div
            className="flex items-center gap-3 px-4 py-3 shrink-0"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <button
              onClick={() => selectSong(null as unknown as typeof selectedSong)}
              className="p-2 rounded-xl active:scale-90 transition-all cursor-pointer"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
            >
              <ChevronLeft size={18} style={{ color: 'var(--muted)' }} />
            </button>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold truncate" style={{ color: 'var(--text)' }}>{selectedSong.title}</p>
              {selectedSong.author && <p className="text-xs" style={{ color: 'var(--muted)' }}>{selectedSong.author}</p>}
            </div>
            {/* LT status pill */}
            <span
              className="shrink-0 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider border"
              style={ltShowing
                ? { background: 'var(--green-dim)', color: 'var(--green)', borderColor: 'rgba(34,197,94,0.4)' }
                : { background: 'transparent', color: 'var(--muted)', borderColor: 'var(--border)' }
              }
            >
              {ltShowing ? '● Live' : 'Hidden'}
            </span>
          </div>

          {/* Lines mode toggle */}
          <div className="px-4 pt-3 shrink-0">
            <Segment
              options={[{ value: '1', label: '1 Line' }, { value: '2', label: '2 Lines' }]}
              value={String(linesMode)}
              onChange={v => setLinesMode(Number(v) as 1 | 2)}
            />
          </div>

          {/* Progress bar */}
          <div className="mx-4 mt-3 h-1 rounded-full overflow-hidden shrink-0" style={{ background: 'var(--surface)' }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${progress}%`, background: 'var(--amber)' }}
            />
          </div>
          <p className="text-center text-[10px] mt-1 shrink-0" style={{ color: 'var(--muted)' }}>
            {lineIdx + 1} / {flatLines.length}
          </p>

          {/* Lyric swipe area */}
          <div
            className="flex-1 flex flex-col items-center justify-center px-6 select-none"
            onTouchStart={e => { touchX.current = e.touches[0].clientX; touchY.current = e.touches[0].clientY; }}
            onTouchEnd={e => {
              const dx = e.changedTouches[0].clientX - touchX.current;
              const dy = e.changedTouches[0].clientY - touchY.current;
              if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
              if (dx < 0) nextLine(); else prevLine();
            }}
          >
            {!line1 ? (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>No lines available</p>
            ) : (
              <div className="flex flex-col items-center gap-2 text-center">
                {line1.sectionLabel && (
                  <span
                    className="px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest"
                    style={{ background: 'var(--amber-dim)', color: 'var(--amber)', border: '1px solid rgba(245,158,11,0.3)' }}
                  >
                    {line1.sectionLabel}
                  </span>
                )}
                <p className="text-2xl font-bold leading-tight" style={{ color: 'var(--text)' }}>{line1.text}</p>
                {line2 && (
                  <p className="text-2xl font-bold leading-tight opacity-60" style={{ color: 'var(--text)' }}>{line2.text}</p>
                )}
              </div>
            )}
            <p className="mt-4 text-[10px]" style={{ color: 'var(--dim)' }}>swipe ← → to navigate</p>
          </div>

          {/* Controls */}
          <div className="flex flex-col gap-2 px-4 pb-4 shrink-0">
            {/* Prev / Next */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={prevLine} disabled={lineIdx === 0}
                className="flex items-center justify-center gap-2 py-4 rounded-2xl border font-bold transition-all active:scale-95 disabled:opacity-30 cursor-pointer"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }}
              >
                <ChevronLeft size={20} /> Prev
              </button>
              <button
                onClick={nextLine} disabled={lineIdx >= flatLines.length - 1}
                className="flex items-center justify-center gap-2 py-4 rounded-2xl border font-bold transition-all active:scale-95 disabled:opacity-30 cursor-pointer"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }}
              >
                Next <ChevronRight size={20} />
              </button>
            </div>

            {/* Show / Hide LT */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={showLt} disabled={!line1}
                className="flex items-center justify-center gap-2 py-4 rounded-2xl border font-black text-sm transition-all active:scale-95 disabled:opacity-30 cursor-pointer"
                style={{ background: 'var(--amber)', borderColor: 'var(--amber)', color: '#000' }}
              >
                <Eye size={18} /> Show
              </button>
              <button
                onClick={() => ws.send({ cmd: 'hide_lt' })}
                className="flex items-center justify-center gap-2 py-4 rounded-2xl border font-black text-sm transition-all active:scale-95 cursor-pointer"
                style={{ background: 'var(--red-dim)', borderColor: 'rgba(239,68,68,0.3)', color: 'var(--red)' }}
              >
                <EyeOff size={18} /> Hide
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
