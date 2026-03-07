import { useAuthStore } from '../stores/authStore';

export function StatusBar() {
  const { connStatus, connLabel } = useAuthStore();
  const ok = connStatus === 'connected';
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs flex-shrink-0"
         style={{ background: 'var(--panel)', borderTop: '1px solid var(--border)', color: 'var(--muted)' }}>
      <span
        className="w-2 h-2 rounded-full transition-colors"
        style={{ background: ok ? 'var(--green)' : connStatus === 'connecting' ? 'var(--amber)' : 'var(--red)' }}
      />
      {connLabel}
    </div>
  );
}
