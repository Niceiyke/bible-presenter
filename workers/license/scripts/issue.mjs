#!/usr/bin/env node
// Issue a beta license key for a church against the deployed Worker.
//
// Usage:
//   set WORDLYTE_LICENSE_URL=https://wordlyte-license.<your-subdomain>.workers.dev
//   set WORDLYTE_ADMIN_TOKEN=<the ADMIN_TOKEN secret>
//   node scripts/issue.mjs "First Baptist Church" pastor@church.org 90 3
//
// Args: church_name email duration_days max_machines tier(free|pro|premium)

const base = process.env.WORDLYTE_LICENSE_URL;
const token = process.env.WORDLYTE_ADMIN_TOKEN;
if (!base || !token) {
  console.error(
    "Set WORDLYTE_LICENSE_URL and WORDLYTE_ADMIN_TOKEN environment variables first."
  );
  process.exit(1);
}

const [church, email, days = "90", machines = "3", tier = "pro"] = process.argv.slice(2);
if (!church || !email) {
  console.error(
    "Usage: issue.mjs <church_name> <email> [duration_days=90] [max_machines=3] [tier=pro]"
  );
  process.exit(1);
}

const res = await fetch(`${base.replace(/\/$/, "")}/issue`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    church_name: church,
    email,
    duration_days: Number(days),
    max_machines: Number(machines),
    tier,
    note: "beta",
  }),
});

const data = await res.json();
if (!res.ok || data.status !== "ok") {
  console.error("Issue failed:", JSON.stringify(data));
  process.exit(1);
}

console.log("\nIssued license:\n");
console.log(`  Key:        ${data.license_key}`);
console.log(`  Church:     ${data.church_name}`);
console.log(`  Email:      ${data.email}`);
console.log(`  Tier:       ${data.tier}`);
console.log(`  Valid until ${new Date(data.expires_at * 1000).toISOString().slice(0, 10)}`);
console.log(`  Machines:   ${data.max_machines}`);
console.log("\nSend the key to the church; they paste it into Settings → License.");