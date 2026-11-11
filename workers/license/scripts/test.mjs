#!/usr/bin/env node
// Hermetic v3 account/device entitlement tests. Runs against Wrangler local
// storage and a throwaway Ed25519 signing key; it never contacts production.

import { spawn, spawnSync } from "node:child_process";
import { createHmac, generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = "local-test-token";
const AI_GATEWAY_SERVICE_TOKEN = "EXAMPLE-local-ai-gateway-token";
const AI_TOKEN_SECRET = "EXAMPLE-local-ai-token-secret";
const M1 = "a".repeat(64);
const M2 = "b".repeat(64);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privateJwk = JSON.stringify(privateKey.export({ format: "jwk" }));
const devVarsPath = join(ROOT, ".dev.vars");
let originalDevVars = null;
try { originalDevVars = readFileSync(devVarsPath, "utf8"); } catch {}

function canonical(payload) {
  return [
    "wl3", payload.organization_id, payload.machine_id, payload.status,
    String(payload.core_activated_at), payload.plan,
    String(payload.plan_expires_at || 0), String(payload.max_machines),
    String(payload.machines_used), String(payload.server_time),
    String(payload.limits.maxBibleVersions), String(payload.limits.maxOutputs),
    String(payload.limits.maxCameras), String(payload.limits.maxScenes),
    String(payload.limits.streamDestinations), payload.limits.sharedAudioInput ? "1" : "0",
    payload.ai.addonActive ? "1" : "0", String(payload.ai.addonExpiresAt || 0),
  ].join("|");
}

function validSignature(payload) {
  return typeof payload?.sig === "string" && verifySignature(
    null,
    canonical(payload),
    publicKey,
    Buffer.from(payload.sig, "base64")
  );
}

function validAiToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts;
  const expected = createHmac("sha256", AI_TOKEN_SECRET).update(`${header}.${payload}`).digest("base64url");
  if (expected !== signature) return false;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  return claims.aud === "wordlyte-ai" && claims.addon_active === true && claims.exp > Math.floor(Date.now() / 1000);
}

const results = [];
function check(name, value) {
  results.push({ name, ok: Boolean(value) });
  console.log(`${value ? "ok  " : "FAIL"} ${name}`);
}

async function call(path, { method = "GET", token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json().catch(() => null) };
}

async function waitForServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Worker did not start in time");
}

const persist = await mkdtemp(join(tmpdir(), "wordlyte-account-test-"));
const wrangler = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
writeFileSync(devVarsPath, `ADMIN_TOKEN=${ADMIN_TOKEN}\nAI_GATEWAY_SERVICE_TOKEN=${AI_GATEWAY_SERVICE_TOKEN}\nAI_TOKEN_SECRET=${AI_TOKEN_SECRET}\nLICENSE_SIGN_PRIVATE_KEY=${privateJwk}\n`);
const worker = spawn(process.execPath, [wrangler, "dev", "--local", "--port", String(PORT), "--persist-to", persist], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
let stdout = "";
worker.stdout.on("data", (chunk) => { stdout += chunk; });
worker.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  await waitForServer();
  let response = await call("/");
  check("root health endpoint is available", response.status === 200 && response.data?.status === "ok");
  const adminPage = await fetch(`${BASE}/admin`);
  const adminHtml = await adminPage.text();
  check("browser administrator console is available", adminPage.status === 200 && adminHtml.includes("Wordlyte Account Admin"));
  check("browser administrator console exposes AI provisioning", adminHtml.includes('data-action="ai"'));
  response = await call("/admin/organizations");
  check("admin organization creation requires authentication", response.status === 401);

  response = await call("/admin/organizations", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { church_name: "Free Church", email: "owner@example.test", plan: "free" },
  });
  check("admin creates a Free organization", response.status === 200 && response.data.status === "ok" && response.data.organization.plan === "free");
  const freeOrganization = response.data.organization;
  const freeCode = response.data.activation_code;
  check("organization receives a one-time activation code", /^WACT-[A-Z2-9]{20}$/.test(freeCode || ""));

  response = await call("/activate", { method: "POST", body: { activation_code: freeCode, machine_id: M1, device_name: "Sanctuary PC" } });
  check("Free activation succeeds", response.status === 200 && response.data.status === "active" && response.data.plan === "free");
  check("activation response is signed", validSignature(response.data));
  check("Free entitlement carries server-signed output capacity", response.data.limits?.maxOutputs === 1 && response.data.limits?.streamDestinations === 0);
  check("activation returns a device-only credential", /^wdv_[A-Za-z0-9_-]{20,}$/.test(response.data.device_token || ""));
  const freeDeviceToken = response.data.device_token;
  const tampered = { ...response.data, plan: "premium" };
  check("tampered entitlement fails signature verification", !validSignature(tampered));

  response = await call("/entitlement", { method: "POST", body: { organization_id: freeOrganization.id, machine_id: M1, device_token: freeDeviceToken } });
  check("device refresh succeeds", response.status === 200 && response.data.status === "active" && response.data.plan === "free" && validSignature(response.data));
  check("refresh never returns a device token", !Object.hasOwn(response.data, "device_token"));

  response = await call("/ai/token", { method: "POST", body: { organization_id: freeOrganization.id, machine_id: M1, device_token: freeDeviceToken } });
  check("AI token requires an active AI Add-on", response.status === 403 && response.data.status === "ai_not_entitled");

  response = await call("/activate", { method: "POST", body: { activation_code: freeCode, machine_id: M2, device_name: "Second PC" } });
  check("activation code cannot consume a second computer", response.status === 200 && response.data.status === "invalid");

  response = await call(`/admin/organizations/${freeOrganization.id}/activation-code`, { method: "POST", token: ADMIN_TOKEN });
  const replacementCode = response.data.activation_code;
  check("admin can create a replacement pairing code", response.status === 200 && /^WACT-/.test(replacementCode || ""));
  response = await call("/activate", { method: "POST", body: { activation_code: replacementCode, machine_id: M2, device_name: "Second PC" } });
  check("Free device limit is enforced", response.status === 200 && response.data.status === "invalid");

  response = await call(`/admin/organizations/${freeOrganization.id}/plan`, {
    method: "POST", token: ADMIN_TOKEN, body: { plan: "premium", plan_duration_days: 30, device_limit: 5 },
  });
  check("admin updates plan and capacity", response.status === 200 && response.data.organization.plan === "premium" && response.data.organization.device_limit === 5);
  response = await call("/activate", { method: "POST", body: { activation_code: replacementCode, machine_id: M2, device_name: "Second PC" } });
  check("Premium capacity permits second device", response.status === 200 && response.data.plan === "premium" && response.data.machines_used === 2);
  check("Premium entitlement carries scaled production limits", response.data.limits?.maxOutputs === 10 && response.data.limits?.sharedAudioInput === true);

  response = await call(`/admin/organizations/${freeOrganization.id}/ai`, {
    method: "POST", token: ADMIN_TOKEN,
    body: { addon_duration_days: 30, monthly_units: 120, topup_units: 25 },
  });
  check("admin provisions the AI Add-on and Unit wallet", response.status === 200
    && response.data.ai?.addon_active === true
    && response.data.ai?.monthly_units_remaining === 120
    && response.data.ai?.topup_units_remaining === 25
    && response.data.ai?.total_units_remaining === 145);
  response = await call("/entitlement", { method: "POST", body: { organization_id: freeOrganization.id, machine_id: M1, device_token: freeDeviceToken } });
  check("AI Add-on entitlement is signed", response.status === 200
    && response.data.ai?.addonActive === true
    && typeof response.data.ai?.addonExpiresAt === "number"
    && validSignature(response.data));

  response = await call("/ai/token", { method: "POST", body: { organization_id: freeOrganization.id, machine_id: M1, device_token: freeDeviceToken } });
  check("device exchanges its credential for a short-lived AI token", response.status === 200
    && validAiToken(response.data.token)
    && response.data.expires_at > Math.floor(Date.now() / 1000)
    && response.data.ai?.total_units_remaining === 145);
  const aiToken = response.data.token;

  response = await call("/ai/token", { method: "POST", body: { organization_id: freeOrganization.id, machine_id: M1, device_token: "wdv_invalid" } });
  check("AI token rejects a bad device credential", response.status === 400 || response.status === 200);

  response = await call("/internal/ai/reserve", {
    method: "POST",
    body: { organization_id: freeOrganization.id, units: 10, kind: "llm", idempotency_key: "test-reserve-001" },
  });
  check("internal AI spend requires the gateway service credential", response.status === 401);

  response = await call("/internal/ai/reserve", {
    method: "POST", token: AI_GATEWAY_SERVICE_TOKEN,
    body: { organization_id: freeOrganization.id, units: 10, kind: "llm", idempotency_key: "test-reserve-001" },
  });
  check("gateway reserves AI Units atomically", response.status === 200
    && response.data.reservation?.status === "reserved"
    && response.data.ai?.available_units_remaining === 135);
  const reservationId = response.data.reservation.id;
  const duplicate = await call("/internal/ai/reserve", {
    method: "POST", token: AI_GATEWAY_SERVICE_TOKEN,
    body: { organization_id: freeOrganization.id, units: 10, kind: "llm", idempotency_key: "test-reserve-001" },
  });
  check("AI reservation is idempotent", duplicate.status === 200 && duplicate.data.reservation?.id === reservationId);

  response = await call("/internal/ai/settle", {
    method: "POST", token: AI_GATEWAY_SERVICE_TOKEN,
    body: { organization_id: freeOrganization.id, reservation_id: reservationId, actual_units: 10 },
  });
  check("gateway settles AI Units after a successful request", response.status === 200
    && response.data.ai?.total_units_remaining === 135
    && response.data.ai?.reserved_units_remaining === 0);

  response = await call("/internal/ai/reserve", {
    method: "POST", token: AI_GATEWAY_SERVICE_TOKEN,
    body: { organization_id: freeOrganization.id, units: 20, kind: "llm", idempotency_key: "test-release-002" },
  });
  const releaseId = response.data.reservation.id;
  response = await call("/internal/ai/release", {
    method: "POST", token: AI_GATEWAY_SERVICE_TOKEN,
    body: { organization_id: freeOrganization.id, reservation_id: releaseId },
  });
  check("failed AI request releases its reservation", response.status === 200
    && response.data.reservation?.status === "released"
    && response.data.ai?.available_units_remaining === 135);

  response = await call(`/admin/organizations/${freeOrganization.id}/ai`, { token: ADMIN_TOKEN });
  check("admins can read the AI Unit balance", response.status === 200
    && response.data.ai?.total_units_remaining === 135
    && Array.isArray(response.data.usage));

  response = await call("/internal/ai/reserve", {
    method: "POST", token: AI_GATEWAY_SERVICE_TOKEN,
    body: { organization_id: freeOrganization.id, units: 1, kind: "asr", idempotency_key: "test-asr-millis-004" },
  });
  const asrReservationId = response.data.reservation.id;
  response = await call("/internal/ai/settle", {
    method: "POST", token: AI_GATEWAY_SERVICE_TOKEN,
    body: { organization_id: freeOrganization.id, reservation_id: asrReservationId, actual_milli_units: 500 },
  });
  check("transcription settles fractional minutes exactly", response.status === 200
    && response.data.ai?.total_units_remaining === 134.5);

  response = await call(`/admin/organizations/${freeOrganization.id}/revoke`, { method: "POST", token: ADMIN_TOKEN, body: { revoked: true } });
  check("admin revokes organization", response.status === 200 && response.data.organization.revoked === true);
  response = await call("/entitlement", { method: "POST", body: { organization_id: freeOrganization.id, machine_id: M1, device_token: freeDeviceToken } });
  check("revoked entitlement remains signed", response.status === 200 && response.data.status === "revoked" && validSignature(response.data));

  response = await call("/admin/organizations", { token: ADMIN_TOKEN });
  check("admin lists organizations", response.status === 200 && response.data.organizations.length === 1);
} catch (error) {
  check(`unexpected error: ${error.message}`, false);
} finally {
  worker.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(persist, { recursive: true, force: true }).catch(() => {});
  if (originalDevVars === null) await rm(devVarsPath, { force: true }).catch(() => {});
  else writeFileSync(devVarsPath, originalDevVars);
}

const failures = results.filter((result) => !result.ok);
if (failures.length) {
  console.error(`\n${failures.length} test(s) failed.`);
  if (stderr) console.error(stderr.split("\n").slice(-40).join("\n"));
  if (stdout) console.error(stdout.split("\n").slice(-40).join("\n"));
  process.exit(1);
}
console.log(`\nAll ${results.length} tests passed.`);
