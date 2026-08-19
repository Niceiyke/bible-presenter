/**
 * `audioGraph` — the Phase 6 shared audio graph (application scope).
 *
 * A single audio pipeline that both recording and streaming draw their program
 * audio from, so the app never holds two separate input captures. The graph
 * owns:
 *   - input-device enumeration + selection,
 *   - one shared input track opened via `getUserMedia` (processing off),
 *   - volume / mute applied through a `GainNode` (the program bus),
 *   - a `programTrack` (the post-gain output) shared by every consumer,
 *   - device-loss detection with a bounded auto-reconnect,
 *   - a unified status + error surface (permission / device / unknown).
 *
 * A/V sync policy: the program track and the compositor's video track are both
 * real-time live captures, so samples and frames are already aligned to the
 * wall clock at capture time; consumers clone both tracks together at start
 * (`startedAt` marks when the graph went live), keeping A/V in step without
 * per-sample timestamping (that is Phase 7's packet-metadata work).
 */

export type AudioGraphStatus =
  | "idle"
  | "opening"
  | "connected"
  | "error"
  | "reconnecting"
  | "disconnected";

export type AudioErrorKind = "permission" | "device" | "unknown";

export interface AudioGraphState {
  enabled: boolean;
  deviceId: string;
  devices: MediaDeviceInfo[];
  status: AudioGraphStatus;
  error: string | null;
  errorKind: AudioErrorKind | null;
  /** The shared post-gain program audio track (consumed by recording +
   *  streaming). Null when disabled. */
  programTrack: MediaStreamTrack | null;
  /** 0..1 program gain. */
  volume: number;
  /** Mute the program bus without touching any visual output. */
  muted: boolean;
  /** Independent monitor policy (P2-2 / WP8): the RAW pre-gain input track for
   *  local operator monitoring. It is taken BEFORE the program gain node, so
   *  program mute/volume can never affect operator monitoring. */
  monitorTrack: MediaStreamTrack | null;
  /** 0..1 monitor gain — only affects local operator playback. */
  monitorVolume: number;
  /** Mute local operator monitoring only — never recording/stream audio. */
  monitorMuted: boolean;
  /** Unix ms when the graph last went live. */
  startedAt: number | null;
}

export function describeAudioError(kind: AudioErrorKind | null): string | null {
  if (kind === "permission") return "Microphone permission denied.";
  if (kind === "device") return "Audio input unavailable or in use.";
  if (kind === "unknown") return "Could not open the audio input.";
  return null;
}

export function mapAudioError(err: unknown): AudioErrorKind {
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

interface AudioNodes {
  programTrack: MediaStreamTrack | null;
  gain: GainNode | null;
  ctx: AudioContext | null;
}

/** Build the program bus (raw input → gain → destination track). Falls back to
 *  passing the raw track straight through when Web Audio is unavailable. */
function buildProgramTrack(rawTrack: MediaStreamTrack, volume: number, muted: boolean): AudioNodes {
  let ctx: AudioContext;
  if (audioContextFactory) {
    ctx = audioContextFactory();
  } else {
    const AC = (window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    }).AudioContext;
    if (!AC) {
      return { programTrack: rawTrack, gain: null, ctx: null };
    }
    ctx = new AC();
  }
  const source = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
  const gain = ctx.createGain();
  gain.gain.value = muted ? 0 : volume;
  const destination = ctx.createMediaStreamDestination();
  source.connect(gain);
  gain.connect(destination);
  const track = destination.stream.getAudioTracks()[0] ?? null;
  return { programTrack: track, gain, ctx };
}

const listeners = new Set<() => void>();
let state: AudioGraphState = {
  enabled: false,
  deviceId: "",
  devices: [],
  status: "idle",
  error: null,
  errorKind: null,
  programTrack: null,
  volume: 1,
  muted: false,
  monitorTrack: null,
  monitorVolume: 1,
  monitorMuted: false,
  startedAt: null,
};

let rawTrack: MediaStreamTrack | null = null;
let nodes: AudioNodes = { programTrack: null, gain: null, ctx: null };
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

/** Test seam: inject an AudioContext factory (Web Audio is absent in jsdom). */
let audioContextFactory: (() => AudioContext) | null = null;
export function __setAudioContextFactoryForTest(fn: (() => AudioContext) | null): void {
  audioContextFactory = fn;
}

function notify(): void {
  listeners.forEach((cb) => cb());
}

export function subscribeAudioGraph(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Stable snapshot (the current `state` object; replaced only on change). */
export function getAudioGraphSnapshot(): AudioGraphState {
  return state;
}

function setState(patch: Partial<AudioGraphState>): void {
  state = { ...state, ...patch };
  notify();
}

export function refreshAudioDevices(): void {
  navigator.mediaDevices
    .enumerateDevices()
    .then((devices) => {
      const inputs = devices.filter((d) => d.kind === "audioinput");
      setState({ devices: inputs });
      if (!state.deviceId) {
        setState({ deviceId: inputs[0]?.deviceId ?? "" });
      }
    })
    .catch(() => {});
}

function closeInternal(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  nodes.ctx?.close().catch(() => {});
  if (rawTrack) {
    rawTrack.stop();
    rawTrack = null;
  }
  if (nodes.programTrack && nodes.programTrack !== rawTrack) {
    nodes.programTrack.stop();
  }
  nodes = { programTrack: null, gain: null, ctx: null };
}
function applyGain(): void {
  if (nodes.gain) {
    nodes.gain.gain.value = state.muted ? 0 : state.volume;
  }
}

function open(deviceId: string): void {
  setState({ status: "opening", error: null, errorKind: null });
  navigator.mediaDevices
    .getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
    .then((stream) => {
      if (!state.enabled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const track = stream.getAudioTracks()[0];
      if (!track) {
        setState({ status: "error", errorKind: "device", error: "No audio input device was found." });
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      rawTrack = track;
      nodes = buildProgramTrack(track, state.volume, state.muted);
      // The monitor track is the RAW pre-gain input, so program mute/volume
      // never affects local operator monitoring (P2-2 / WP8).
      track.onended = () => {
        if (!state.enabled) return;
        closeInternal();
        setState({ status: "reconnecting", error: null, errorKind: null });
        reconnectTimer = setTimeout(() => open(state.deviceId), 750);
      };
      setState({
        status: "connected",
        programTrack: nodes.programTrack,
        monitorTrack: track,
        error: null,
        errorKind: null,
        startedAt: Date.now(),
      });
    })
    .catch((err) => {
      if (!state.enabled) return;
      const kind = mapAudioError(err);
      setState({ status: "error", errorKind: kind, error: describeAudioError(kind), programTrack: null, monitorTrack: null });
    });
}

/** Enable/disable the shared program audio bus. Disabling closes the capture. */
export function setAudioEnabled(enabled: boolean): void {
  if (enabled === state.enabled) return;
  if (!enabled) {
    closeInternal();
    setState({ enabled: false, status: "idle", programTrack: null, monitorTrack: null, error: null, errorKind: null, startedAt: null });
    return;
  }
  setState({ enabled: true });
  refreshAudioDevices();
  const deviceId = state.deviceId;
  open(deviceId);
}

/** Select a different input device (re-opens the capture). */
export function setAudioDeviceId(deviceId: string): void {
  if (deviceId === state.deviceId) return;
  const wasEnabled = state.enabled;
  closeInternal();
  setState({ deviceId, status: wasEnabled ? "opening" : "idle", programTrack: null, monitorTrack: null });
  if (wasEnabled) open(deviceId);
}

/** Set program volume (0..1). */
export function setAudioVolume(volume: number): void {
  const clamped = Math.max(0, Math.min(1, volume));
  setState({ volume: clamped });
  applyGain();
}

/** Mute/unmute the program bus (audio-only; never alters visual output). */
export function setAudioMuted(muted: boolean): void {
  setState({ muted });
  applyGain();
}

/** Set local operator-monitor gain (0..1). Only affects monitor playback —
 *  never recording or streaming program audio (P2-2 / WP8). */
export function setMonitorVolume(volume: number): void {
  const clamped = Math.max(0, Math.min(1, volume));
  setState({ monitorVolume: clamped });
}

/** Mute/unmute local operator monitoring only. Never touches the program bus,
 *  so it cannot alter recorded or streamed audio (P2-2 / WP8). */
export function setMonitorMuted(muted: boolean): void {
  setState({ monitorMuted: muted });
}

/** Explicit re-open after a permission denial / device loss. */
export function retryAudio(): void {
  if (!state.enabled) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  open(state.deviceId);
}

/** For tests: reset the module-level graph. */
export function resetAudioGraph(): void {
  closeInternal();
  state = {
    enabled: false,
    deviceId: "",
    devices: [],
    status: "idle",
    error: null,
    errorKind: null,
    programTrack: null,
    volume: 1,
    muted: false,
    monitorTrack: null,
    monitorVolume: 1,
    monitorMuted: false,
    startedAt: null,
  };
  notify();
}
