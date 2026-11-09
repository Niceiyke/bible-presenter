/**
 * Wordlyte account and entitlement service.
 *
 * This clean v3 service establishes permanent Free core activation at the
 * organization/device level. Pro and Premium are expiring entitlements layered
 * on top; the desktop app always degrades an activated organization to Free.
 * AI Add-on status and AI Unit balances are organization data. Actual AI
 * requests remain the responsibility of a future managed AI Gateway; this
 * Worker never accepts provider credentials or exposes a client-side charge API.
 */

const PLANS = ["free", "pro", "premium"];
const PLAN_DEVICE_CAPS = { free: 1, pro: 3, premium: 50 };
const jsonHeaders = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...jsonHeaders,
          "access-control-allow-methods": "POST, GET, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
        },
      });
    }
    // The account service retains the lightweight browser console from the
    // previous license service. Every data request it makes is still protected
    // by ADMIN_TOKEN; the page itself contains no organization data.
    if (url.pathname === "/admin" && request.method === "GET") {
      return new Response(ADMIN_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        },
      });
    }
    if (!env.ORGANIZATIONS) return json({ status: "error", message: "ORGANIZATIONS KV binding is missing." }, 500);

    if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
      return json({ status: "ok" });
    }

    if (url.pathname === "/activate" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const activationCode = String(body?.activation_code || "").trim().toUpperCase();
      const machineId = String(body?.machine_id || "").trim();
      const deviceName = cleanDeviceName(body?.device_name);
      if (!activationCode || !validMachineId(machineId)) {
        return json({ status: "invalid", message: "A valid activation code and machine id are required." }, 400);
      }
      const codeHash = await sha256(activationCode);
      const organization = await findOrganizationByActivationCode(env, codeHash);
      if (!organization) return json({ status: "invalid", message: "This activation code is invalid or has expired." }, 200);
      const stub = env.ORGANIZATION_REGISTRY.get(env.ORGANIZATION_REGISTRY.idFromName(organization.id));
      return forward(await stub.fetch("https://registry/activate", {
        method: "POST",
        body: JSON.stringify({ organization_id: organization.id, code_hash: codeHash, machine_id: machineId, device_name: deviceName }),
      }));
    }

    if (url.pathname === "/entitlement" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const organizationId = String(body?.organization_id || "").trim();
      const machineId = String(body?.machine_id || "").trim();
      const deviceToken = String(body?.device_token || "").trim();
      if (!validOrganizationId(organizationId) || !validMachineId(machineId) || !validDeviceToken(deviceToken)) {
        return json({ status: "invalid", message: "Invalid device entitlement request." }, 400);
      }
      const stub = env.ORGANIZATION_REGISTRY.get(env.ORGANIZATION_REGISTRY.idFromName(organizationId));
      return forward(await stub.fetch("https://registry/entitlement", {
        method: "POST",
        body: JSON.stringify({ organization_id: organizationId, machine_id: machineId, device_token: deviceToken }),
      }));
    }

    if (url.pathname === "/admin/organizations" && request.method === "POST") {
      if (!(await isAdmin(request, env))) return unauthorized();
      const body = await request.json().catch(() => null);
      const name = String(body?.church_name || "").trim();
      const email = String(body?.email || "").trim().toLowerCase();
      const plan = normalizePlan(body?.plan);
      if (!name || !email) return json({ status: "error", message: "church_name and email are required." }, 400);
      const now = epoch();
      const id = `org_${crypto.randomUUID().replaceAll("-", "")}`;
      const deviceLimit = clampDevices(plan, body?.device_limit);
      const planDurationDays = Math.max(0, Math.min(3650, Number.parseInt(body?.plan_duration_days, 10) || 0));
      const activationCode = activationCodeFor();
      const activation = {
        code_hash: await sha256(activationCode),
        expires_at: now + 14 * 86_400,
        claimed_by_machine_id: null,
      };
      const organization = {
        id,
        church_name: name,
        owner_email: email,
        plan,
        plan_expires_at: plan === "free" ? null : now + Math.max(1, planDurationDays || 30) * 86_400,
        device_limit: deviceLimit,
        devices: [],
        activation_codes: [activation],
        revoked: false,
        created_at: now,
        updated_at: now,
      };
      await env.ORGANIZATIONS.put(orgKey(id), JSON.stringify(organization));
      return json({ status: "ok", organization: publicOrganization(organization), activation_code: activationCode });
    }

    if (url.pathname === "/admin/organizations" && request.method === "GET") {
      if (!(await isAdmin(request, env))) return unauthorized();
      return json({ status: "ok", organizations: await listOrganizations(env) });
    }

    const organizationMatch = url.pathname.match(/^\/admin\/organizations\/(org_[a-f0-9]+)$/);
    if (organizationMatch && request.method === "GET") {
      if (!(await isAdmin(request, env))) return unauthorized();
      const organization = await env.ORGANIZATIONS.get(orgKey(organizationMatch[1]), "json");
      if (!organization) return json({ status: "error", message: "Organization not found." }, 404);
      return json({ status: "ok", organization: publicOrganization(organization) });
    }

    const match = url.pathname.match(/^\/admin\/organizations\/(org_[a-f0-9]+)\/(plan|activation-code|revoke|ai)$/);
    if (match && request.method === "POST") {
      if (!(await isAdmin(request, env))) return unauthorized();
      const [, organizationId, action] = match;
      const body = await request.json().catch(() => ({}));
      const stub = env.ORGANIZATION_REGISTRY.get(env.ORGANIZATION_REGISTRY.idFromName(organizationId));
      return forward(await stub.fetch(`https://registry/admin/${action}`, {
        method: "POST",
        body: JSON.stringify({ organization_id: organizationId, ...body }),
      }));
    }

    return json({ status: "error", message: "Not found" }, 404);
  },
};

/** Serializes activation and entitlement changes for one organization. */
export class OrganizationRegistry {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.organization = null;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json().catch(() => ({}));
    const organizationId = String(body.organization_id || "").trim();
    if (!validOrganizationId(organizationId)) return json({ status: "invalid", message: "Invalid organization." }, 400);
    const organization = await this.load(organizationId);
    if (!organization) return json({ status: "invalid", message: "Organization not found." }, 404);
    if (path === "/activate") return this.activate(organization, body);
    if (path === "/entitlement") return this.entitlement(organization, body);
    if (path === "/admin/plan") return this.updatePlan(organization, body);
    if (path === "/admin/activation-code") return this.createActivationCode(organization);
    if (path === "/admin/revoke") return this.revoke(organization, body);
    if (path === "/admin/ai") return this.updateAi(organization, body);
    return json({ status: "error", message: "Not found" }, 404);
  }

  async load(organizationId) {
    if (this.organization) return this.organization;
    this.organization = await this.env.ORGANIZATIONS.get(orgKey(organizationId), "json");
    return this.organization;
  }

  async save(organization) {
    organization.updated_at = epoch();
    this.organization = organization;
    await this.env.ORGANIZATIONS.put(orgKey(organization.id), JSON.stringify(organization));
  }

  async activate(organization, body) {
    const machineId = String(body.machine_id || "").trim();
    const codeHash = String(body.code_hash || "").trim();
    if (!validMachineId(machineId) || !/^[a-f0-9]{64}$/i.test(codeHash)) {
      return json({ status: "invalid", message: "Invalid activation request." }, 400);
    }
    if (organization.revoked) return signedResponse(this.env, organization, machineId, "revoked", null);
    const now = epoch();
    const code = (organization.activation_codes || []).find((entry) => entry.code_hash === codeHash);
    if (!code || now >= code.expires_at || (code.claimed_by_machine_id && code.claimed_by_machine_id !== machineId)) {
      return json({ status: "invalid", message: "This activation code is invalid, expired, or already used." }, 200);
    }
    let device = (organization.devices || []).find((entry) => entry.machine_id === machineId);
    const deviceToken = tokenFor();
    if (!device) {
      const deviceLimit = effectiveDeviceLimit(organization, now);
      if ((organization.devices || []).length >= deviceLimit) {
        return json({ status: "invalid", message: `This organization has reached its ${deviceLimit}-computer limit.` }, 200);
      }
      device = {
        machine_id: machineId,
        device_name: cleanDeviceName(body.device_name),
        token_hash: await sha256(deviceToken),
        activated_at: now,
        last_seen_at: now,
        revoked: false,
      };
      organization.devices.push(device);
    } else {
      device.last_seen_at = now;
      device.device_name = cleanDeviceName(body.device_name) || device.device_name;
      device.revoked = false;
      // A user who deliberately re-enters the same one-time pairing code on
      // this computer receives a rotated device credential; KV never retains
      // a usable plaintext device token.
      device.token_hash = await sha256(deviceToken);
    }
    code.claimed_by_machine_id = machineId;
    await this.save(organization);
    return signedResponse(this.env, organization, machineId, "active", deviceToken);
  }

  async entitlement(organization, body) {
    const machineId = String(body.machine_id || "").trim();
    const token = String(body.device_token || "").trim();
    const device = (organization.devices || []).find((entry) => entry.machine_id === machineId);
    if (!device || !(await constantTimeEqual(await sha256(token), device.token_hash))) {
      return json({ status: "invalid", message: "This computer is not activated for the organization." }, 200);
    }
    if (organization.revoked || device.revoked) return signedResponse(this.env, organization, machineId, "revoked", null);
    device.last_seen_at = epoch();
    await this.save(organization);
    return signedResponse(this.env, organization, machineId, "active", null);
  }

  async updatePlan(organization, body) {
    const plan = normalizePlan(body.plan);
    const days = Math.max(0, Math.min(3650, Number.parseInt(body.plan_duration_days, 10) || 0));
    organization.plan = plan;
    organization.device_limit = clampDevices(plan, body.device_limit ?? organization.device_limit);
    organization.plan_expires_at = plan === "free" ? null : epoch() + Math.max(1, days || 30) * 86_400;
    await this.save(organization);
    return json({ status: "ok", organization: publicOrganization(organization) });
  }

  async createActivationCode(organization) {
    const code = activationCodeFor();
    organization.activation_codes = (organization.activation_codes || []).filter((entry) => entry.expires_at > epoch() && !entry.claimed_by_machine_id);
    organization.activation_codes.push({ code_hash: await sha256(code), expires_at: epoch() + 14 * 86_400, claimed_by_machine_id: null });
    await this.save(organization);
    return json({ status: "ok", activation_code: code, expires_at: organization.activation_codes.at(-1).expires_at });
  }

  async revoke(organization, body) {
    organization.revoked = body.revoked !== false;
    await this.save(organization);
    return json({ status: "ok", organization: publicOrganization(organization) });
  }

  /**
   * Transitional provisioning for the future billing webhook and Dashboard.
   * `monthly_units` replaces the included allowance, while `topup_units` only
   * grants additional non-expiring purchased Units. Values are stored in
   * milli-Units so per-second transcription can be settled exactly later.
   */
  async updateAi(organization, body) {
    const now = epoch();
    const wallet = aiWallet(organization);
    const duration = optionalWhole(body.addon_duration_days, 0, 3650);
    if (duration !== null) {
      wallet.addon_expires_at = duration === 0 ? null : now + duration * 86_400;
    }

    const monthlyUnits = optionalWhole(body.monthly_units, 0, 1_000_000);
    if (monthlyUnits !== null) {
      wallet.monthly_units_allowance_millis = monthlyUnits * 1000;
      wallet.monthly_units_remaining_millis = monthlyUnits * 1000;
      const resetDays = optionalWhole(body.monthly_reset_days, 1, 366) ?? 30;
      wallet.monthly_cycle_days = resetDays;
      wallet.monthly_reset_at = now + resetDays * 86_400;
      recordWalletEvent(wallet, now, "monthly_allowance_set", monthlyUnits * 1000);
    }

    const topupUnits = optionalWhole(body.topup_units, 0, 1_000_000);
    if (topupUnits !== null && topupUnits > 0) {
      wallet.topup_units_remaining_millis += topupUnits * 1000;
      recordWalletEvent(wallet, now, "topup_granted", topupUnits * 1000);
    }

    await this.save(organization);
    return json({
      status: "ok",
      organization: publicOrganization(organization),
      ai: aiBalance(organization, now),
    });
  }
}

async function signedResponse(env, organization, machineId, status, deviceToken) {
  const now = epoch();
  const plan = effectivePlan(organization, now);
  const fields = {
    organization_id: organization.id,
    machine_id: machineId,
    status,
    core_activated_at: organization.created_at,
    // Expired paid subscriptions are signed as Free. A desktop must never keep
    // using Pro/Premium capacity merely because it holds an older snapshot.
    plan,
    plan_expires_at: organization.plan_expires_at || 0,
    max_machines: effectiveDeviceLimit(organization, now),
    machines_used: (organization.devices || []).length,
    server_time: now,
    limits: planLimits(plan),
    ai: aiEntitlement(organization, now),
  };
  const sig = await signEntitlement(env, fields);
  return json({
    status,
    message: status === "active" ? "ok" : "This device or organization has been revoked.",
    ...fields,
    plan_expires_at: organization.plan_expires_at ?? null,
    church_name: organization.church_name,
    email: organization.owner_email,
    ...(deviceToken ? { device_token: deviceToken } : {}),
    ...(sig ? { sig } : {}),
  });
}

function publicOrganization(organization) {
  const now = epoch();
  const subscriptionPlan = normalizePlan(organization.plan);
  const plan = effectivePlan(organization, now);
  return {
    id: organization.id,
    church_name: organization.church_name,
    email: organization.owner_email,
    // `plan` is the currently effective entitlement. The subscription value is
    // included for staff/support display but is never used for authorization.
    plan,
    subscription_plan: subscriptionPlan,
    plan_active: subscriptionPlan === "free" || plan === subscriptionPlan,
    plan_expires_at: organization.plan_expires_at,
    device_limit: effectiveDeviceLimit(organization, now),
    devices_used: (organization.devices || []).length,
    revoked: organization.revoked === true,
    ai: aiEntitlement(organization),
    created_at: organization.created_at,
  };
}

async function listOrganizations(env) {
  const result = [];
  let cursor;
  do {
    const page = await env.ORGANIZATIONS.list({ prefix: "org:", cursor });
    for (const key of page.keys) {
      const organization = await env.ORGANIZATIONS.get(key.name, "json");
      if (organization) result.push(publicOrganization(organization));
    }
    cursor = page.cursor;
  } while (cursor);
  return result.sort((a, b) => a.church_name.localeCompare(b.church_name));
}

async function findOrganizationByActivationCode(env, codeHash) {
  let cursor;
  do {
    const page = await env.ORGANIZATIONS.list({ prefix: "org:", cursor });
    for (const key of page.keys) {
      const organization = await env.ORGANIZATIONS.get(key.name, "json");
      if ((organization?.activation_codes || []).some((entry) => entry.code_hash === codeHash)) return organization;
    }
    cursor = page.cursor;
  } while (cursor);
  return null;
}

async function isAdmin(request, env) {
  const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return constantTimeEqual(supplied, env.ADMIN_TOKEN || "");
}

async function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  if (a.byteLength !== b.byteLength) return false;
  const leftHash = await crypto.subtle.digest("SHA-256", a);
  const rightHash = await crypto.subtle.digest("SHA-256", b);
  const x = new Uint8Array(leftHash);
  const y = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < x.length; index += 1) difference |= x[index] ^ y[index];
  return difference === 0;
}

async function signEntitlement(env, fields) {
  if (!env.LICENSE_SIGN_PRIVATE_KEY) return "";
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.LICENSE_SIGN_PRIVATE_KEY), { name: "Ed25519" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(canonicalEntitlement(fields)));
  return base64(new Uint8Array(signature));
}

function canonicalEntitlement(fields) {
  return [
    "wl3",
    fields.organization_id,
    fields.machine_id,
    fields.status,
    String(fields.core_activated_at),
    fields.plan,
    String(fields.plan_expires_at || 0),
    String(fields.max_machines),
    String(fields.machines_used),
    String(fields.server_time),
    String(fields.limits.maxBibleVersions),
    String(fields.limits.maxOutputs),
    String(fields.limits.maxCameras),
    String(fields.limits.maxScenes),
    String(fields.limits.streamDestinations),
    fields.limits.sharedAudioInput ? "1" : "0",
    fields.ai.addonActive ? "1" : "0",
    String(fields.ai.addonExpiresAt || 0),
  ].join("|");
}

function activationCodeFor() {
  // Human-entered pairing codes are intentionally case-insensitive. Device
  // credentials remain high-entropy base64url values and are never typed.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return `WACT-${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join("")}`;
}
function tokenFor() { return tokenWithPrefix("wdv"); }
function tokenWithPrefix(prefix) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `${prefix}_${base64url(bytes)}`;
}
function base64(bytes) { let value = ""; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value); }
function base64url(bytes) { return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function sha256(value) { const bytes = new TextEncoder().encode(value); const digest = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function epoch() { return Math.floor(Date.now() / 1000); }
function orgKey(id) { return `org:${id}`; }
function validOrganizationId(id) { return /^org_[a-f0-9]{32}$/.test(id); }
function validMachineId(id) { return /^[a-f0-9]{64}$/i.test(id); }
function validDeviceToken(token) { return /^wdv_[A-Za-z0-9_-]{20,}$/.test(token); }
function normalizePlan(value) { const plan = String(value || "").trim().toLowerCase(); return PLANS.includes(plan) ? plan : "free"; }
function clampDevices(plan, requested) { return Math.max(1, Math.min(PLAN_DEVICE_CAPS[plan], Number.parseInt(requested, 10) || PLAN_DEVICE_CAPS[plan])); }
function effectivePlan(organization, now = epoch()) {
  const plan = normalizePlan(organization.plan);
  return plan === "free" || (Number(organization.plan_expires_at) || 0) > now ? plan : "free";
}
function effectiveDeviceLimit(organization, now = epoch()) {
  const plan = effectivePlan(organization, now);
  return clampDevices(plan, organization.device_limit);
}
function planLimits(value) {
  switch (normalizePlan(value)) {
    case "premium":
      return { maxBibleVersions: 1000, maxOutputs: 10, maxCameras: 10, maxScenes: 1000, streamDestinations: 5, sharedAudioInput: true };
    case "pro":
      return { maxBibleVersions: 1000, maxOutputs: 2, maxCameras: 3, maxScenes: 1000, streamDestinations: 1, sharedAudioInput: false };
    default:
      return { maxBibleVersions: 1000, maxOutputs: 1, maxCameras: 1, maxScenes: 3, streamDestinations: 0, sharedAudioInput: false };
  }
}
function aiWallet(organization) {
  if (!organization.ai || typeof organization.ai !== "object") organization.ai = {};
  const wallet = organization.ai;
  wallet.addon_expires_at = positiveEpoch(wallet.addon_expires_at);
  wallet.monthly_units_allowance_millis = nonNegativeInt(wallet.monthly_units_allowance_millis);
  wallet.monthly_units_remaining_millis = nonNegativeInt(wallet.monthly_units_remaining_millis);
  wallet.topup_units_remaining_millis = nonNegativeInt(wallet.topup_units_remaining_millis);
  wallet.monthly_reset_at = positiveEpoch(wallet.monthly_reset_at);
  if (!Array.isArray(wallet.ledger)) wallet.ledger = [];
  return wallet;
}
function aiEntitlement(organization, now = epoch()) {
  const wallet = aiWallet(organization);
  const expiresAt = wallet.addon_expires_at;
  return {
    addonActive: Boolean(expiresAt && now < expiresAt),
    addonExpiresAt: expiresAt,
  };
}
function aiBalance(organization, now = epoch()) {
  const wallet = aiWallet(organization);
  refreshMonthlyAllowance(wallet, now);
  const monthly = wallet.monthly_units_remaining_millis;
  const topup = wallet.topup_units_remaining_millis;
  return {
    addon_active: aiEntitlement(organization, now).addonActive,
    monthly_units_remaining: monthly / 1000,
    topup_units_remaining: topup / 1000,
    total_units_remaining: (monthly + topup) / 1000,
    monthly_reset_at: wallet.monthly_reset_at,
    rates: { transcription_units_per_minute: 1, standard_llm_request_units: 10 },
  };
}
function recordWalletEvent(wallet, at, type, deltaMillis) {
  wallet.ledger.push({ at, type, delta_millis: deltaMillis });
  if (wallet.ledger.length > 200) wallet.ledger.splice(0, wallet.ledger.length - 200);
}
function refreshMonthlyAllowance(wallet, now) {
  const cycleDays = optionalWhole(wallet.monthly_cycle_days, 1, 366) ?? 30;
  if (!wallet.monthly_reset_at || wallet.monthly_reset_at > now || !wallet.monthly_units_allowance_millis) return;
  // An extended outage should result in one current billing allowance, not an
  // accumulation of missed monthly allocations.
  wallet.monthly_units_remaining_millis = wallet.monthly_units_allowance_millis;
  wallet.monthly_reset_at = now + cycleDays * 86_400;
  recordWalletEvent(wallet, now, "monthly_allowance_reset", wallet.monthly_units_allowance_millis);
}
function positiveEpoch(value) { const number = Number.parseInt(value, 10); return Number.isSafeInteger(number) && number > 0 ? number : null; }
function nonNegativeInt(value) { const number = Number.parseInt(value, 10); return Number.isSafeInteger(number) && number >= 0 ? number : 0; }
function optionalWhole(value, min, max) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}
function cleanDeviceName(value) { return String(value || "").trim().replace(/[\u0000-\u001f]/g, "").slice(0, 80) || "Wordlyte computer"; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: jsonHeaders }); }
function unauthorized() { return json({ status: "error", message: "Unauthorized" }, 401); }
function forward(response) { return new Response(response.body, { status: response.status, headers: jsonHeaders }); }

const ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wordlyte Account Admin</title><style>
:root{color-scheme:dark;--bg:#10131a;--panel:#191e29;--border:#30394a;--text:#edf2f7;--muted:#a5b0c0;--accent:#77b7ff;--danger:#fb7185;--ok:#5eead4}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif}header{padding:16px 22px;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:center}h1,h2{margin:0}h1{font-size:17px}h2{font-size:15px}.spacer{flex:1}main{max-width:1200px;margin:22px auto;padding:0 18px;display:grid;gap:16px}.panel{padding:16px;background:var(--panel);border:1px solid var(--border);border-radius:10px}.hidden{display:none}.muted{color:var(--muted)}.row{display:flex;flex-wrap:wrap;gap:9px;align-items:center;margin-top:12px}input,select,button{font:inherit;border-radius:6px;padding:8px 10px;border:1px solid var(--border);background:#10141c;color:var(--text)}input{min-width:130px}button{cursor:pointer}button:hover{border-color:var(--accent)}button.primary{background:var(--accent);color:#07111f;border-color:var(--accent);font-weight:700}button.danger{color:var(--danger)}table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--border);vertical-align:middle}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}.badge{border:1px solid var(--border);border-radius:999px;padding:2px 7px;font-size:11px;font-weight:700}.free{color:#cbd5e1}.pro{color:#7dd3fc}.premium{color:#d8b4fe}.revoked{color:var(--danger)}.code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.notice{min-height:20px;margin-top:10px;color:var(--muted)}.error{color:var(--danger)}@media(max-width:800px){table{display:block;overflow:auto}}
</style></head><body>
<section id="login"><main><div class="panel"><h1>Wordlyte Account Admin</h1><p class="muted">Sign in with the server administrator token. The token is held only in this browser tab.</p><div class="row"><input id="token" type="password" autocomplete="current-password" placeholder="ADMIN_TOKEN" style="flex:1"><button class="primary" id="signIn">Sign in</button></div><p class="notice" id="loginNotice"></p></div></main></section>
<section id="app" class="hidden"><header><h1>Wordlyte Account Admin</h1><span class="muted" id="summary"></span><span class="spacer"></span><button id="refresh">Refresh</button><button id="signOut">Sign out</button></header><main>
<div class="panel"><h2>Create organization</h2><div class="row"><input id="church" placeholder="Church name" style="flex:2"><input id="email" type="email" placeholder="Owner email" style="flex:2"><select id="createPlan"><option value="free">Free</option><option value="pro">Pro</option><option value="premium">Premium</option></select><input id="createDays" type="number" min="1" max="3650" value="30" title="Paid plan duration in days"><input id="createDevices" type="number" min="1" value="1" title="Device limit"><button class="primary" id="create">Create</button></div><p class="notice" id="createNotice"></p></div>
<div class="panel"><h2>Organizations</h2><p class="notice" id="notice"></p><table><thead><tr><th>Church</th><th>Owner</th><th>Plan</th><th>Devices</th><th>Paid expiry</th><th>Status</th><th>Actions</th></tr></thead><tbody id="rows"></tbody></table></div>
</main></section>
<script>
let token=sessionStorage.getItem('wordlyte_admin_token')||'', organizations=[];
const $=id=>document.getElementById(id); const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=ts=>ts?new Date(ts*1000).toLocaleDateString():'—';
async function api(path,options={}){const headers={'content-type':'application/json',authorization:'Bearer '+token,...(options.headers||{})};const response=await fetch(path,{...options,headers});return {status:response.status,data:await response.json().catch(()=>null)}}
function showNotice(id,text,error=false){const e=$(id);e.textContent=text;e.className='notice'+(error?' error':'')}
function showApp(){ $('login').classList.add('hidden');$('app').classList.remove('hidden');load(); }
function showLogin(message=''){ $('app').classList.add('hidden');$('login').classList.remove('hidden');$('token').value=token;showNotice('loginNotice',message,true); }
async function load(){showNotice('notice','Loading…');const r=await api('/admin/organizations');if(r.status===401){showLogin('Unauthorized — check the administrator token.');return}if(r.status!==200||!r.data?.organizations){showNotice('notice',r.data?.message||'Could not load organizations.',true);return}organizations=r.data.organizations;$('summary').textContent=organizations.length+' organization'+(organizations.length===1?'':'s');showNotice('notice','');render()}
function render(){const body=$('rows');if(!organizations.length){body.innerHTML='<tr><td colspan="7" class="muted">No organizations yet.</td></tr>';return}body.innerHTML=organizations.map(o=>'<tr><td><b>'+esc(o.church_name)+'</b><br><span class="muted code">'+esc(o.id)+'</span></td><td>'+esc(o.email)+'</td><td><span class="badge '+esc(o.plan)+'">'+esc(o.plan)+'</span></td><td>'+esc(o.devices_used)+' / '+esc(o.device_limit)+'</td><td>'+date(o.plan_expires_at)+'</td><td>'+(o.revoked?'<span class="badge revoked">revoked</span>':'<span class="badge">active</span>')+'</td><td><button data-action="code" data-id="'+esc(o.id)+'">Pair code</button> <button data-action="plan" data-id="'+esc(o.id)+'">Plan</button> <button class="danger" data-action="revoke" data-id="'+esc(o.id)+'">'+(o.revoked?'Restore':'Revoke')+'</button></td></tr>').join('')}
async function create(){const church_name=$('church').value.trim(),email=$('email').value.trim(),plan=$('createPlan').value;if(!church_name||!email){showNotice('createNotice','Church name and owner email are required.',true);return}const r=await api('/admin/organizations',{method:'POST',body:JSON.stringify({church_name,email,plan,plan_duration_days:+$('createDays').value,device_limit:+$('createDevices').value})});if(r.status!==200){showNotice('createNotice',r.data?.message||'Could not create organization.',true);return}showNotice('createNotice','Created. Activation code: '+r.data.activation_code);$('church').value='';$('email').value='';load()}
async function action(event){const button=event.target.closest('button[data-action]');if(!button)return;const id=button.dataset.id,kind=button.dataset.action;if(kind==='code'){const r=await api('/admin/organizations/'+id+'/activation-code',{method:'POST',body:'{}'});showNotice('notice',r.status===200?'Device activation code: '+r.data.activation_code:(r.data?.message||'Could not create pairing code.'),r.status!==200);return}if(kind==='revoke'){const organization=organizations.find(o=>o.id===id);if(!organization||!confirm((organization.revoked?'Restore':'Revoke')+' '+organization.church_name+'?'))return;const r=await api('/admin/organizations/'+id+'/revoke',{method:'POST',body:JSON.stringify({revoked:!organization.revoked})});if(r.status!==200)showNotice('notice',r.data?.message||'Update failed.',true);else load();return}const organization=organizations.find(o=>o.id===id);const plan=prompt('Plan: free, pro, or premium',organization?.plan||'free');if(!plan)return;const days=prompt('Plan duration in days (paid plans)', '30');const devices=prompt('Device limit',String(organization?.device_limit||1));const r=await api('/admin/organizations/'+id+'/plan',{method:'POST',body:JSON.stringify({plan,plan_duration_days:+days,device_limit:+devices})});if(r.status!==200)showNotice('notice',r.data?.message||'Plan update failed.',true);else load()}
$('signIn').onclick=()=>{token=$('token').value.trim();if(!token){showNotice('loginNotice','Enter the administrator token.',true);return}sessionStorage.setItem('wordlyte_admin_token',token);showApp()};$('signOut').onclick=()=>{token='';sessionStorage.removeItem('wordlyte_admin_token');showLogin('')};$('refresh').onclick=load;$('create').onclick=create;$('rows').onclick=action;if(token)showApp();
</script></body></html>`;
