import { useState } from 'react';
import { Eye, EyeOff, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { ws } from '../api/wsClient';
import { useLiveStore } from '../stores/liveStore';
import { Card, CardLabel, Input, Segment } from '../components/ui';
import type { LtPreset } from '../api/types';

type LtMode = 'nameplate' | 'freetext';

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

// ── Preset row ────────────────────────────────────────────────────────────────
function PresetRow({ preset, templates, currentTemplate, onDelete }: { 
  preset: LtPreset; 
  templates: any[]; 
  currentTemplate: object; 
  onDelete: (id: string) => void 
}) {
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
          onClick={() => {
            let targetTemplate = currentTemplate;
            if (preset.template_id) {
              const found = templates.find(t => t.id === preset.template_id);
              if (found) targetTemplate = found;
            }
            ws.send({ cmd: 'show_lt_preset', id: preset.id, template: targetTemplate });
          }}
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
  const [saveTemplateIdx, setSaveTemplateIdx] = useState<number | null>(selectedTemplateIdx);
  const [saveOpen, setSaveOpen] = useState(false);

  // Preset list collapse
  const [presetsOpen, setPresetsOpen] = useState(true);

  // Update saveTemplateIdx when selectedTemplateIdx changes if form is not open
  if (!saveOpen && saveTemplateIdx !== selectedTemplateIdx) {
    setSaveTemplateIdx(selectedTemplateIdx);
  }

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
    
    let tpl_id: string | undefined = undefined;
    if (saveTemplateIdx !== null && ltTemplates[saveTemplateIdx]) {
      tpl_id = (ltTemplates[saveTemplateIdx] as any).id;
    }

    const preset: LtPreset = {
      id: `preset-${Date.now()}`,
      label: saveLabel.trim(),
      template_id: tpl_id,
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
    <div className="flex flex-col gap-3 p-4 overflow-y-auto flex-1 custom-scrollbar">

      {/* ── Status banner ── */}
      <div
        className="flex items-center justify-between rounded-2xl px-4 py-3 shrink-0"
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
                  <PresetRow key={p.id} preset={p} templates={ltTemplates} currentTemplate={getTemplate()} onDelete={deletePreset} />
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
            <CardLabel>Live style template</CardLabel>
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
        <div className="grid grid-cols-2 gap-2 pt-2">
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
          <div className="pt-2 border-t border-white/5 mt-2">
            {!saveOpen ? (
              <button
                onClick={() => setSaveOpen(true)}
                className="flex items-center gap-1.5 w-full justify-center py-2.5 rounded-2xl text-xs font-black cursor-pointer active:scale-95 transition-all"
                style={{ background: 'transparent', border: '1px dashed var(--border)', color: 'var(--muted)' }}
              >
                <Plus size={14} /> Save as preset
              </button>
            ) : (
              <div className="flex flex-col gap-3 anim-fade-up bg-black/20 p-3 rounded-2xl border border-white/5">
                <p className="text-[10px] font-black text-amber-500 uppercase tracking-widest">New Preset</p>
                
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-bold text-slate-500 uppercase px-1">Preset Label</span>
                  <Input
                    placeholder="E.g. Pastor's Nameplate"
                    value={saveLabel}
                    onChange={e => setSaveLabel(e.target.value)}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-bold text-slate-500 uppercase px-1">Style Template</span>
                  <div className="flex gap-1.5 flex-wrap">
                    <button
                      onClick={() => setSaveTemplateIdx(null)}
                      className="px-3 py-1.5 rounded-full text-xs font-bold border cursor-pointer active:scale-95 transition-all"
                      style={saveTemplateIdx === null
                        ? { borderColor: 'var(--amber)', color: 'var(--amber)', background: 'var(--amber-dim)' }
                        : { borderColor: 'var(--border)', color: 'var(--muted)', background: 'transparent' }
                      }
                    >Default</button>
                    {ltTemplates.map((t, i) => (
                      <button
                        key={i}
                        onClick={() => setSaveTemplateIdx(i)}
                        className="px-3 py-1.5 rounded-full text-xs font-bold border cursor-pointer active:scale-95 transition-all"
                        style={saveTemplateIdx === i
                          ? { borderColor: 'var(--amber)', color: 'var(--amber)', background: 'var(--amber-dim)' }
                          : { borderColor: 'var(--border)', color: 'var(--muted)', background: 'transparent' }
                        }
                      >
                        {(t as any).name ?? `Style ${i+1}`}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2 mt-1">
                  <button
                    onClick={savePreset}
                    disabled={!saveLabel.trim()}
                    className="flex-1 py-3 rounded-xl text-sm font-black cursor-pointer active:scale-95 disabled:opacity-40 transition-all"
                    style={{ background: 'var(--amber)', color: '#000', border: 'none' }}
                  >
                    Save Preset
                  </button>
                  <button
                    onClick={() => { setSaveOpen(false); setSaveLabel(''); }}
                    className="px-4 py-3 rounded-xl text-sm font-bold cursor-pointer active:scale-95"
                    style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
    </div>
  );
}
