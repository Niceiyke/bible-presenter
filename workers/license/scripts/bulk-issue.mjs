#!/usr/bin/env node
// Bulk-issue license keys from a CSV against the deployed Worker.
//
// Usage:
//   set WORDLYTE_LICENSE_URL=https://wordlyte-license.<your-subdomain>.workers.dev
//   set WORDLYTE_ADMIN_TOKEN=<the ADMIN_TOKEN secret>
//   node scripts/bulk-issue.mjs churches.csv [--limit 10]
//
// CSV format (first line is the header and is skipped):
//   church_name,email,duration_days,max_machines,tier
//   First Baptist Church,pastor@fbc.org,90,3,pro
//   Grace Chapel,office@gracechapel.org,180,2,pro

import { readFileSync } from "node:fs";

const base = process.env.WORDLYTE_LICENSE_URL;
const token = process.env.WORDLYTE_ADMIN_TOKEN;
if (!base || !token) {
  console.error(
    "Set WORDLYTE_LICENSE_URL and WORDLYTE_ADMIN_TOKEN environment variables first."
  );
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: bulk-issue.mjs <churches.csv> [--limit N]");
  process.exit(1);
}
const limitIdx = process.argv.indexOf("--limit");
const limit = limitIdx !== -1 ? Number(process.argv[limitIdx + 1]) : Infinity;

const rows = readFileSync(file, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .filter((l) => !/^church/i.test(l));

let issued = 0;
let failed = 0;
for (const row of rows.slice(0, limit)) {
  const [church, email, days = "90", machines = "3", tier = "pro"] = row
    .split(",")
    .map((s) => s.trim());
  if (!church || !email) {
    console.error(`skip malformed row: ${row}`);
    failed++;
    continue;
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
      note: "bulk",
    }),
  });
  const data = await res.json();
  if (res.ok && data.status === "ok") {
    issued++;
    console.log(
      `${data.license_key}  ${church} <${email}> until ${new Date(data.expires_at * 1000)
        .toISOString()
        .slice(0, 10)}`
    );
  } else {
    failed++;
    console.error(`FAILED ${church}: ${JSON.stringify(data)}`);
  }
}

console.log(`\nDone. ${issued} issued, ${failed} failed.`);
if (failed) process.exit(1);