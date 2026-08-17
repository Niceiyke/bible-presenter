#!/usr/bin/env node
// Extend a license key by N days and/or change its tier against the Worker.
//
// Usage:
//   set WORDLYTE_LICENSE_URL=https://wordlyte-license.<your-subdomain>.workers.dev
//   set WORDLYTE_ADMIN_TOKEN=<the ADMIN_TOKEN secret>
//   node scripts/extend.mjs WORDLYTE-XXXX-XXXX-XXXX-XXXX 14
//   node scripts/extend.mjs WORDLYTE-XXXX-XXXX-XXXX-XXXX 0 premium

const base = process.env.WORDLYTE_LICENSE_URL;
const token = process.env.WORDLYTE_ADMIN_TOKEN;
if (!base || !token) {
  console.error(
    "Set WORDLYTE_LICENSE_URL and WORDLYTE_ADMIN_TOKEN environment variables first."
  );
  process.exit(1);
}

const [key, days = "14", tier] = process.argv.slice(2);
if (!key) {
  console.error("Usage: extend.mjs <license_key> [days=14] [tier]");
  process.exit(1);
}

const body = { license_key: key, days: Number(days) };
if (tier) body.tier = tier;

const res = await fetch(`${base.replace(/\/$/, "")}/extend`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify(body),
});

const data = await res.json();
if (!res.ok || data.status !== "ok") {
  console.error("Extend failed:", JSON.stringify(data));
  process.exit(1);
}

const bits = [];
if (Number(days) > 0) bits.push(`by ${days} day(s)`);
if (tier) bits.push(`tier -> ${data.tier} (max ${data.max_machines} machines)`);
console.log(`\nUpdated ${data.key} (${data.church_name}) ${bits.join(" and ")}.`);
console.log(`  New expiry ${new Date(data.expires_at * 1000).toISOString().slice(0, 10)}`);