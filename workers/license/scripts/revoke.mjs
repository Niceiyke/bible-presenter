#!/usr/bin/env node
// Revoke (or un-revoke) a license key against the deployed Worker.
//
// Usage:
//   set WORDLYTE_LICENSE_URL=https://wordlyte-license.<your-subdomain>.workers.dev
//   set WORDLYTE_ADMIN_TOKEN=<the ADMIN_TOKEN secret>
//   node scripts/revoke.mjs WORDLYTE-XXXX-XXXX-XXXX-XXXX        # revoke
//   node scripts/revoke.mjs WORDLYTE-XXXX-XXXX-XXXX-XXXX false  # un-revoke

const base = process.env.WORDLYTE_LICENSE_URL;
const token = process.env.WORDLYTE_ADMIN_TOKEN;
if (!base || !token) {
  console.error(
    "Set WORDLYTE_LICENSE_URL and WORDLYTE_ADMIN_TOKEN environment variables first."
  );
  process.exit(1);
}

const [key, state] = process.argv.slice(2);
if (!key) {
  console.error("Usage: revoke.mjs <license_key> [revoked=true|false]");
  process.exit(1);
}
const revoked = state === undefined ? true : !["false", "0", "no", "n"].includes(state.toLowerCase());

const res = await fetch(`${base.replace(/\/$/, "")}/revoke`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ license_key: key, revoked }),
});

const data = await res.json();
if (!res.ok || data.status !== "ok") {
  console.error("Revoke failed:", JSON.stringify(data));
  process.exit(1);
}

console.log(`\n${revoked ? "Revoked" : "Un-revoked"} ${data.key} (${data.church_name}).`);
console.log(`  Expires ${new Date(data.expires_at * 1000).toISOString().slice(0, 10)}`);