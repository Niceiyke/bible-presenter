import { useRef, useState } from 'react';
import { ws } from '../api/wsClient';
import { useAuthStore, type Role } from '../stores/authStore';

export function PinScreen() {
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [name, setName] = useState(sessionStorage.getItem('remote_name') ?? '');
  const [role, setRole] = useState<Role>((sessionStorage.getItem('remote_role') as Role) ?? 'operator');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const { connStatus } = useAuthStore();

  function handleChange(i: number, val: string) {
    const v = val.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[i] = v;
    setDigits(next);
    if (v && i < 5) refs.current[i + 1]?.focus();
    if (i === 5 && v) submit(next.join(''));
  }

  function handleKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'Enter') submit(digits.join(''));
  }

  function handlePaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (text.length === 6) {
      setDigits(text.split(''));
      refs.current[5]?.focus();
      setTimeout(() => submit(text), 0);
    }
    e.preventDefault();
  }

  function submit(pin = digits.join('')) {
    if (!name.trim()) { setError('Enter your name'); return; }
    if (pin.length < 6) { setError('Enter all 6 digits'); return; }
    setError('');
    setSubmitting(true);
    ws.auth(pin, name.trim(), role);
    setTimeout(() => setSubmitting(false), 4000);
  }

  const connColor =
    connStatus === 'connected' ? 'var(--green)' :
    connStatus === 'connecting' ? 'var(--amber)' : 'var(--red)';

  return (
    <div
      className="flex flex-col h-full overflow-hidden relative"
      style={{ background: 'var(--bg)' }}
    >
      {/* Ambient glow blobs */}
      <div
        className="absolute -top-24 left-1/2 -translate-x-1/2 w-80 h-80 rounded-full blur-3xl opacity-20 pointer-events-none"
        style={{ background: 'radial-gradient(circle, var(--amber) 0%, transparent 70%)' }}
      />
      <div
        className="absolute -bottom-32 right-0 w-64 h-64 rounded-full blur-3xl opacity-10 pointer-events-none"
        style={{ background: 'radial-gradient(circle, #3b82f6 0%, transparent 70%)' }}
      />

      {/* Content */}
      <div className="flex flex-col items-center justify-center flex-1 gap-8 px-8 relative z-10">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl anim-live-ring"
            style={{
              background: 'var(--amber-dim)',
              border: '1px solid var(--amber)',
            }}
          >
            ✝
          </div>
          <div>
            <h1 className="text-2xl font-black text-center tracking-tight" style={{ color: 'var(--text)' }}>
              Wordlyte
            </h1>
            <p className="text-xs text-center font-medium tracking-widest uppercase mt-0.5" style={{ color: 'var(--muted)' }}>
              Remote Control
            </p>
          </div>
        </div>

        {/* PIN inputs */}
        <div className="flex flex-col items-center gap-5 w-full max-w-xs">
          {/* Name + Role */}
          <div className="flex flex-col gap-2 w-full">
            <input
              type="text"
              placeholder="Your name"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
              maxLength={32}
              className="w-full px-4 py-3 rounded-2xl outline-none text-sm transition-all"
              style={{
                background: 'var(--surface)',
                border: `2px solid ${name ? 'var(--amber)' : 'var(--border)'}`,
                color: 'var(--text)',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--amber)')}
              onBlur={e => (e.currentTarget.style.borderColor = name ? 'var(--amber)' : 'var(--border)')}
            />
            <div className="flex gap-2">
              {(['operator', 'viewer'] as const).map(r => (
                <button
                  key={r}
                  onClick={() => setRole(r)}
                  className="flex-1 py-2 rounded-xl text-xs font-black capitalize transition-all active:scale-95 cursor-pointer"
                  style={role === r
                    ? { background: 'var(--amber)', color: '#000', border: '2px solid var(--amber)' }
                    : { background: 'var(--surface)', color: 'var(--muted)', border: '2px solid var(--border)' }
                  }
                >
                  {r === 'operator' ? 'Operator' : 'Viewer (read-only)'}
                </button>
              ))}
            </div>
          </div>

          <p className="text-sm text-center" style={{ color: 'var(--muted)' }}>
            Enter the 6-digit PIN from the app
          </p>

          <div className="flex gap-3 justify-center" onPaste={handlePaste}>
            {digits.map((d, i) => (
              <input
                key={i}
                ref={el => { refs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={d}
                onChange={e => handleChange(i, e.target.value)}
                onKeyDown={e => handleKeyDown(i, e)}
                className="w-11 h-14 text-center text-xl font-black rounded-2xl outline-none transition-all"
                style={{
                  background: 'var(--surface)',
                  border: `2px solid ${d ? 'var(--amber)' : 'var(--border)'}`,
                  color: 'var(--text)',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = 'var(--amber)')}
                onBlur={e => (e.currentTarget.style.borderColor = d ? 'var(--amber)' : 'var(--border)')}
              />
            ))}
          </div>

          {error && (
            <p className="text-xs text-center anim-fade-up" style={{ color: 'var(--red)' }}>
              {error}
            </p>
          )}

          <button
            onClick={() => submit()}
            disabled={submitting || digits.some(d => !d)}
            className="w-full py-4 text-sm font-black rounded-2xl transition-all active:scale-95 disabled:opacity-40 cursor-pointer"
            style={{ background: 'var(--amber)', color: '#000', border: 'none' }}
          >
            {submitting ? 'Connecting…' : 'Connect'}
          </button>
        </div>

        {/* Status */}
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full transition-colors" style={{ background: connColor }} />
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {connStatus === 'connected' ? 'Ready' : connStatus === 'connecting' ? 'Connecting…' : 'Disconnected'}
          </span>
        </div>
      </div>
    </div>
  );
}
