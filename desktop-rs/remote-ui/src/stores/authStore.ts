import { create } from 'zustand';

export type Role = 'operator' | 'presenter' | 'viewer';

interface AuthState {
  authed: boolean;
  token: string | null;
  key: string | null;
  name: string;
  role: Role;
  connStatus: 'connecting' | 'connected' | 'disconnected';
  connLabel: string;
  setAuthed: (token: string, key?: string) => void;
  setName: (name: string) => void;
  setRole: (role: Role) => void;
  setStatus: (s: AuthState['connStatus'], label?: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  authed: false,
  token: null,
  key: null,
  name: sessionStorage.getItem('remote_name') ?? '',
  role: (sessionStorage.getItem('remote_role') as Role) ?? 'operator',
  connStatus: 'connecting',
  connLabel: 'Connecting…',

  setAuthed: (token, key) => {
    sessionStorage.setItem('remote_token', token);
    set({ authed: true, token, key: key ?? null, connStatus: 'connected', connLabel: 'Connected' });
  },
  setName: (name) => {
    sessionStorage.setItem('remote_name', name);
    set({ name });
  },
  setRole: (role) => {
    sessionStorage.setItem('remote_role', role);
    set({ role });
  },
  setStatus: (connStatus, label) =>
    set({ connStatus, connLabel: label ?? (connStatus === 'connected' ? 'Connected' : 'Connecting…') }),
  logout: () => {
    sessionStorage.removeItem('remote_token');
    sessionStorage.removeItem('remote_pin');
    set({ authed: false, token: null, connStatus: 'disconnected', connLabel: 'Disconnected' });
  },
}));
