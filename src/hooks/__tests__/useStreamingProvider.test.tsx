import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { useAppStore } from "../../store";
import { StreamingProvider, useStreaming } from "../useStreamingProvider";
import { OUTPUT_SCHEMA_VERSION } from "../../types";
import type { OutputConfig, PresentationSettings, StreamDestination } from "../../types";
import type { LicenseInfo } from "../../types/license";
import React from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

// Status commands return an empty session table so the poll never throws.
const defaultInvoke = vi.fn(async (cmd: string) => {
  if (cmd === "rtmp_status" || cmd === "recording_status") return [];
  return undefined;
});

// The transport lives in the engine sidecar (Phase D); the provider owns the
// sessions and drives them through the rtmp_* commands. This file proves the
// PROVIDER's intent-first + stop-before-persist contract (WP2 P0-1) and the
// engine-phase blocking of WHIP/NDI destinations.
vi.mock("../../components/outputs/ProgramFeedPreview", () => ({
  ProgramFeedPreview: () => null,
}));

vi.mock("../../system/SystemDiagnosticsContext", () => ({
  useSystemDiagnostics: () => ({
    checks: { capabilities: { rtmpAvailable: true, ndiAvailable: true, audioAvailable: true } },
  }),
}));

const baseSettings = {
  theme: "dark",
  reference_position: "bottom",
  background: { type: "None" },
  is_blanked: false,
  font_size: 72,
  disabled_bible_versions: [],
  auto_split_verses: true,
  verse_split_threshold: 200,
} as PresentationSettings;

const dest = (id: string, over: Partial<StreamDestination> = {}): StreamDestination => ({
  id,
  label: `Dest ${id}`,
  platform: "custom-rtmp",
  mode: "rtmp",
  url: "rtmp://ingest.test/live",
  stream_key: "key",
  enabled: true,
  audio: true,
  ...over,
});

const streamMainOutput = (): OutputConfig => ({
  schema_version: OUTPUT_SCHEMA_VERSION,
  id: "stream-main",
  kind: "streamer",
  label: "Streaming",
  enabled: true,
  visible: false,
  source: { type: "live" },
  geometry: { width: 1920, height: 1080 },
  capture_fps: 30,
  overlays: { props: true, lower_third: true, logo: true },
});

/** Probe child that exposes the streaming context actions to the test. */
function Probe({ onReady }: { onReady: (ctx: any) => void }) {
  const ctx = useStreaming();
  React.useEffect(() => {
    onReady(ctx);
  }, [ctx]);
  return null;
}

describe("StreamingProvider engine session ownership (Phase D)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(defaultInvoke);
    useAppStore.setState({
      license: {
        status: "active",
        tier: "premium",
        expires_at: 0,
        machine_id_hash: "hash",
        max_machines: 50,
        machines_used: 1,
      } as LicenseInfo,
      outputs: [streamMainOutput()],
      settings: baseSettings,
      liveItem: null,
      stagedItem: null,
      propItems: [],
      currentLowerThird: null,
      scenes: [],
      appDataDir: null,
    });
  });

  it("addDestination persists the destination to the stream-main output", async () => {
    const ctx: any = {};
    render(
      <StreamingProvider>
        <Probe onReady={(c) => Object.assign(ctx, c)} />
      </StreamingProvider>
    );

    await act(async () => {
      ctx.addDestination("custom-rtmp");
    });

    await waitFor(() => {
      expect(ctx.destinations.length).toBe(1);
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "outputs_update",
      expect.objectContaining({
        configs: expect.arrayContaining([
          expect.objectContaining({
            id: "stream-main",
            stream_destinations: expect.arrayContaining([expect.objectContaining({ mode: "rtmp" })]),
          }),
        ]),
      })
    );
  });

  it("startDestination starts an RTMP engine session for the destination", async () => {
    const ctx: any = {};
    render(
      <StreamingProvider>
        <Probe onReady={(c) => Object.assign(ctx, c)} />
      </StreamingProvider>
    );

    await act(async () => {
      ctx.addDestination("custom-rtmp");
    });
    const id = ctx.destinations[0].id;
    await act(async () => {
      ctx.updateDestination({ ...ctx.destinations[0], url: "rtmp://ingest.test/live", stream_key: "key" });
    });

    await act(async () => {
      await ctx.startDestination(id);
    });

    expect(mockInvoke).toHaveBeenCalledWith("rtmp_start", {
      sessionId: id,
      serverUrl: "rtmp://ingest.test/live",
      streamKey: "key",
      withAudio: false,
      fps: 30,
    });
    expect(ctx.statuses[id]?.status).toBe("live");
  });

  it("startDestination blocks WHIP/NDI destinations until the engine phase", async () => {
    const ctx: any = {};
    render(
      <StreamingProvider>
        <Probe onReady={(c) => Object.assign(ctx, c)} />
      </StreamingProvider>
    );

    await act(async () => {
      ctx.addDestination("custom-whip");
    });
    const id = ctx.destinations[0].id;

    let ok: boolean | null = null;
    await act(async () => {
      ok = await ctx.startDestination(id);
    });

    expect(ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalledWith("rtmp_start", expect.anything());
    expect(useAppStore.getState().toast).toContain("RTMP");
  });

  it("removes the engine session BEFORE persisting a removal", async () => {
    const ctx: any = {};
    render(
      <StreamingProvider>
        <Probe onReady={(c) => Object.assign(ctx, c)} />
      </StreamingProvider>
    );

    await act(async () => {
      ctx.addDestination("custom-rtmp");
    });
    const id = ctx.destinations[0].id;

    const events: string[] = [];
    mockInvoke.mockImplementation(async (cmd: string) => {
      events.push(cmd);
      if (cmd === "rtmp_status" || cmd === "recording_status") return [];
      return undefined;
    });

    await act(async () => {
      await ctx.removeDestination(id);
    });

    expect(events[0]).toBe("rtmp_stop");
    expect(events).toContain("outputs_update");
    const stopIdx = events.indexOf("rtmp_stop");
    const persistIdx = events.indexOf("outputs_update");
    expect(stopIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeLessThan(persistIdx);
    expect(ctx.destinations).toHaveLength(0);
  });

  it("stopAll stops every enabled RTMP session and is idempotent after a disappearance", async () => {
    const ctx: any = {};
    render(
      <StreamingProvider>
        <Probe onReady={(c) => Object.assign(ctx, c)} />
      </StreamingProvider>
    );

    await act(async () => {
      ctx.addDestination("custom-rtmp");
    });
    await act(async () => {
      ctx.addDestination("custom-rtmp");
    });
    const [a, b] = ctx.destinations.map((d: StreamDestination) => d.id);

    // Go live (this sets masterActive and starts both enabled RTMP sessions).
    await act(async () => {
      await ctx.goLive();
    });

    mockInvoke.mockClear();
    await act(async () => {
      await ctx.stopAll();
    });
    expect(mockInvoke).toHaveBeenCalledWith("rtmp_stop", { sessionId: a });
    expect(mockInvoke).toHaveBeenCalledWith("rtmp_stop", { sessionId: b });

    // A second stopAll (master now inactive) must not throw or re-stop.
    mockInvoke.mockClear();
    await act(async () => {
      await ctx.stopAll();
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("rtmp_stop", expect.anything());
  });

  it("goLive reports the surface phase through the OutputManager", async () => {
    const ctx: any = {};
    render(
      <StreamingProvider>
        <Probe onReady={(c) => Object.assign(ctx, c)} />
      </StreamingProvider>
    );

    await act(async () => {
      ctx.addDestination("custom-rtmp");
    });
    await act(async () => {
      ctx.updateDestination({ ...ctx.destinations[0], url: "rtmp://ingest.test/live", stream_key: "key" });
    });

    // Stateful engine mock: rtmp_start registers the session (as the real
    // engine does before the invoke resolves), rtmp_status returns it, so the
    // provider's poll reflects an active session instead of a stale empty table.
    const engineSessions = new Map<string, boolean>();
    const events: string[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "rtmp_start") {
        engineSessions.set(args.sessionId, true);
        events.push("start");
      }
      if (cmd === "rtmp_stop") {
        engineSessions.delete(args.sessionId);
        events.push("stop");
      }
      if (cmd === "outputs_set_visible") events.push("visible");
      if (cmd === "report_output_state") events.push("report");
      if (cmd === "rtmp_status")
        return [...engineSessions.entries()]
          .filter(([, active]) => active)
          .map(([id]) => ({ id, active: true, url: null, fps: 30, queued: 0, sent: 0, dropped: 0 }));
      if (cmd === "recording_status") return [];
      return undefined;
    });

    await act(async () => {
      await ctx.goLive();
    });

    expect(events).toContain("visible");
    expect(events).toContain("start");
    // The intent (output visible) is persisted BEFORE the engine session starts.
    expect(events.indexOf("visible")).toBeLessThan(events.indexOf("start"));
    expect(events.filter((e) => e === "report").length).toBeGreaterThanOrEqual(2);
    // The engine poll confirms the session as live.
    await waitFor(() => {
      expect(ctx.liveCount).toBe(1);
    });
    expect(ctx.statuses[ctx.destinations[0].id]?.status).toBe("live");
  });
});