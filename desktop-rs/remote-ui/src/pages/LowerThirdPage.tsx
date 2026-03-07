import { useState } from 'react';
import { Eye, EyeOff, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { ws } from '../api/wsClient';
import { useLiveStore } from '../stores/liveStore';
import { Card, CardLabel, Input, Segment } from '../components/ui';
import type { LtPreset } from '../api/types';

type LtMode = 'nameplate' | 'freetext';

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

// ── Preset row ────────────────────────────────────────────────────────────────
function PresetRow({ preset, template, onDelete }: { preset: LtPreset; template: object; onDelete: (id: string) => void }) {
  const isNameplate = preset.data.kind === 'Nameplate';
  const summary = isNameplate
    ? `${(preset.data as { kind: 'Nameplate'; data: { name: string; title?: string } }).data.name}${(preset.data as { kind: 'Nameplate'; data: { name: string; title?: string } }).data.title ? ` · ${(preset.data as { kind: 'Nameplate'; data: { name: string; title?: string } }).data.title}` : ''}`
    : (preset.data as { kind: 'FreeText'; data: { text: string } }).data.text.slice(0, 50) + ((preset.data as { kind: 'FreeText'; data: { text: string } }).data.text.length > 50 ? '…' : '');

  return (
    <div
      className="flex items-center gap-3 rounded-2xl px-3 py-3 anim-fade-up"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      {/* Kind badge */}
      <span
        className="shrink-0 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider"
        style={isNameplate
          ? { background: 'rgba(59,130,246,0.12)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.3)' }
          : { background: 'rgba(168,85,247,0.12)', color: '#c084fc', border: '1px solid rgba(168,85,247,0.3)' }
        }
      >
        {isNameplate ? 'NP' : 'FT'}
      </span>

      {/* Label + preview */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold truncate" style={{ color: 'var(--text)' }}>{preset.label}</p>
        <p className="text-xs truncate" style={{ color: 'var(--muted)' }}>{summary}</p>
      </div>

      {/* Actions */}
      <div className="flex gap-1.5 shrink-0">
        <button
          onClick={() => ws.send({ cmd: 'show_lt_preset', id: preset.id, template })}
          className="flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-black cursor-pointer active:scale-95 transition-all"
          style={{ background: 'var(--amber)', color: '#000', border: '1px solid var(--amber)' }}
        >
          <Eye size={13} /> Show
        </button>
        <button
          onClick={() => onDelete(preset.id)}
          className="p-2 rounded-xl cursor-pointer active:scale-95 transition-all"
          style={{ background: 'var(--red-dim)', color: 'var(--red)', border: '1px solid rgba(239,68,68,0.3)' }}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export function LowerThirdPage() {
  const { ltShowing, ltTemplates, selectedTemplateIdx, setSelectedTemplate, ltPresets, setLtPresets } = useLiveStore();

  const [mode, setMode] = useState<LtMode>('nameplate');
  const [npName, setNpName] = useState('');
  const [npTitle, setNpTitle] = useState('');
  const [ftText, setFtText] = useState('');

  // Save-as-preset form
  const [saveLabel, setSaveLabel] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);

  // Preset list collapse
  const [presetsOpen, setPresetsOpen] = useState(true);

  function getTemplate() {
    if (selectedTemplateIdx !== null && ltTemplates[selectedTemplateIdx]) return ltTemplates[selectedTemplateIdx];
    return DEFAULT_TEMPLATE;
  }

  function buildData() {
    if (mode === 'nameplate') {
      if (!npName.trim()) return null;
      return { kind: 'Nameplate' as const, data: { name: npName.trim(), title: npTitle.trim() || undefined } };
    } else {
      if (!ftText.trim()) return null;
      return { kind: 'FreeText' as const, data: { text: ftText.trim() } };
    }
  }

  function showCurrent() {
    const data = buildData();
    if (!data) return;
    ws.send({ cmd: 'show_lt', data, template: getTemplate() });
  }

  function savePreset() {
    if (!saveLabel.trim()) return;
    const data = buildData();
    if (!data) return;
    const preset: LtPreset = {
      id: `preset-${Date.now()}`,
      label: saveLabel.trim(),
      data,
    };
    ws.send({ cmd: 'save_lt_preset', preset });
    setSaveLabel('');
    setSaveOpen(false);
  }

  function deletePreset(id: string) {
    ws.send({ cmd: 'delete_lt_preset', id });
    // Optimistic update — server will broadcast the updated list
    setLtPresets(ltPresets.filter(p => p.id !== id));
  }

  const canShow = !!buildData();

  return (
    <div className="flex flex-col gap-3 p-4 overflow-y-auto flex-1">

      {/* ── Status banner ── */}
      <div
        className="flex items-center justify-between rounded-2xl px-4 py-3"
        style={ltShowing
          ? { background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.3)' }
          : { background: 'var(--surface)', border: '1px solid var(--border)' }
        }
      >
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: ltShowing ? 'var(--green)' : 'var(--dim)' }} />
          <span className="text-sm font-bold" style={{ color: ltShowing ? 'var(--green)' : 'var(--muted)' }}>
            {ltShowing ? 'Lower Third showing' : 'Lower Third hidden'}
          </span>
        </div>
        {ltShowing && (
          <button
            onClick={() => ws.send({ cmd: 'hide_lt' })}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black cursor-pointer active:scale-95"
            style={{ background: 'var(--red-dim)', color: 'var(--red)', border: '1px solid rgba(239,68,68,0.3)' }}
          >
            <EyeOff size={12} /> Hide
          </button>
        )}
      </div>

      {/* ── Saved presets ── */}
      <Card>
        <button
          onClick={() => setPresetsOpen(p => !p)}
          className="flex items-center justify-between w-full cursor-pointer"
        >
          <CardLabel>Saved Presets {ltPresets.length > 0 && `(${ltPresets.length})`}</CardLabel>
          {presetsOpen ? <ChevronUp size={14} style={{ color: 'var(--muted)' }} /> : <ChevronDown size={14} style={{ color: 'var(--muted)' }} />}
        </button>

        {presetsOpen && (
          <>
            {ltPresets.length === 0 ? (
              <p className="text-xs text-center py-3" style={{ color: 'var(--muted)' }}>
                No saved presets yet — create one below
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {ltPresets.map(p => (
                  <PresetRow key={p.id} preset={p} template={getTemplate()} onDelete={deletePreset} />
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      {/* ── Compose ── */}
      <Card>
        <CardLabel>Compose</CardLabel>

        <Segment
          options={[{ value: 'nameplate', label: 'Nameplate' }, { value: 'freetext', label: 'Free Text' }]}
          value={mode}
          onChange={v => setMode(v as LtMode)}
        />

        {/* Template selector */}
        {ltTemplates.length > 0 && (
          <div>
            <CardLabel>Style template</CardLabel>
            <div className="flex gap-1.5 flex-wrap mt-1.5">
              <button
                onClick={() => setSelectedTemplate(null)}
                className="px-3 py-1.5 rounded-full text-xs font-bold border cursor-pointer active:scale-95 transition-all"
                style={selectedTemplateIdx === null
                  ? { borderColor: 'var(--amber)', color: 'var(--amber)', background: 'var(--amber-dim)' }
                  : { borderColor: 'var(--border)', color: 'var(--muted)', background: 'transparent' }
                }
              >Default</button>
              {ltTemplates.map((t, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedTemplate(i)}
                  className="px-3 py-1.5 rounded-full text-xs font-bold border cursor-pointer active:scale-95 transition-all"
                  style={selectedTemplateIdx === i
                    ? { borderColor: 'var(--amber)', color: 'var(--amber)', background: 'var(--amber-dim)' }
                    : { borderColor: 'var(--border)', color: 'var(--muted)', background: 'transparent' }
                  }
                >
                  {(t as { name?: string }).name ?? `Template ${i + 1}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Nameplate fields */}
        {mode === 'nameplate' && (
          <div className="flex flex-col gap-2">
            <Input
              placeholder="Name (required)"
              value={npName}
              onChange={e => setNpName(e.target.value)}
            />
            <Input
              placeholder="Title / Role (optional)"
              value={npTitle}
              onChange={e => setNpTitle(e.target.value)}
            />
            {npName && (
              <div
                className="rounded-xl px-4 py-3"
                style={{ background: 'var(--bg)', borderLeft: '4px solid var(--amber)', border: '1px solid var(--amber)' }}
              >
                <p className="font-bold text-base" style={{ color: '#fff' }}>{npName}</p>
                {npTitle && <p className="text-sm mt-0.5" style={{ color: '#e2e8f0' }}>{npTitle}</p>}
              </div>
            )}
          </div>
        )}

        {/* Free text fields */}
        {mode === 'freetext' && (
          <textarea
            value={ftText}
            onChange={e => setFtText(e.target.value)}
            placeholder="Text to display on screen…"
            rows={4}
            className="w-full px-4 py-3 rounded-2xl text-sm resize-none outline-none"
            style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', fontFamily: 'inherit' }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--amber)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
          />
        )}

        {/* Show / Hide row */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={showCurrent} disabled={!canShow}
            className="flex items-center justify-center gap-2 py-4 rounded-2xl font-black text-sm transition-all active:scale-95 disabled:opacity-30 cursor-pointer"
            style={{ background: 'var(--amber)', border: '1px solid var(--amber)', color: '#000' }}
          >
            <Eye size={16} /> Show
          </button>
          <button
            onClick={() => ws.send({ cmd: 'hide_lt' })}
            className="flex items-center justify-center gap-2 py-4 rounded-2xl font-black text-sm transition-all active:scale-95 cursor-pointer"
            style={{ background: 'var(--red-dim)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--red)' }}
          >
            <EyeOff size={16} /> Hide
          </button>
        </div>

        {/* Save as preset */}
        {canShow && (
          <div>
            {!saveOpen ? (
              <button
                onClick={() => setSaveOpen(true)}
                className="flex items-center gap-1.5 w-full justify-center py-2.5 rounded-2xl text-xs font-black cursor-pointer active:scale-95 transition-all"
                style={{ background: 'transparent', border: '1px dashed var(--border)', color: 'var(--muted)' }}
              >
                <Plus size={14} /> Save as preset
              </button>
            ) : (
              <div className="flex gap-2 anim-fade-up">
                <Input
                  placeholder="Preset name…"
                  value={saveLabel}
                  onChange={e => setSaveLabel(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') savePreset(); if (e.key === 'Escape') setSaveOpen(false); }}
                  className="flex-1"
                />
                <button
                  onClick={savePreset}
                  disabled={!saveLabel.trim()}
                  className="px-4 py-2 rounded-2xl text-sm font-black cursor-pointer active:scale-95 disabled:opacity-40 transition-all"
                  style={{ background: 'var(--amber)', color: '#000', border: 'none' }}
                >
                  Save
                </button>
                <button
                  onClick={() => { setSaveOpen(false); setSaveLabel(''); }}
                  className="px-3 py-2 rounded-2xl text-sm cursor-pointer active:scale-95"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
