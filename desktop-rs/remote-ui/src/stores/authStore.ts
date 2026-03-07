import { create } from 'zustand';

type Role = 'operator' | 'presenter' | 'viewer';

interface AuthState {
  authed: boolean;
  token: string | null;
  role: Role;
  connStatus: 'connecting' | 'connected' | 'disconnected';
  connLabel: string;
  setAuthed: (token: string) => void;
  setRole: (role: Role) => void;
  setStatus: (s: AuthState['connStatus'], label?: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  authed: false,
  token: null,
  role: 'operator',
  connStatus: 'connecting',
  connLabel: 'Connecting…',

  setAuthed: (token) => {
    sessionStorage.setItem('remote_token', token);
    set({ authed: true, token, connStatus: 'connected', connLabel: 'Connected' });
  },
  setRole: (role) => set({ role }),
  setStatus: (connStatus, label) =>
    set({ connStatus, connLabel: label ?? (connStatus === 'connected' ? 'Connected' : 'Connecting…') }),
  logout: () => {
    sessionStorage.removeItem('remote_token');
    sessionStorage.removeItem('remote_pin');
    set({ authed: false, token: null, connStatus: 'disconnected', connLabel: 'Disconnected' });
  },
}));
