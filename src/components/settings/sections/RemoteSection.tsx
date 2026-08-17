import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Cast,
  Check,
  ClipboardCopy,
  KeyRound,
  Power,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserX,
  Wifi,
} from "lucide-react";
import { useT } from "../../../i18n";
import { useAppStore } from "../../../store";
import { tierCapabilities } from "../../../system/tiers";
import type { RemotePermissions, RemoteRole, RemoteStatus } from "../../../types/remote";
import type { SettingsSectionProps } from "../shared";

const ROLE_OPTIONS: { value: RemoteRole; label: string }[] = [
  { value: "viewer", label: "Viewer" },
  { value: "operator", label: "Operator" },
  { value: "admin", label: "Admin" },
];

const PERMISSIONS: { key: keyof RemotePermissions; label: string }[] = [
  { key: "scripture", label: "Scripture" },
  { key: "song", label: "Songs" },
  { key: "camera", label: "Camera" },
  { key: "lower_third", label: "Lower ⅓" },
  { key: "presentation", label: "Presentation" },
];

function formatClock(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getHours()}:${mm}`;
}

function formatRemaining(expires_at?: number, now = Date.now()): string | null {
  if (!expires_at) return null;
  const ms = expires_at * 1000 - now;
  if (ms <= 0) return "expires any second…";
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function RemoteSection(_props: SettingsSectionProps) {
  const t = useT();
  const { license } = useAppStore();
  const remoteBlocked = !!license && license.status === "active" && !tierCapabilities(license.tier).remoteControl;
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  // Seconds ticker so the pairing-code countdown stays live without re-fetching
  // status every second.
  const [, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<RemoteStatus>("remote_status"));
    } catch {
      // server unreachable; leave the last known status
    }
  }, []);

  useEffect(() => {
    refresh();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    if (status?.enabled) {
      pollRef.current = window.setInterval(refresh, 4000);
    }
  }, [status?.enabled, refresh]);

  // One-second tick to drive the pairing-code countdown.
  useEffect(() => {
    if (!status?.enabled) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [status?.enabled]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const next = await fn();
      if (next && typeof next === "object") setStatus(next as RemoteStatus);
      else await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      // clipboard unavailable
    }
  };

  const heldByUs = status?.controller_state.kind === "held";
  const remoteHolds = status?.controller_state.kind === "held" || status?.controller_state.kind === "requested";

  return (
    <div className="flex flex-col gap-6">
      {/* Enable / disable */}
      <div>
        <p className="text-xs text-slate-400 font-bold uppercase mb-3">{t("settings.remote.server")}</p>
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="text-xs text-slate-300 font-medium">{t("settings.remote.serverDesc")}</span>
            <p className="text-[10px] text-slate-600 mt-0.5">{t("settings.remote.serverHint")}</p>
          </div>
          <button
            onClick={() =>
              run(() =>
                status?.enabled ? invoke("remote_disable") : invoke("remote_enable")
              )
            }
            disabled={busy || (remoteBlocked && !status?.enabled)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[10px] font-black uppercase transition-all border shrink-0 disabled:opacity-50 ${
              status?.enabled
                ? "bg-red-600 border-red-500 text-white hover:bg-red-500"
                : "bg-amber-600 border-amber-500 text-black hover:bg-amber-500"
            }`}
          >
            <Power size={12} />
            {status?.enabled ? t("settings.remote.disable") : t("settings.remote.enable")}
          </button>
        </div>
        {remoteBlocked && !status?.enabled && (
          <p className="mt-2 text-[10px] text-amber-500 font-medium">
            Remote Control is a Pro feature. Upgrade in Settings → License to control the presentation
            from a phone or tablet.
          </p>
        )}
      </div>

      {status?.enabled && (
        <>
          {/* Pairing code */}
          <div className="border-t border-slate-800 pt-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 min-w-0">
                <KeyRound size={14} className="text-amber-400 shrink-0" />
                <span className="text-sm font-black tracking-[0.35em] text-amber-400 font-mono">
                  {status.pairing_code ?? "——————"}
                </span>
                {status.pairing_expires_at && (
                  <span className="text-[10px] text-slate-500 shrink-0">
                    {t("settings.remote.expiresAt")} {formatClock(status.pairing_expires_at)}
                    {formatRemaining(status.pairing_expires_at) && (
                      <span className="text-slate-400"> · {formatRemaining(status.pairing_expires_at)}</span>
                    )}
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => copy(status.pairing_code ?? "")}
                disabled={!status.pairing_code}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 transition-all disabled:opacity-40"
              >
                {copied ? <Check size={12} className="text-green-400" /> : <ClipboardCopy size={12} />}
                {copied ? t("settings.remote.copied") : t("settings.remote.copy")}
              </button>
              <button
                onClick={() => run(() => invoke("remote_regenerate_pairing"))}
                disabled={busy}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 transition-all disabled:opacity-40"
              >
                <RefreshCcw size={12} />
                {t("settings.remote.regenerate")}
              </button>
            </div>
            <p className="text-[10px] text-slate-600 mt-2">{t("settings.remote.pairingDesc")}</p>
          </div>

          {/* Access URLs */}
          <div className="border-t border-slate-800 pt-4">
            <p className="text-[10px] text-slate-500 uppercase font-bold mb-2 flex items-center gap-1">
              <Wifi size={12} /> {t("settings.remote.urls")}
            </p>
            <div className="flex flex-col gap-1.5">
              {status.urls.length === 0 && (
                <p className="text-[10px] text-slate-600 italic">{t("settings.remote.noUrls")}</p>
              )}
              {status.urls.map((url) => (
                <div key={url} className="flex items-center justify-between gap-2 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5">
                  <code className="text-[11px] text-cyan-300 truncate">{url}</code>
                  <button
                    onClick={() => copy(url)}
                    className="shrink-0 text-slate-500 hover:text-white transition-colors"
                    aria-label={t("settings.remote.copy")}
                  >
                    {copied === url ? <Check size={12} className="text-green-400" /> : <ClipboardCopy size={12} />}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Controller lease */}
          <div className="border-t border-slate-800 pt-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] text-slate-500 uppercase font-bold flex items-center gap-1">
                  {remoteHolds ? <ShieldAlert size={12} className="text-red-400" /> : <ShieldCheck size={12} className="text-green-400" />}
                  {t("settings.remote.lease")}
                </p>
                <p className="text-[10px] text-slate-600 mt-1">
                  {status.controller_state.kind === "held"
                    ? (status.controller_state.device_name ?? status.controller_state.device_id ?? "")
                    : status.controller_state.kind === "requested"
                      ? t("settings.remote.leaseRequested")
                      : t("settings.remote.leaseFree")}
                </p>
              </div>
              <button
                onClick={() => run(() => invoke("remote_claim_control"))}
                disabled={busy || !remoteHolds}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase border border-red-700 bg-red-950/40 text-red-300 hover:bg-red-900/40 transition-all disabled:opacity-40"
              >
                <ShieldAlert size={12} />
                {t("settings.remote.reclaim")}
              </button>
            </div>
          </div>

          {/* Paired devices */}
          <div className="border-t border-slate-800 pt-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] text-slate-500 uppercase font-bold flex items-center gap-1">
                <Cast size={12} /> {t("settings.remote.devices")}
              </p>
              <button
                onClick={() => run(() => invoke("remote_revoke_all"))}
                disabled={busy || status.devices.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase border border-slate-700 text-slate-400 hover:text-red-300 hover:border-red-700 transition-all disabled:opacity-40"
              >
                <Trash2 size={12} />
                {t("settings.remote.revokeAll")}
              </button>
            </div>
            {status.devices.length === 0 && (
              <p className="text-[10px] text-slate-600 italic">{t("settings.remote.noDevices")}</p>
            )}
            <p className="text-[10px] text-slate-600 mb-2">{t("settings.remote.roleHint")}</p>
            <div className="flex flex-col gap-2">
              {status.devices.map((d) => (
                <div key={d.id} className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${d.connected ? "bg-green-400" : "bg-slate-600"}`} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-slate-200 font-semibold truncate">{d.name}</span>
                          <span className="text-[9px] uppercase font-black px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                            {d.role}
                          </span>
                        </div>
                        <p className="text-[9px] text-slate-600">
                          {d.connected ? t("settings.remote.connected") : t("settings.remote.disconnected")}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <select
                        value={d.role}
                        disabled={busy}
                        onChange={(e) => run(() => invoke("remote_set_role", { deviceId: d.id, role: e.target.value }))}
                        className="bg-slate-800 border border-slate-700 rounded-md text-[10px] text-slate-200 px-1.5 py-1 disabled:opacity-50"
                      >
                        {ROLE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => run(() => invoke("remote_revoke_device", { deviceId: d.id }))}
                        disabled={busy}
                        className="text-slate-500 hover:text-red-300 transition-colors p-1"
                        aria-label={t("settings.remote.revoke")}
                      >
                        <UserX size={13} />
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {PERMISSIONS.map((p) => {
                      const on = Boolean(d.permissions?.[p.key]);
                      return (
                        <button
                          key={p.key}
                          disabled={busy}
                          onClick={() =>
                            run(() =>
                              invoke("remote_set_permissions", {
                                deviceId: d.id,
                                permissions: { ...(d.permissions ?? {}), [p.key]: !on },
                              })
                            )
                          }
                          title={t("settings.remote.permissionHint", { name: d.name, perm: p.label })}
                          className={`flex items-center gap-1 px-2 py-1 rounded-md text-[9px] font-bold uppercase border transition-all disabled:opacity-50 ${
                            on
                              ? "bg-cyan-500/15 border-cyan-500/60 text-cyan-300"
                              : "bg-slate-800/60 border-slate-700 text-slate-500 hover:text-slate-300"
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${on ? "bg-cyan-400" : "bg-slate-600"}`} />
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {err && <p className="text-[10px] text-red-400 border border-red-900 bg-red-950/40 rounded-lg px-3 py-2">{err}</p>}
    </div>
  );
}