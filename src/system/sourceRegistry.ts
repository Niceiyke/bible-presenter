/**
 * `sourceRegistry` — the Phase 5 source registry and camera lifecycle model.
 *
 * A single app-wide, per-device registry that unifies camera sources across
 * local webcams, phone cameras (relayed over WebRTC), and future capture
 * devices. Every source resolves to a `SourceState` carrying a unified
 * `SourceStatus`, so previews, scene zones, projection, recording, and
 * streaming can render a consistent status and a safe fallback without each
 * consumer re-deriving device lifecycle.
 *
 * Local cameras are the only sources this module *opens* (`getUserMedia`) — and
 * it opens each device once, ref-counted across every consumer, so a camera is
 * shared rather than duplicated. Phone cameras are *registered* here by the
 * WebRTC host (signaling stays separate); synthetic `phone-camera-`/`native:`/
 * `ndi:` ids are never sent to `getUserMedia`.
 *
 * The registry is an external store: consumers subscribe via
 * `useSyncExternalStore` (`subscribeSource`/`getSourceSnapshot`) or the
 * React hooks in `src/hooks/useCameraSource.ts`.
 */

export type SourceStatus =
  /** Known (enumerated or registered) but not requested. */
  | "idle"
  /** Acquiring the stream. */
  | "opening"
  /** Stream is available. */
  | "connected"
  /** Acquisition failed (permission/device/unknown). */
  | "error"
  /** Lost the stream; auto-retrying. */
  | "reconnecting"
  /** Lost the stream and not retrying. */
  | "disconnected";

/** Future-compatible capture-device interface. Only `local` opens the browser
 *  camera today; `phone` is relayed, and `native`/`ndi` are reserved. */
export type SourceKind = "local" | "phone" | "native" | "ndi";

/** Coarse, machine-readable error class (mirrors `CameraStreamError`). */
export type SourceErrorKind = "permission" | "device" | "unknown";

export interface SourceState {
  deviceId: string;
  kind: SourceKind;
  stream: MediaStream | null;
  status: SourceStatus;
  errorKind: SourceErrorKind | null;
}

export function describeSourceError(kind: SourceErrorKind | null): string | null {
  if (kind === "permission") return "Camera permission denied.";
  if (kind === "device") return "Camera unavailable or in use.";
  if (kind === "unknown") return "Could not open the camera.";
  return null;
}

/** Classify a `getUserMedia` rejection into a coarse error kind. */
export function mapSourceError(err: unknown): SourceErrorKind {
  const name = (err as DOMException)?.name ?? "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "permission";
  }
  if (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    name === "OverconstrainedError" ||
    name === "NotReadableError" ||
    name === "AbortError"
  ) {
    return "device";
  }
  return "unknown";
}

/** Map a device id to its source kind. Never opens non-local devices. */
export function resolveSourceKind(deviceId: string): SourceKind {
  if (deviceId.startsWith("phone-camera-")) return "phone";
  if (deviceId.startsWith("native:")) return "native";
  if (deviceId.startsWith("ndi:")) return "ndi";
  return "local";
}

export const isPhoneSource = (deviceId: string) => resolveSourceKind(deviceId) === "phone";

interface InternalEntry {
  state: SourceState;
  /** Consumers holding an open local stream (ref count). */
  consumers: Set<string>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, InternalEntry>();
const listeners = new Map<string, Set<() => void>>();
const allListeners = new Set<() => void>();
let allSnapshot: Record<string, MediaStream> = {};

function notify(deviceId: string) {
  listeners.get(deviceId)?.forEach((cb) => cb());
  notifyAll();
}

function notifyAll() {
  const next: Record<string, MediaStream> = {};
  for (const entry of entries.values()) {
    if (entry.state.stream) next[entry.state.deviceId] = entry.state.stream;
  }
  allSnapshot = next;
  allListeners.forEach((cb) => cb());
}

export function subscribeSource(deviceId: string, cb: () => void): () => void {
  let set = listeners.get(deviceId);
  if (!set) {
    set = new Set();
    listeners.set(deviceId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(deviceId);
  };
}

export function subscribeAllSources(cb: () => void): () => void {
  allListeners.add(cb);
  return () => {
    allListeners.delete(cb);
  };
}

/** Stable snapshot reference for a device (unchanged until its state changes). */
export function getSourceSnapshot(deviceId: string): SourceState | null {
  return entries.get(deviceId)?.state ?? null;
}

/** Map of currently-connected streams (used by the bulk compositor path). */
export function getAllSourceStreams(): Record<string, MediaStream> {
  return allSnapshot;
}

function setState(deviceId: string, patch: Partial<SourceState>): void {
  const entry = entries.get(deviceId);
  if (!entry) return;
  const next = { ...entry.state, ...patch };
  entry.state = next;
  notify(deviceId);
}

function stopStream(state: SourceState): void {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
  }
}

function clearEntry(deviceId: string): void {
  const entry = entries.get(deviceId);
  if (!entry) return;
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  stopStream(entry.state);
  entries.delete(deviceId);
  notify(deviceId);
}

/** Open a local camera once; the track's `ended` fires a bounded reconnect. */
function openLocal(deviceId: string): void {
  const entry = entries.get(deviceId);
  if (!entry) return;
  setState(deviceId, { status: "opening", stream: null, errorKind: null });
  navigator.mediaDevices
    .getUserMedia({ video: { deviceId: { exact: deviceId } } })
    .then((stream) => {
      const current = entries.get(deviceId);
      // Drop the stream if every consumer vanished while it was opening.
      if (!current || current.consumers.size === 0) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      // React to a device being unplugged / track ending with one auto-retry.
      stream.getVideoTracks().forEach((track) => {
        track.onended = () => {
          const live = entries.get(deviceId);
          if (!live || live.consumers.size === 0) return;
          stopStream(live.state);
          setState(deviceId, { stream: null, status: "reconnecting", errorKind: null });
          live.reconnectTimer = setTimeout(() => openLocal(deviceId), 750);
        };
      });
      setState(deviceId, { stream, status: "connected", errorKind: null });
      notifyAll();
    })
    .catch((err) => {
      const current = entries.get(deviceId);
      if (!current || current.consumers.size === 0) return;
      setState(deviceId, { stream: null, status: "error", errorKind: mapSourceError(err) });
    });
}

/**
 * Acquire a local camera for a consumer. The device is opened once (ref-counted);
 * when the last consumer releases it the stream is closed. Phone/native/ndi ids
 * are ignored for acquisition.
 */
export function acquireSource(deviceId: string, consumerId: string): void {
  const kind = resolveSourceKind(deviceId);
  if (kind !== "local") return;
  let entry = entries.get(deviceId);
  if (!entry) {
    entry = {
      state: { deviceId, kind, stream: null, status: "idle", errorKind: null },
      consumers: new Set(),
    };
    entries.set(deviceId, entry);
  }
  entry.consumers.add(consumerId);
  if (entry.state.status === "idle") {
    openLocal(deviceId);
  }
  notify(deviceId);
}

/** Release a consumer's hold on a local camera; closes it when the last one
 *  leaves, so a camera is never left open when nothing is watching it. */
export function releaseSource(deviceId: string, consumerId: string): void {
  const kind = resolveSourceKind(deviceId);
  if (kind !== "local") return;
  const entry = entries.get(deviceId);
  if (!entry) return;
  entry.consumers.delete(consumerId);
  if (entry.consumers.size === 0) {
    clearEntry(deviceId);
  } else {
    notify(deviceId);
  }
}

/** Explicit re-open after a permission denial / device loss. */
export function retrySource(deviceId: string): void {
  if (resolveSourceKind(deviceId) !== "local") return;
  let entry = entries.get(deviceId);
  if (!entry) {
    entry = {
      state: { deviceId, kind: "local", stream: null, status: "idle", errorKind: null },
      consumers: new Set(),
    };
    entries.set(deviceId, entry);
  }
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = undefined;
  }
  openLocal(deviceId);
}

/**
 * Register a phone camera's stream + status (called by the WebRTC host; phone
 * signaling stays separate from local acquisition). Passing `null` stream with
 * a status marks the phone source's connectivity without a live feed.
 */
export function setPhoneSource(
  deviceId: string,
  stream: MediaStream | null,
  status: SourceStatus,
  errorKind?: SourceErrorKind
): void {
  if (resolveSourceKind(deviceId) !== "phone") return;
  let entry = entries.get(deviceId);
  if (!entry) {
    entry = {
      state: { deviceId, kind: "phone", stream: null, status: "idle", errorKind: null },
      consumers: new Set(),
    };
    entries.set(deviceId, entry);
  }
  if (entry.state.stream && entry.state.stream !== stream) {
    entry.state.stream.getTracks().forEach((t) => t.stop());
  }
  setState(deviceId, {
    stream,
    status,
    errorKind: errorKind ?? null,
  });
}

/** Remove a phone source (peer torn down / device disconnected). */
export function removePhoneSource(deviceId: string): void {
  if (resolveSourceKind(deviceId) !== "phone") return;
  clearEntry(deviceId);
}

/** Map a WebRTC peer-connection state onto the unified source status. */
export function phoneStatusFromConnection(state: RTCPeerConnectionState): SourceStatus {
  switch (state) {
    case "connected":
      return "connected";
    case "connecting":
    case "new":
      return "opening";
    case "disconnected":
      return "reconnecting";
    case "failed":
      return "error";
    case "closed":
      return "disconnected";
    default:
      return "idle";
  }
}

/** For tests: reset the module-level registry. */
export function resetSourceRegistry(): void {
  for (const entry of entries.values()) {
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    stopStream(entry.state);
  }
  entries.clear();
  listeners.clear();
  allListeners.clear();
  allSnapshot = {};
}
