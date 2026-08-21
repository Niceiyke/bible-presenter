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

import { webviewDeviceIdForEngineName } from "./cameraNames";

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
  /** Capture resolution/fps this entry was opened at (local sources only). */
  quality: CaptureQuality;
}

/** Capture resolution/fps for a local source. `getUserMedia` honors these as
 *  ideal-with-max so a camera that cannot reach the target degrades gracefully
 *  instead of erroring. */
export interface CaptureQuality {
  width: number;
  height: number;
  fps: number;
}

/** Full-res capture bus: the projected/on-air output, the compositor
 *  (recording/streaming), and anything that must match broadcast fidelity. */
export const CAPTURE_1080P: CaptureQuality = { width: 1920, height: 1080, fps: 30 };

/** Lightweight preview tier: operator cockpit, Camera tab, feed tiles, A/B
 *  switcher, and stage monitors. A 720p stream costs a fraction of the 1080p
 *  decode while every surface below still renders at full quality (decode, not
 *  display resolution, is the expensive part). */
export const PREVIEW_720P: CaptureQuality = { width: 1280, height: 720, fps: 30 };

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

/** Registry key for a local source: deviceId + capture quality, so one device
 *  can be open at 1080p (broadcast/compositor) and 720p (previews) at once.
 *  Phone/native/ndi sources stay keyed by the bare device id. */
export const entryKey = (deviceId: string, q: CaptureQuality): string =>
  `${deviceId}@${q.width}x${q.height}@${q.fps}`;

const hasQuality = (key: string): boolean => key.includes("@");
const deviceIdOf = (key: string): string => key.split("@")[0];

/** Area comparison for "best entry" resolution arbitration. */
function better(a: InternalEntry, b: InternalEntry): boolean {
  const aq = a.state.quality;
  const bq = b.state.quality;
  return aq.width * aq.height > bq.width * bq.height;
}

const entries = new Map<string, InternalEntry>();
const listeners = new Map<string, Set<() => void>>();
const allListeners = new Set<() => void>();
let allSnapshot: Record<string, MediaStream> = {};

function notify(key: string) {
  listeners.get(key)?.forEach((cb) => cb());
  // Device-wide listeners (bare deviceId subscriptions) fire for ANY quality
  // change of that device, so `useSourceStatus` stays simple.
  listeners.get(deviceIdOf(key))?.forEach((cb) => cb());
  notifyAll();
}

function notifyAll() {
  const bestPerDevice = new Map<string, { entry: InternalEntry; stream: MediaStream }>();
  for (const entry of entries.values()) {
    if (!entry.state.stream) continue;
    const id = entry.state.deviceId;
    const cur = bestPerDevice.get(id);
    if (!cur || better(entry, cur.entry)) bestPerDevice.set(id, { entry, stream: entry.state.stream });
  }
  const next: Record<string, MediaStream> = {};
  for (const [id, best] of bestPerDevice) next[id] = best.stream;
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

/** Stable snapshot reference for a source. Pass a full entry key (deviceId +
 *  quality) for an exact entry, or a bare device id to get the highest-quality
 *  entry currently open for that device. */
export function getSourceSnapshot(deviceIdOrKey: string): SourceState | null {
  if (hasQuality(deviceIdOrKey)) return entries.get(deviceIdOrKey)?.state ?? null;
  let best: InternalEntry | null = null;
  for (const entry of entries.values()) {
    if (entry.state.deviceId === deviceIdOrKey && (!best || better(entry, best))) {
      best = entry;
    }
  }
  return best?.state ?? null;
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

/** Open a local camera once at a specific quality; the track's `ended` fires a
 *  bounded reconnect. The device is keyed by deviceId + quality so a camera can
 *  be open at 1080p (broadcast/compositor) and 720p (previews) simultaneously
 *  without duplicating either stream. */
function openLocal(key: string, deviceId: string, q: CaptureQuality): void {
  const entry = entries.get(key);
  if (!entry) return;
  setState(key, { status: "opening", stream: null, errorKind: null });
  // The id may be an ENGINE friendly name (broadcast items carry it); translate
  // to the real webview device for the actual getUserMedia constraint.
  const nativeDeviceId = webviewDeviceIdForEngineName(deviceId);
  navigator.mediaDevices
    .getUserMedia({
      video: {
        deviceId: { exact: nativeDeviceId },
        width: { ideal: q.width, max: q.width },
        height: { ideal: q.height, max: q.height },
        frameRate: { ideal: q.fps, max: q.fps },
      },
    })
    .then((stream) => {
      const current = entries.get(key);
      // Drop the stream if every consumer vanished while it was opening.
      if (!current || current.consumers.size === 0) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      // React to a device being unplugged / track ending with one auto-retry.
      stream.getVideoTracks().forEach((track) => {
        track.onended = () => {
          const live = entries.get(key);
          if (!live || live.consumers.size === 0) return;
          stopStream(live.state);
          setState(key, { stream: null, status: "reconnecting", errorKind: null });
          live.reconnectTimer = setTimeout(() => openLocal(key, deviceId, q), 750);
        };
      });
      setState(key, { stream, status: "connected", errorKind: null });
      notifyAll();
    })
    .catch((err) => {
      const current = entries.get(key);
      if (!current || current.consumers.size === 0) return;
      setState(key, { stream: null, status: "error", errorKind: mapSourceError(err) });
    });
}

/**
 * Acquire a local camera for a consumer at the requested quality. The device is
 * opened once per (device, quality) — ref-counted — so a camera can feed the
 * 1080p capture bus and the 720p preview tier at the same time without
 * duplication; when the last consumer releases its hold the stream closes.
 * Phone/native/ndi ids are ignored for acquisition.
 */
export function acquireSource(
  deviceId: string,
  consumerId: string,
  quality: CaptureQuality = CAPTURE_1080P
): void {
  const kind = resolveSourceKind(deviceId);
  if (kind !== "local") return;
  const key = entryKey(deviceId, quality);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      state: { deviceId, kind, stream: null, status: "idle", errorKind: null, quality },
      consumers: new Set(),
    };
    entries.set(key, entry);
  }
  entry.consumers.add(consumerId);
  if (entry.state.status === "idle") {
    openLocal(key, deviceId, quality);
  }
  notify(key);
}

/** Release a consumer's hold on a local camera; closes it when the last one
 *  leaves, so a camera is never left open when nothing is watching it. */
export function releaseSource(
  deviceId: string,
  consumerId: string,
  quality: CaptureQuality = CAPTURE_1080P
): void {
  const kind = resolveSourceKind(deviceId);
  if (kind !== "local") return;
  const key = entryKey(deviceId, quality);
  const entry = entries.get(key);
  if (!entry) return;
  entry.consumers.delete(consumerId);
  if (entry.consumers.size === 0) {
    clearEntry(key);
  } else {
    notify(key);
  }
}

/** Explicit re-open after a permission denial / device loss. */
export function retrySource(
  deviceId: string,
  quality: CaptureQuality = CAPTURE_1080P
): void {
  if (resolveSourceKind(deviceId) !== "local") return;
  const key = entryKey(deviceId, quality);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      state: { deviceId, kind: "local", stream: null, status: "idle", errorKind: null, quality },
      consumers: new Set(),
    };
    entries.set(key, entry);
  }
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = undefined;
  }
  openLocal(key, deviceId, quality);
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
      state: { deviceId, kind: "phone", stream: null, status: "idle", errorKind: null, quality: CAPTURE_1080P },
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
  permissionPrimed = false;
}

let permissionPrimed = false;

/**
 * Request camera permission ONCE, routed through the registry policy (WP4).
 *
 * Browsers only reveal camera device labels (and, on some platforms, the
 * device list at all) after the user grants `getUserMedia`. The operator shell
 * must therefore warm permission before enumerating, or a first-run user sees
 * no webcam. This is a deliberate, tracked permission warm-up — it opens the
 * default camera and immediately stops the track — NOT a second acquisition
 * path (the per-device `acquireSource` remains the only thing that keeps a
 * stream open). Idempotent: it primes once per session and never fights the
 * registry's real acquisitions.
 */
export async function primeCameraPermission(): Promise<void> {
  if (permissionPrimed) return;
  permissionPrimed = true;
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== "function"
  ) {
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: PREVIEW_720P.width }, height: { ideal: PREVIEW_720P.height } },
    });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // Denied / no device — mark primed so we don't re-prompt every render.
  }
}
