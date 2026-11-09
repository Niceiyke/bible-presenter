#!/usr/bin/env node
// Revoke or restore an organization.
// Usage: node scripts/revoke.mjs org_<id> [true|false]

const base = process.env.WORDLYTE_LICENSE_URL;
const token = process.env.WORDLYTE_ADMIN_TOKEN;
const [organizationId, state] = process.argv.slice(2);
if (!base || !token || !organizationId) {
  console.error("Usage: WORDLYTE_LICENSE_URL=... WORDLYTE_ADMIN_TOKEN=... node scripts/revoke.mjs <organization_id> [revoked=true|false]");
  process.exit(1);
}
const revoked = state === undefined ? true : !["false", "0", "no", "n"].includes(state.toLowerCase());
const response = await fetch(`${base.replace(/\/$/, "")}/admin/organizations/${encodeURIComponent(organizationId)}/revoke`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ revoked }),
});
const data = await response.json();
if (!response.ok || data.status !== "ok") {
  console.error("Revoke failed:", JSON.stringify(data));
  process.exit(1);
}
console.log(`${revoked ? "Revoked" : "Restored"} ${data.organization.church_name} (${data.organization.id}).`);
