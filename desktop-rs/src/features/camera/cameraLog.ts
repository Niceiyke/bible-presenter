/**
 * Lightweight camera event log — shared across all camera hooks.
 *
 * Module-level pub/sub so any hook or component can write to the log
 * and any component can subscribe without prop-drilling.
 */
import { useEffect, useState, useCallback } from "react";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface CameraLogEntry {
  id: number;
  ts: number;        // Date.now()
  level: LogLevel;
  source: string;    // "ws" | "publisher" | "relay" | "manager" | "server" | "mobile"
  msg: string;
}

let _entries: CameraLogEntry[] = [];
let _idCounter = 0;
const _listeners = new Set<() => void>();
const MAX_ENTRIES = 500;

/** Write a log entry — callable from any module (no React context needed). */
export function cameraLog(level: LogLevel, source: string, msg: string): void {
  const entry: CameraLogEntry = { id: _idCounter++, ts: Date.now(), level, source, msg };
  _entries = [..._entries.slice(-(MAX_ENTRIES - 1)), entry];
  _listeners.forEach(fn => fn());
}

/** React hook — returns live entries and a clear function. */
export function useCameraLog() {
  const [entries, setEntries] = useState<CameraLogEntry[]>(_entries);

  useEffect(() => {
    const update = () => setEntries([..._entries]);
    _listeners.add(update);
    return () => { _listeners.delete(update); };
  }, []);

  const clear = useCallback(() => {
    _entries = [];
    _listeners.forEach(fn => fn());
  }, []);

  return { entries, clear };
}
