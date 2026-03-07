// ─── Design system primitives ─────────────────────────────────────────────────

import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from 'react';
import type { Verse } from '../api/types';
import { ws } from '../api/wsClient';

// ── GlassCard ──────────────────────────────────────────────────────────────────
export function Card({ children, className = '', live = false }: {
  children: ReactNode; className?: string; live?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-2xl p-4 ${className}`}
      style={{
        background: live ? 'rgba(34,197,94,0.06)' : 'rgba(255,255,255,0.025)',
        border: live ? '1px solid rgba(34,197,94,0.35)' : '1px solid rgba(255,255,255,0.055)',
        backdropFilter: 'blur(16px)',
      }}
    >
      {children}
    </div>
  );
}

// ── Section label ─────────────────────────────────────────────────────────────
export function CardLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10px] font-bold tracking-[0.15em] uppercase" style={{ color: 'var(--muted)' }}>
      {children}
    </div>
  );
}

// ── Buttons ───────────────────────────────────────────────────────────────────
type BtnVariant = 'default' | 'live' | 'danger' | 'ghost' | 'stage';

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const variantCls: Record<BtnVariant, string> = {
  default: 'bg-[var(--elevated)] border-[var(--border)] text-[var(--text)] active:bg-[#1e2540]',
  live:    'bg-[var(--amber)] border-[var(--amber)] text-black font-black active:brightness-90 disabled:bg-[#3d2f0a] disabled:text-[#5a4414] disabled:border-transparent',
  stage:   'bg-[var(--amber-dim)] border-[var(--amber)] text-[var(--amber)] active:bg-[var(--amber-glow)]',
  danger:  'bg-[var(--red-dim)] border-[rgba(239,68,68,0.3)] text-[var(--red)] active:bg-[rgba(239,68,68,0.2)]',
  ghost:   'bg-transparent border-transparent text-[var(--muted)] active:text-[var(--text)]',
};

const sizeCls = {
  sm: 'px-3 py-2 text-xs rounded-xl',
  md: 'px-4 py-3.5 text-sm rounded-2xl',
  lg: 'px-4 py-4 text-[15px] rounded-2xl',
};

export function Btn({ variant = 'default', size = 'md', className = '', children, ...props }: BtnProps) {
  return (
    <button
      {...props}
      className={`border font-bold cursor-pointer transition-all active:scale-[0.96] disabled:opacity-40 disabled:cursor-not-allowed select-none ${variantCls[variant]} ${sizeCls[size]} ${className}`}
    >
      {children}
    </button>
  );
}

// ── Pill chip ─────────────────────────────────────────────────────────────────
export function Pill({ active, onClick, children }: { active?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-3.5 py-1.5 rounded-full text-xs font-bold border transition-all cursor-pointer active:scale-95 select-none"
      style={active
        ? { borderColor: 'var(--amber)', color: 'var(--amber)', background: 'var(--amber-dim)' }
        : { borderColor: 'var(--border)', color: 'var(--muted)', background: 'transparent' }
      }
    >
      {children}
    </button>
  );
}

// ── Segmented control ─────────────────────────────────────────────────────────
export function Segment<T extends string>({
  options, value, onChange,
}: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-xl overflow-hidden border p-0.5 gap-0.5" style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className="flex-1 py-2 text-xs font-bold rounded-lg transition-all cursor-pointer select-none"
          style={o.value === value
            ? { background: 'var(--amber)', color: '#000' }
            : { background: 'transparent', color: 'var(--muted)' }
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Text input ────────────────────────────────────────────────────────────────
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full px-4 py-3.5 rounded-2xl text-base outline-none transition-colors ${props.className ?? ''}`}
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', ...props.style }}
      onFocus={e => { e.currentTarget.style.borderColor = 'var(--amber)'; props.onFocus?.(e); }}
      onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; props.onBlur?.(e); }}
    />
  );
}

// ── Select ────────────────────────────────────────────────────────────────────
export function Select(props: InputHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  const { children, ...rest } = props;
  return (
    <select
      {...rest}
      className={`w-full px-4 py-3.5 rounded-2xl text-base outline-none cursor-pointer appearance-none ${rest.className ?? ''}`}
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)', ...rest.style }}
    >
      {children}
    </select>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────
export function Spinner() {
  return (
    <div className="w-5 h-5 rounded-full border-2 animate-spin"
      style={{ borderColor: 'var(--border)', borderTopColor: 'var(--amber)' }} />
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────
export function Row({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex gap-2 items-center ${className}`}>{children}</div>;
}

// ── Score badge ───────────────────────────────────────────────────────────────
export function ScoreBadge({ score }: { score?: number }) {
  if (score == null || score === 0) return null;
  const pct = Math.round(score * 100);
  const color = pct >= 70 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--muted)';
  const bg = pct >= 70 ? 'rgba(34,197,94,0.12)' : pct >= 50 ? 'rgba(245,158,11,0.12)' : 'rgba(86,98,122,0.15)';
  return (
    <span
      className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-black tabular-nums"
      style={{ color, background: bg, border: `1px solid ${color}` }}
    >
      {pct}%
    </span>
  );
}

// ── Verse result (with inline actions) ───────────────────────────────────────
export function VerseResult({ verse, selected, onClick }: { verse: Verse; selected?: boolean; onClick: () => void }) {
  return (
    <div
      className="rounded-2xl overflow-hidden transition-all anim-fade-up"
      style={{
        border: selected ? '1px solid var(--amber)' : '1px solid var(--border)',
        background: selected ? 'var(--amber-dim)' : 'var(--surface)',
      }}
    >
      {/* Header row — tap to select/preview */}
      <div className="px-3 pt-3 pb-2 cursor-pointer" onClick={onClick}>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[11px] font-black uppercase tracking-wider" style={{ color: 'var(--amber)' }}>
            {verse.book} {verse.chapter}:{verse.verse}
          </span>
          <span className="text-[9px] px-1.5 py-0.5 rounded-full border" style={{ color: 'var(--muted)', borderColor: 'var(--border)' }}>
            {verse.version}
          </span>
          {verse.score != null && verse.score > 0 && <ScoreBadge score={verse.score} />}
        </div>
        <p className="text-sm leading-relaxed line-clamp-3" style={{ color: 'var(--text)' }}>
          {verse.text}
        </p>
      </div>

      {/* Action row */}
      <div className="flex gap-1.5 px-3 pb-3">
        <button
          onClick={e => { e.stopPropagation(); ws.send({ cmd: 'stage_item', item: { type: 'Verse', data: verse } }); }}
          className="flex-1 py-2 text-xs font-black rounded-xl border transition-all active:scale-95 cursor-pointer"
          style={{ background: 'var(--amber-dim)', borderColor: 'var(--amber)', color: 'var(--amber)' }}
        >
          Stage
        </button>
        <button
          onClick={e => { e.stopPropagation(); ws.send({ cmd: 'go_live', item: { type: 'Verse', data: verse } }); }}
          className="flex-1 py-2 text-xs font-black rounded-xl border transition-all active:scale-95 cursor-pointer"
          style={{ background: 'var(--amber)', borderColor: 'var(--amber)', color: '#000' }}
        >
          Go Live
        </button>
      </div>
    </div>
  );
}

// ── Verse preview ─────────────────────────────────────────────────────────────
export function VersePreview({ verse }: { verse: Verse }) {
  return (
    <div className="rounded-2xl px-4 py-3 leading-relaxed"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="text-[10px] font-black uppercase tracking-wider mb-1.5" style={{ color: 'var(--amber)' }}>
        {verse.book} {verse.chapter}:{verse.verse} · {verse.version}
      </div>
      <p className="text-sm" style={{ color: 'var(--text)' }}>{verse.text}</p>
    </div>
  );
}

// ── Live dot ──────────────────────────────────────────────────────────────────
export function LiveDot() {
  return (
    <span className="inline-block w-2 h-2 rounded-full anim-pulse-dot" style={{ background: 'var(--green)' }} />
  );
}
