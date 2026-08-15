import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, ListOrdered, MessageSquare, Music2, Power, RefreshCw, Radio, UserCircle2, BookOpen, X, Video, Presentation } from "lucide-react";
import { storedName, useRemote } from "./wsClient";
import { Btn, Card, Label, TextInput, cx } from "./ui";
import { OnAirPanel } from "./panels/OnAirPanel";
import { BiblePanel } from "./panels/BiblePanel";
import { SongsPanel } from "./panels/SongsPanel";
import { ServicePanel } from "./panels/ServicePanel";
import { LowerThirdPanel } from "./panels/LowerThirdPanel";
import { CameraPanel } from "./panels/CameraPanel";
import { TimersPanel } from "./panels/TimersPanel";
import { StudioPanel } from "./panels/StudioPanel";
import { itemTitle } from "./itemLabel";
import type { DisplayItem } from "../types/display";

type Tab = "onair" | "bible" | "songs" | "service" | "lower" | "camera" | "timers" | "studio";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "onair", label: "On Air", icon: <Radio size={14} /> },
  { id: "bible", label: "Scripture", icon: <BookOpen size={14} /> },
  { id: "songs", label: "Songs", icon: <Music2 size={14} /> },
  { id: "service", label: "Service", icon: <ListOrdered size={14} /> },
  { id: "lower", label: "Lower ⅓", icon: <MessageSquare size={14} /> },
  { id: "camera", label: "Camera", icon: <Video size={14} /> },
  { id: "timers", label: "Timers", icon: <Clock size={14} /> },
  { id: "studio", label: "Studio", icon: <Presentation size={14} /> },
];

/** Stable identity for a live item so "Now Live" notifications fire only on
 *  actual content changes, not on every revision bump. */
function liveKeyOf(item: DisplayItem): string {
  switch (item.type) {
    case "Verse":
      return `verse:${item.data.book}:${item.data.chapter}:${item.data.verse}`;
    case "Song":
      return `song:${item.data.song_id ?? item.data.title}:${item.data.slide_index}`;
    case "Media":
      return `media:${item.data.id ?? item.data.name}`;
    case "Camera":
      return `camera:${item.data.deviceId}`;
    case "CustomSlide":
      return `slide:${item.data.presentation_id ?? ""}:${item.data.slide_index}`;
    case "Timer":
      return `timer:${item.data.timer_type}:${item.data.label ?? ""}:${item.data.started_at ?? ""}`;
    default:
      return `item:${itemTitle(item)}`;
  }
}

interface Toast {
  id: number;
  msg: string;
  kind: "error" | "info";
}

export function App() {
  const client = useRemote();
  const [tab, setTab] = useState<Tab>("onair");
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(storedName() || "");
  const [pairing, setPairing] = useState(false);
  const [pairErr, setPairErr] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // A `#pair=<code>` fragment (appended by the operator's QR code) auto-pairs
  // this device. The fragment is cleared immediately so a later refresh can't
  // re-pair with an already-used code.
  const [autoPairCode, setAutoPairCode] = useState<string | null>(() => {
    const m = window.location.hash.match(/^#pair=([A-Za-z0-9_-]+)/);
    if (m) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
      return m[1];
    }
    return null;
  });

  const pushToast = useCallback((msg: unknown, kind: "error" | "info" = "error") => {
    const text = msg instanceof Error ? msg.message : String(msg ?? "");
    const id = Date.now() + Math.random();
    setToasts((cur) => [...cur, { id, msg: text, kind }]);
    window.setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 4200);
  }, []);

  const panelProps = useMemo(() => ({ client, pushToast }), [client, pushToast]);

  // Keep the screen awake while the operator console is open on the phone.
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    let active = true;
    const acquire = async () => {
      if (!active) return;
      try {
        if ("wakeLock" in navigator && typeof navigator.wakeLock?.request === "function") {
          wakeLock = await navigator.wakeLock.request("screen");
        }
      } catch {
        /* Wake Lock is best-effort (e.g. battery saver, unsupported browsers). */
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") acquire();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void acquire();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
      wakeLock?.release?.().catch(() => {});
    };
  }, []);

  // Notify when a different item goes live. The first snapshot is skipped so a
  // fresh connection doesn't spam a "Now Live" toast.
  const liveItem = client.snapshot?.live_item ?? null;
  const liveKey = liveItem ? liveKeyOf(liveItem) : null;
  const prevLiveKeyRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevLiveKeyRef.current === undefined) {
      prevLiveKeyRef.current = liveKey;
      return;
    }
    if (liveKey && liveKey !== prevLiveKeyRef.current) {
      pushToast(`Now Live: ${itemTitle(liveItem)}`, "info");
    }
    prevLiveKeyRef.current = liveKey;
  }, [liveKey, liveItem, pushToast]);

  const doPair = async () => {
    if (!code.trim()) {
      setPairErr("Enter the pairing code shown in the operator's Settings.");
      return;
    }
    if (!deviceName.trim()) {
      setPairErr("Give this device a name, e.g. “Tablet 1”.");
      return;
    }
    setPairing(true);
    setPairErr(null);
    try {
      await client.pair(code, deviceName);
    } catch (e) {
      setPairErr(String((e as Error).message ?? e));
    } finally {
      setPairing(false);
    }
  };

  // Auto-pair from a `#pair=<code>` fragment once the handshake reaches the
  // pairing screen. On failure the code stays in the input so the operator can
  // retry manually (expired/rate-limited codes are transient). The ref guards
  // against StrictMode double-invoking the effect (the code is single-use).
  const autoPairStartedRef = useRef(false);
  useEffect(() => {
    if (!autoPairCode) return;
    if (client.conn !== "pairing") return;
    if (autoPairStartedRef.current) return;
    autoPairStartedRef.current = true;
    const name = deviceName.trim() || "My Device";
    setCode(autoPairCode);
    setDeviceName(name);
    setPairing(true);
    setPairErr(null);
    client
      .pair(autoPairCode, name)
      .catch((e) => setPairErr(String((e as Error).message ?? e)))
      .finally(() => {
        setAutoPairCode(null);
        setPairing(false);
      });
  }, [autoPairCode, client.conn]);

  const takeOrRelease = async () => {
    try {
      if (client.isHeldBySelf) {
        await client.releaseControl();
        pushToast("Control released", "info");
      } else {
        await client.requestControl();
        pushToast("You now control the presentation", "info");
      }
    } catch (e) {
      pushToast(String((e as Error).message ?? e));
    }
  };

  const holderName = client.controllerState?.kind === "held" ? client.controllerState.device_name ?? "another device" : null;

  // Content permissions granted to this device. A read-only device cannot take
  // control, so the lease button is hidden and the panels show read-only views.
  const perms = client.snapshot?.permissions;
  const canTakeControl = Boolean(perms && (perms.scripture || perms.song || perms.camera || perms.lower_third || perms.presentation));

  return (
    <div className="h-full flex flex-col">
      {/* Top bar */}
      <header className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <span className="text-[13px] font-black tracking-wide shrink-0">Wordlyte</span>
        <span className="text-[9px] uppercase font-bold text-slate-500 shrink-0">Remote</span>

        <div className="flex-1" />

        {client.conn === "connected" ? (
          <span className="flex items-center gap-1.5 text-[10px] text-green-400 font-semibold shrink-0">
            <CheckCircle2 size={12} /> Live
          </span>
        ) : client.conn === "error" ? (
          <span className="flex items-center gap-1.5 text-[10px] text-red-400 font-semibold shrink-0">
            <AlertTriangle size={12} /> Offline
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-[10px] text-slate-500 shrink-0">
            <RefreshCw size={12} className="animate-spin" /> Connecting…
          </span>
        )}
        <Btn variant="ghost" onClick={client.forgetDevice} className="px-2 py-1 shrink-0" title="Forget this device and re-pair">
          <Power size={12} />
        </Btn>
      </header>

      {/* Lease bar */}
      {client.conn === "connected" && (
        <div className={cx(
          "flex items-center gap-2 px-3 py-1.5 border-b text-[11px]",
          client.isHeldBySelf
            ? "bg-amber-500/10 border-amber-500/30 text-amber-200"
            : holderName
              ? "bg-red-950/30 border-red-900/60 text-red-200"
              : "bg-slate-900/50 border-slate-800 text-slate-400"
        )}>
          <UserCircle2 size={13} className="shrink-0" />
          <span className="truncate">
            {client.isHeldBySelf
              ? "You are controlling the presentation"
              : holderName
                ? `${holderName} is controlling — you can only watch`
                : "No one is controlling yet"}
          </span>
          <span className="flex-1" />
          {(client.isHeldBySelf || canTakeControl) && (
            <button onClick={takeOrRelease} className={cx(
              "shrink-0 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase border transition-colors",
              client.isHeldBySelf
                ? "border-amber-500/50 text-amber-300 hover:bg-amber-500/10"
                : "border-cyan-700/60 text-cyan-300 hover:bg-cyan-900/30"
            )}>
              {client.isHeldBySelf ? "Release" : holderName ? "Request" : "Take control"}
            </button>
          )}
        </div>
      )}

      {/* Now Live banner */}
      {client.conn === "connected" && liveItem && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-red-900/50 bg-red-950/40 text-red-200 text-[11px]">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
          <span className="truncate font-semibold">Now Live: {itemTitle(liveItem)}</span>
        </div>
      )}

      {/* Body */}
      {client.conn === "connecting" && (
        <div className="flex-1 flex items-center justify-center">
          <Card className="text-center max-w-xs">
            <p className="text-sm text-slate-300 font-semibold">Connecting…</p>
            <p className="text-[11px] text-slate-500 mt-1">Waiting for the Wordlyte operator on this network.</p>
          </Card>
        </div>
      )}

      {client.conn === "error" && (
        <div className="flex-1 flex items-center justify-center p-4">
          <Card className="text-center max-w-xs w-full">
            <p className="text-sm text-red-300 font-semibold">Can't reach Wordlyte</p>
            <p className="text-[11px] text-slate-500 mt-1">Make sure the operator enabled Remote Control, then stay on the same Wi-Fi and retry.</p>
            <div className="mt-3">
              <Btn variant="primary" onClick={client.connect} className="w-full"><RefreshCw size={13} /> Retry</Btn>
            </div>
          </Card>
        </div>
      )}

      {client.conn === "pairing" && (
        <div className="flex-1 flex items-center justify-center p-4 overflow-y-auto">
          <Card className="max-w-xs w-full">
            <Label>Pair this device</Label>
            <div className="flex flex-col gap-2">
              <TextInput value={code} onChange={setCode} placeholder="Pairing code (6 letters)" className="uppercase tracking-[0.3em] text-center text-lg" />
              <TextInput value={deviceName} onChange={setDeviceName} placeholder="Device name, e.g. Tablet 1" />
            </div>
            {pairErr && <p className="mt-2 text-[10px] text-red-400">{pairErr}</p>}
            <div className="mt-3">
              <Btn variant="primary" onClick={doPair} disabled={pairing} className="w-full">
                {pairing ? "Pairing…" : "Pair"}
              </Btn>
            </div>
            <p className="mt-3 text-[10px] text-slate-500 leading-relaxed">
              {pairing ? "Pairing…" : "Scan the QR code in the operator's Remote tab to pair automatically, or enter the code shown there."}
            </p>
          </Card>
        </div>
      )}

      {client.conn === "connected" && (
        <>
          <main className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
            {tab === "onair" && <OnAirPanel {...panelProps} />}
            {tab === "bible" && <BiblePanel {...panelProps} />}
            {tab === "songs" && <SongsPanel {...panelProps} />}
            {tab === "service" && <ServicePanel {...panelProps} />}
            {tab === "lower" && <LowerThirdPanel {...panelProps} />}
            {tab === "camera" && <CameraPanel {...panelProps} />}
            {tab === "timers" && <TimersPanel {...panelProps} />}
            {tab === "studio" && <StudioPanel {...panelProps} />}
          </main>

          <nav className="grid grid-cols-8 border-t border-slate-800 bg-slate-950/95 pb-[env(safe-area-inset-bottom)]">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cx(
                  "flex flex-col items-center gap-1 py-2.5 text-[9px] font-bold uppercase tracking-wider transition-colors",
                  tab === t.id ? "text-amber-400" : "text-slate-500 hover:text-slate-300"
                )}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </nav>
        </>
      )}

      {/* Toasts */}
      <div className="fixed top-12 right-3 z-50 flex flex-col gap-2 max-w-[82vw]">
        {toasts.map((t) => (
          <button
            key={t.id}
            onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}
            className={cx(
              "text-left text-[11px] rounded-lg px-3 py-2 border shadow-lg flex items-start gap-2",
              t.kind === "error"
                ? "bg-red-950/95 border-red-900 text-red-200"
                : "bg-cyan-950/95 border-cyan-900 text-cyan-200"
            )}
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span className="flex-1">{t.msg}</span>
            <X size={12} className="shrink-0 opacity-60" />
          </button>
        ))}
      </div>
    </div>
  );
}