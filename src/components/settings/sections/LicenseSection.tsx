import React, { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CheckCircle2,
  Clock,
  KeyRound,
  Monitor,
  RefreshCcw,
  ShieldAlert,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useAppStore } from "../../../store";
import { TIER_CAPABILITIES, TIER_LABELS } from "../../../system/tiers";
import type { LicenseInfo, LicenseStatus } from "../../../types/license";
import type { SettingsSectionProps } from "../shared";

const STATUS_LABEL: Record<LicenseStatus, string> = {
  unactivated: "Not activated",
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
  invalid: "Invalid",
  clock_tampered: "Clock issue",
};

function fmtDate(ts?: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-console-border/60 last:border-0">
      <span className="text-[11px] font-bold uppercase tracking-widest text-console-text-muted">{label}</span>
      <span className="text-[11px] text-console-text text-right">{value}</span>
    </div>
  );
}

export function LicenseSection(_props: SettingsSectionProps) {
  const { license, setLicense } = useAppStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  const run = useCallback(async (fn: () => Promise<LicenseInfo>) => {
    setBusy(true);
    setError(null);
    try {
      setLicense(await fn());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [setLicense]);

  if (!license) return null;

  const daysLeft = license.grace_until
    ? Math.max(0, Math.ceil((license.grace_until * 1000 - Date.now()) / 86400000))
    : null;

  const active = license.status === "active";

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-console-border bg-console-surface-raised p-4 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {active ? (
            <CheckCircle2 size={16} className="text-emerald-400" />
          ) : (
            <ShieldAlert size={16} className="text-red-400" />
          )}
          <h3 className="op-control-label text-console-text uppercase tracking-widest">License</h3>
          <span
            className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full border ${
              license.tier === "free"
                ? "bg-slate-500/15 text-slate-300 border-slate-500/30"
                : license.tier === "pro"
                  ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/30"
                  : "bg-purple-500/15 text-purple-300 border-purple-500/30"
            }`}
          >
            {TIER_LABELS[license.tier]}
          </span>
          <span
            className={`ml-auto text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full ${
              active
                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                : "bg-red-500/15 text-red-300 border border-red-500/30"
            }`}
          >
            {STATUS_LABEL[license.status]}
          </span>
        </div>

        <Row label="Plan" value={TIER_LABELS[license.tier]} />
        <Row label="Church" value={license.church_name || "—"} />
        {license.email ? <Row label="Email" value={license.email} /> : null}
        {license.license_key ? <Row label="Key" value={<span className="font-mono">{license.license_key}</span>} /> : null}
        <Row label="Issued" value={fmtDate(license.issued_at)} />
        <Row label="Expires" value={fmtDate(license.expires_at)} />
        <Row
          label="Machines"
          value={`${license.machines_used} of ${license.max_machines} registered`}
        />
        <Row
          label="This computer"
          value={<span className="font-mono text-[10px]">{license.machine_id_hash.slice(0, 16)}…</span>}
        />
        {daysLeft !== null && (
          <Row
            label="Offline grace"
            value={
              <span className="inline-flex items-center gap-1">
                <WifiOff size={11} className="text-amber-400" />
                {daysLeft} day{daysLeft === 1 ? "" : "s"} remaining
              </span>
            }
          />
        )}

        <p className="text-[11px] text-console-text-muted leading-relaxed mt-1">{license.message}</p>

        {error && <p className="text-[11px] text-red-400">{error}</p>}

        <div className="flex gap-2 mt-2">
          <button
            onClick={() => run(() => invoke<LicenseInfo>("license_refresh"))}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-action-primary/15 text-action-primary border border-action-primary/30 hover:bg-action-primary/25 text-[11px] font-black uppercase tracking-widest disabled:opacity-40 transition-all"
          >
            <RefreshCcw size={12} /> {busy ? "Checking…" : "Refresh"}
          </button>
          {confirmDeactivate ? (
            <>
              <button
                onClick={() => run(() => invoke<LicenseInfo>("license_deactivate"))}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25 text-[11px] font-black uppercase tracking-widest disabled:opacity-40 transition-all"
              >
                <Trash2 size={12} /> Confirm
              </button>
              <button
                onClick={() => setConfirmDeactivate(false)}
                className="inline-flex items-center px-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-widest text-console-text-subtle hover:text-console-text transition-all"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmDeactivate(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-console-text-subtle hover:text-red-300 text-[11px] font-black uppercase tracking-widest border border-console-border hover:border-red-500/40 transition-all"
            >
              <Trash2 size={12} /> Deactivate this computer
            </button>
          )}
        </div>

        {active && license.tier === "free" && (
          <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-[11px] font-bold uppercase tracking-widest text-amber-300 mb-1">Free plan</p>
            <p className="text-[11px] text-console-text-muted leading-relaxed">
              You're on the Free plan: one Bible version, one on-air window, and a small Wordlyte
              watermark on the output. Upgrade to Pro for remote control, recording, streaming, NDI,
              unlimited scenes and templates, and more.
            </p>
            <p className="text-[11px] text-amber-300 mt-1.5">
              Contact the Wordlyte team to upgrade your license key.
            </p>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-console-border bg-console-surface-raised p-4">
        <div className="flex items-center gap-2 mb-2">
          <KeyRound size={14} className="text-console-text-muted" />
          <h3 className="op-control-label text-console-text uppercase tracking-widest">How it works</h3>
        </div>
        <ul className="text-[11px] text-console-text-muted leading-relaxed flex flex-col gap-1.5">
          <li>· Wordlyte verifies your key online on launch and periodically while running.</li>
          <li>· If the internet is unavailable, Wordlyte keeps working for {TIER_CAPABILITIES[license.tier].offlineGraceDays} days, then locks until you reconnect and refresh.</li>
          <li>· Each key allows a fixed number of computers ({license.max_machines}); copying the app to another PC will not activate it.</li>
          <li>· If your key expires, Wordlyte continues on the Free plan (or locks, if you're already on Free) until the Wordlyte team renews or upgrades it.</li>
        </ul>
        <div className="flex items-center gap-1.5 mt-3 text-[10px] text-console-text-muted">
          <Monitor size={11} /> Machine fingerprint {license.machine_id_hash}
        </div>
      </div>
    </div>
  );
}