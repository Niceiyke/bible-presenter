import React, { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  KeyRound,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useAppStore } from "../store";
import type { LicenseInfo, LicenseStatus } from "../types/license";

const STATUS_META: Record<LicenseStatus, { title: string; icon: React.ReactNode; accent: string }> = {
  active: {
    title: "License active",
    icon: <CheckCircle2 size={20} className="text-emerald-400" />,
    accent: "bg-emerald-500/15 border-emerald-500/30",
  },
  unactivated: {
    title: "Activate Wordlyte",
    icon: <KeyRound size={20} className="text-amber-400" />,
    accent: "bg-amber-500/15 border-amber-500/30",
  },
  expired: {
    title: "License expired",
    icon: <Clock size={20} className="text-red-400" />,
    accent: "bg-red-500/15 border-red-500/30",
  },
  revoked: {
    title: "License revoked",
    icon: <ShieldAlert size={20} className="text-red-400" />,
    accent: "bg-red-500/15 border-red-500/30",
  },
  invalid: {
    title: "License not valid here",
    icon: <ShieldAlert size={20} className="text-red-400" />,
    accent: "bg-red-500/15 border-red-500/30",
  },
  clock_tampered: {
    title: "Clock issue detected",
    icon: <AlertTriangle size={20} className="text-red-400" />,
    accent: "bg-red-500/15 border-red-500/30",
  },
};

export function LicenseGate() {
  const { license, setLicense } = useAppStore();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = license?.status ?? "unactivated";
  const meta = STATUS_META[status];

  const apply = useCallback((info: LicenseInfo) => {
    setLicense(info);
    if (info.status !== "active") {
      setError(info.message || "The license could not be activated.");
    } else {
      setError(null);
    }
  }, [setLicense]);

  const activate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      apply(await invoke<LicenseInfo>("license_activate", { key: key.trim() }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [key, apply]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      apply(await invoke<LicenseInfo>("license_refresh"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [apply]);

  const switchKey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      apply(await invoke<LicenseInfo>("license_deactivate"));
      setKey("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [apply]);

  const needsKeyInput = status === "unactivated";

  return (
    <div className="h-screen bg-slate-950 text-slate-200 flex items-center justify-center select-none">
      <div className="w-full max-w-md px-6">
        {/* Brand */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="w-12 h-12 bg-amber-500 rounded-xl flex items-center justify-center text-black font-black text-lg">
            WL
          </div>
          <p className="text-xs font-black uppercase tracking-[0.25em] text-slate-500">Wordlyte</p>
        </div>

        <div className={`rounded-xl border ${meta.accent} p-5`}>
          <div className="flex items-center gap-3 mb-1">
            {meta.icon}
            <h1 className="text-base font-black text-slate-100">{meta.title}</h1>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed mt-1">
            {license?.message ||
              "Enter the license key issued to your church during the Wordlyte beta."}
          </p>

          {needsKeyInput && (
            <div className="mt-4 flex flex-col gap-2">
              {license?.offline && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                  <WifiOff size={12} className="text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-amber-200/90 leading-relaxed">
                    This computer is offline and cannot reach the license server.
                    Activating a key requires an internet connection. Check the
                    connection (or the license server), then retry.
                  </p>
                </div>
              )}
              <input
                autoFocus
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") activate(); }}
                placeholder="WORDLYTE-XXXX-XXXX-XXXX-XXXX"
                spellCheck={false}
                className="w-full bg-slate-900 text-slate-100 text-sm rounded-lg px-3 py-2.5 border border-slate-700 focus:border-amber-500 focus:outline-none focus-visible:outline-2 focus-visible:outline-amber-500/50 uppercase tracking-wider"
              />
              <button
                onClick={activate}
                disabled={busy || !key.trim()}
                className="mt-1 w-full py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-black text-xs font-black uppercase tracking-widest transition-all"
              >
                {busy ? "Activating…" : "Activate"}
              </button>
              <p className="text-[11px] text-slate-500 text-center">
                Need a key? Contact the Wordlyte team — keys are issued per church during the beta.
              </p>
            </div>
          )}

          {!needsKeyInput && (
            <div className="mt-4 flex flex-col gap-2">
              {status === "clock_tampered" && (
                <p className="text-[11px] text-slate-500">
                  Set the correct date and time on this computer, then refresh the license.
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={refresh}
                  disabled={busy}
                  className="flex-1 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-black text-xs font-black uppercase tracking-widest transition-all"
                >
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <RefreshCcw size={12} /> Retry / Refresh
                  </span>
                </button>
                <button
                  onClick={switchKey}
                  disabled={busy}
                  className="flex-1 py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 text-xs font-black uppercase tracking-widest border border-slate-700 transition-all"
                >
                  Use a different key
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="mt-3 text-[11px] text-red-400 leading-relaxed">{error}</p>
          )}
        </div>

        {/* Status footer */}
        <div className="mt-5 flex flex-col items-center gap-1.5">
          {license?.offline ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-400/90">
              <WifiOff size={12} /> Offline — could not reach the license server
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
              <Wifi size={12} /> Online license checks enabled
            </span>
          )}
          {license?.status === "active" && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400/90">
              <CheckCircle2 size={12} /> {license.church_name}
              {license.expires_at ? ` · valid until ${new Date(license.expires_at * 1000).toLocaleDateString()}` : ""}
            </span>
          )}
          <span className="text-[10px] text-slate-600 font-mono">
            {license?.machine_id_hash ? `machine ${license.machine_id_hash.slice(0, 12)}…` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

export function OfflineLicenseBanner() {
  const { license, setLicense } = useAppStore();
  if (!license || license.status !== "active" || !license.offline) return null;

  const daysLeft = license.grace_until
    ? Math.max(0, Math.ceil((license.grace_until * 1000 - Date.now()) / 86400000))
    : null;

  return (
    <div className="bg-sky-950/90 border-b border-sky-700 px-4 py-2 flex items-center gap-2 text-xs text-sky-200">
      <ShieldCheck size={14} className="text-sky-400 shrink-0" />
      <div className="flex-1">
        <span className="font-bold text-sky-300">Offline license mode: </span>
        {daysLeft === null
          ? "Wordlyte could not reach the license server and is running on its offline grace period."
          : `Wordlyte could not reach the license server. Reconnect the internet within ${daysLeft} day${daysLeft === 1 ? "" : "s"} to keep it active.`}
      </div>
      <button
        onClick={() => invoke<LicenseInfo>("license_refresh").then(setLicense).catch(() => {})}
        className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-sky-800 hover:bg-sky-700 text-sky-100 font-bold uppercase tracking-wide transition-colors"
      >
        <RefreshCcw size={11} /> Check now
      </button>
    </div>
  );
}