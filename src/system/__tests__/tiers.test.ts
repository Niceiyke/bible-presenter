import { describe, expect, it } from "vitest";
import { TIER_CAPABILITIES, tabAllowed, tierCapabilities } from "../tiers";

describe("tier capabilities", () => {
  it("free can use core workspaces but not remote/recording/streaming", () => {
    const caps = tierCapabilities("free");
    expect(caps.recording).toBe(false);
    expect(caps.streaming).toBe(false);
    expect(caps.remoteControl).toBe(false);
    expect(tabAllowed("bible", caps)).toBe(true);
    expect(tabAllowed("settings", caps)).toBe(true);
    expect(tabAllowed("remote", caps)).toBe(false);
    expect(tabAllowed("recordings", caps)).toBe(false);
    expect(tabAllowed("streaming", caps)).toBe(false);
  });

  it("pro and premium unlock the gated workspaces", () => {
    for (const tier of ["pro", "premium"] as const) {
      const caps = tierCapabilities(tier);
      expect(tabAllowed("remote", caps)).toBe(true);
      expect(tabAllowed("recordings", caps)).toBe(true);
      expect(tabAllowed("streaming", caps)).toBe(true);
    }
  });

  it("unknown/null tier falls back to free", () => {
    const caps = tierCapabilities(null);
    expect(caps.remoteControl).toBe(false);
    expect(tabAllowed("streaming", caps)).toBe(false);
    expect(TIER_CAPABILITIES.free.remoteControl).toBe(false);
  });
});
