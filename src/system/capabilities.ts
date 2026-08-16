import type { CapabilityInputs, SystemCapabilities } from "../types/system";

/**
 * Capability scoring + service gating (Phase 7).
 *
 * Derives which production services are usable on this machine and an honest
 * estimate of how much streaming load it can carry. Everything here is pure so
 * the logic is unit-testable; the check battery lives in the diagnostics
 * provider and feeds `computeCapabilities`.
 *
 * Hardware acceleration is not directly exposed by WebCodecs, so `hwAccelLikely`
 * is a documented heuristic: H.264 encoding must be supported and the machine
 * must have at least 4 logical cores (software encoders still win on many-core
 * machines, but they also take the biggest CPU hit — the tier accounts for that).
 */
export function computeCapabilities(inputs: CapabilityInputs): SystemCapabilities {
  const {
    h264Supported,
    ffmpegAvailable,
    webrtcAvailable,
    audioInputPresent,
    cameraPresent,
    monitors,
    hardwareConcurrency,
    deviceMemory,
  } = inputs;

  const rtmpAvailable = h264Supported && ffmpegAvailable;
  const whipAvailable = webrtcAvailable;
  const audioAvailable = audioInputPresent;
  const cameraAvailable = cameraPresent;
  const monitorsAvailable = monitors >= 1;
  const hwAccelLikely = h264Supported && hardwareConcurrency >= 4;

  const score =
    (hardwareConcurrency >= 8 ? 2 : hardwareConcurrency >= 4 ? 1 : 0) +
    (deviceMemory >= 8 ? 2 : deviceMemory >= 4 ? 1 : 0) +
    (hwAccelLikely ? 1 : 0);
  const streamingCapacityTier = score >= 4 ? "high" : score >= 2 ? "medium" : "low";
  const recommendedMaxStreams = score >= 4 ? 4 : score >= 2 ? 2 : 1;

  const rtmpReason = !h264Supported
    ? "WebCodecs H.264 encoding is unavailable in this WebView2 build; RTMP destinations are disabled."
    : !ffmpegAvailable
      ? "ffmpeg was not found on PATH; RTMP destinations are disabled (add ffmpeg to PATH and restart)."
      : hardwareConcurrency < 4
        ? "H.264 encoding is supported but CPU is limited — keep simultaneous RTMP streams low."
        : "RTMP destinations are available.";

  const audioReason = !audioInputPresent
    ? "No audio input device detected — shared audio in the Streaming workspace is disabled."
    : "Audio input detected — shared audio is available.";

  const cameraReason = !cameraPresent
    ? "No camera detected — Camera sources are unavailable in content workspaces."
    : "Camera detected.";

  return {
    rtmpAvailable,
    whipAvailable,
    audioAvailable,
    cameraAvailable,
    monitorsAvailable,
    hwAccelLikely,
    recommendedMaxStreams,
    streamingCapacityTier,
    rtmpReason,
    audioReason,
    cameraReason,
  };
}