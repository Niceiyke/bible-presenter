/**
 * System diagnostics types (Phase 7). Mirrors the backend `commands/system.rs`
 * payloads plus the frontend-derived capability checks.
 */

/** One-shot hardware + environment snapshot (backend). */
export interface SystemInfo {
  cpu_model: string;
  physical_cores: number | null;
  total_ram_mb: number;
  total_disk_mb: number;
  ffmpeg_available: boolean;
}

/** Cheap polled metric for the live performance monitor (backend). */
export interface SystemMetrics {
  cpu_usage_percent: number;
  used_ram_percent: number;
  used_disk_percent: number;
  active_rtmp_sessions: number;
}

/** Raw inputs the capability scorer derives service availability from. */
export interface CapabilityInputs {
  h264Supported: boolean;
  ffmpegAvailable: boolean;
  webrtcAvailable: boolean;
  audioInputPresent: boolean;
  cameraPresent: boolean;
  monitors: number;
  hardwareConcurrency: number;
  deviceMemory: number;
}

/** Derived service availability + a hardware-capacity estimate. */
export interface SystemCapabilities {
  rtmpAvailable: boolean;
  whipAvailable: boolean;
  audioAvailable: boolean;
  cameraAvailable: boolean;
  monitorsAvailable: boolean;
  hwAccelLikely: boolean;
  /** Estimated simultaneous RTMP streams this machine can sustain. */
  recommendedMaxStreams: number;
  streamingCapacityTier: "low" | "medium" | "high";
  rtmpReason: string;
  audioReason: string;
  cameraReason: string;
}

/** The full diagnostics snapshot produced by the provider. */
export interface SystemChecks {
  info: SystemInfo | null;
  h264Supported: boolean;
  webrtcAvailable: boolean;
  audioInputPresent: boolean;
  cameraPresent: boolean;
  monitors: number;
  hardwareConcurrency: number;
  deviceMemory: number;
  capabilities: SystemCapabilities;
  checkedAt: number;
}