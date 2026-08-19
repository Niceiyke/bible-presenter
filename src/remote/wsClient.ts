import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RemoteCommandResult,
  RemoteCommandType,
  RemoteControllerState,
  RemoteEvent,
  RemotePermissions,
  RemoteRole,
  RemoteSnapshot,
} from "../types/remote";
import type { DisplayItem, ServiceMeta } from "../types/display";
import { isRemoteCommandResult, isRemoteEvent } from "../types/remote";

const LS_DEVICE_TOKEN = "wordlyte.remote.token";
const LS_DEVICE_NAME = "wordlyte.remote.name";

// The remote app is served over plain HTTP on the LAN, which is not a secure
// context, so `crypto.randomUUID` is unavailable there. Generate a v4 UUID
// from `crypto.getRandomValues` (also unavailable in very old engines) with a
// last-resort Math.random fallback.
function makeUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  const fallback = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
  return fallback.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const MUTATING = new Set<RemoteCommandType>([
  "remote.request_control",
  "remote.release_control",
  "remote.renew_lease",
  "bible.stage",
  "bible.go_live",
  "bible.stage_next",
  "bible.go_live_next",
  "bible.stage_previous",
  "bible.go_live_previous",
  "bible.add_to_service",
  "display.go_live",
  "display.stage_next",
  "display.stage_previous",
  "display.clear_live",
  "display.clear_all",
  "display.blackout",
  "display.logo_toggle",
  "timer.stage",
  "timer.go_live",
  "timer.toggle",
  "studio.stage",
  "studio.go_live",
  "song.stage",
  "song.go_live",
  "lower_third.show",
  "lower_third.hide",
  "camera.start",
  "camera.stop",
  // `camera.offer`, `camera.answer`, and `camera.ice` are WebRTC signaling
  // relays — they never touch authoritative state, so they are deliberately
  // NOT mutating. Attaching a stale `expected_revision` to them would make a
  // session fail mid-handshake whenever the local snapshot went stale, and
  // they must not be throttled like content mutations either.
]);

export type RemoteConnState = "connecting" | "pairing" | "connected" | "error";

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

export function storedToken(): string | null {
  return localStorage.getItem(LS_DEVICE_TOKEN);
}

export function storedName(): string {
  return localStorage.getItem(LS_DEVICE_NAME) ?? "";
}

/** Short physical tap on mutating actions (phones only). No-op where the
 *  Vibration API is unavailable. */
function buzz() {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(20);
    }
  } catch {
    /* ignore */
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: number;
}

function isSnapshot(value: unknown): value is RemoteSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RemoteSnapshot).revision === "number"
  );
}

/** Keeps the local snapshot optimistically in sync with hub events. */
function applyEvent(snapshot: RemoteSnapshot, event: RemoteEvent): RemoteSnapshot {
  const p = event.payload as Record<string, unknown>;
  const next: RemoteSnapshot = { ...snapshot, revision: event.revision };
  switch (event.kind) {
    case "snapshot":
      return isSnapshot(p) ? p : next;
    case "live.changed":
      next.live_item = (p.live_item as DisplayItem | null) ?? null;
      return next;
    case "staged.changed":
      next.staged_item = (p.staged_item as DisplayItem | null) ?? null;
      return next;
    case "schedule.changed":
      next.active_service = (p.active_service as ServiceMeta | null) ?? null;
      next.schedule_entries = Array.isArray(p.entries) ? (p.entries as RemoteSnapshot["schedule_entries"]) : next.schedule_entries;
      return next;
    case "lower_third.changed":
      next.lower_third = (p.lower_third as unknown) ?? null;
      return next;
    case "output.changed":
      next.output_visible = Boolean(p.output_visible);
      return next;
    case "blackout.changed":
      next.blackout = Boolean(p.blackout);
      return next;
    case "logo.changed":
      next.background_logo = Boolean(p.logo);
      return next;
    case "controller.changed":
      next.controller_state = p.controller_state as RemoteControllerState;
      return next;
    case "permissions.changed":
      // A revoked / permission-reduced client updates its role + permissions
      // immediately without reconnecting (Phase 10).
      if (typeof p.role === "string") next.role = p.role as RemoteRole;
      if (p.permissions && typeof p.permissions === "object") {
        next.permissions = p.permissions as RemotePermissions;
      }
      return next;
    default:
      return next;
  }
}

export interface UseRemote {
  conn: RemoteConnState;
  err: string | null;
  snapshot: RemoteSnapshot | null;
  selfId: string | null;
  selfName: string;
  controllerState: RemoteControllerState | null;
  isHeldBySelf: boolean;
  pair: (code: string, name: string) => Promise<void>;
  command: <T = unknown>(type: RemoteCommandType, payload?: unknown) => Promise<T>;
  requestControl: () => Promise<RemoteControllerState>;
  releaseControl: () => Promise<RemoteControllerState>;
  connect: () => void;
  forgetDevice: () => void;
}

export function useRemote(): UseRemote {
  const [conn, setConn] = useState<RemoteConnState>("connecting");
  const [err, setErr] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<RemoteSnapshot | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [selfName, setSelfName] = useState<string>(storedName());

  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<Map<string, Pending>>(new Map());
  const revisionRef = useRef<number | null>(null);
  const connectedRef = useRef(false);
  const pairRef = useRef<{ resolve: () => void; reject: (e: Error) => void } | null>(null);
  // `connect` is defined below, but the message handler must be able to reopen
  // the socket when authentication fails. Keep a ref instead of closing over
  // `connect` to avoid a stale/recursive callback.
  const connectRef = useRef<() => void>(() => {});
  // Handle for the pending auto-reconnect timer (exponential backoff).
  const reconnectTimerRef = useRef<number | null>(null);
  // Consecutive failed reconnect attempts; drives the backoff schedule.
  const retryRef = useRef(0);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // Schedules a single reconnect attempt with exponential backoff (1s, 2s, 4s,
  // … capped at 30s). At most one timer is pending at a time. The attempt
  // counter is reset whenever a snapshot arrives (see handleMessage), so
  // steady connections never grow the backoff.
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current != null) return;
    const attempt = retryRef.current++;
    const delay = Math.min(1000 * 2 ** attempt, 30000);
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      connectRef.current();
    }, delay);
  }, []);

  const closeAllPending = useCallback((e: Error) => {
    for (const [, p] of pendingRef.current) {
      window.clearTimeout(p.timer);
      p.reject(e);
    }
    pendingRef.current.clear();
  }, []);

  const handleMessage = useCallback((data: string) => {
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (isRemoteCommandResult(msg)) {
      const result: RemoteCommandResult = msg;
      revisionRef.current = result.revision;
      if (result.command_id === "pair") {
        const pair = pairRef.current;
        pairRef.current = null;
        if (result.ok && result.result) {
          const r = result.result as { device_token?: string; device_id?: string };
          if (r.device_token) localStorage.setItem(LS_DEVICE_TOKEN, r.device_token);
          if (r.device_id) setSelfId(r.device_id);
          if (pair) pair.resolve();
          setConn("connected");
        } else {
          if (pair) pair.reject(new Error(result.error?.message ?? "Pairing failed"));
          setConn("pairing");
        }
        return;
      }
      if (result.command_id === "handshake") {
        // Authentication/pairing failure. The server closes the connection
        // right after this, so handle the transition here rather than letting
        // `onclose` flip to a generic error.
        //
        // Only an explicit "this token is dead" response may clear the stored
        // token. Pairing-code rejections, throttling, and handshake timeouts
        // must never wipe a still-valid device token, or a transient hiccup
        // would force the user to re-pair.
        const pair = pairRef.current;
        pairRef.current = null;
        const message = result.error?.message ?? "Authentication failed";
        if (pair) pair.reject(new Error(message));
        const code = result.error?.code ?? "";
        if (code === "unknown_token" || code === "revoked") {
          localStorage.removeItem(LS_DEVICE_TOKEN);
          setSelfId(null);
          setConn("pairing");
          // Reopen so the pairing screen has a live socket. With no stored
          // token the fresh socket cannot re-trigger a rejected handshake,
          // so this is a single transition, not a reconnect loop.
          connectRef.current();
        } else if (!pair && storedToken()) {
          // Transient auth failure (e.g. handshake_timeout/rate_limited) that
          // leaves a still-valid token intact — keep it, surface the error,
          // and let the backoff reconnect retry authentication automatically.
          setErr(message);
          setConn("error");
        } else {
          // Pairing-code rejection while pairing — no token is involved.
          // Keep the pairing screen and reopen so the user can retry.
          setConn("pairing");
          connectRef.current();
        }
        return;
      }
      const pending = pendingRef.current.get(result.command_id);
      if (pending) {
        window.clearTimeout(pending.timer);
        pendingRef.current.delete(result.command_id);
        if (result.ok) pending.resolve(result.result);
        else pending.reject(new Error(result.error?.message ?? result.error?.code ?? "Command failed"));
      }
      return;
    }

    if (isRemoteEvent(msg)) {
      const event: RemoteEvent = msg;
      revisionRef.current = event.revision;
      if (event.kind === "snapshot") {
        const snap = event.payload as unknown;
        if (isSnapshot(snap)) {
          retryRef.current = 0;
          setConn("connected");
          setSnapshot(snap);
          // Restore the device identity on reload/reconnect. Only the pairing
          // response sets `selfId`; after re-authenticating with a stored
          // token the server identifies us in the snapshot's
          // `controller_device_id`, and without it `isHeldBySelf` can never
          // match `controller_state.device_id` — controller-gated actions
          // (e.g. Start Camera) stay silently disabled.
          if (snap.controller_device_id) setSelfId(snap.controller_device_id);
        }
        return;
      }
      // Camera relay events (operator answer / ICE) are delivered to the
      // phone's peer-connection panels via window postMessage, which the
      // CameraPanel/usePhoneCamera components subscribe to.
      if (event.kind === "camera.answer" || event.kind === "camera.ice") {
        console.log("[phone-camera] received relay event", event.kind, "for", (event.payload as { device_id?: string })?.device_id, "target", (event.payload as { target?: string })?.target);
        window.postMessage(JSON.stringify({ kind: event.kind, payload: event.payload }), "*");
        return;
      }
      setSnapshot((prev) => (prev ? applyEvent(prev, event) : prev));
    }
  }, []);

  const connect = useCallback(() => {
    clearReconnectTimer();
    connectedRef.current = false;
    setConn("connecting");
    setErr(null);
    closeAllPending(new Error("Reconnect"));

    const ws = new WebSocket(wsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      const token = storedToken();
      if (token) {
        ws.send(JSON.stringify({ command_id: "authenticate", type: "remote.authenticate", payload: { device_token: token } }));
      } else {
        setSelfId(null);
        setConn("pairing");
      }
    };
    ws.onmessage = (e) => handleMessage(String(e.data));
    ws.onerror = () => setErr("Connection failed");
    ws.onclose = () => {
      if (wsRef.current === ws) {
        connectedRef.current = false;
        closeAllPending(new Error("Connection closed"));
        setConn("error");
        // Auto-reconnect with backoff after an unexpected drop (the server's
        // watchdog, flaky Wi-Fi, an app restart). Only when a token is stored
        // — on the pairing screen there's nothing to authenticate, so wait for
        // the user to retry instead of churning connections.
        if (storedToken()) scheduleReconnect();
      }
    };
  }, [handleMessage, closeAllPending, clearReconnectTimer, scheduleReconnect]);

  connectRef.current = connect;

  useEffect(() => {
    connect();
    return () => {
      clearReconnectTimer();
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect, clearReconnectTimer]);

  const pair = useCallback(
    (code: string, name: string) =>
      new Promise<void>((resolve, reject) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error("Not connected"));
          return;
        }
        const cleanName = name.trim();
        pairRef.current = { resolve, reject };
        localStorage.setItem(LS_DEVICE_NAME, cleanName);
        setSelfName(cleanName);
        setErr(null);
        ws.send(JSON.stringify({ command_id: "pair", type: "remote.pair", payload: { pairing_token: code.trim(), device_name: cleanName } }));
      }),
    []
  );

  const command = useCallback(<T,>(type: RemoteCommandType, payload?: unknown): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }
      const command_id = makeUuid();
      const mutating = MUTATING.has(type);
      const cmd: Record<string, unknown> = { command_id, type };
      if (payload !== undefined) cmd.payload = payload;
      if (mutating && revisionRef.current != null) cmd.expected_revision = revisionRef.current;
      else if (mutating) cmd.expected_revision = 0;
      ws.send(JSON.stringify(cmd));
      const timer = window.setTimeout(() => {
        pendingRef.current.delete(command_id);
        reject(new Error("Command timed out"));
      }, 15000);
      pendingRef.current.set(command_id, {
        resolve: (value: unknown) => {
          if (mutating) buzz();
          resolve(value as T);
        },
        reject,
        timer,
      });
    });
  }, []);

  const requestControl = useCallback(async (): Promise<RemoteControllerState> => {
    const state = await command<{ controller_state: RemoteControllerState }>("remote.request_control");
    return state.controller_state;
  }, [command]);

  const releaseControl = useCallback(async (): Promise<RemoteControllerState> => {
    await command("remote.release_control");
    return { kind: "viewing" };
  }, [command]);

  const forgetDevice = useCallback(() => {
    localStorage.removeItem(LS_DEVICE_TOKEN);
    localStorage.removeItem(LS_DEVICE_NAME);
    setSelfId(null);
    setSelfName("");
    connect();
  }, [connect]);

  const controllerState = snapshot?.controller_state ?? null;
  const isHeldBySelf = controllerState?.kind === "held" && controllerState.device_id != null && controllerState.device_id === selfId;

  return {
    conn,
    err,
    snapshot,
    selfId,
    selfName,
    controllerState,
    isHeldBySelf,
    pair,
    command,
    requestControl,
    releaseControl,
    connect,
    forgetDevice,
  };
}