import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storedName, storedToken, useRemote, wsUrl } from "../wsClient";
import type { RemoteSnapshot } from "../../types/remote";

function makeSnapshot(overrides: Partial<RemoteSnapshot> = {}): RemoteSnapshot {
  return {
    protocol_version: 1,
    revision: 1,
    connected: true,
    role: "operator",
    permissions: { scripture: true, song: true, camera: true, lower_third: true, presentation: true },
    controller_state: { kind: "viewing" },
    live_item: null,
    staged_item: null,
    active_service: null,
    schedule_entries: [],
    output_visible: false,
    blackout: false,
    background_logo: false,
    lower_third: null,
    bible_versions: ["KJV"],
    active_bible_version: "KJV",
    songs: [],
    ...overrides,
  };
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  recv(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  last() {
    return JSON.parse(this.sent[this.sent.length - 1] ?? "null") as Record<string, unknown>;
  }
}

function lastWs(): FakeWebSocket {
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  if (!ws) throw new Error("no websocket opened");
  return ws;
}

function recvSnapshot(ws: FakeWebSocket, revision: number) {
  ws.recv({ kind: "snapshot", revision, timestamp: 1, payload: makeSnapshot({ revision }) });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wsUrl and storage helpers", () => {
  it("derives the websocket url from the current location", () => {
    expect(wsUrl()).toBe(`ws://${window.location.host}/ws`);
  });

  it("round-trips the device token and name through localStorage", () => {
    expect(storedToken()).toBeNull();
    expect(storedName()).toBe("");
    localStorage.setItem("wordlyte.remote.token", "tok-1");
    localStorage.setItem("wordlyte.remote.name", "iPad");
    expect(storedToken()).toBe("tok-1");
    expect(storedName()).toBe("iPad");
  });
});

describe("useRemote handshake", () => {
  it("opens the socket and shows pairing when no token is stored", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useRemote());
    expect(result.current.conn).toBe("connecting");
    act(() => lastWs().open());
    expect(result.current.conn).toBe("pairing");
  });

  it("pairs with the code, stores the token, and connects on the snapshot", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useRemote());
    act(() => lastWs().open());

    let pairing: Promise<void> | undefined;
    act(() => {
      pairing = result.current.pair("ABC123", "iPad");
    });
    const sent = lastWs().last();
    expect(sent.type).toBe("remote.pair");
    expect(sent.payload).toEqual({ pairing_token: "ABC123", device_name: "iPad" });

    act(() => {
      lastWs().recv({ command_id: "pair", ok: true, revision: 1, result: { device_id: "d1", device_token: "tok-1", role: "operator" } });
    });
    await act(async () => {
      await pairing;
    });
    expect(localStorage.getItem("wordlyte.remote.token")).toBe("tok-1");
    expect(result.current.selfId).toBe("d1");

    act(() => recvSnapshot(lastWs(), 1));
    expect(result.current.conn).toBe("connected");
    expect(result.current.snapshot?.bible_versions).toEqual(["KJV"]);
  });

  it("rejects pairing when the server rejects the code", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useRemote());
    act(() => lastWs().open());

    const pairing = result.current.pair("BAD", "iPad");
    act(() => {
      lastWs().recv({ command_id: "handshake", ok: false, revision: 0, error: { code: "invalid_pairing", message: "Invalid pairing code" } });
    });
    await expect(pairing).rejects.toThrow("Invalid pairing code");
    act(() => lastWs().open());
    expect(result.current.conn).toBe("pairing");
  });

  it("authenticates with a stored token instead of pairing", async () => {
    localStorage.setItem("wordlyte.remote.token", "tok-1");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    renderHook(() => useRemote());
    act(() => lastWs().open());
    expect(lastWs().last().type).toBe("remote.authenticate");
    expect(lastWs().last().payload).toEqual({ device_token: "tok-1" });
  });

  it("restores the device identity from the snapshot after reload", async () => {
    localStorage.setItem("wordlyte.remote.token", "tok-1");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useRemote());
    act(() => lastWs().open());
    expect(result.current.selfId).toBeNull();

    // A reloaded client re-authenticates (no pair result), so only the
    // snapshot's controller_device_id can re-identify it. Without this,
    // isHeldBySelf never matches controller_state.device_id and
    // controller-gated buttons (e.g. Start Camera) stay disabled.
    act(() => {
      lastWs().recv({ kind: "snapshot", revision: 2, timestamp: 1, payload: makeSnapshot({ revision: 2, controller_device_id: "d1" }) });
    });
    expect(result.current.selfId).toBe("d1");

    act(() => {
      lastWs().recv({
        kind: "controller.changed",
        revision: 3,
        timestamp: 1,
        payload: { controller_state: { kind: "held", device_id: "d1", device_name: "iPad", expires_at: 9999999999 } },
      });
    });
    expect(result.current.isHeldBySelf).toBe(true);
  });

  it("drops the stored token and lands on pairing when the token is rejected", async () => {
    localStorage.setItem("wordlyte.remote.token", "stale");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useRemote());
    act(() => lastWs().open());
    act(() => {
      lastWs().recv({ command_id: "handshake", ok: false, revision: 0, error: { code: "unknown_token", message: "Unknown token" } });
    });
    expect(localStorage.getItem("wordlyte.remote.token")).toBeNull();
    // A single fresh socket is opened so the pairing screen can submit a new
    // code — not a reconnect loop.
    expect(FakeWebSocket.instances.length).toBe(2);
    act(() => lastWs().open());
    expect(result.current.conn).toBe("pairing");
    // No authentication is re-sent — there's no token left to authenticate.
    expect(lastWs().sent).toHaveLength(0);
  });

  it("wipes the token and lands on pairing when the device is revoked", async () => {
    localStorage.setItem("wordlyte.remote.token", "revoked");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useRemote());
    act(() => lastWs().open());
    act(() => {
      lastWs().recv({ command_id: "handshake", ok: false, revision: 0, error: { code: "revoked", message: "Device revoked" } });
    });
    expect(localStorage.getItem("wordlyte.remote.token")).toBeNull();
    expect(FakeWebSocket.instances.length).toBe(2);
    act(() => lastWs().open());
    expect(result.current.conn).toBe("pairing");
  });

  it("does not wipe a valid token on a transient handshake failure, and reconnects with backoff", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("wordlyte.remote.token", "tok-ok");
      vi.stubGlobal("WebSocket", FakeWebSocket);
      const { result } = renderHook(() => useRemote());
      act(() => lastWs().open());
      expect(result.current.conn).toBe("connecting");

      act(() => {
        lastWs().recv({ command_id: "handshake", ok: false, revision: 0, error: { code: "rate_limited", message: "try again later" } });
      });
      // The token is kept — only a definitive auth error may clear it — and no
      // new socket is opened synchronously; the backoff reconnect takes over.
      expect(localStorage.getItem("wordlyte.remote.token")).toBe("tok-ok");
      expect(FakeWebSocket.instances.length).toBe(1);
      expect(result.current.conn).toBe("error");

      // The server closes the socket; the client schedules a reconnect.
      act(() => lastWs().onclose?.());
      expect(FakeWebSocket.instances.length).toBe(1);
      act(() => vi.advanceTimersByTime(1001));
      expect(FakeWebSocket.instances.length).toBe(2);

      act(() => lastWs().open());
      expect(lastWs().last().type).toBe("remote.authenticate");
      expect(lastWs().last().payload).toEqual({ device_token: "tok-ok" });
      act(() => recvSnapshot(lastWs(), 3));
      expect(result.current.conn).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects automatically after an unexpected drop and resumes connecting", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("wordlyte.remote.token", "tok-1");
      vi.stubGlobal("WebSocket", FakeWebSocket);
      const { result } = renderHook(() => useRemote());
      act(() => lastWs().open());
      act(() => recvSnapshot(lastWs(), 2));
      expect(result.current.conn).toBe("connected");

      // Watchdog/server restart drops the socket.
      act(() => lastWs().onclose?.());
      expect(result.current.conn).toBe("error");
      expect(FakeWebSocket.instances.length).toBe(1);

      act(() => vi.advanceTimersByTime(1001));
      expect(result.current.conn).toBe("connecting");
      expect(FakeWebSocket.instances.length).toBe(2);
      act(() => lastWs().open());
      act(() => recvSnapshot(lastWs(), 3));
      expect(result.current.conn).toBe("connected");
      expect(result.current.snapshot?.revision).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useRemote commands", () => {
  it("attaches the current revision to mutating commands only", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useRemote());
    act(() => lastWs().open());
    act(() => recvSnapshot(lastWs(), 3));

    act(() => {
      void result.current.command("display.blackout", { on: true });
    });
    let sent = lastWs().last();
    expect(sent.type).toBe("display.blackout");
    expect(sent.expected_revision).toBe(3);

    act(() => {
      void result.current.command("bible.search", { query: "faith", version: "KJV" });
    });
    sent = lastWs().last();
    expect(sent.type).toBe("bible.search");
    expect(sent.expected_revision).toBeUndefined();

    // WebRTC signaling relays are non-mutating and must not carry a stale
    // revision or trip the mutation rate limiter.
    act(() => {
      void result.current.command("camera.ice", { candidate: "c0", sdp_mid: "0", sdp_m_line_index: 0, device_id: "phone-camera-x" });
    });
    sent = lastWs().last();
    expect(sent.type).toBe("camera.ice");
    expect(sent.expected_revision).toBeUndefined();
  });

  it("resolves the promise with the command result", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useRemote());
    act(() => lastWs().open());
    act(() => recvSnapshot(lastWs(), 1));

    let promise: Promise<unknown> | undefined;
    act(() => {
      promise = result.current.command("bible.search", { query: "faith", version: "KJV" });
    });
    const cmd = lastWs().last();
    act(() => {
      lastWs().recv({ command_id: cmd.command_id, ok: true, revision: 2, result: { method: "fuzzy", results: [] } });
    });
    await expect(promise).resolves.toEqual({ method: "fuzzy", results: [] });
  });

  it("rejects the promise when a command fails", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useRemote());
    act(() => lastWs().open());
    act(() => recvSnapshot(lastWs(), 1));

    let promise: Promise<unknown> | undefined;
    act(() => {
      promise = result.current.command("display.blackout", { on: true });
    });
    const cmd = lastWs().last();
    act(() => {
      lastWs().recv({ command_id: cmd.command_id, ok: false, revision: 1, error: { code: "stale_revision", message: "Stale client" } });
    });
    await expect(promise).rejects.toThrow("Stale client");
  });
});

describe("useRemote event hydration", () => {
  it("applies a live.changed event to the snapshot", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useRemote());
    act(() => lastWs().open());
    act(() => recvSnapshot(lastWs(), 2));

    act(() => {
      lastWs().recv({
        kind: "live.changed",
        revision: 3,
        timestamp: 1,
        payload: { live_item: { type: "Verse", data: { book: "John", chapter: 3, verse: 16, text: "For God so loved...", version: "KJV" } } },
      });
    });
    expect(result.current.snapshot?.live_item).toMatchObject({ type: "Verse" });
    expect(result.current.snapshot?.revision).toBe(3);
  });

  it("applies a controller.changed event", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useRemote());
    act(() => lastWs().open());
    act(() => recvSnapshot(lastWs(), 2));

    act(() => {
      lastWs().recv({ kind: "controller.changed", revision: 3, timestamp: 1, payload: { controller_state: { kind: "held", device_id: "d1", device_name: "iPad", expires_at: 9999999999 } } });
    });
    expect(result.current.controllerState?.kind).toBe("held");
  });

  it("applies a logo.changed event to the snapshot", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useRemote());
    act(() => lastWs().open());
    act(() => recvSnapshot(lastWs(), 2));

    act(() => {
      lastWs().recv({ kind: "logo.changed", revision: 3, timestamp: 1, payload: { logo: true } });
    });
    expect(result.current.snapshot?.background_logo).toBe(true);
    expect(result.current.snapshot?.revision).toBe(3);
  });

  it("tracks whether this device holds the lease", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useRemote());
    act(() => lastWs().open());

    act(() => {
      void result.current.pair("ABC", "iPad");
    });
    act(() => {
      lastWs().recv({ command_id: "pair", ok: true, revision: 1, result: { device_id: "d1", device_token: "tok-1", role: "operator" } });
    });
    act(() => recvSnapshot(lastWs(), 2));
    expect(result.current.selfId).toBe("d1");

    act(() => {
      lastWs().recv({
        kind: "controller.changed",
        revision: 3,
        timestamp: 1,
        payload: { controller_state: { kind: "held", device_id: "other", device_name: "Phone", expires_at: 9999999999 } },
      });
    });
    expect(result.current.isHeldBySelf).toBe(false);

    act(() => {
      lastWs().recv({
        kind: "controller.changed",
        revision: 4,
        timestamp: 1,
        payload: { controller_state: { kind: "held", device_id: "d1", device_name: "iPad", expires_at: 9999999999 } },
      });
    });
    expect(result.current.isHeldBySelf).toBe(true);
  });

  it("clears live content when the live.changed payload is null", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { result } = renderHook(() => useRemote());
    act(() => lastWs().open());
    act(() => recvSnapshot(lastWs(), 2));

    act(() => {
      lastWs().recv({ kind: "live.changed", revision: 3, timestamp: 1, payload: { live_item: null } });
    });
    expect(result.current.snapshot?.live_item).toBeNull();
  });
});
