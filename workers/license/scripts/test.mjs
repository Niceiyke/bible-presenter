#!/usr/bin/env node
// Hermetic worker tests. Spawns `wrangler dev --local` against a throwaway KV
// persistence dir and exercises the whole license API surface. Never talks to
// Cloudflare or the real namespace.
//
//   npm test
//
// Requires Node >= 18 (global fetch) and the `wrangler` devDependency installed.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;

let adminToken = process.env.TEST_ADMIN_TOKEN;
if (!adminToken) {
  try {
    const devVars = readFileSync(join(ROOT, ".dev.vars"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith("ADMIN_TOKEN="));
    adminToken = devVars?.slice("ADMIN_TOKEN=".length);
  } catch {
    // No .dev.vars (e.g. CI) — fall back to the default below.
  }
}
const ADMIN_TOKEN = adminToken || "local-test-token";

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
}

async function call(path, { method = "GET", token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function waitForServer(url, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status >= 200) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Server did not come up within ${timeoutMs}ms: ${lastErr}`);
}

const persist = await mkdtemp(join(tmpdir(), "license-test-"));
const wranglerJs = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const proc = spawn(process.execPath, [wranglerJs, "dev", "--local", "--port", String(PORT), "--persist-to", persist], {
  cwd: ROOT,
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
proc.stderr.on("data", (d) => (stderr += d.toString()));

try {
  await waitForServer(`${BASE}/license`);

  const admin = await fetch(`${BASE}/admin`);
  const adminHtml = await admin.text();
  check(
    "GET /admin serves the admin UI",
    admin.status === 200 && (admin.headers.get("content-type") || "").includes("text/html")
  );
  check("admin UI uses delegated row actions", adminHtml.includes('data-action'));
  check("admin UI has tier selector + badges", adminHtml.includes('id="fTier"') && adminHtml.includes('value="premium"') && adminHtml.includes('tierBadge'));
  const scriptMatch = adminHtml.match(/<script>([\s\S]*)<\/script>/);
  if (scriptMatch) {
    const checkFile = join(tmpdir(), `license-admin-${process.pid}.js`);
    await writeFile(checkFile, scriptMatch[1]);
    const chk = spawnSync(process.execPath, ["--check", checkFile], { encoding: "utf8" });
    check("admin page JS parses cleanly", chk.status === 0);
    await rm(checkFile, { force: true }).catch(() => {});
  } else {
    check("admin page JS parses cleanly", false);
  }

  const M1 = "a".repeat(64);
  const M2 = "b".repeat(64);
  const M3 = "c".repeat(64);

  // auth gating
  let r = await call("/licenses");
  check("GET /licenses without token → 401", r.status === 401);
  r = await call("/licenses", { token: "wrong-token" });
  check("GET /licenses with wrong token → 401", r.status === 401);
  r = await call("/issue", { method: "POST", body: {} });
  check("POST /issue without token → 401", r.status === 401);

  // empty list
  r = await call("/licenses", { token: ADMIN_TOKEN });
  check("GET /licenses empty → status ok", r.status === 200 && r.data.status === "ok" && r.data.licenses.length === 0);

  // issue
  r = await call("/issue", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { church_name: "Test Church", email: "test@example.com", duration_days: 30, max_machines: 2, tier: "pro" },
  });
  check("issue → status ok", r.status === 200 && r.data.status === "ok");
  const key = r.data.license_key;
  check("issued key format WORDLYTE-XXXX-XXXX-XXXX-XXXX", /^WORDLYTE-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(key || ""));
  const expiresAt = r.data.expires_at;
  check("issue stores tier", r.data.tier === "pro" && r.data.max_machines === 2);

  // listing
  r = await call("/licenses", { token: ADMIN_TOKEN });
  check("list shows 1 license", r.status === 200 && r.data.licenses.length === 1 && r.data.licenses[0].key === key);

  // validate: unknown
  r = await call("/validate", {
    method: "POST",
    body: { license_key: "WORDLYTE-AAAA-BBBB-CCCC-DDDD", machine_id: M1 },
  });
  check("validate unknown key → invalid", r.status === 200 && r.data.status === "invalid");

  // validate: bad machine id
  r = await call("/validate", {
    method: "POST",
    body: { license_key: key, machine_id: "not-hex" },
  });
  check("validate malformed machine id → invalid (400)", r.status === 400 && r.data.status === "invalid");

  // validate: activate machines up to cap
  r = await call("/validate", { method: "POST", body: { license_key: key, machine_id: M1 } });
  check("validate machine 1 → active, machines_used 1", r.status === 200 && r.data.status === "active" && r.data.machines_used === 1);
  r = await call("/validate", { method: "POST", body: { license_key: key, machine_id: M2 } });
  check("validate machine 2 → active, machines_used 2", r.status === 200 && r.data.status === "active" && r.data.machines_used === 2);
  r = await call("/validate", { method: "POST", body: { license_key: key, machine_id: M3 } });
  check("validate machine 3 → invalid (slot cap)", r.status === 200 && r.data.status === "invalid");
  r = await call("/validate", { method: "POST", body: { license_key: key, machine_id: M1 } });
  check("validate machine 1 again → active (idempotent)", r.status === 200 && r.data.status === "active" && r.data.machines_used === 2);

  // stored record integrity: the machines array must hold the real fingerprints,
  // never a phantom null/undefined entry (audit: the DO body was parsed twice).
  r = await call("/licenses", { token: ADMIN_TOKEN });
  const storedRec = r.data.licenses.find((l) => l.key === key);
  check(
    "stored machines are exactly M1 + M2 (no phantom entries)",
    r.status === 200 && Array.isArray(storedRec?.machines) &&
      storedRec.machines.length === 2 &&
      storedRec.machines.includes(M1) && storedRec.machines.includes(M2) &&
      storedRec.machines.every((m) => typeof m === "string" && /^[0-9a-f]{64}$/.test(m))
  );

  // extend
  r = await call("/extend", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { license_key: key, days: 10 },
  });
  check("extend +10 days", r.status === 200 && r.data.status === "ok" && r.data.expires_at === expiresAt + 10 * 86400);

  // tier: validate returns tier
  r = await call("/validate", { method: "POST", body: { license_key: key, machine_id: M1 } });
  check("validate returns tier", r.status === 200 && r.data.status === "active" && r.data.tier === "pro");

  // tier: free issue clamps machines to 1
  r = await call("/issue", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { church_name: "Free Church", email: "free@example.com", duration_days: 30, max_machines: 5 },
  });
  check("issue defaults to free + clamps machines to 1", r.status === 200 && r.data.status === "ok" && r.data.tier === "free" && r.data.max_machines === 1);

  // tier: premium issue keeps machines
  r = await call("/issue", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { church_name: "Premium Church", email: "prem@example.com", duration_days: 30, max_machines: 20, tier: "premium" },
  });
  check("issue premium tier keeps 20 machines", r.status === 200 && r.data.status === "ok" && r.data.tier === "premium" && r.data.max_machines === 20);

  // tier: unknown tier value falls back to free
  r = await call("/issue", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { church_name: "Bad Tier", email: "bad@example.com", duration_days: 30, tier: "ultimate" },
  });
  check("unknown tier falls back to free", r.status === 200 && r.data.status === "ok" && r.data.tier === "free");

  // tier: extend can change tier without days (keeps 2 machines on upgrade)
  r = await call("/extend", { method: "POST", token: ADMIN_TOKEN, body: { license_key: key, tier: "premium" } });
  check("extend changes tier (no days) → premium, machines 2", r.status === 200 && r.data.status === "ok" && r.data.tier === "premium" && r.data.max_machines === 2);
  // tier: downgrade re-clamps machines
  r = await call("/extend", { method: "POST", token: ADMIN_TOKEN, body: { license_key: key, tier: "free" } });
  check("extend downgrade to free re-clamps machines to 1", r.status === 200 && r.data.status === "ok" && r.data.tier === "free" && r.data.max_machines === 1);

  // extend with no days and no tier → 400
  r = await call("/extend", { method: "POST", token: ADMIN_TOKEN, body: { license_key: key, days: 0 } });
  check("extend with days 0 and no tier → 400", r.status === 400);

  // audit #9: an admin mutation followed by a new-device registration must not
  // be overwritten by a warm Durable Object cache (stale tier/expiry/machines).
  r = await call("/issue", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { church_name: "Registry Test", email: "reg@example.com", duration_days: 30, max_machines: 2, tier: "pro" },
  });
  const key2 = r.data.license_key;
  r = await call("/validate", { method: "POST", body: { license_key: key2, machine_id: M1 } });
  check("registry key M1 → active", r.status === 200 && r.data.status === "active");
  const expiryBefore = (await call("/licenses", { token: ADMIN_TOKEN })).data.licenses.find((l) => l.key === key2).expires_at;
  r = await call("/extend", { method: "POST", token: ADMIN_TOKEN, body: { license_key: key2, days: 15 } });
  check("registry key extend +15d", r.status === 200 && r.data.status === "ok" && r.data.expires_at === expiryBefore + 15 * 86400);
  r = await call("/validate", { method: "POST", body: { license_key: key2, machine_id: M2 } });
  check(
    "registry key M2 after admin mutation → active, expiry preserved",
    r.status === 200 && r.data.status === "active" && r.data.expires_at === expiryBefore + 15 * 86400
  );
  r = await call("/validate", { method: "POST", body: { license_key: key2, machine_id: M3 } });
  check("registry key M3 → invalid (2-slot cap after admin mutation)", r.status === 200 && r.data.status === "invalid");
  const stored2 = (await call("/licenses", { token: ADMIN_TOKEN })).data.licenses.find((l) => l.key === key2);
  check(
    "registry key stored machines have no phantom entries",
    Array.isArray(stored2?.machines) && stored2.machines.length === 2 &&
      stored2.machines.includes(M1) && stored2.machines.includes(M2) &&
      stored2.machines.every((m) => typeof m === "string" && /^[0-9a-f]{64}$/.test(m))
  );
  r = await call("/revoke", { method: "POST", token: ADMIN_TOKEN, body: { license_key: key2, revoked: true } });
  check("registry key revoke after registration", r.status === 200 && r.data.status === "ok" && r.data.revoked === true);
  r = await call("/validate", { method: "POST", body: { license_key: key2, machine_id: M1 } });
  check("registry key revoked → revoked", r.status === 200 && r.data.status === "revoked");

  // expiring
  r = await call("/expiring?days=365", { token: ADMIN_TOKEN });
  check("expiring lists the key", r.status === 200 && r.data.status === "ok" && r.data.expiring.some((l) => l.key === key));

  // revoke
  r = await call("/revoke", { method: "POST", token: ADMIN_TOKEN, body: { license_key: key, revoked: true } });
  check("revoke → ok, revoked true", r.status === 200 && r.data.status === "ok" && r.data.revoked === true);
  r = await call("/validate", { method: "POST", body: { license_key: key, machine_id: M1 } });
  check("validate revoked key → revoked", r.status === 200 && r.data.status === "revoked");

  // unknown key admin ops
  r = await call("/revoke", { method: "POST", token: ADMIN_TOKEN, body: { license_key: "WORDLYTE-AAAA-BBBB-CCCC-DDDD" } });
  check("revoke unknown key → 404", r.status === 404);
  r = await call("/extend", { method: "POST", token: ADMIN_TOKEN, body: { license_key: "WORDLYTE-AAAA-BBBB-CCCC-DDDD", days: 5 } });
  check("extend unknown key → 404", r.status === 404);
} catch (err) {
  check(`unexpected error: ${err.message}`, false);
} finally {
  proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  await rm(persist, { recursive: true, force: true }).catch(() => {});
}

const failures = results.filter((r) => !r.ok);
if (failures.length) {
  console.error(`\n${failures.length} test(s) failed.`);
  if (stderr) console.error("--- wrangler stderr (last 40 lines) ---\n" + stderr.split("\n").slice(-40).join("\n"));
  process.exit(1);
}
console.log(`\nAll ${results.length} tests passed.`);