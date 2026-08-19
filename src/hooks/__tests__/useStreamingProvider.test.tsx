import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { useAppStore } from "../../store";
import { StreamingProvider, useStreaming } from "../useStreamingProvider";
import { OUTPUT_SCHEMA_VERSION } from "../../types";
import type { OutputConfig, PresentationSettings, StreamDestination } from "../../types";
import type { LicenseInfo } from "../../types/license";
import type { DestinationCardHandle } from "../../components/streaming/DestinationCard";
import React from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

// The runtime is mocked to a controllable fake so we can observe handle
// registration and lifecycle ordering. The real transport hooks have their own
// unit tests; this file proves the PROVIDER owns the runtimes and their
// stop-before-persist contract (WP2 P0-1).
const registeredHandles = new Map<string, DestinationCardHandle>();
const runtimeStarts = vi.fn();
const runtimeStops = vi.fn();

vi.mock("../../components/streaming/DestinationRuntime", () => ({
  DestinationRuntime: (props: any) => {
    // Register a controllable handle keyed by the destination id.
    React.useEffect(() => {
      const handle: DestinationCardHandle = {
        start: async () => {
          runtimeStarts(props.destination.id);
          return true;
        },
        stop: async () => {
          runtimeStops(props.destination.id);
        },
      };
      registeredHandles.set(props.destination.id, handle);
      props.onRegister(props.destination.id, handle);
      return () => {
        registeredHandles.delete(props.destination.id);
        props.onRegister(props.destination.id, null);
      };
    }, [props.destination.id]);
    return null;
  },
}));

vi.mock("../../components/outputs/ProgramFeedPreview", () => ({
  ProgramFeedPreview: () => null,
}));

vi.mock("../../system/SystemDiagnosticsContext", () => ({
  useSystemDiagnostics: () => ({
    checks: { capabilities: { rtmpAvailable: true, ndiAvailable: true, audioAvailable: true } },
  }),
}));

vi.mock("../useAudioGraphProvider", () => ({
  useAudioGraph: () => ({
    enabled: false,
    devices: [],
    deviceId: "",
    setDeviceId: vi.fn(),
    setEnabled: vi.fn(),
    volume: 1,
    setVolume: vi.fn(),
    muted: false,
    setMuted: vi.fn(),
    programTrack: null,
    status: "idle",
    error: null,
    retry: vi.fn(),
    blocked: false,
  }),
}));

vi.mock("../../system/programEncoder", () => {
  const snapshot = { live: false };
  return {
    startProgramEncoder: vi.fn(async () => true),
    stopProgramEncoder: vi.fn(),
    getProgramEncoderSnapshot: () => snapshot,
    subscribeProgramEncoder: () => () => {},
  };
});

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

describe("StreamingProvider destination runtime ownership (WP2)", () => {
  beforeEach(() => {
    registeredHandles.clear();
    runtimeStarts.mockClear();
    runtimeStops.mockClear();
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async () => undefined);
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

  it("renders one runtime per destination and registers stable handles", async () => {
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
      ctx.addDestination("custom-whip");
    });

    await waitFor(() => {
      expect(ctx.destinations.length).toBe(2);
      expect(registeredHandles.size).toBe(2);
    });

    // Each destination's handle is startable through the provider.
    const firstId = ctx.destinations[0].id;
    await act(async () => {
      await ctx.startDestination(firstId);
    });
    expect(runtimeStarts).toHaveBeenCalledWith(firstId);
  });

  it("stops the runtime BEFORE persisting a removal", async () => {
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
    runtimeStops.mockImplementation((id: string) => {
      events.push("stop");
      return Promise.resolve();
    });
    mockInvoke.mockImplementation(async (cmd: string) => {
      events.push(`persist:${cmd}`);
      return undefined;
    });

    await act(async () => {
      await ctx.removeDestination(id);
    });

    expect(events).toEqual(["stop", "persist:outputs_update"]);
    expect(ctx.destinations).toHaveLength(0);
    expect(registeredHandles.has(id)).toBe(false);
  });

  it("stopAll is idempotent after a destination has disappeared", async () => {
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

    // Simulate a destination whose runtime vanished (e.g. a removal that
    // already happened): no handle registered.
    registeredHandles.delete(id);

    await act(async () => {
      await ctx.stopAll();
    });
    // No throw, no leftover handles.
    expect(registeredHandles.size).toBe(0);
  });

  it("unmounting only the tab view leaves runtimes mounted", async () => {
    const ctx: any = {};
    const ProbeToggle = ({ show, onReady }: { show: boolean; onReady: (c: any) => void }) =>
      show ? <Probe onReady={onReady} /> : null;
    const { rerender } = render(
      <StreamingProvider>
        <ProbeToggle show onReady={(c) => Object.assign(ctx, c)} />
      </StreamingProvider>
    );

    await act(async () => {
      ctx.addDestination("custom-rtmp");
    });
    const id = ctx.destinations[0].id;
    expect(registeredHandles.has(id)).toBe(true);

    // Simulate navigating away: unmount the tab (Probe) while the provider (and
    // its app-scoped runtimes) stays mounted. The transport must not be stopped
    // or deregistered.
    rerender(
      <StreamingProvider>
        <ProbeToggle show={false} onReady={() => {}} />
      </StreamingProvider>
    );
    expect(registeredHandles.has(id)).toBe(true);
    expect(runtimeStops).not.toHaveBeenCalled();
  });
});