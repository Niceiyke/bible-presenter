import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  acquireSource,
  getAllSourceStreams,
  getSourceSnapshot,
  releaseSource,
  retrySource,
  subscribeAllSources,
  subscribeSource,
  resolveSourceKind,
  type SourceState,
  type SourceStatus,
} from "../system/sourceRegistry";

export type CameraStreamError = "permission" | "device" | "unknown" | null;

const EMPTY: SourceState = {
  deviceId: "",
  kind: "local",
  stream: null,
  status: "idle",
  errorKind: null,
};

/**
 * App-wide, ref-counted cache of local camera streams so multiple surfaces
 * (the Camera tab preview, the A/B switcher, the All Camera Feeds grid, scene
 * zones, the compositor) open a single `getUserMedia` per device instead of one
 * per tile. Backed by the Phase 5 source registry; the stream is opened on
 * first consumer, closed when the last consumer unmounts, auto-reconnects once
 * on device loss, and can be re-opened on demand via `retry`.
 *
 * Phone cameras are relayed over WebRTC and never open `getUserMedia` here, so
 * passing a `phone-camera-*` id yields a null stream (use `useCameraSource` for
 * the unified phone+local view).
 */
export function useSharedLocalCameraStream(
  deviceId: string | null | undefined,
  consumerId: string
): {
  stream: MediaStream | null;
  error: CameraStreamError;
  connected: boolean;
  status: SourceStatus;
  retry: () => void;
} {
  const key = deviceId && resolveSourceKind(deviceId) === "local" ? deviceId : null;

  const subscribeCb = useCallback(
    (cb: () => void) => subscribeSource(key ?? "", cb),
    [key]
  );
  const getSnapshotCb = useCallback(
    () => getSourceSnapshot(key ?? "") ?? EMPTY,
    [key]
  );
  const snapshot = useSyncExternalStore(subscribeCb, getSnapshotCb);

  useEffect(() => {
    if (!key) return;
    acquireSource(key, consumerId);
    return () => releaseSource(key, consumerId);
  }, [key, consumerId]);

  const retry = useCallback(() => {
    if (key) retrySource(key);
  }, [key]);

  return {
    stream: snapshot.stream,
    error: snapshot.errorKind,
    connected: snapshot.status === "connected",
    status: snapshot.status,
    retry,
  };
}

/**
 * Bulk variant for the compositor: opens every local camera device id
 * referenced by the live program and returns a map of currently-available
 * streams (ref-counted against `consumerId`, snapshotted via the registry's
 * all-sources cache). Phone cameras are excluded here — their streams come
 * from the WebRTC relay and are merged by the caller.
 */
export function useSharedLocalCameraStreams(
  deviceIds: string[],
  consumerId: string
): Record<string, MediaStream> {
  const ids = [...new Set(deviceIds.filter((id) => id && resolveSourceKind(id) === "local"))];
  const key = ids.join("|");

  const subscribeCb = useCallback((cb: () => void) => subscribeAllSources(cb), []);
  const snapshot = useSyncExternalStore(subscribeCb, getAllSourceStreams, getAllSourceStreams);

  useEffect(() => {
    for (const id of ids) {
      acquireSource(id, consumerId);
    }
    return () => {
      for (const id of ids) {
        releaseSource(id, consumerId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, consumerId]);

  return snapshot;
}
