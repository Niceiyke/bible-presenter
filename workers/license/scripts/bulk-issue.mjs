#!/usr/bin/env node
// Bulk-create organizations from CSV: church_name,email,plan,duration_days,device_limit

import { readFileSync } from "node:fs";

const base = process.env.WORDLYTE_LICENSE_URL;
const token = process.env.WORDLYTE_ADMIN_TOKEN;
const file = process.argv[2];
if (!base || !token || !file) {
  console.error("Usage: WORDLYTE_LICENSE_URL=... WORDLYTE_ADMIN_TOKEN=... node scripts/bulk-issue.mjs <organizations.csv>");
  process.exit(1);
}
let created = 0;
let failed = 0;
for (const line of readFileSync(file, "utf8").split(/\r?\n/).map((value) => value.trim()).filter(Boolean).filter((value) => !/^church_name,/i.test(value))) {
  const [church_name, email, plan = "free", duration_days = "0", device_limit] = line.split(",").map((value) => value.trim());
  const response = await fetch(`${base.replace(/\/$/, "")}/admin/organizations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ church_name, email, plan, plan_duration_days: Number(duration_days), ...(device_limit ? { device_limit: Number(device_limit) } : {}) }),
  });
  const data = await response.json();
  if (response.ok && data.status === "ok") {
    created += 1;
    console.log(`${data.organization.id},${data.organization.church_name},${data.activation_code}`);
  } else {
    failed += 1;
    console.error(`FAILED ${church_name}: ${JSON.stringify(data)}`);
  }
}
console.log(`Created ${created}; failed ${failed}.`);
if (failed) process.exit(1);
