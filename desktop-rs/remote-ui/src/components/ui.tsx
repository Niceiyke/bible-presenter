// ─── Shared primitive UI components ──────────────────────────────────────────

import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from 'react';

// Card
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-xl p-4 ${className}`}
      style={{ background: 'var(--panel)', border: '1px solid var(--border)' }}
    >
      {children}
    </div>
  );
}

// Card section label
export function CardLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10px] font-bold tracking-widest uppercase mb-1" style={{ color: 'var(--muted)' }}>
      {children}
    </div>
  );
}

// Button variants
type BtnVariant = 'default' | 'live' | 'danger' | 'ghost';

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  children: ReactNode;
}

const variantStyles: Record<BtnVariant, string> = {
  default: 'border-[var(--border)] bg-[var(--panel)] text-[var(--text)] active:bg-[#22253a]',
  live:    'border-[var(--amber)] bg-[var(--amber)] text-black active:brightness-90 disabled:bg-[#4a3d1a] disabled:text-[#7a6030] disabled:border-[#4a3d1a]',
  danger:  'border-[var(--red)] text-[var(--red)] active:bg-red-900/20 bg-transparent',
  ghost:   'border-transparent bg-transparent text-[var(--muted)] active:text-[var(--text)]',
};

export function Btn({ variant = 'default', className = '', children, ...props }: BtnProps) {
  return (
    <button
      {...props}
      className={`px-4 py-3 border rounded-xl text-sm font-bold cursor-pointer transition-all
        disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.97] ${variantStyles[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

// Pill (selectable chip)
export function Pill({
  active, onClick, children,
}: { active?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 rounded-full text-xs font-bold border transition-all cursor-pointer active:scale-95"
      style={
        active
          ? { borderColor: 'var(--amber)', color: 'var(--amber)', background: 'rgba(245,158,11,.15)' }
          : { borderColor: 'var(--border)', color: 'var(--muted)', background: 'transparent' }
      }
    >
      {children}
    </button>
  );
}

// Text input
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full px-4 py-3 rounded-xl text-base outline-none transition-colors ${props.className ?? ''}`}
      style={{
        background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)',
        ...props.style,
      }}
      onFocus={e => { e.currentTarget.style.borderColor = 'var(--amber)'; props.onFocus?.(e); }}
      onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)'; props.onBlur?.(e); }}
    />
  );
}

// Select
export function Select(props: InputHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  const { children, ...rest } = props;
  return (
    <select
      {...rest}
      className={`w-full px-4 py-3 rounded-xl text-base outline-none cursor-pointer appearance-none ${rest.className ?? ''}`}
      style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', ...rest.style }}
    >
      {children}
    </select>
  );
}

// Spinner
export function Spinner() {
  return (
    <div className="w-4 h-4 rounded-full border-2 animate-spin"
      style={{ borderColor: 'var(--border)', borderTopColor: 'var(--amber)' }} />
  );
}

// Row
export function Row({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex gap-2 items-center ${className}`}>{children}</div>;
}

// Verse result item
import type { Verse } from '../api/types';

export function VerseResult({
  verse, selected, onClick,
}: { verse: Verse; selected?: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="px-3 py-2 rounded-lg cursor-pointer transition-all"
      style={
        selected
          ? { border: '1px solid var(--amber)', background: 'rgba(245,158,11,.07)' }
          : { border: '1px solid var(--border)', background: 'var(--bg)' }
      }
    >
      <div className="text-[10px] font-bold uppercase tracking-wider mb-0.5" style={{ color: 'var(--amber)' }}>
        {verse.book} {verse.chapter}:{verse.verse} ({verse.version})
      </div>
      <div className="text-xs leading-relaxed line-clamp-2" style={{ color: 'var(--text)' }}>
        {verse.text}
      </div>
    </div>
  );
}

// Verse preview box
export function VersePreview({ verse }: { verse: Verse }) {
  return (
    <div className="rounded-lg px-3 py-3 text-sm leading-relaxed"
      style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)' }}>
      <div className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: 'var(--amber)' }}>
        {verse.book} {verse.chapter}:{verse.verse} ({verse.version})
      </div>
      {verse.text}
    </div>
  );
}
