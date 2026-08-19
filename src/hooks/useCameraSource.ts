import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  acquireSource,
  describeSourceError,
  getSourceSnapshot,
  releaseSource,
  retrySource,
  subscribeSource,
  resolveSourceKind,
  CAPTURE_1080P,
  entryKey,
  type CaptureQuality,
  type SourceState,
  type SourceStatus,
} from "../system/sourceRegistry";

const IDLE: SourceState = {
  deviceId: "",
  kind: "local",
  stream: null,
  status: "idle",
  errorKind: null,
  quality: CAPTURE_1080P,
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
  consumerId: string,
  quality: CaptureQuality = CAPTURE_1080P
): {
  stream: MediaStream | null;
  status: SourceStatus;
  error: string | null;
  isPhone: boolean;
  retry: () => void;
} {
  const isPhone = deviceId ? resolveSourceKind(deviceId) === "phone" : false;
  // Local sources are keyed by deviceId + quality (a device can be open at
  // 1080p and 720p at once); phone/native/ndi sources stay keyed by the bare id.
  const key = deviceId ? (resolveSourceKind(deviceId) === "local" ? entryKey(deviceId, quality) : deviceId) : null;

  const subscribeCb = useCallback((cb: () => void) => subscribeSource(key ?? "", cb), [key]);
  // STABLE fallback snapshot while a source is unregistered. `useSyncExternalStore`
  // re-reads this on every render and compares with Object.is — a freshly
  // allocated object would appear "changed" forever and loop (React error #185).
  const fallbackRef = useRef<SourceState | null>(null);
  const getSnapshotCb = useCallback(() => {
    const s = getSourceSnapshot(key ?? "");
    if (s) return s;
    if (
      !fallbackRef.current ||
      fallbackRef.current.deviceId !== (deviceId ?? "") ||
      fallbackRef.current.quality !== quality
    ) {
      fallbackRef.current = { ...IDLE, deviceId: deviceId ?? "", quality };
    }
    return fallbackRef.current;
  }, [key, deviceId, quality]);
  const snapshot = useSyncExternalStore(subscribeCb, getSnapshotCb);

  // Local cameras are acquired (ref-counted) by this consumer. Phone sources
  // are registered by the WebRTC host; native/ndi are reserved.
  useEffect(() => {
    if (!key || isPhone || resolveSourceKind(deviceId!) !== "local") return;
    acquireSource(deviceId!, consumerId, quality);
    return () => releaseSource(deviceId!, consumerId, quality);
  }, [key, isPhone, consumerId, quality, deviceId]);

  const retry = useCallback(() => {
    if (deviceId && !isPhone && resolveSourceKind(deviceId) === "local") retrySource(deviceId, quality);
  }, [deviceId, isPhone, quality]);

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
