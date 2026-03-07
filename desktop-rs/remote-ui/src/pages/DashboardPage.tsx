import { ws } from '../api/wsClient';
import { useLiveStore } from '../stores/liveStore';
import { useAuthStore } from '../stores/authStore';
import type { DisplayItem } from '../api/types';

function LiveContent({ item }: { item: DisplayItem }) {
  switch (item.type) {
    case 'Verse':
      return (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-black uppercase tracking-widest" style={{ color: 'var(--amber)' }}>
              {item.data.book} {item.data.chapter}:{item.data.verse}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full border"
              style={{ color: 'var(--muted)', borderColor: 'var(--border)' }}>
              {item.data.version}
            </span>
          </div>
          <p className="text-[1.15rem] font-semibold leading-relaxed" style={{ color: 'var(--text)' }}>
            {item.data.text}
          </p>
        </div>
      );
    case 'Song':
      return (
        <div className="flex flex-col gap-3">
          <div>
            <span className="text-xs font-black uppercase tracking-widest" style={{ color: 'var(--amber)' }}>
              {item.data.title}
            </span>
            {item.data.section_label && (
              <span className="ml-2 text-[10px] px-2 py-0.5 rounded-full border"
                style={{ color: 'var(--muted)', borderColor: 'var(--border)' }}>
                {item.data.section_label}
              </span>
            )}
          </div>
          {item.data.lines.map((line, i) => (
            <p key={i} className="text-[1.15rem] font-semibold leading-relaxed" style={{ color: 'var(--text)' }}>
              {line}
            </p>
          ))}
        </div>
      );
    case 'Media':
      return (
        <div className="flex items-center gap-3">
          <span className="text-2xl">🖼</span>
          <span className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{item.data.name}</span>
        </div>
      );
    case 'Timer':
      return (
        <div className="flex items-center gap-3">
          <span className="text-2xl">⏱</span>
          <span className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
            {item.data.label ?? item.data.timer_type}
          </span>
        </div>
      );
    case 'CustomSlide':
      return (
        <div className="flex items-center gap-3">
          <span className="text-2xl">📑</span>
          <span className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
            {item.data.presentation_name} · slide {item.data.slide_index + 1}
          </span>
        </div>
      );
    default:
      return <span style={{ color: 'var(--muted)' }}>{item.type}</span>;
  }
}

export function DashboardPage() {
  const liveItem = useLiveStore(s => s.liveItem);
  const stagedItem = useLiveStore(s => s.stagedItem);
  const ltShowing = useLiveStore(s => s.ltShowing);
  const isOutputBlanked = useLiveStore(s => s.isOutputBlanked);
  const transcription = useLiveStore(s => s.transcription);
  const operators = useLiveStore(s => s.operators);
  const lastChangedBy = useLiveStore(s => s.lastChangedBy);
  const myRole = useAuthStore(s => s.role);

  const isViewer = myRole === 'viewer';

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex flex-col gap-3 p-4">

        {/* ── Operators presence ── */}
        {operators.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {operators.map(op => (
              <span
                key={op.key}
                className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
                style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px solid var(--border)' }}
              >
                {op.name}{op.role === 'viewer' && <span style={{ opacity: 0.6 }}> (view)</span>}
              </span>
            ))}
          </div>
        )}

        {/* ── Now Live ── */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 rounded-full anim-pulse-dot" style={{ background: liveItem ? 'var(--green)' : 'var(--dim)' }} />
            <span className="text-[10px] font-black tracking-[0.18em] uppercase" style={{ color: liveItem ? 'var(--green)' : 'var(--muted)' }}>
              {liveItem ? 'Now Live' : 'Output Clear'}
            </span>
            {isOutputBlanked && (
              <span className="ml-1 text-[9px] px-2 py-0.5 rounded-full font-black uppercase tracking-widest"
                style={{ background: 'var(--amber-dim)', color: 'var(--amber)', border: '1px solid var(--amber)' }}>
                Blanked
              </span>
            )}
            {lastChangedBy && liveItem && (
              <span className="ml-auto text-[9px]" style={{ color: 'var(--muted)' }}>by {lastChangedBy}</span>
            )}
          </div>

          <div
            className="rounded-2xl p-4 min-h-[120px] flex items-center anim-fade-up"
            style={{
              background: liveItem ? 'rgba(34,197,94,0.06)' : 'var(--surface)',
              border: liveItem ? '1px solid rgba(34,197,94,0.3)' : '1px solid var(--border)',
            }}
          >
            {liveItem ? (
              <LiveContent item={liveItem} />
            ) : (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                Nothing on screen · select a verse, song, or media to go live
              </p>
            )}
          </div>
        </div>

        {/* ── Staged (pending main operator approval) ── */}
        {stagedItem && (
          <div>
            <p className="text-[10px] font-black tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--muted)' }}>
              Staged — Awaiting Main Operator
            </p>
            <div
              className="rounded-2xl p-3 flex items-center gap-3 anim-fade-up"
              style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)' }}
            >
              <div className="flex-1 min-w-0">
                <LiveContent item={stagedItem} />
              </div>
              <span
                className="shrink-0 text-[10px] font-black uppercase px-2.5 py-1.5 rounded-xl"
                style={{ background: 'rgba(245,158,11,0.12)', color: 'var(--amber)', border: '1px solid rgba(245,158,11,0.3)' }}
              >
                Pending
              </span>
            </div>
          </div>
        )}

        {/* ── Transcription ── */}
        {transcription && (
          <div
            className="flex items-start gap-2 rounded-2xl px-4 py-3 anim-fade-up"
            style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)' }}
          >
            <span className="text-sm shrink-0" style={{ color: 'var(--amber)' }}>🎙</span>
            <p className="text-sm italic leading-relaxed" style={{ color: 'var(--amber)' }}>{transcription}</p>
          </div>
        )}

        {/* ── Quick actions ── */}
        <div>
          <p className="text-[10px] font-black tracking-[0.18em] uppercase mb-2" style={{ color: 'var(--muted)' }}>
            Quick Actions
          </p>
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => ws.send({ cmd: 'blank_output' })}
              disabled={isViewer}
              className="flex flex-col items-center justify-center gap-1.5 py-4 rounded-2xl border transition-all active:scale-95 cursor-pointer disabled:opacity-30"
              style={isOutputBlanked
                ? { background: 'var(--amber)', borderColor: 'var(--amber)', color: '#000' }
                : { background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }
              }
            >
              <span className="text-xl">☁</span>
              <span className="text-[11px] font-bold">{isOutputBlanked ? 'Unblank' : 'Logo'}</span>
            </button>

            <button
              onClick={() => { ws.send({ cmd: 'clear_live' }); }}
              disabled={isViewer}
              className="flex flex-col items-center justify-center gap-1.5 py-4 rounded-2xl border transition-all active:scale-95 cursor-pointer disabled:opacity-30"
              style={{ background: 'var(--red-dim)', borderColor: 'rgba(239,68,68,0.3)', color: 'var(--red)' }}
            >
              <span className="text-xl">✕</span>
              <span className="text-[11px] font-bold">Clear</span>
            </button>

            <button
              onClick={() => ws.send({ cmd: ltShowing ? 'hide_lt' : 'show_lt' })}
              disabled={isViewer}
              className="flex flex-col items-center justify-center gap-1.5 py-4 rounded-2xl border transition-all active:scale-95 cursor-pointer disabled:opacity-30"
              style={ltShowing
                ? { background: 'rgba(34,197,94,0.1)', borderColor: 'rgba(34,197,94,0.4)', color: 'var(--green)' }
                : { background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--muted)' }
              }
            >
              <span className="text-xl">≡</span>
              <span className="text-[11px] font-bold">{ltShowing ? 'Hide LT' : 'L. Third'}</span>
            </button>
          </div>
        </div>

        {/* ── LT status ── */}
        {ltShowing && (
          <div
            className="flex items-center justify-between rounded-2xl px-4 py-3 anim-fade-up"
            style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.25)' }}
          >
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--green)' }} />
              <span className="text-xs font-bold" style={{ color: 'var(--green)' }}>Lower Third showing</span>
            </div>
            <button
              onClick={() => ws.send({ cmd: 'hide_lt' })}
              disabled={isViewer}
              className="text-xs font-black px-3 py-1.5 rounded-xl active:scale-95 cursor-pointer disabled:opacity-30"
              style={{ background: 'var(--red-dim)', color: 'var(--red)', border: '1px solid rgba(239,68,68,0.3)' }}
            >
              Hide
            </button>
          </div>
        )}

        {/* ── Role notice ── */}
        {isViewer ? (
          <div
            className="rounded-2xl px-4 py-3 text-center anim-fade-up"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              You are in <strong>viewer mode</strong> — output controls are read-only
            </p>
          </div>
        ) : (
          <div
            className="rounded-2xl px-4 py-3 text-center anim-fade-up"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Stage items to propose them for display — the main operator sends them live
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
