import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RemoteCommandResult,
  RemoteCommandType,
  RemoteControllerState,
  RemoteEvent,
  RemoteSnapshot,
} from "../types/remote";
import type { DisplayItem, ServiceMeta } from "../types/display";
import { isRemoteCommandResult, isRemoteEvent } from "../types/remote";

const LS_DEVICE_TOKEN = "wordlyte.remote.token";
const LS_DEVICE_NAME = "wordlyte.remote.name";

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
  "song.stage",
  "song.go_live",
  "lower_third.show",
  "lower_third.hide",
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
    case "controller.changed":
      next.controller_state = p.controller_state as RemoteControllerState;
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
        // Authentication/pairing failure — reject any in-flight pair and
        // drop the stored token so the device re-pairs.
        const pair = pairRef.current;
        pairRef.current = null;
        if (pair) pair.reject(new Error(result.error?.message ?? "Authentication failed"));
        localStorage.removeItem(LS_DEVICE_TOKEN);
        setConn("pairing");
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
          setConn("connected");
          setSnapshot(snap);
        }
        return;
      }
      setSnapshot((prev) => (prev ? applyEvent(prev, event) : prev));
    }
  }, []);

  const connect = useCallback(() => {
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
      }
    };
  }, [handleMessage, closeAllPending]);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

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
      const command_id = crypto.randomUUID();
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
      pendingRef.current.set(command_id, { resolve: resolve as (v: unknown) => void, reject, timer });
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