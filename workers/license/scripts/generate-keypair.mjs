#!/usr/bin/env node
// Generates an ECDSA P-256 keypair for signing /validate responses.
//
//   npm run generate-keypair
//
// Outputs:
//   - The PRIVATE JWK: put this in the LICENSE_SIGNING_KEY secret
//     (GitHub Actions secret + `wrangler secret put LICENSE_SIGNING_KEY` +
//     `.dev.vars` for local tests). NEVER commit it.
//   - The PUBLIC key point (04 + x + y, hex): embed this in
//     src-tauri/src/license_crypto.rs as LICENSE_PUB_KEY_POINT_HEX.
//
// Keep the halves in sync: the app must verify with the same key the worker
// signs with, so if you rotate, update both.

import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

const pub = publicKey.export({ format: "jwk" });
const priv = privateKey.export({ format: "jwk" });

const b64urlToHex = (s) =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex");

const pointHex = "04" + b64urlToHex(pub.x) + b64urlToHex(pub.y);

console.log("=== LICENSE_SIGNING_KEY (PRIVATE JWK — keep secret) ===");
console.log(JSON.stringify(priv));
console.log();
console.log("=== LICENSE_PUB_KEY_POINT_HEX (embed in src/license_crypto.rs) ===");
console.log(pointHex);
console.log();
console.log("Deploy steps:");
console.log("  npx wrangler secret put LICENSE_SIGNING_KEY   # paste the private JWK");
console.log("  # GitHub Actions: add LICENSE_SIGNING_KEY as a repo secret with the private JWK");
console.log(`  # .dev.vars:      LICENSE_SIGNING_KEY=${JSON.stringify(priv)}`);
