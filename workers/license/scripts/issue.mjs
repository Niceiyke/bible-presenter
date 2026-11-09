#!/usr/bin/env node
// Create an organization and its first one-time desktop activation code.
// Usage: node scripts/issue.mjs "First Church" owner@example.org [free|pro|premium] [duration_days] [device_limit]

const base = process.env.WORDLYTE_LICENSE_URL;
const token = process.env.WORDLYTE_ADMIN_TOKEN;
const [church, email, plan = "free", durationDays = "0", deviceLimit] = process.argv.slice(2);
if (!base || !token || !church || !email) {
  console.error("Usage: WORDLYTE_LICENSE_URL=... WORDLYTE_ADMIN_TOKEN=... node scripts/issue.mjs <church_name> <email> [plan=free] [duration_days=0] [device_limit]");
  process.exit(1);
}

const response = await fetch(`${base.replace(/\/$/, "")}/admin/organizations`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({
    church_name: church,
    email,
    plan,
    plan_duration_days: Number(durationDays),
    ...(deviceLimit ? { device_limit: Number(deviceLimit) } : {}),
  }),
});
const data = await response.json();
if (!response.ok || data.status !== "ok") {
  console.error("Organization creation failed:", JSON.stringify(data));
  process.exit(1);
}
console.log(`\nOrganization: ${data.organization.church_name}`);
console.log(`ID:           ${data.organization.id}`);
console.log(`Plan:         ${data.organization.plan}`);
console.log(`Activation:   ${data.activation_code}`);
console.log("\nGive the activation code to the operator for Settings → License. It is valid for 14 days and activates one computer.");
