import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import QRCode from "qrcode";
import {
  Cast,
  Check,
  ClipboardCopy,
  KeyRound,
  MonitorSmartphone,
  Pencil,
  Power,
  RadioTower,
  RefreshCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserX,
  Wifi,
  X,
} from "lucide-react";
import { useAppStore } from "../store";
import { useT } from "../i18n";
import { itemTitle } from "../remote/itemLabel";
import type { RemotePermissions, RemoteRole, RemoteStatus } from "../types/remote";
import { Button, Panel, SectionHeader, StatusBadge } from "./ui";

const ROLE_OPTIONS: { value: RemoteRole; labelKey: string }[] = [
  { value: "viewer", labelKey: "settings.remote.viewer" },
  { value: "operator", labelKey: "settings.remote.operator" },
  { value: "admin", labelKey: "settings.remote.admin" },
];

const PERMISSIONS: { key: keyof RemotePermissions; label: string }[] = [
  { key: "scripture", label: "Scripture" },
  { key: "song", label: "Songs" },
  { key: "camera", label: "Camera" },
  { key: "lower_third", label: "Lower ⅓" },
  { key: "presentation", label: "Presentation" },
];

const AUTO_REVOKE_HOURS: number[] = [2, 6, 12, 24, 72];

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

export function RemoteTab() {
  const t = useT();
  const { liveItem, settings, outputVisible, setToast } = useAppStore();

  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const pollRef = useRef<number | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
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
    const id = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [status?.enabled]);

  // Regenerate the QR whenever the pairing code or primary URL changes.
  const qrValue =
    status?.enabled && status.pairing_code && status.urls.length > 0
      ? `${status.urls[0]}#pair=${status.pairing_code}`
      : null;

  useEffect(() => {
    if (!qrValue) {
      setQrUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(qrValue, { width: 176, margin: 1, errorCorrectionLevel: "M" })
      .then((dataUrl) => {
        if (!cancelled) setQrUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [qrValue]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
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
    },
    [refresh]
  );

  const toggleEnabled = () => {
    const enable = !status?.enabled;
    run(() => (enable ? invoke("remote_enable") : invoke("remote_disable"))).then(() => {
      setToast(t(enable ? "remote.toastEnabled" : "remote.toastDisabled"));
    });
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      // clipboard unavailable
    }
  };

  const saveRename = async (id: string) => {
    const name = renameValue.trim();
    if (!name) return;
    await run(() => invoke("remote_rename_device", { deviceId: id, name }));
    setRenamingId(null);
    setRenameValue("");
  };

  const startRename = (d: { id: string; name: string }) => {
    setRenamingId(d.id);
    setRenameValue(d.name);
    window.setTimeout(() => renameInputRef.current?.focus(), 0);
  };

  const setPermissionPreset = (id: string, all: boolean) => {
    run(() =>
      invoke("remote_set_permissions", {
        deviceId: id,
        permissions: {
          scripture: all,
          song: all,
          camera: all,
          lower_third: all,
          presentation: all,
        },
      })
    );
  };

  const remoteHolds = status?.controller_state.kind === "held" || status?.controller_state.kind === "requested";
  const connectedCount = status?.devices.filter((d) => d.connected).length ?? 0;

  return (
    <div className="flex flex-col gap-4 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-console-text">{t("remote.title")}</h2>
          <p className="text-[10px] text-console-text-subtle">{t("remote.subtitle")}</p>
        </div>
        <Button
          variant={status?.enabled ? "live" : "primary"}
          icon={<Power size={12} />}
          disabled={busy}
          onClick={toggleEnabled}
        >
          {status?.enabled ? t("settings.remote.disable") : t("settings.remote.enable")}
        </Button>
      </div>

      {!status?.enabled ? (
        <Panel className="p-8 flex flex-col items-center gap-2 text-center">
          <MonitorSmartphone size={32} className="text-console-text-subtle" />
          <p className="text-xs text-console-text-muted max-w-sm">{t("settings.remote.serverDesc")}</p>
          <p className="text-[10px] text-console-text-subtle max-w-sm">{t("settings.remote.serverHint")}</p>
          <div className="mt-2">
            <Button variant="primary" icon={<Power size={12} />} disabled={busy} onClick={toggleEnabled}>
              {t("settings.remote.enable")}
            </Button>
          </div>
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 items-start">
          {/* Left column: pairing, URLs, auto-revoke */}
          <div className="flex flex-col gap-4">
            <Panel>
              <SectionHeader icon={<KeyRound size={14} />} title={t("remote.pairingCard")} />
              <div className="flex gap-4 px-3 pb-2 items-center">
                <div className="shrink-0 rounded-lg border border-console-border bg-white p-1.5">
                  {qrUrl ? (
                    <img src={qrUrl} width={176} height={176} alt="Pairing QR code" className="block" />
                  ) : (
                    <div className="w-44 h-44 bg-console-surface-raised rounded animate-pulse" />
                  )}
                </div>
                <div className="flex flex-col gap-2 min-w-0">
                  <span className="text-xl font-black tracking-[0.35em] text-amber-400 font-mono">
                    {status.pairing_code ?? "——————"}
                  </span>
                  {status.pairing_expires_at && (
                    <span className="text-[10px] text-console-text-subtle">
                      {t("settings.remote.expiresAt")} {formatClock(status.pairing_expires_at)}
                      {formatRemaining(status.pairing_expires_at) && (
                        <span className="text-console-text-muted">
                          {" · "}
                          {formatRemaining(status.pairing_expires_at)}
                        </span>
                      )}
                    </span>
                  )}
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={copied === "code" ? <Check size={12} className="text-green-400" /> : <ClipboardCopy size={12} />}
                      disabled={!status.pairing_code}
                      onClick={() => copy(status.pairing_code ?? "")}
                    >
                      {copied === "code" ? t("settings.remote.copied") : t("settings.remote.copy")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<RefreshCcw size={12} />}
                      disabled={busy}
                      onClick={() => run(() => invoke("remote_regenerate_pairing"))}
                    >
                      {t("settings.remote.regenerate")}
                    </Button>
                  </div>
                  <p className="text-[10px] text-console-text-subtle">{t("remote.scanHint")}</p>
                </div>
              </div>
              <p className="px-3 pb-3 text-[10px] text-console-text-subtle">{t("settings.remote.pairingDesc")}</p>
            </Panel>

            <Panel>
              <SectionHeader icon={<Wifi size={14} />} title={t("settings.remote.urls")} />
              <div className="px-3 pb-3 flex flex-col gap-1.5">
                {status.urls.length === 0 && (
                  <p className="text-[10px] text-console-text-subtle italic">{t("settings.remote.noUrls")}</p>
                )}
                {status.urls.map((url) => (
                  <div
                    key={url}
                    className="flex items-center justify-between gap-2 bg-console-surface-raised border border-console-border rounded-lg px-3 py-1.5"
                  >
                    <code className="text-[11px] text-cyan-300 truncate">{url}</code>
                    <button
                      onClick={() => copy(url)}
                      aria-label={t("settings.remote.copy")}
                      className="shrink-0 text-console-text-subtle hover:text-white transition-colors"
                    >
                      {copied === url ? <Check size={12} className="text-green-400" /> : <ClipboardCopy size={12} />}
                    </button>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel>
              <SectionHeader icon={<ShieldAlert size={14} />} title={t("remote.autoRevoke")} />
              <div className="px-3 pb-3">
                <select
                  value={status.auto_revoke_hours ?? ""}
                  disabled={busy}
                  onChange={(e) =>
                    run(() =>
                      invoke("remote_set_auto_revoke", {
                        hours: e.target.value === "" ? null : Number(e.target.value),
                      })
                    )
                  }
                  className="w-full bg-console-surface-raised text-console-text text-[11px] rounded-md px-2 py-1.5 border border-console-border focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
                >
                  <option value="">{t("remote.off")}</option>
                  {AUTO_REVOKE_HOURS.map((h) => (
                    <option key={h} value={h}>
                      {h} {t("remote.hours")}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-console-text-subtle mt-2">{t("remote.autoRevokeDesc")}</p>
              </div>
            </Panel>
          </div>

          {/* Right column: on-air, lease, devices */}
          <div className="flex flex-col gap-4">
            <Panel>
              <SectionHeader
                icon={<RadioTower size={14} />}
                title={t("remote.onAirCard")}
                actions={
                  <StatusBadge
                    tone={liveItem ? "live" : "neutral"}
                    label={liveItem ? t("remote.onAir") : t("remote.nothing")}
                    pulsing={Boolean(liveItem)}
                  />
                }
              />
              <div className="px-3 pb-3">
                <p className="text-xs font-semibold text-console-text truncate">{liveItem ? itemTitle(liveItem) : t("remote.nothing")}</p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {settings.is_blanked && <StatusBadge tone="warning" label={t("remote.blanked")} />}
                  <StatusBadge
                    tone={outputVisible ? "success" : "neutral"}
                    label={outputVisible ? t("remote.outputVisible") : t("remote.outputHidden")}
                  />
                  {settings.show_background_logo && <StatusBadge tone="design" label={t("remote.backgroundLogo")} />}
                  <StatusBadge
                    tone={connectedCount > 0 ? "success" : "neutral"}
                    label={t("remote.connectedCount", { count: connectedCount })}
                  />
                </div>
              </div>
            </Panel>

            <Panel>
              <SectionHeader
                icon={
                  remoteHolds ? (
                    <ShieldAlert size={14} className="text-state-live" />
                  ) : (
                    <ShieldCheck size={14} className="text-state-success" />
                  )
                }
                title={t("settings.remote.lease")}
                actions={
                  <Button
                    variant="live"
                    size="sm"
                    icon={<ShieldAlert size={12} />}
                    disabled={busy || !remoteHolds}
                    onClick={() => run(() => invoke("remote_claim_control"))}
                  >
                    {t("settings.remote.reclaim")}
                  </Button>
                }
              />
              <div className="px-3 pb-3">
                <p className="text-[10px] text-console-text-muted">
                  {status.controller_state.kind === "held"
                    ? (status.controller_state.device_name ?? status.controller_state.device_id ?? "")
                    : status.controller_state.kind === "requested"
                      ? t("settings.remote.leaseRequested")
                      : t("settings.remote.leaseFree")}
                </p>
              </div>
            </Panel>

            <Panel>
              <SectionHeader
                icon={<Cast size={14} />}
                title={t("settings.remote.devices")}
                actions={
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={12} />}
                    disabled={busy || status.devices.length === 0}
                    onClick={() => run(() => invoke("remote_revoke_all"))}
                  >
                    {t("settings.remote.revokeAll")}
                  </Button>
                }
              />
              <div className="px-3 pb-3 flex flex-col gap-2">
                {status.devices.length === 0 && (
                  <p className="text-[10px] text-console-text-subtle italic">{t("settings.remote.noDevices")}</p>
                )}
                <p className="text-[10px] text-console-text-subtle">{t("settings.remote.roleHint")}</p>
                {status.devices.map((d) => (
                  <div key={d.id} className="bg-console-surface-raised border border-console-border rounded-lg px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${d.connected ? "bg-green-400" : "bg-slate-600"}`} />
                        <div className="min-w-0">
                          {renamingId === d.id ? (
                            <div className="flex items-center gap-1">
                              <input
                                ref={renameInputRef}
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") saveRename(d.id);
                                  if (e.key === "Escape") setRenamingId(null);
                                }}
                                placeholder={t("remote.renamePlaceholder")}
                                className="bg-slate-900 border border-console-border rounded-md text-[11px] text-console-text px-1.5 py-0.5 w-32 focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
                              />
                              <button
                                onClick={() => saveRename(d.id)}
                                aria-label={t("remote.save")}
                                className="text-green-400 hover:text-green-300 p-0.5"
                              >
                                <Save size={12} />
                              </button>
                              <button
                                onClick={() => setRenamingId(null)}
                                aria-label={t("remote.cancel")}
                                className="text-console-text-subtle hover:text-white p-0.5"
                              >
                                <X size={12} />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11px] text-console-text font-semibold truncate">{d.name}</span>
                              <button
                                onClick={() => startRename(d)}
                                aria-label={t("remote.rename")}
                                className="text-console-text-subtle hover:text-white p-0.5"
                              >
                                <Pencil size={11} />
                              </button>
                              <span className="text-[9px] uppercase font-black px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                                {d.role}
                              </span>
                            </div>
                          )}
                          <p className="text-[9px] text-console-text-subtle">
                            {d.connected ? t("settings.remote.connected") : t("settings.remote.disconnected")}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <select
                          value={d.role}
                          disabled={busy}
                          onChange={(e) => run(() => invoke("remote_set_role", { deviceId: d.id, role: e.target.value }))}
                          className="bg-slate-800 border border-console-border rounded-md text-[10px] text-console-text px-1.5 py-1 disabled:opacity-50"
                        >
                          {ROLE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {t(o.labelKey)}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => run(() => invoke("remote_revoke_device", { deviceId: d.id }))}
                          disabled={busy}
                          className="text-console-text-subtle hover:text-red-300 transition-colors p-1"
                          aria-label={t("settings.remote.revoke")}
                        >
                          <UserX size={13} />
                        </button>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5 items-center">
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
                      <span className="mx-1 w-px h-4 bg-console-border" />
                      <button
                        disabled={busy}
                        onClick={() => setPermissionPreset(d.id, true)}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[9px] font-bold uppercase border border-slate-700 text-slate-400 hover:text-green-300 hover:border-green-700 transition-all disabled:opacity-50"
                      >
                        <ShieldCheck size={10} />
                        {t("remote.grantAll")}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => setPermissionPreset(d.id, false)}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-[9px] font-bold uppercase border border-slate-700 text-slate-400 hover:text-red-300 hover:border-red-700 transition-all disabled:opacity-50"
                      >
                        <UserX size={10} />
                        {t("remote.revokeAllPerms")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </div>
      )}

      {err && (
        <p className="text-[10px] text-state-error border border-state-error/40 bg-state-live-soft rounded-lg px-3 py-2">
          {err}
        </p>
      )}
    </div>
  );
}
