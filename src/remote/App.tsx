import React, { useCallback, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ListOrdered, MessageSquare, Music2, Power, RefreshCw, Radio, UserCircle2, BookOpen, X } from "lucide-react";
import { storedName, useRemote } from "./wsClient";
import { Btn, Card, Label, TextInput, cx } from "./ui";
import { OnAirPanel } from "./panels/OnAirPanel";
import { BiblePanel } from "./panels/BiblePanel";
import { SongsPanel } from "./panels/SongsPanel";
import { ServicePanel } from "./panels/ServicePanel";
import { LowerThirdPanel } from "./panels/LowerThirdPanel";

type Tab = "onair" | "bible" | "songs" | "service" | "lower";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "onair", label: "On Air", icon: <Radio size={14} /> },
  { id: "bible", label: "Scripture", icon: <BookOpen size={14} /> },
  { id: "songs", label: "Songs", icon: <Music2 size={14} /> },
  { id: "service", label: "Service", icon: <ListOrdered size={14} /> },
  { id: "lower", label: "Lower ⅓", icon: <MessageSquare size={14} /> },
];

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

  const pushToast = useCallback((msg: unknown, kind: "error" | "info" = "error") => {
    const text = msg instanceof Error ? msg.message : String(msg ?? "");
    const id = Date.now() + Math.random();
    setToasts((cur) => [...cur, { id, msg: text, kind }]);
    window.setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 4200);
  }, []);

  const panelProps = useMemo(() => ({ client, pushToast }), [client, pushToast]);

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
          <button onClick={takeOrRelease} className={cx(
            "shrink-0 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase border transition-colors",
            client.isHeldBySelf
              ? "border-amber-500/50 text-amber-300 hover:bg-amber-500/10"
              : "border-cyan-700/60 text-cyan-300 hover:bg-cyan-900/30"
          )}>
            {client.isHeldBySelf ? "Release" : holderName ? "Request" : "Take control"}
          </button>
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
              Ask the operator for the code and URL (Settings → Remote Control). The URL is shown on their screen.
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
          </main>

          <nav className="grid grid-cols-5 border-t border-slate-800 bg-slate-950/95 pb-[env(safe-area-inset-bottom)]">
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