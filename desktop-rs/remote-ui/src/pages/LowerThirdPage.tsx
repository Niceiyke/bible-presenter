import { useState } from 'react';
import { ws } from '../api/wsClient';
import { useLiveStore } from '../stores/liveStore';
import { Card, CardLabel, Btn, Input, Pill, Row } from '../components/ui';

type LtMode = 'nameplate' | 'freetext';
type ScrollMode = 'Static' | 'ScrollLeft' | 'ScrollRight';

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

export function LowerThirdPage() {
  const { ltShowing, ltTemplates, selectedTemplateIdx, setSelectedTemplate } = useLiveStore();

  const [mode, setMode] = useState<LtMode>('nameplate');
  const [npName, setNpName] = useState('');
  const [npTitle, setNpTitle] = useState('');
  const [ftText, setFtText] = useState('');
  const [scrollMode, setScrollMode] = useState<ScrollMode>('Static');
  const [speed, setSpeed] = useState(50);

  function getTemplate() {
    if (selectedTemplateIdx !== null && ltTemplates[selectedTemplateIdx]) return ltTemplates[selectedTemplateIdx];
    return DEFAULT_TEMPLATE;
  }

  function showNameplate() {
    if (!npName.trim()) return;
    ws.send({ cmd: 'show_lt', data: { kind: 'Nameplate', name: npName, title: npTitle || null }, template: getTemplate() });
  }

  function showFreeText() {
    if (!ftText.trim()) return;
    ws.send({ cmd: 'show_lt', data: { kind: 'FreeText', text: ftText, scroll_mode: scrollMode, speed }, template: getTemplate() });
  }

  return (
    <div className="flex flex-col gap-3 p-3 overflow-y-auto flex-1">
      {/* Mode */}
      <Card>
        <CardLabel>Mode</CardLabel>
        <Row>
          {(['nameplate', 'freetext'] as LtMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className="flex-1 py-2 text-center rounded-lg text-xs font-bold border transition-all cursor-pointer"
              style={mode === m
                ? { borderColor: 'var(--amber)', color: 'var(--amber)', background: 'rgba(245,158,11,.1)' }
                : { borderColor: 'var(--border)', color: 'var(--muted)', background: 'transparent' }}
            >
              {m === 'nameplate' ? 'Nameplate' : 'Free Text'}
            </button>
          ))}
        </Row>
      </Card>

      {/* Template selector */}
      {ltTemplates.length > 0 && (
        <Card>
          <CardLabel>Template</CardLabel>
          <div className="flex flex-col gap-1 max-h-28 overflow-y-auto">
            <div
              onClick={() => setSelectedTemplate(null)}
              className="px-3 py-2 rounded-lg cursor-pointer text-xs transition-all"
              style={selectedTemplateIdx === null
                ? { border: '1px solid var(--amber)', background: 'rgba(245,158,11,.07)', color: 'var(--amber)' }
                : { border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
            >Default</div>
            {ltTemplates.map((t, i) => (
              <div
                key={i}
                onClick={() => setSelectedTemplate(i)}
                className="px-3 py-2 rounded-lg cursor-pointer text-xs transition-all"
                style={selectedTemplateIdx === i
                  ? { border: '1px solid var(--amber)', background: 'rgba(245,158,11,.07)', color: 'var(--amber)' }
                  : { border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
              >
                {(t as { name?: string }).name ?? `Template ${i + 1}`}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Nameplate */}
      {mode === 'nameplate' && (
        <Card>
          <CardLabel>Nameplate</CardLabel>
          <Input placeholder="Name (required)" value={npName} onChange={e => setNpName(e.target.value)} />
          <Input placeholder="Title / Role (optional)" value={npTitle} onChange={e => setNpTitle(e.target.value)} />
          <Row>
            <Btn variant="live" className="flex-1" disabled={!npName.trim()} onClick={showNameplate}>Show</Btn>
            <Btn variant="danger" className="flex-1" onClick={() => ws.send({ cmd: 'hide_lt' })}>Hide</Btn>
          </Row>
        </Card>
      )}

      {/* Free Text */}
      {mode === 'freetext' && (
        <Card>
          <CardLabel>Free Text</CardLabel>
          <textarea
            value={ftText}
            onChange={e => setFtText(e.target.value)}
            placeholder="Text to display…"
            rows={3}
            className="w-full px-3 py-2 rounded-lg text-sm resize-y outline-none"
            style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'inherit' }}
          />
          <CardLabel>Scroll mode</CardLabel>
          <div className="flex gap-1.5 flex-wrap">
            {(['Static', 'ScrollLeft', 'ScrollRight'] as ScrollMode[]).map(m => (
              <Pill key={m} active={scrollMode === m} onClick={() => setScrollMode(m)}>
                {m === 'Static' ? 'Static' : m === 'ScrollLeft' ? '→→ Left' : '←← Right'}
              </Pill>
            ))}
          </div>
          {scrollMode !== 'Static' && (
            <div>
              <div className="text-[10px] mb-1" style={{ color: 'var(--muted)' }}>Speed: {speed}</div>
              <input type="range" min={10} max={200} value={speed}
                onChange={e => setSpeed(Number(e.target.value))}
                className="w-full" style={{ accentColor: 'var(--amber)' }} />
            </div>
          )}
          <Row>
            <Btn variant="live" className="flex-1" disabled={!ftText.trim()} onClick={showFreeText}>Show</Btn>
            <Btn variant="danger" className="flex-1" onClick={() => ws.send({ cmd: 'hide_lt' })}>Hide</Btn>
          </Row>
        </Card>
      )}

      {/* Status */}
      <Card>
        <Row>
          <span className="text-xs" style={{ color: 'var(--muted)' }}>Lower Third:</span>
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
    </div>
  );
}
