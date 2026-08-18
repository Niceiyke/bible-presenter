import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  acquireSource,
  describeSourceError,
  getSourceSnapshot,
  releaseSource,
  retrySource,
  subscribeSource,
  resolveSourceKind,
  type SourceState,
  type SourceStatus,
} from "../system/sourceRegistry";

const IDLE: SourceState = {
  deviceId: "",
  kind: "local",
  stream: null,
  status: "idle",
  errorKind: null,
};

/**
 * Unified camera source hook (Phase 5). Returns one consistent
 * `{ stream, status, error, isPhone, retry }` for ANY camera source — local
 * webcams (opened once via the shared source registry, never duplicated), phone
 * cameras (relayed over WebRTC and registered by the phone host), and future
 * `native:`/`ndi:` capture devices (reserved; never opened here).
 *
 * Consumers no longer branch on a `phone-camera-` prefix to know how to get a
 * stream or what state the source is in — the registry owns the lifecycle and
 * this hook surfaces it uniformly. Synthetic phone/native/ndi ids are never
 * sent to `getUserMedia`.
 */
export function useCameraSource(
  deviceId: string | null | undefined,
  consumerId: string
): {
  stream: MediaStream | null;
  status: SourceStatus;
  error: string | null;
  isPhone: boolean;
  retry: () => void;
} {
  const key = deviceId ?? null;
  const isPhone = key ? resolveSourceKind(key) === "phone" : false;

  const subscribeCb = useCallback((cb: () => void) => subscribeSource(key ?? "", cb), [key]);
  const getSnapshotCb = useCallback(
    () => getSourceSnapshot(key ?? "") ?? { ...IDLE, deviceId: key ?? "" },
    [key]
  );
  const snapshot = useSyncExternalStore(subscribeCb, getSnapshotCb);

  // Local cameras are acquired (ref-counted) by this consumer. Phone sources
  // are registered by the WebRTC host; native/ndi are reserved.
  useEffect(() => {
    if (!key || isPhone || resolveSourceKind(key) !== "local") return;
    acquireSource(key, consumerId);
    return () => releaseSource(key, consumerId);
  }, [key, isPhone, consumerId]);

  const retry = useCallback(() => {
    if (key && !isPhone && resolveSourceKind(key) === "local") retrySource(key);
  }, [key, isPhone]);

  return {
    stream: snapshot.stream,
    status: snapshot.status,
    error: describeSourceError(snapshot.errorKind),
    isPhone,
    retry,
  };
}

/**
 * Lightweight, non-acquiring view of a source's unified status (for pickers /
 * lists that must not open every camera). Read-only — never calls
 * `getUserMedia`.
 */
export function useSourceStatus(deviceId: string | null | undefined): SourceStatus {
  const key = deviceId ?? null;
  const subscribeCb = useCallback((cb: () => void) => subscribeSource(key ?? "", cb), [key]);
  const getSnapshotCb = useCallback(
    () => getSourceSnapshot(key ?? "")?.status ?? "idle",
    [key]
  );
  return useSyncExternalStore(subscribeCb, getSnapshotCb);
}
