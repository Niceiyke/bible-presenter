import { useRef } from 'react';
import { ws } from '../api/wsClient';
import { useSongsStore } from '../stores/songsStore';
import { useLiveStore } from '../stores/liveStore';
import { Card, CardLabel, Btn, Pill, Input, Row } from '../components/ui';

const DEFAULT_TEMPLATE = {
  bgType: 'gradient', bgColor: '#000000', bgOpacity: 0.85,
  bgGradient: 'linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0) 100%)',
  bgBlur: 0, accentSide: 'left', accentColor: '#f59e0b', accentWidth: 4,
  hAlign: 'left', vAlign: 'bottom', offsetX: 5, offsetY: 5,
  widthPct: 60, paddingX: 32, paddingY: 20, borderRadius: 8,
  primaryFont: 'Georgia', primarySize: 36, primaryColor: '#ffffff', primaryWeight: '700',
  secondaryFont: 'Arial', secondarySize: 22, secondaryColor: '#e2e8f0', secondaryWeight: '400',
  animIn: 'fade', animOut: 'fade',
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
    <div className="flex flex-col gap-3 p-3 overflow-y-auto flex-1">
      {/* Song list */}
      <Card>
        <CardLabel>Song</CardLabel>
        <Input
          placeholder="Search songs…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <div className="flex flex-col gap-1 max-h-44 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="text-xs py-2 text-center" style={{ color: 'var(--muted)' }}>No songs</div>
          )}
          {filtered.map(s => (
            <div
              key={s.id}
              onClick={() => selectSong(s)}
              className="px-3 py-2 rounded-lg cursor-pointer transition-all text-sm"
              style={selectedSong?.id === s.id
                ? { border: '1px solid var(--amber)', background: 'rgba(245,158,11,.07)' }
                : { border: '1px solid var(--border)', background: 'var(--bg)' }}
            >
              <div style={{ color: 'var(--text)' }}>{s.title}</div>
              {s.author && <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{s.author}</div>}
            </div>
          ))}
        </div>
      </Card>

      {/* Lyric controls */}
      {selectedSong && (
        <Card>
          <CardLabel>{selectedSong.title}</CardLabel>

          <Row>
            <Pill active={linesMode === 1} onClick={() => setLinesMode(1)}>1 Line</Pill>
            <Pill active={linesMode === 2} onClick={() => setLinesMode(2)}>2 Lines</Pill>
          </Row>

          {/* Lyric display with swipe */}
          <div
            className="rounded-lg flex flex-col items-center justify-center text-center p-4 select-none cursor-pointer min-h-20"
            style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
            onTouchStart={e => { touchX.current = e.touches[0].clientX; touchY.current = e.touches[0].clientY; }}
            onTouchEnd={e => {
              const dx = e.changedTouches[0].clientX - touchX.current;
              const dy = e.changedTouches[0].clientY - touchY.current;
              if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
              dx < 0 ? nextLine() : prevLine();
            }}
          >
            {!line1 ? (
              <span className="text-sm" style={{ color: 'var(--muted)' }}>No lines</span>
            ) : (
              <>
                {line1.sectionLabel && (
                  <span className="text-[10px] font-bold tracking-widest uppercase block mb-1.5" style={{ color: 'var(--amber)' }}>
                    {line1.sectionLabel}
                  </span>
                )}
                <span className="text-lg font-bold leading-snug" style={{ color: 'var(--text)' }}>{line1.text}</span>
                {line2 && (
                  <span className="text-lg font-bold leading-snug mt-1 opacity-70" style={{ color: 'var(--text)' }}>
                    {line2.text}
                  </span>
                )}
              </>
            )}
          </div>
          <div className="text-[10px] text-center" style={{ color: 'var(--muted)' }}>
            {lineIdx + 1} / {flatLines.length} · swipe to navigate
          </div>

          <Row>
            <Btn className="flex-1" onClick={prevLine} disabled={lineIdx === 0}>◀ Prev</Btn>
            <Btn className="flex-1" onClick={nextLine} disabled={lineIdx >= flatLines.length - 1}>Next ▶</Btn>
          </Row>

          <Row>
            <Btn variant="live" className="flex-1" onClick={showLt} disabled={!line1}>Show</Btn>
            <Btn className="flex-1" onClick={() => line1 && ws.send({ cmd: 'stage_item', item: { type: 'Song', data: { kind: 'Lyrics', line1: line1.text } } })} disabled={!line1}>Stage</Btn>
            <Btn variant="danger" className="flex-1" onClick={() => ws.send({ cmd: 'hide_lt' })}>Hide</Btn>
          </Row>

          <Row>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>LT Status:</span>
            <span
              className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border"
              style={ltShowing
                ? { background: 'rgba(34,197,94,.15)', color: 'var(--green)', borderColor: 'var(--green)' }
                : { background: 'rgba(239,68,68,.15)', color: 'var(--red)', borderColor: 'var(--red)' }}
            >
              {ltShowing ? 'Showing' : 'Hidden'}
            </span>
          </Row>
        </Card>
      )}
    </div>
  );
}
