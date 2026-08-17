import { describe, expect, it } from "vitest";
import { PLATFORM_PRESETS, presetFor, makeDestination, applyPreset, newDestinationId } from "../presets";
import type { StreamDestination } from "../../../types";

describe("streaming presets", () => {
  it("covers the built-in platforms with the right mode and server", () => {
    const byPlatform = Object.fromEntries(PLATFORM_PRESETS.map((p) => [p.platform, p]));
    expect(byPlatform.youtube).toMatchObject({ mode: "rtmp", url: "rtmp://a.rtmp.youtube.com/live2" });
    expect(byPlatform.facebook).toMatchObject({ mode: "rtmp", url: "rtmp://live-api-s.facebook.com:443/rtmp" });
    expect(byPlatform.twitch).toMatchObject({ mode: "rtmp", url: "rtmp://live.twitch.tv/app" });
    expect(byPlatform["custom-rtmp"]).toMatchObject({ mode: "rtmp", url: "" });
    expect(byPlatform["custom-whip"]).toMatchObject({ mode: "whip", url: "" });
    // NDI is a LAN source — no ingest URL; the label becomes the source name.
    expect(byPlatform.ndi).toMatchObject({ mode: "ndi", url: "" });
  });

  it("makeDestination builds an NDI destination without an ingest URL", () => {
    const d = makeDestination("ndi");
    expect(d.platform).toBe("ndi");
    expect(d.mode).toBe("ndi");
    expect(d.url).toBe("");
    expect(d.label).toBe("NDI");
    expect(d.enabled).toBe(true);
  });

  it("makeDestination creates an enabled audio-carrying destination", () => {
    const d = makeDestination("youtube");
    expect(d.platform).toBe("youtube");
    expect(d.label).toBe("YouTube");
    expect(d.mode).toBe("rtmp");
    expect(d.url).toBe("rtmp://a.rtmp.youtube.com/live2");
    expect(d.enabled).toBe(true);
    expect(d.audio).toBe(true);
    expect(d.id.length).toBeGreaterThan(0);
  });

  it("makeDestination falls back to custom RTMP for unknown platforms", () => {
    const d = makeDestination("custom-rtmp" as any);
    expect(d.mode).toBe("rtmp");
  });

  it("applyPreset switches platform keeping the id and stream key", () => {
    const base: StreamDestination = {
      id: "dest-abc",
      label: "YouTube",
      platform: "youtube",
      mode: "rtmp",
      url: "rtmp://a.rtmp.youtube.com/live2",
      stream_key: "my-key",
      enabled: false,
      audio: false,
    };
    const next = applyPreset(base, "twitch");
    expect(next.id).toBe("dest-abc");
    expect(next.stream_key).toBe("my-key");
    expect(next.platform).toBe("twitch");
    expect(next.mode).toBe("rtmp");
    expect(next.url).toBe("rtmp://live.twitch.tv/app");
    // Non-ingest fields are preserved.
    expect(next.enabled).toBe(false);
    expect(next.audio).toBe(false);
  });

  it("presetFor returns the matching preset or custom RTMP", () => {
    expect(presetFor("facebook").label).toBe("Facebook Live");
    expect(presetFor("custom-whip").mode).toBe("whip");
  });

  it("newDestinationId yields distinct ids", () => {
    expect(newDestinationId()).not.toBe(newDestinationId());
  });
});