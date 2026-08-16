import { describe, expect, it } from "vitest";
import { computeCapabilities } from "../capabilities";
import type { CapabilityInputs } from "../../types/system";

function inputs(overrides: Partial<CapabilityInputs> = {}): CapabilityInputs {
  return {
    h264Supported: true,
    ffmpegAvailable: true,
    webrtcAvailable: true,
    audioInputPresent: true,
    cameraPresent: true,
    ndiSupported: true,
    ndiReason: "NDI output is available.",
    monitors: 2,
    hardwareConcurrency: 8,
    deviceMemory: 16,
    ...overrides,
  };
}

describe("computeCapabilities", () => {
  it("flags RTMP as available only when both H.264 and ffmpeg are present", () => {
    expect(computeCapabilities(inputs()).rtmpAvailable).toBe(true);
    expect(
      computeCapabilities(inputs({ ffmpegAvailable: false })).rtmpAvailable,
    ).toBe(false);
    expect(
      computeCapabilities(inputs({ h264Supported: false })).rtmpAvailable,
    ).toBe(false);
    expect(
      computeCapabilities(inputs({ h264Supported: false, ffmpegAvailable: false }))
        .rtmpAvailable,
    ).toBe(false);
  });

  it("explains WHY a service is disabled, not just that it is", () => {
    const noFfmpeg = computeCapabilities(inputs({ ffmpegAvailable: false }));
    expect(noFfmpeg.rtmpReason).toContain("ffmpeg");
    const noH264 = computeCapabilities(inputs({ h264Supported: false }));
    expect(noH264.rtmpReason).toContain("WebCodecs");
  });

  it("gates WHIP on WebRTC availability", () => {
    expect(computeCapabilities(inputs()).whipAvailable).toBe(true);
    expect(
      computeCapabilities(inputs({ webrtcAvailable: false })).whipAvailable,
    ).toBe(false);
  });

  it("gates NDI on the backend SDK probe and passes its reason through", () => {
    const enabled = computeCapabilities(inputs());
    expect(enabled.ndiAvailable).toBe(true);
    expect(enabled.ndiReason).toContain("available");
    const gated = computeCapabilities(
      inputs({ ndiSupported: false, ndiReason: "NDI output is not compiled into this build." }),
    );
    expect(gated.ndiAvailable).toBe(false);
    expect(gated.ndiReason).toContain("not compiled");
  });

  it("gates shared audio and cameras on device presence", () => {
    const caps = computeCapabilities(inputs({ audioInputPresent: false, cameraPresent: false }));
    expect(caps.audioAvailable).toBe(false);
    expect(caps.audioReason).toContain("No audio input");
    expect(caps.cameraAvailable).toBe(false);
    expect(caps.cameraReason).toContain("No camera");
  });

  it("reports monitor availability", () => {
    expect(computeCapabilities(inputs()).monitorsAvailable).toBe(true);
    expect(computeCapabilities(inputs({ monitors: 0 })).monitorsAvailable).toBe(false);
  });

  it("applies the hardware-acceleration heuristic only when H.264 is supported", () => {
    expect(computeCapabilities(inputs()).hwAccelLikely).toBe(true);
    expect(computeCapabilities(inputs({ hardwareConcurrency: 2 })).hwAccelLikely).toBe(false);
    expect(computeCapabilities(inputs({ h264Supported: false })).hwAccelLikely).toBe(false);
  });

  it("scales the streaming capacity tier with CPU + RAM", () => {
    expect(computeCapabilities(inputs()).streamingCapacityTier).toBe("high");
    expect(computeCapabilities(inputs()).recommendedMaxStreams).toBe(4);
    expect(
      computeCapabilities(inputs({ hardwareConcurrency: 4, deviceMemory: 4 }))
        .streamingCapacityTier,
    ).toBe("medium");
    expect(
      computeCapabilities(inputs({ hardwareConcurrency: 4, deviceMemory: 4 }))
        .recommendedMaxStreams,
    ).toBe(2);
    expect(
      computeCapabilities(inputs({ hardwareConcurrency: 2, deviceMemory: 2 }))
        .streamingCapacityTier,
    ).toBe("low");
    expect(
      computeCapabilities(inputs({ hardwareConcurrency: 2, deviceMemory: 2 }))
        .recommendedMaxStreams,
    ).toBe(1);
  });

  it("stays internally consistent: any disabled service keeps its default reason", () => {
    const caps = computeCapabilities(inputs({ ffmpegAvailable: false }));
    expect(caps.rtmpAvailable).toBe(false);
    expect(caps.rtmpReason.length).toBeGreaterThan(0);
    expect(caps.audioReason.length).toBeGreaterThan(0);
    expect(caps.cameraReason.length).toBeGreaterThan(0);
  });
});