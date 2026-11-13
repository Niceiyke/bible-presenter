import React, { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useAppStore } from "../store";
import { BrandLockup } from "./brand/Brand";
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
  const [activationCode, setActivationCode] = useState("");
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
      apply(await invoke<LicenseInfo>("license_activate", { activationCode: activationCode.trim() }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [activationCode, apply]);

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
      setActivationCode("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [apply]);

  const openDashboard = useCallback(async () => {
    try {
      await open("https://dashboard.wordlyte.com");
    } catch (e) {
      setError(`Could not open the Wordlyte Dashboard: ${String(e)}`);
    }
  }, []);

  const needsActivationInput = status === "unactivated";

  return (
    <div className="flex h-screen select-none items-center justify-center bg-console-canvas text-console-text">
      <div className="w-full max-w-md px-6">
        {/* Brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <BrandLockup className="h-11 w-auto" />
          <p className="text-[9px] font-black uppercase tracking-[0.25em] text-console-text-subtle">Church Production Suite</p>
        </div>

        <div className={`rounded-xl border ${meta.accent} p-5`}>
          <div className="flex items-center gap-3 mb-1">
            {meta.icon}
            <h1 className="text-base font-black text-console-text">{meta.title}</h1>
          </div>

          <p className="mt-1 text-xs leading-relaxed text-console-text-muted">
              {license?.message ||
               "Ask your Wordlyte organization owner for a device activation code for this computer."}
            </p>

           {needsActivationInput && (
            <div className="mt-4 flex flex-col gap-2">
              {license?.offline && (
                <div className="flex items-start gap-2 rounded-lg border border-action-primary/30 bg-action-primary/10 px-3 py-2">
                  <WifiOff size={12} className="mt-0.5 shrink-0 text-action-primary" />
                  <p className="text-[11px] leading-relaxed text-action-primary">
                    This computer is offline and cannot reach the license server.
                     Activating this computer requires an internet connection. Check the
                    connection (or the license server), then retry.
                  </p>
                </div>
              )}
              <input
                autoFocus
                value={activationCode}
                onChange={(e) => setActivationCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === "Enter") activate(); }}
                placeholder="WACT-XXXXXXXXXXXXXXXXXXXX"
                spellCheck={false}
                className="w-full rounded-lg border border-console-border bg-console-surface-raised px-3 py-2.5 text-sm uppercase tracking-wider text-console-text focus:border-action-primary focus:outline-none focus-visible:outline-2 focus-visible:outline-action-primary/50"
              />
              <button
                onClick={activate}
                disabled={busy || !activationCode.trim()}
                className="mt-1 w-full rounded-lg bg-action-primary py-2.5 text-xs font-black uppercase tracking-widest text-black transition-all hover:bg-action-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Activating…" : "Activate this computer"}
              </button>
              <p className="text-center text-[11px] text-console-text-subtle">
                Need a code? Ask the owner of your Wordlyte organization to create one for this computer.
              </p>
              <button
                type="button"
                onClick={openDashboard}
                className="text-[11px] font-bold text-action-primary underline underline-offset-2 transition-colors hover:text-action-primary-hover"
              >
                New to Wordlyte? Sign up in the Dashboard
              </button>
            </div>
          )}

           {!needsActivationInput && (
            <div className="mt-4 flex flex-col gap-2">
              {status === "clock_tampered" && (
                <p className="text-[11px] text-console-text-subtle">
                  Set the correct date and time on this computer, then refresh the license.
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={refresh}
                  disabled={busy}
                  className="flex-1 rounded-lg bg-action-primary py-2.5 text-xs font-black uppercase tracking-widest text-black transition-all hover:bg-action-primary-hover disabled:opacity-40"
                >
                  <span className="inline-flex items-center justify-center gap-1.5">
                    <RefreshCcw size={12} /> Retry / Refresh
                  </span>
                </button>
                <button
                  onClick={switchKey}
                  disabled={busy}
                  className="flex-1 rounded-lg border border-console-border bg-console-surface-strong py-2.5 text-xs font-black uppercase tracking-widest text-console-text-muted transition-all hover:bg-console-surface-raised disabled:opacity-40"
                >
                    Use a different account
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="mt-3 text-[11px] leading-relaxed text-state-error">{error}</p>
          )}
        </div>

        {/* Status footer */}
        <div className="mt-5 flex flex-col items-center gap-1.5">
          {license?.offline ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-action-primary/90">
              <WifiOff size={12} /> Offline — could not reach the license server
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-console-text-subtle">
              <Wifi size={12} /> Online license checks enabled
            </span>
          )}
          {license?.status === "active" && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400/90">
              <CheckCircle2 size={12} /> {license.church_name}
              {license.plan_expires_at ? ` · ${license.tier} plan until ${new Date(license.plan_expires_at * 1000).toLocaleDateString()}` : " · Activated"}
            </span>
          )}
          <span className="font-mono text-[10px] text-console-text-subtle">
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
    <div className="flex items-center gap-2 border-b border-action-primary/30 bg-action-primary/10 px-4 py-2 text-xs text-console-text">
      <ShieldCheck size={14} className="shrink-0 text-action-primary" />
      <div className="flex-1">
        <span className="font-bold text-action-primary">Offline license mode: </span>
        {daysLeft === null
          ? "Wordlyte could not reach the license server and is running on its offline grace period."
          : `Wordlyte could not reach the license server. Reconnect the internet within ${daysLeft} day${daysLeft === 1 ? "" : "s"} to keep it active.`}
      </div>
      <button
        onClick={() => invoke<LicenseInfo>("license_refresh").then(setLicense).catch(() => {})}
        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-action-primary px-2 py-1 font-bold uppercase tracking-wide text-black transition-colors hover:bg-action-primary-hover"
      >
        <RefreshCcw size={11} /> Check now
      </button>
    </div>
  );
}
