import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export type CameraStreamError = "permission" | "device" | "unknown" | null;

interface LocalEntry {
  stream: MediaStream | null;
  error: CameraStreamError;
}

const EMPTY: LocalEntry = { stream: null, error: null };
const entries = new Map<string, LocalEntry>();
const consumers = new Map<string, Set<string>>();
const listeners = new Map<string, Set<() => void>>();

function notify(deviceId: string) {
  listeners.get(deviceId)?.forEach((cb) => cb());
}

function subscribe(deviceId: string, cb: () => void) {
  let set = listeners.get(deviceId);
  if (!set) {
    set = new Set();
    listeners.set(deviceId, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(deviceId);
  };
}

function getSnapshot(deviceId: string): LocalEntry {
  return entries.get(deviceId) ?? EMPTY;
}

function mapError(err: unknown): CameraStreamError {
  const name = (err as DOMException)?.name ?? "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "permission";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "device";
  return "unknown";
}

/**
 * App-wide, ref-counted cache of local camera streams so multiple surfaces
 * (the Camera tab preview, the A/B switcher, the All Camera Feeds grid) open a
 * single `getUserMedia` per device instead of one per tile. The stream is
 * opened on first consumer, closed when the last consumer unmounts, and can be
 * re-opened on demand via `retry`.
 *
 * Phone cameras are relayed over WebRTC and never open getUserMedia here, so
 * passing a `phone-camera-*` id yields a null stream.
 */
export function useSharedLocalCameraStream(
  deviceId: string | null | undefined,
  consumerId: string
): { stream: MediaStream | null; error: CameraStreamError; connected: boolean; retry: () => void } {
  const isPhone = deviceId?.startsWith("phone-camera-") ?? false;
  const key = isPhone ? null : deviceId ?? null;

  const subscribeCb = useCallback((cb: () => void) => subscribe(key ?? "", cb), [key]);
  const getSnapshotCb = useCallback(() => getSnapshot(key ?? ""), [key]);
  const snapshot = useSyncExternalStore(subscribeCb, getSnapshotCb);

  const [refreshToken, setRefreshToken] = useState(0);
  const retry = useCallback(() => {
    if (key) {
      const old = entries.get(key);
      entries.delete(key);
      old?.stream?.getTracks().forEach((t) => t.stop());
    }
    setRefreshToken((x) => x + 1);
  }, [key]);

  useEffect(() => {
    if (!key) return;
    const set = consumers.get(key) ?? new Set<string>();
    set.add(consumerId);
    consumers.set(key, set);

    if (!entries.has(key)) {
      entries.set(key, EMPTY);
      navigator.mediaDevices
        .getUserMedia({ video: { deviceId: { exact: key } } })
        .then((s) => {
          // Drop the stream if every consumer vanished while it was opening.
          if ((consumers.get(key)?.size ?? 0) === 0) {
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          entries.set(key, { stream: s, error: null });
          notify(key);
        })
        .catch((err) => {
          if ((consumers.get(key)?.size ?? 0) === 0) return;
          entries.set(key, { stream: null, error: mapError(err) });
          notify(key);
        });
    }

    return () => {
      const set2 = consumers.get(key);
      if (!set2) return;
      set2.delete(consumerId);
      if (set2.size === 0) {
        consumers.delete(key);
        entries.get(key)?.stream?.getTracks().forEach((t) => t.stop());
        entries.delete(key);
        notify(key);
      }
    };
  }, [key, consumerId, refreshToken]);

  return { stream: snapshot.stream, error: snapshot.error, connected: !!snapshot.stream, retry };
}
