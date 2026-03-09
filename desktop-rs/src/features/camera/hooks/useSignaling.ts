import { useRef, useCallback, useEffect } from "react";
import type { WsInbound } from "../types";
import { cameraLog } from "../cameraLog";

export type MessageHandler = (msg: WsInbound) => void;

interface UseSignalingOptions {
  pin: string | null;
  clientType: string;
  /** Called with every typed inbound message */
  onMessage: MessageHandler;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

const MIN_BACKOFF_MS  = 1_000;
const MAX_BACKOFF_MS  = 30_000;
const BACKOFF_FACTOR  = 1.5;
const PING_INTERVAL_MS = 10_000;

/** Resolve the signaling server host. */
function resolveHost(): string {
  const h = window.location.hostname;
  if (!h || h === "localhost" || h === "tauri.localhost") return "127.0.0.1";
  return h;
}

/**
 * Manages a single WebSocket connection to the signaling server.
 * Handles auth, exponential backoff reconnect, and typed message dispatch.
 */
export function useSignaling({ pin, clientType, onMessage, onConnected, onDisconnected }: UseSignalingOptions) {
  const wsRef          = useRef<WebSocket | null>(null);
  const backoffRef     = useRef(MIN_BACKOFF_MS);
  const mountedRef     = useRef(true);
  const pingTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = useCallback((payload: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  const connect = useCallback(() => {
    if (!pin || !mountedRef.current) return;
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) return;

    const host = resolveHost();
    const isLocal = host === "localhost" || host === "127.0.0.1";
    // If local, prefer ws:// to avoid cert issues. If remote, prefer wss://.
    const protocol = isLocal ? "ws" : "wss";
    const url = `${protocol}://${host}:7420/ws`;
    
    cameraLog("info", "ws", `Connecting to ${url} as ${clientType}`);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      cameraLog("info", "ws", `Socket open — sending auth (client_type=${clientType})`);
      ws.send(JSON.stringify({ cmd: "auth", pin, client_type: clientType }));
    };

    ws.onmessage = (ev) => {
      let msg: WsInbound;
      try { msg = JSON.parse(ev.data) as WsInbound; } catch { return; }

      // Reset backoff on any successful message
      backoffRef.current = MIN_BACKOFF_MS;

      if ((msg as any).type === "auth_ok") {
        cameraLog("info", "ws", `Auth OK — key=${(msg as any).key ?? "?"}`);
        onConnected?.();
        // Start ping to keep connection alive and feed server heartbeat
        if (pingTimerRef.current) clearInterval(pingTimerRef.current);
        pingTimerRef.current = setInterval(() => {
          ws.send(JSON.stringify({ cmd: "ping" }));
        }, PING_INTERVAL_MS);
      }
      if ((msg as any).type === "auth_fail") {
        cameraLog("error", "ws", `Auth FAILED — reason=${(msg as any).reason ?? "wrong PIN"}`);
        ws.close();
        return;
      }

      // Server-relayed log entries
      if ((msg as any).type === "camera_log") {
        cameraLog((msg as any).level ?? "info", "server", (msg as any).msg ?? "");
        return;
      }

      onMessage(msg);
    };

    ws.onclose = (ev) => {
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      const delay = Math.round(backoffRef.current / 1000);
      cameraLog("warn", "ws", `Socket closed (code=${ev.code}) — reconnecting in ${delay}s`);
      onDisconnected?.();
      if (!mountedRef.current) return;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(() => {
        backoffRef.current = Math.min(backoffRef.current * BACKOFF_FACTOR, MAX_BACKOFF_MS);
        connect();
      }, backoffRef.current);
    };

    ws.onerror = (ev) => {
      cameraLog("error", "ws", `Socket error — check that the server is running and the TLS cert is trusted`);
      ws.close();
    };
  }, [pin, clientType, onMessage, onConnected, onDisconnected]);

  const disconnect = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (pingTimerRef.current) clearInterval(pingTimerRef.current);
    wsRef.current?.close();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (pin) connect();
    return () => {
      mountedRef.current = false;
      disconnect();
    };
  }, [pin, connect, disconnect]);

  return { send, wsRef };
}
