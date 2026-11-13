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
const AI_TOKEN_TTL_SECONDS = 15 * 60;
const AI_TOKEN_AUDIENCE = "wordlyte-ai";
const MAX_AI_RESERVATION_UNITS = 10_000;
const AI_RESERVATION_TTL_SECONDS = 15 * 60;
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

    if (url.pathname === "/ai/token" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const organizationId = String(body?.organization_id || "").trim();
      const machineId = String(body?.machine_id || "").trim();
      const deviceToken = String(body?.device_token || "").trim();
      if (!validOrganizationId(organizationId) || !validMachineId(machineId) || !validDeviceToken(deviceToken)) {
        return json({ status: "invalid", message: "Invalid AI token request." }, 400);
      }
      const stub = env.ORGANIZATION_REGISTRY.get(env.ORGANIZATION_REGISTRY.idFromName(organizationId));
      return forward(await stub.fetch("https://registry/ai/token", {
        method: "POST",
        body: JSON.stringify({ organization_id: organizationId, machine_id: machineId, device_token: deviceToken }),
      }));
    }

    if (url.pathname.startsWith("/internal/ai/") && request.method === "POST") {
      if (!(await isGateway(request, env))) return unauthorized();
      const action = url.pathname.slice("/internal/ai/".length);
      if (!["reserve", "settle", "release", "balance"].includes(action)) {
        return json({ status: "error", message: "Not found" }, 404);
      }
      const body = await request.json().catch(() => null);
      const organizationId = String(body?.organization_id || "").trim();
      if (!validOrganizationId(organizationId)) {
        return json({ status: "invalid", message: "Invalid organization." }, 400);
      }
      const stub = env.ORGANIZATION_REGISTRY.get(env.ORGANIZATION_REGISTRY.idFromName(organizationId));
      return forward(await stub.fetch(`https://registry/internal/ai/${action}`, {
        method: "POST",
        body: JSON.stringify({ organization_id: organizationId, ...body }),
      }));
    }

    if (url.pathname === "/transcripts/sync" && request.method === "POST") {
      const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const claims = await verifyAiToken(env, supplied);
      if (!claims) return json({ status: "invalid", message: "A valid Wordlyte AI token is required." }, 401);
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ status: "invalid", message: "Invalid transcript payload." }, 400);
      const stub = env.ORGANIZATION_REGISTRY.get(env.ORGANIZATION_REGISTRY.idFromName(claims.org));
      return forward(await stub.fetch("https://registry/transcripts/sync", {
        method: "POST",
        body: JSON.stringify({ organization_id: claims.org, ...body }),
      }));
    }

    const transcriptListMatch = url.pathname.match(/^\/admin\/organizations\/(org_[a-f0-9]+)\/transcripts$/);
    if (transcriptListMatch && request.method === "GET") {
      if (!(await isAdmin(request, env))) return unauthorized();
      const stub = env.ORGANIZATION_REGISTRY.get(env.ORGANIZATION_REGISTRY.idFromName(transcriptListMatch[1]));
      return forward(await stub.fetch("https://registry/admin/transcripts/list", {
        method: "POST",
        body: JSON.stringify({ organization_id: transcriptListMatch[1] }),
      }));
    }

    const transcriptMatch = url.pathname.match(/^\/admin\/organizations\/(org_[a-f0-9]+)\/transcripts\/([^/]+)$/);
    if (transcriptMatch && (request.method === "GET" || request.method === "DELETE")) {
      if (!(await isAdmin(request, env))) return unauthorized();
      const sessionId = decodeURIComponent(transcriptMatch[2]);
      const action = request.method === "DELETE" ? "delete" : "get";
      const stub = env.ORGANIZATION_REGISTRY.get(env.ORGANIZATION_REGISTRY.idFromName(transcriptMatch[1]));
      return forward(await stub.fetch(`https://registry/admin/transcripts/${action}`, {
        method: "POST",
        body: JSON.stringify({ organization_id: transcriptMatch[1], session_id: sessionId }),
      }));
    }

    const aiReadMatch = url.pathname.match(/^\/admin\/organizations\/(org_[a-f0-9]+)\/ai$/);
    if (aiReadMatch && request.method === "GET") {
      if (!(await isAdmin(request, env))) return unauthorized();
      const organization = await env.ORGANIZATIONS.get(orgKey(aiReadMatch[1]), "json");
      if (!organization) return json({ status: "error", message: "Organization not found." }, 404);
      const stub = env.ORGANIZATION_REGISTRY.get(env.ORGANIZATION_REGISTRY.idFromName(organization.id));
      const response = await stub.fetch("https://registry/internal/ai/balance", {
        method: "POST",
        body: JSON.stringify({ organization_id: organization.id }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ai) {
        return json({ status: "error", message: data?.message || "AI balance unavailable." }, 503);
      }
      return json({
        status: "ok",
        organization: publicOrganization(organization),
        ai: data.ai,
        usage: Array.isArray(data.usage) ? data.usage : [],
      });
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

    // Platform-admin cross-church view. Each organization remains isolated in
    // its own Durable Object; this endpoint only fans out the read.
    if (url.pathname === "/admin/insights" && request.method === "GET") {
      if (!(await isAdmin(request, env))) return unauthorized();
      const organizations = await listOrganizations(env);
      const insights = await Promise.all(organizations.map(async (organization) => {
        try {
          const stub = env.ORGANIZATION_REGISTRY.get(env.ORGANIZATION_REGISTRY.idFromName(organization.id));
          const response = await stub.fetch("https://registry/admin/transcripts/list", {
            method: "POST",
            body: JSON.stringify({ organization_id: organization.id }),
          });
          const data = await response.json().catch(() => null);
          return {
            organization,
            transcripts: Array.isArray(data?.transcripts) ? data.transcripts : [],
          };
        } catch (error) {
          console.error("Admin insights read failed", organization.id, error);
          return { organization, transcripts: [], error: "Insights unavailable." };
        }
      }));
      return json({ status: "ok", organizations: insights });
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
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ai_wallet (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        monthly_allowance_millis INTEGER NOT NULL DEFAULT 0,
        monthly_remaining_millis INTEGER NOT NULL DEFAULT 0,
        topup_remaining_millis INTEGER NOT NULL DEFAULT 0,
        reserved_millis INTEGER NOT NULL DEFAULT 0,
        monthly_reset_at INTEGER,
        monthly_cycle_days INTEGER NOT NULL DEFAULT 30,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS ai_wallet_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        delta_millis INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ai_wallet_events_at_idx ON ai_wallet_events(at);
      CREATE TABLE IF NOT EXISTS ai_reservations (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        units_millis INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        settled_units_millis INTEGER NOT NULL DEFAULT 0,
        settled_at INTEGER,
        released_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS ai_reservations_key_idx ON ai_reservations(idempotency_key);
      CREATE INDEX IF NOT EXISTS ai_reservations_status_idx ON ai_reservations(status, expires_at);
      CREATE TABLE IF NOT EXISTS transcripts (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        provider TEXT NOT NULL,
        mode TEXT NOT NULL,
        version TEXT NOT NULL,
        transcript_text TEXT NOT NULL,
        transcript_json TEXT NOT NULL,
        suggestions_json TEXT NOT NULL,
        stop_reason TEXT,
        performance_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS transcripts_started_idx ON transcripts(started_at DESC);
    `);
    const columns = this.sql.exec("PRAGMA table_info(transcripts)").toArray();
    if (!columns.some((column) => column.name === "performance_json")) {
      this.sql.exec("ALTER TABLE transcripts ADD COLUMN performance_json TEXT NOT NULL DEFAULT '{}'");
    }
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
    if (path === "/ai/token") return this.aiToken(organization, body);
    if (path === "/internal/ai/reserve") return this.reserveAi(organization, body);
    if (path === "/internal/ai/settle") return this.settleAi(organization, body);
    if (path === "/internal/ai/release") return this.releaseAi(organization, body);
    if (path === "/internal/ai/balance") return this.aiBalance(organization);
    if (path === "/transcripts/sync") return this.syncTranscript(organization, body);
    if (path === "/admin/transcripts/list") return this.listTranscripts();
    if (path === "/admin/transcripts/get") return this.getTranscript(body);
    if (path === "/admin/transcripts/delete") return this.deleteTranscript(body);
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

  readAiWallet() {
    return this.sql.exec("SELECT * FROM ai_wallet WHERE id = 1").toArray()[0] || null;
  }

  ensureAiWallet(organization) {
    const existing = this.readAiWallet();
    if (existing) return existing;
    // One-time import from the legacy organization.ai record. All future
    // balance, reservation, and ledger mutations live in SQLite.
    const legacy = aiWallet(organization);
    this.sql.exec(
      "INSERT INTO ai_wallet (id, monthly_allowance_millis, monthly_remaining_millis, topup_remaining_millis, reserved_millis, monthly_reset_at, monthly_cycle_days, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
      legacy.monthly_units_allowance_millis,
      legacy.monthly_units_remaining_millis,
      legacy.topup_units_remaining_millis,
      legacy.reserved_units_millis,
      legacy.monthly_reset_at,
      optionalWhole(legacy.monthly_cycle_days, 1, 366) ?? 30,
      epoch(),
    );
    for (const event of legacy.ledger) {
      this.sql.exec(
        "INSERT INTO ai_wallet_events (at, type, delta_millis) VALUES (?, ?, ?)",
        nonNegativeInt(event.at),
        String(event.type || "legacy_event"),
        Number.parseInt(event.delta_millis, 10) || 0,
      );
    }
    for (const reservation of legacy.reservations) {
      this.sql.exec(
        "INSERT OR IGNORE INTO ai_reservations (id, idempotency_key, units_millis, kind, status, created_at, expires_at, settled_units_millis, settled_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        reservation.id,
        reservation.idempotency_key || `legacy-${reservation.id}`,
        nonNegativeInt(reservation.units_millis),
        String(reservation.kind || "standard"),
        String(reservation.status || "released"),
        nonNegativeInt(reservation.created_at),
        nonNegativeInt(reservation.expires_at),
        nonNegativeInt(reservation.settled_units_millis),
        reservation.settled_at || null,
        reservation.released_at || null,
      );
    }
    return this.readAiWallet();
  }

  recordAiEvent(at, type, deltaMillis) {
    this.sql.exec(
      "INSERT INTO ai_wallet_events (at, type, delta_millis) VALUES (?, ?, ?)",
      at,
      type,
      deltaMillis,
    );
  }

  usageEvents(limit = 50) {
    return this.sql.exec(
      "SELECT at, type, delta_millis FROM ai_wallet_events ORDER BY id DESC LIMIT ?",
      limit,
    ).toArray().reverse();
  }

  expireAiReservations(now) {
    const expired = this.sql.exec(
      "SELECT id, units_millis FROM ai_reservations WHERE status = 'reserved' AND expires_at <= ?",
      now,
    ).toArray();
    for (const reservation of expired) {
      this.sql.exec(
        "UPDATE ai_reservations SET status = 'released', released_at = ? WHERE id = ? AND status = 'reserved'",
        now,
        reservation.id,
      );
      this.sql.exec(
        "UPDATE ai_wallet SET reserved_millis = MAX(0, reserved_millis - ?), updated_at = ? WHERE id = 1",
        reservation.units_millis,
        now,
      );
    }
  }

  spendAiUnits(unitsMillis, now) {
    const wallet = this.readAiWallet();
    const monthly = nonNegativeInt(wallet.monthly_remaining_millis);
    const topup = nonNegativeInt(wallet.topup_remaining_millis);
    const fromMonthly = Math.min(monthly, unitsMillis);
    const remaining = unitsMillis - fromMonthly;
    this.sql.exec(
      "UPDATE ai_wallet SET monthly_remaining_millis = ?, topup_remaining_millis = ?, updated_at = ? WHERE id = 1",
      monthly - fromMonthly,
      Math.max(0, topup - remaining),
      now,
    );
  }

  aiBalanceFor(organization) {
    const now = epoch();
    this.ensureAiWallet(organization);
    this.expireAiReservations(now);
    let wallet = this.readAiWallet();
    const cycleDays = optionalWhole(wallet.monthly_cycle_days, 1, 366) ?? 30;
    if (
      wallet.monthly_reset_at &&
      wallet.monthly_reset_at <= now &&
      wallet.monthly_allowance_millis
    ) {
      const resetAt = now + cycleDays * 86_400;
      this.sql.exec(
        "UPDATE ai_wallet SET monthly_remaining_millis = ?, monthly_reset_at = ?, updated_at = ? WHERE id = 1",
        wallet.monthly_allowance_millis,
        resetAt,
        now,
      );
      this.recordAiEvent(now, "monthly_allowance_reset", wallet.monthly_allowance_millis);
      wallet = this.readAiWallet();
    }
    const monthly = nonNegativeInt(wallet.monthly_remaining_millis);
    const topup = nonNegativeInt(wallet.topup_remaining_millis);
    const reserved = nonNegativeInt(wallet.reserved_millis);
    return {
      addon_active: aiEntitlement(organization, now).addonActive,
      monthly_units_remaining: monthly / 1000,
      topup_units_remaining: topup / 1000,
      reserved_units_remaining: reserved / 1000,
      total_units_remaining: (monthly + topup) / 1000,
      available_units_remaining: Math.max(0, monthly + topup - reserved) / 1000,
      monthly_reset_at: wallet.monthly_reset_at || null,
      rates: { transcription_units_per_minute: 1, standard_llm_request_units: 10 },
    };
  }

  async aiToken(organization, body) {
    const now = epoch();
    const machineId = String(body.machine_id || "").trim();
    const token = String(body.device_token || "").trim();
    const device = (organization.devices || []).find((entry) => entry.machine_id === machineId);
    if (!device || !(await constantTimeEqual(await sha256(token), device.token_hash))) {
      return json({ status: "invalid", message: "This computer is not activated for the organization." }, 200);
    }
    if (organization.revoked || device.revoked) {
      return json({ status: "revoked", message: "This device or organization has been revoked." }, 403);
    }
    const ai = aiEntitlement(organization, now);
    if (!ai.addonActive) {
      return json({ status: "ai_not_entitled", message: "The Wordlyte AI Add-on is not active for this organization." }, 403);
    }
    const balance = this.aiBalanceFor(organization);
    let accessToken;
    try {
      accessToken = await createAiToken(this.env, organization.id, machineId, ai, now);
    } catch (error) {
      return json({ status: "error", message: String(error?.message || error) }, 500);
    }
    return json({
      status: "ok",
      token: accessToken,
      expires_at: now + AI_TOKEN_TTL_SECONDS,
      ai: { ...balance, addonActive: ai.addonActive, addonExpiresAt: ai.addonExpiresAt || null },
    });
  }

  async aiBalance(organization) {
    return json({
      status: "ok",
      ai: this.aiBalanceFor(organization),
      usage: this.usageEvents(),
    });
  }

  async reserveAi(organization, body) {
    const now = epoch();
    const units = optionalWhole(body.units, 1, MAX_AI_RESERVATION_UNITS);
    const key = cleanIdempotencyKey(body.idempotency_key);
    if (units === null || !key) {
      return json({ status: "invalid", message: "units and idempotency_key are required." }, 400);
    }
    if (!aiEntitlement(organization, now).addonActive) {
      return json({ status: "ai_not_entitled", message: "The Wordlyte AI Add-on is not active." }, 403);
    }
    this.ensureAiWallet(organization);
    this.expireAiReservations(now);
    const existing = this.sql.exec(
      "SELECT * FROM ai_reservations WHERE idempotency_key = ?",
      key,
    ).toArray()[0];
    if (existing) {
      return json({ status: "ok", reservation: publicReservation(existing), ai: this.aiBalanceFor(organization) });
    }
    const balance = this.aiBalanceFor(organization);
    if (balance.available_units_remaining < units) {
      return json({ status: "ai_no_units", message: "Not enough AI Units available.", ai: balance }, 402);
    }
    const reservation = {
      id: `res_${crypto.randomUUID().replaceAll("-", "")}`,
      idempotency_key: key,
      units_millis: units * 1000,
      kind: String(body.kind || "standard").trim().slice(0, 32) || "standard",
      status: "reserved",
      created_at: now,
      expires_at: now + AI_RESERVATION_TTL_SECONDS,
    };
    this.sql.exec(
      "INSERT INTO ai_reservations (id, idempotency_key, units_millis, kind, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'reserved', ?, ?)",
      reservation.id,
      reservation.idempotency_key,
      reservation.units_millis,
      reservation.kind,
      reservation.created_at,
      reservation.expires_at,
    );
    this.sql.exec(
      "UPDATE ai_wallet SET reserved_millis = reserved_millis + ?, updated_at = ? WHERE id = 1",
      reservation.units_millis,
      now,
    );
    this.recordAiEvent(now, "reservation", 0);
    return json({ status: "ok", reservation: publicReservation(reservation), ai: this.aiBalanceFor(organization) });
  }

  async settleAi(organization, body) {
    const now = epoch();
    const reservationId = cleanReservationId(body.reservation_id);
    if (!reservationId) return json({ status: "invalid", message: "reservation_id is required." }, 400);
    this.ensureAiWallet(organization);
    this.expireAiReservations(now);
    const reservation = this.sql.exec(
      "SELECT * FROM ai_reservations WHERE id = ?",
      reservationId,
    ).toArray()[0];
    if (!reservation) return json({ status: "not_found", message: "Reservation not found." }, 404);
    if (reservation.status === "settled") {
      return json({ status: "ok", reservation: publicReservation(reservation), ai: this.aiBalanceFor(organization) });
    }
    if (reservation.status !== "reserved") {
      return json({ status: "invalid", message: "Reservation is no longer active." }, 409);
    }
    let actualUnitsMillis;
    if (body.actual_milli_units !== undefined && body.actual_milli_units !== null) {
      actualUnitsMillis = optionalWhole(body.actual_milli_units, 0, MAX_AI_RESERVATION_UNITS * 1000);
    } else {
      const actualUnits = optionalWhole(body.actual_units, 0, MAX_AI_RESERVATION_UNITS);
      actualUnitsMillis = actualUnits === null ? null : actualUnits * 1000;
    }
    if (actualUnitsMillis === null) {
      return json({ status: "invalid", message: "actual_units or actual_milli_units is required." }, 400);
    }
    if (actualUnitsMillis > reservation.units_millis) {
      return json({ status: "invalid", message: "Settled usage exceeds the reservation." }, 400);
    }
    this.sql.exec(
      "UPDATE ai_wallet SET reserved_millis = MAX(0, reserved_millis - ?), updated_at = ? WHERE id = 1",
      reservation.units_millis,
      now,
    );
    this.spendAiUnits(actualUnitsMillis, now);
    this.sql.exec(
      "UPDATE ai_reservations SET status = 'settled', settled_units_millis = ?, settled_at = ? WHERE id = ?",
      actualUnitsMillis,
      now,
      reservationId,
    );
    this.recordAiEvent(now, "usage_settled", -actualUnitsMillis);
    return json({ status: "ok", reservation: publicReservation({ ...reservation, status: "settled", settled_units_millis: actualUnitsMillis, settled_at: now }), ai: this.aiBalanceFor(organization) });
  }

  async releaseAi(organization, body) {
    const reservationId = cleanReservationId(body.reservation_id);
    if (!reservationId) return json({ status: "invalid", message: "reservation_id is required." }, 400);
    this.ensureAiWallet(organization);
    const reservation = this.sql.exec(
      "SELECT * FROM ai_reservations WHERE id = ?",
      reservationId,
    ).toArray()[0];
    if (!reservation) return json({ status: "not_found", message: "Reservation not found." }, 404);
    if (reservation.status === "released") {
      return json({ status: "ok", reservation: publicReservation(reservation), ai: this.aiBalanceFor(organization) });
    }
    if (reservation.status !== "reserved") {
      return json({ status: "invalid", message: "Reservation is no longer active." }, 409);
    }
    this.sql.exec(
      "UPDATE ai_wallet SET reserved_millis = MAX(0, reserved_millis - ?), updated_at = ? WHERE id = 1",
      reservation.units_millis,
      epoch(),
    );
    const releasedAt = epoch();
    this.sql.exec(
      "UPDATE ai_reservations SET status = 'released', released_at = ? WHERE id = ?",
      releasedAt,
      reservationId,
    );
    this.recordAiEvent(releasedAt, "reservation_released", 0);
    return json({ status: "ok", reservation: publicReservation({ ...reservation, status: "released", released_at: releasedAt }), ai: this.aiBalanceFor(organization) });
  }

  async syncTranscript(_organization, body) {
    const id = String(body.session_id || "").trim();
    const transcript = Array.isArray(body.transcript) ? body.transcript : [];
    const suggestions = Array.isArray(body.suggestions) ? body.suggestions : [];
    const transcriptText = String(body.transcript_text || "").trim();
    if (!id || id.length > 80 || transcriptText.length > 1_000_000 || transcript.length > 5_000) {
      return json({ status: "invalid", message: "Invalid transcript payload." }, 400);
    }
    const createdAt = epoch();
    const startedAt = nonNegativeInt(body.started_at) || createdAt;
    const endedAt = body.ended_at ? nonNegativeInt(body.ended_at) : null;
    const performance = body.performance && typeof body.performance === "object" ? body.performance : {};
    this.sql.exec(
      `INSERT INTO transcripts (id, created_at, started_at, ended_at, provider, mode, version, transcript_text, transcript_json, suggestions_json, stop_reason, performance_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         ended_at = excluded.ended_at,
         transcript_text = excluded.transcript_text,
         transcript_json = excluded.transcript_json,
         suggestions_json = excluded.suggestions_json,
         stop_reason = excluded.stop_reason,
         performance_json = excluded.performance_json`,
      id,
      createdAt,
      startedAt,
      endedAt,
      String(body.provider || "").slice(0, 40),
      String(body.mode || "").slice(0, 40),
      String(body.version || "").slice(0, 80),
      transcriptText,
      JSON.stringify(transcript),
      JSON.stringify(suggestions),
      body.stop_reason ? String(body.stop_reason).slice(0, 500) : null,
      JSON.stringify(performance),
    );
    return json({ status: "ok", session_id: id });
  }

  async listTranscripts() {
    const transcripts = this.sql.exec(
      `SELECT id, created_at, started_at, ended_at, provider, mode, version,
              substr(transcript_text, 1, 240) AS preview,
              length(transcript_text) AS transcript_chars,
              performance_json
         FROM transcripts
        ORDER BY started_at DESC
        LIMIT 100`,
    ).toArray();
    return json({
      status: "ok",
      transcripts: transcripts.map(({ performance_json, ...transcript }) => ({
        ...transcript,
        performance: JSON.parse(performance_json || "{}"),
      })),
    });
  }

  async getTranscript(body) {
    const id = String(body.session_id || "").trim();
    if (!id) return json({ status: "invalid", message: "session_id is required." }, 400);
    const row = this.sql.exec("SELECT * FROM transcripts WHERE id = ?", id).toArray()[0];
    if (!row) return json({ status: "not_found", message: "Transcript not found." }, 404);
    return json({
      status: "ok",
      transcript: {
        id: row.id,
        created_at: row.created_at,
        started_at: row.started_at,
        ended_at: row.ended_at,
        provider: row.provider,
        mode: row.mode,
        version: row.version,
        transcript_text: row.transcript_text,
        transcript: JSON.parse(row.transcript_json || "[]"),
        suggestions: JSON.parse(row.suggestions_json || "[]"),
        performance: JSON.parse(row.performance_json || "{}"),
        stop_reason: row.stop_reason,
      },
    });
  }

  async deleteTranscript(body) {
    const id = String(body.session_id || "").trim();
    if (!id) return json({ status: "invalid", message: "session_id is required." }, 400);
    const existing = this.sql.exec("SELECT id FROM transcripts WHERE id = ?", id).toArray()[0];
    if (!existing) return json({ status: "not_found", message: "Transcript not found." }, 404);
    this.sql.exec("DELETE FROM transcripts WHERE id = ?", id);
    return json({ status: "ok" });
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
    this.ensureAiWallet(organization);
    const wallet = aiWallet(organization);
    const duration = optionalWhole(body.addon_duration_days, 0, 3650);
    if (duration !== null) {
      wallet.addon_expires_at = duration === 0 ? null : now + duration * 86_400;
    }

    const monthlyUnits = optionalWhole(body.monthly_units, 0, 1_000_000);
    if (monthlyUnits !== null) {
      const resetDays = optionalWhole(body.monthly_reset_days, 1, 366) ?? 30;
      this.sql.exec(
        "UPDATE ai_wallet SET monthly_allowance_millis = ?, monthly_remaining_millis = ?, monthly_cycle_days = ?, monthly_reset_at = ?, updated_at = ? WHERE id = 1",
        monthlyUnits * 1000,
        monthlyUnits * 1000,
        resetDays,
        now + resetDays * 86_400,
        now,
      );
      this.recordAiEvent(now, "monthly_allowance_set", monthlyUnits * 1000);
    }

    const topupUnits = optionalWhole(body.topup_units, 0, 1_000_000);
    if (topupUnits !== null && topupUnits > 0) {
      this.sql.exec(
        "UPDATE ai_wallet SET topup_remaining_millis = topup_remaining_millis + ?, updated_at = ? WHERE id = 1",
        topupUnits * 1000,
        now,
      );
      this.recordAiEvent(now, "topup_granted", topupUnits * 1000);
    }

    await this.save(organization);
    return json({
      status: "ok",
      organization: publicOrganization(organization),
      ai: this.aiBalanceFor(organization),
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
      if (!organization) continue;
      const publicOrg = publicOrganization(organization);
      try {
        const stub = env.ORGANIZATION_REGISTRY.get(env.ORGANIZATION_REGISTRY.idFromName(organization.id));
        const response = await stub.fetch("https://registry/internal/ai/balance", {
          method: "POST",
          body: JSON.stringify({ organization_id: organization.id }),
        });
        const data = await response.json().catch(() => null);
        if (data?.ai) publicOrg.ai_balance = data.ai;
      } catch (error) {
        console.error("AI balance lookup failed for admin list", organization.id, error);
      }
      result.push(publicOrg);
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

async function isGateway(request, env) {
  const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return Boolean(env.AI_GATEWAY_SERVICE_TOKEN) && constantTimeEqual(supplied, env.AI_GATEWAY_SERVICE_TOKEN);
}

function decodeBase64urlText(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const raw = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(raw, (char) => char.charCodeAt(0)));
}

async function verifyAiToken(env, token) {
  if (!env.AI_TOKEN_SECRET || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = await hmacBase64url(env.AI_TOKEN_SECRET, `${header}.${payload}`);
  if (!constantTimeEqual(expected, signature)) return null;
  let claims;
  try {
    claims = JSON.parse(decodeBase64urlText(payload));
  } catch {
    return null;
  }
  if (claims.aud !== AI_TOKEN_AUDIENCE) return null;
  if (!Number.isInteger(claims.exp) || claims.exp <= epoch()) return null;
  if (claims.addon_active !== true) return null;
  if (Number(claims.addon_expires_at) > 0 && Number(claims.addon_expires_at) <= epoch()) return null;
  if (typeof claims.org !== "string" || !validOrganizationId(claims.org)) return null;
  return claims;
}

async function createAiToken(env, organizationId, machineId, ai, now) {
  if (!env.AI_TOKEN_SECRET) throw new Error("AI_TOKEN_SECRET is not configured.");
  const header = base64urlText(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64urlText(JSON.stringify({
    aud: AI_TOKEN_AUDIENCE,
    org: organizationId,
    machine: machineId,
    addon_active: ai.addonActive === true,
    addon_expires_at: ai.addonExpiresAt || 0,
    iat: now,
    exp: now + AI_TOKEN_TTL_SECONDS,
    jti: crypto.randomUUID(),
  }));
  const unsigned = `${header}.${payload}`;
  const signature = await hmacBase64url(env.AI_TOKEN_SECRET, unsigned);
  return `${unsigned}.${signature}`;
}

function base64urlText(value) {
  return base64url(new TextEncoder().encode(value));
}

async function hmacBase64url(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64url(new Uint8Array(signature));
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
  wallet.monthly_cycle_days = optionalWhole(wallet.monthly_cycle_days, 1, 366) ?? 30;
  wallet.reserved_units_millis = nonNegativeInt(wallet.reserved_units_millis);
  if (!Array.isArray(wallet.ledger)) wallet.ledger = [];
  if (!Array.isArray(wallet.reservations)) wallet.reservations = [];
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
function publicReservation(reservation) {
  return {
    id: reservation.id,
    units: reservation.units_millis / 1000,
    kind: reservation.kind,
    status: reservation.status,
    created_at: reservation.created_at,
    expires_at: reservation.expires_at,
    settled_units: (reservation.settled_units_millis || 0) / 1000,
  };
}

function cleanIdempotencyKey(value) {
  const key = String(value || "").trim();
  return key.length >= 8 && key.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(key) ? key : null;
}

function cleanReservationId(value) {
  const id = String(value || "").trim();
  return /^res_[a-f0-9]{32}$/.test(id) ? id : null;
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
:root{color-scheme:dark;--bg:#10131a;--panel:#191e29;--border:#30394a;--text:#edf2f7;--muted:#a5b0c0;--accent:#77b7ff;--danger:#fb7185;--ok:#5eead4}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif}header{padding:16px 22px;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:center}h1,h2{margin:0}h1{font-size:17px}h2{font-size:15px}.spacer{flex:1}main{max-width:1200px;margin:22px auto;padding:0 18px;display:grid;gap:16px}.panel{padding:16px;background:var(--panel);border:1px solid var(--border);border-radius:10px}.hidden{display:none}.muted{color:var(--muted)}.row{display:flex;flex-wrap:wrap;gap:9px;align-items:center;margin-top:12px}input,select,button{font:inherit;border-radius:6px;padding:8px 10px;border:1px solid var(--border);background:#10141c;color:var(--text)}input{min-width:130px}button{cursor:pointer}button:hover{border-color:var(--accent)}button.primary{background:var(--accent);color:#07111f;border-color:var(--accent);font-weight:700}button.danger{color:var(--danger)}table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--border);vertical-align:middle}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}.badge{border:1px solid var(--border);border-radius:999px;padding:2px 7px;font-size:11px;font-weight:700}.free{color:#cbd5e1}.pro{color:#7dd3fc}.premium{color:#d8b4fe}.revoked{color:var(--danger)}.ai{color:#5eead4}.code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.notice{min-height:20px;margin-top:10px;color:var(--muted)}.error{color:var(--danger)}@media(max-width:800px){table{display:block;overflow:auto}}
</style></head><body>
<section id="login"><main><div class="panel"><h1>Wordlyte Account Admin</h1><p class="muted">Sign in with the server administrator token. The token is held only in this browser tab.</p><div class="row"><input id="token" type="password" autocomplete="current-password" placeholder="ADMIN_TOKEN" style="flex:1"><button class="primary" id="signIn">Sign in</button></div><p class="notice" id="loginNotice"></p></div></main></section>
<section id="app" class="hidden"><header><h1>Wordlyte Account Admin</h1><span class="muted" id="summary"></span><span class="spacer"></span><button id="refresh">Refresh</button><button id="signOut">Sign out</button></header><main>
<div class="panel"><h2>Create organization</h2><div class="row"><input id="church" placeholder="Church name" style="flex:2"><input id="email" type="email" placeholder="Owner email" style="flex:2"><select id="createPlan"><option value="free">Free</option><option value="pro">Pro</option><option value="premium">Premium</option></select><input id="createDays" type="number" min="1" max="3650" value="30" title="Paid plan duration in days"><input id="createDevices" type="number" min="1" value="1" title="Device limit"><button class="primary" id="create">Create</button></div><p class="notice" id="createNotice"></p></div>
<div class="panel"><h2>Organizations</h2><p class="notice" id="notice"></p><table><thead><tr><th>Church</th><th>Owner</th><th>Plan</th><th>Devices</th><th>Paid expiry</th><th>Status</th><th>AI</th><th>Actions</th></tr></thead><tbody id="rows"></tbody></table></div>
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
function render(){const body=$('rows');if(!organizations.length){body.innerHTML='<tr><td colspan="8" class="muted">No organizations yet.</td></tr>';return}body.innerHTML=organizations.map(o=>'<tr><td><b>'+esc(o.church_name)+'</b><br><span class="muted code">'+esc(o.id)+'</span></td><td>'+esc(o.email)+'</td><td><span class="badge '+esc(o.plan)+'">'+esc(o.plan)+'</span></td><td>'+esc(o.devices_used)+' / '+esc(o.device_limit)+'</td><td>'+date(o.plan_expires_at)+'</td><td>'+(o.revoked?'<span class="badge revoked">revoked</span>':'<span class="badge">active</span>')+'</td><td>'+(o.ai?.addonActive?'<span class="badge ai">AI</span><br><span class="muted">'+esc(o.ai_balance?.total_units_remaining??'—')+' Units</span>':'<span class="muted">—</span>')+'</td><td><button data-action="code" data-id="'+esc(o.id)+'">Pair code</button> <button data-action="plan" data-id="'+esc(o.id)+'">Plan</button> <button data-action="ai" data-id="'+esc(o.id)+'">AI</button> <button class="danger" data-action="revoke" data-id="'+esc(o.id)+'">'+(o.revoked?'Restore':'Revoke')+'</button></td></tr>').join('')}
async function create(){const church_name=$('church').value.trim(),email=$('email').value.trim(),plan=$('createPlan').value;if(!church_name||!email){showNotice('createNotice','Church name and owner email are required.',true);return}const r=await api('/admin/organizations',{method:'POST',body:JSON.stringify({church_name,email,plan,plan_duration_days:+$('createDays').value,device_limit:+$('createDevices').value})});if(r.status!==200){showNotice('createNotice',r.data?.message||'Could not create organization.',true);return}showNotice('createNotice','Created. Activation code: '+r.data.activation_code);$('church').value='';$('email').value='';load()}
async function action(event){const button=event.target.closest('button[data-action]');if(!button)return;const id=button.dataset.id,kind=button.dataset.action;if(kind==='code'){const r=await api('/admin/organizations/'+id+'/activation-code',{method:'POST',body:'{}'});showNotice('notice',r.status===200?'Device activation code: '+r.data.activation_code:(r.data?.message||'Could not create pairing code.'),r.status!==200);return}if(kind==='revoke'){const organization=organizations.find(o=>o.id===id);if(!organization||!confirm((organization.revoked?'Restore':'Revoke')+' '+organization.church_name+'?'))return;const r=await api('/admin/organizations/'+id+'/revoke',{method:'POST',body:JSON.stringify({revoked:!organization.revoked})});if(r.status!==200)showNotice('notice',r.data?.message||'Update failed.',true);else load();return}if(kind==='ai'){const organization=organizations.find(o=>o.id===id);const days=prompt('AI Add-on duration in days (0 disables)','30');if(days===null)return;const monthly=prompt('Monthly AI Units',String(organization?.ai_balance?.monthly_units_remaining??120));if(monthly===null)return;const topup=prompt('One-time top-up Units (added)', '0');if(topup===null)return;const r=await api('/admin/organizations/'+id+'/ai',{method:'POST',body:JSON.stringify({addon_duration_days:+days,monthly_units:+monthly,topup_units:+topup})});if(r.status!==200)showNotice('notice',r.data?.message||'AI provisioning failed.',true);else{showNotice('notice','AI provisioned: '+esc(r.data?.ai?.total_units_remaining??0)+' Units available.');load()}return}const organization=organizations.find(o=>o.id===id);const plan=prompt('Plan: free, pro, or premium',organization?.plan||'free');if(!plan)return;const days=prompt('Plan duration in days (paid plans)', '30');const devices=prompt('Device limit',String(organization?.device_limit||1));const r=await api('/admin/organizations/'+id+'/plan',{method:'POST',body:JSON.stringify({plan,plan_duration_days:+days,device_limit:+devices})});if(r.status!==200)showNotice('notice',r.data?.message||'Plan update failed.',true);else load()}
$('signIn').onclick=()=>{token=$('token').value.trim();if(!token){showNotice('loginNotice','Enter the administrator token.',true);return}sessionStorage.setItem('wordlyte_admin_token',token);showApp()};$('signOut').onclick=()=>{token='';sessionStorage.removeItem('wordlyte_admin_token');showLogin('')};$('refresh').onclick=load;$('create').onclick=create;$('rows').onclick=action;if(token)showApp();
</script></body></html>`;
