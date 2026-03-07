import { useRef, useState } from 'react';
import { ws } from '../api/wsClient';

export function PinScreen() {
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [error, setError] = useState('');
  const refs = useRef<(HTMLInputElement | null)[]>([]);

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
    if (pin.length < 6) { setError('Enter all 6 digits.'); return; }
    setError('');
    ws.auth(pin);
  }

  return (
    <div className="flex flex-col items-center justify-center gap-6 p-6 h-full">
      <div className="text-4xl">⛪</div>
      <div>
        <div className="text-xl font-bold text-center mb-1" style={{ color: 'var(--text)' }}>
          Wordlyte Remote
        </div>
        <div className="text-xs text-center" style={{ color: 'var(--muted)' }}>
          Enter the PIN shown in the app's Settings tab
        </div>
      </div>

      <div className="flex gap-2.5" onPaste={handlePaste}>
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
            className="w-12 h-16 text-center text-2xl font-bold rounded-xl outline-none transition-colors"
            style={{
              background: 'var(--panel)',
              border: '2px solid var(--border)',
              color: 'var(--text)',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--amber)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
          />
        ))}
      </div>

      {error && <div className="text-xs text-center" style={{ color: 'var(--red)' }}>{error}</div>}

      <button
        onClick={() => submit()}
        className="px-10 py-3.5 font-bold text-sm rounded-xl w-full max-w-[220px] transition-all hover:brightness-110"
        style={{ background: 'var(--amber)', color: '#000', border: 'none', cursor: 'pointer' }}
      >
        Connect
      </button>
    </div>
  );
}
