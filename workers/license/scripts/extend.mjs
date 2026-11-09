#!/usr/bin/env node
// Set an organization's paid plan and renewal duration.
// Usage: node scripts/extend.mjs org_<id> <free|pro|premium> [duration_days=30] [device_limit]

const base = process.env.WORDLYTE_LICENSE_URL;
const token = process.env.WORDLYTE_ADMIN_TOKEN;
const [organizationId, plan, durationDays = "30", deviceLimit] = process.argv.slice(2);
if (!base || !token || !organizationId || !plan) {
  console.error("Usage: WORDLYTE_LICENSE_URL=... WORDLYTE_ADMIN_TOKEN=... node scripts/extend.mjs <organization_id> <free|pro|premium> [duration_days=30] [device_limit]");
  process.exit(1);
}
const response = await fetch(`${base.replace(/\/$/, "")}/admin/organizations/${encodeURIComponent(organizationId)}/plan`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ plan, plan_duration_days: Number(durationDays), ...(deviceLimit ? { device_limit: Number(deviceLimit) } : {}) }),
});
const data = await response.json();
if (!response.ok || data.status !== "ok") {
  console.error("Plan update failed:", JSON.stringify(data));
  process.exit(1);
}
console.log(`Updated ${data.organization.church_name}: ${data.organization.plan}${data.organization.plan_expires_at ? ` until ${new Date(data.organization.plan_expires_at * 1000).toISOString().slice(0, 10)}` : ""}.`);
