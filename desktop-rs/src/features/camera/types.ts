// ── Tally ─────────────────────────────────────────────────────────────────
export type TallyState = "off" | "preview" | "program";

// ── Quality ───────────────────────────────────────────────────────────────
export interface QualityStats {
  rttMs?: number;
  packetLossPct?: number;
  bitrateKbps?: number;
  batteryPct?: number;
  resolutionW?: number;
  resolutionH?: number;
  updatedAtMs: number;
}

// ── Per-device camera source ───────────────────────────────────────────────
export interface CameraSource {
  deviceId: string;
  deviceName: string;
  tally: TallyState;
  status: "connecting" | "connected" | "disconnected";
  connectedAt: number;
  quality: QualityStats;
  /** Live preview MediaStream — null until preview PC is established */
  previewStream: MediaStream | null;
}

// ── WS message shapes (inbound from server) ────────────────────────────────
export interface WsAuthOk    { type: "auth_ok" }
export interface WsAuthFail  { type: "auth_fail"; reason: string }
export interface WsCameraConnected    { type: "camera_source_connected";    device_id: string; device_name: string }
export interface WsCameraDisconnected { type: "camera_source_disconnected"; device_id: string }
export interface WsTallyUpdate { type: "tally_update"; device_id: string; tally: TallyState }
export interface WsCameraOffer  { cmd: "camera_offer";  device_id: string; device_name?: string; sdp: string; target: string }
export interface WsCameraAnswer { cmd: "camera_answer"; device_id: string; sdp: string }
export interface WsCameraIce    { cmd: "camera_ice";    device_id: string; candidate: RTCIceCandidateInit }
export interface WsTelemetry {
  cmd: "camera_telemetry";
  device_id: string;
  battery?: number;
  resolution_w?: number;
  resolution_h?: number;
  rtt_ms?: number;
  bitrate_kbps?: number;
}
export interface WsOutputReady { cmd: "output_ready" }
export interface WsHeartbeat   { type: "heartbeat" }

export type WsInbound =
  | WsAuthOk | WsAuthFail
  | WsCameraConnected | WsCameraDisconnected | WsTallyUpdate
  | WsCameraOffer | WsCameraAnswer | WsCameraIce
  | WsTelemetry | WsOutputReady | WsHeartbeat;

// ── Hook return types ──────────────────────────────────────────────────────
export interface UseCameraManagerReturn {
  /** All known camera sources, keyed by deviceId */
  sources: Map<string, CameraSource>;
  /** Set a video element to receive preview stream for a device */
  attachPreview: (deviceId: string, el: HTMLVideoElement | null) => void;
  /** Switch program output to this device (slot A by default) */
  setProgram: (deviceId: string | null) => void;
  /** Internal: used by OutputWindow to register scene handlers */
  registerSceneHandler: (deviceId: string, handler: (msg: WsCameraOffer | WsCameraIce) => void) => void;
  unregisterSceneHandler: (deviceId: string) => void;
}

export interface UseOutputCameraReturn {
  /** Whether a LAN camera is currently the live program source */
  isLanCameraLive: boolean;
  /** Assign the program video element (mounts once, never unmounts) */
  programVideoRef: React.RefObject<HTMLVideoElement | null>;
}

// ── STUN config (shared) ──────────────────────────────────────────────────
export const STUN_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
  iceCandidatePoolSize: 10,
};
