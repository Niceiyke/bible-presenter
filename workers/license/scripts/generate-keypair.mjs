#!/usr/bin/env node
/**
 * Generates the Ed25519 license-signing keypair used by the app's license
 * anti-tamper layer (signed /validate responses + signed v2 license.json).
 *
 * Usage:
 *   node scripts/generate-keypair.mjs
 *
 * Outputs:
 *   - The base64 raw public key (32 bytes) → embed in the Rust client as
 *     `SIGNING_PUBLIC_KEY_B64` in src-tauri/src/license.rs.
 *   - The private JWK → set as the worker's `LICENSE_SIGN_PRIVATE_KEY` secret
 *     (`npx wrangler secret put LICENSE_SIGN_PRIVATE_KEY`) and mirrored into
 *     `.dev.vars` so `npm test` (wrangler dev --local) can sign locally.
 *
 * The private material is written to `.license-sign-private.jwk` next to this
 * script, which is git-ignored. Never commit that file or the secret.
 *
 * Deriving the two secrets from the same keypair is REQUIRED: the client only
 * accepts signatures from the public key it embeds, so a worker deployed with
 * a different private key produces responses the app refuses as unverifiable.
 */
import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("../", import.meta.url));
const gitignorePath = `${here}.gitignore`;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubJwk = publicKey.export({ format: "jwk" });
const privJwk = privateKey.export({ format: "jwk" });
const rawPublicB64 = Buffer.from(pubJwk.x, "base64url").toString("base64");
const privJson = JSON.stringify(privJwk);

// Keep the private key only in git-ignored locations.
try {
  const existing = readFileSync(gitignorePath, "utf8");
  if (!existing.includes(".license-sign-private.jwk")) {
    appendFileSync(gitignorePath, "\n# License signing private key (regenerate with scripts/generate-keypair.mjs)\n.license-sign-private.jwk\n");
  }
} catch {
  // No .gitignore yet — nothing to guard; the file is still not committed if
  // CI uses a throwaway checkout.
}
writeFileSync(`${here}.license-sign-private.jwk`, privJson);

console.log("Embed in src-tauri/src/license.rs as SIGNING_PUBLIC_KEY_B64 (raw base64):");
console.log(rawPublicB64);
console.log("\nWorker secret LICENSE_SIGN_PRIVATE_KEY (JWK) — set with:");
console.log("npx wrangler secret put LICENSE_SIGN_PRIVATE_KEY");
console.log("\nSecret value (also written to workers/license/.license-sign-private.jwk):");
console.log(privJson);