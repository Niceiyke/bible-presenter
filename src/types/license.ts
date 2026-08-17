/**
 * License state mirrored from the Rust `license.rs` module. `license_status`,
 * `license_activate`, `license_refresh` and `license_deactivate` return this
 * shape; the backend also broadcasts it on `license-updated`.
 */
export type LicenseStatus =
  | "unactivated"
  | "active"
  | "expired"
  | "revoked"
  | "invalid"
  | "clock_tampered";

export type LicenseTier = "free" | "pro" | "premium";

export interface LicenseInfo {
  status: LicenseStatus;
  /** Effective plan after degradation (a lapsed paid plan reports `free`). */
  tier: LicenseTier;
  /** Masked key, e.g. `WORD…5678`. Never the full key. */
  license_key?: string;
  church_name?: string;
  email?: string;
  issued_at?: number;
  expires_at?: number;
  /** SHA-256 hex of this machine's fingerprint. */
  machine_id_hash: string;
  max_machines: number;
  machines_used: number;
  last_validated_at?: number;
  /** `last_validated_at + OFFLINE_GRACE_DAYS` — deadline for the next online check. */
  grace_until?: number;
  /** True when the last validation could not reach the license server. */
  offline: boolean;
  message: string;
}

export const BLOCKING_LICENSE_STATUSES: LicenseStatus[] = [
  "unactivated",
  "expired",
  "revoked",
  "invalid",
  "clock_tampered",
];

export function isLicenseBlocked(status?: LicenseStatus): boolean {
  return !!status && BLOCKING_LICENSE_STATUSES.includes(status);
}