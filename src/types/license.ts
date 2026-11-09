/**
 * Account/device activation state mirrored from Rust `license.rs`.
 */
export type LicenseStatus =
  | "unactivated"
  | "active"
  | "revoked"
  | "invalid"
  | "clock_tampered";

export type LicenseTier = "free" | "pro" | "premium";

/** Quantitative limits signed by the Wordlyte entitlement service. */
export interface LicenseLimits {
  maxBibleVersions: number;
  maxOutputs: number;
  maxCameras: number;
  maxScenes: number;
  streamDestinations: number;
  sharedAudioInput: boolean;
}

/** Signed AI Add-on availability. AI Unit balances are always fetched online. */
export interface AiEntitlement {
  addonActive: boolean;
  addonExpiresAt?: number;
}

export interface LicenseInfo {
  status: LicenseStatus;
  /** Effective plan after degradation (lapsed paid access reports `free`). */
  tier: LicenseTier;
  organization_id?: string;
  church_name?: string;
  email?: string;
  /** Permanent first activation time for this organization/device. */
  core_activated_at?: number;
  /** The paid Pro/Premium entitlement expiry, if one exists. */
  plan_expires_at?: number;
  limits: LicenseLimits;
  ai: AiEntitlement;
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
  "revoked",
  "invalid",
  "clock_tampered",
];

export function isLicenseBlocked(status?: LicenseStatus): boolean {
  return !!status && BLOCKING_LICENSE_STATUSES.includes(status);
}
