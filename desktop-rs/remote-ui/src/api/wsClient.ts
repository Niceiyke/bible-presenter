import type { WsEvent } from './types';

type Listener = (event: WsEvent) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private listeners: Listener[] = [];
  private reconnectDelay = 1000;
  private token: string | null = null;
  private intentionallyClosed = false;

  subscribe(fn: Listener) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  private emit(event: WsEvent) {
    this.listeners.forEach(l => l(event));
  }

  connect() {
    this.intentionallyClosed = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      const saved = sessionStorage.getItem('remote_token');
      if (saved) {
        this.token = saved;
        this.send({ cmd: 'auth', pin: sessionStorage.getItem('remote_pin') ?? '' });
      }
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data) as WsEvent;
        if (msg.type === 'auth_ok') {
          this.token = (msg as { type: 'auth_ok'; token: string }).token;
          sessionStorage.setItem('remote_token', this.token);
        }
        this.emit(msg);
      } catch { /* ignore */ }
    };

    this.ws.onclose = () => {
      if (this.intentionallyClosed) return;
      this.scheduleReconnect();
    };

    this.ws.onerror = () => this.ws?.close();
  }

  private scheduleReconnect() {
    setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30_000);
      this.connect();
    }, this.reconnectDelay);
  }

  send(obj: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  auth(pin: string) {
    sessionStorage.setItem('remote_pin', pin);
    this.send({ cmd: 'auth', pin });
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export const ws = new WsClient();
