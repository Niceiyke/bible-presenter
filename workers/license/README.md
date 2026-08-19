# Wordlyte License Server (Cloudflare Worker)

Tiny Cloudflare Worker that powers Wordlyte beta licensing: it validates keys,
binds them to a machine count per church, tracks expiry, and gives you an admin
API to issue/revoke keys.

The desktop app only calls `POST /validate` from its Rust backend (`license.rs`,
reqwest). It sends the SHA-256 machine fingerprint (no PII) plus the key, and
the Worker returns authoritative status, expiry and server time. The app then
uses that to enforce the offline-grace window locally.

## Why this gives you what you asked for

- **Churches don't use it forever** — every key carries `expires_at` (server
  time is authoritative) and the app refuses to run past it. You extend a key
  by re-issuing or extending its record.
- **Offline grace** — a church's projection PC is often offline during a
  service, so the app keeps working for `OFFLINE_GRACE_DAYS` (14) after the
  last successful online check, then locks until revalidated once.
- **Copying to other systems** — each key registers up to `max_machines`
  fingerprints. Copying `%LOCALAPPDATA%\io.wordlyte.app` or the install folder
  to another PC fails the machine-binding check locally (`invalid`), and
  re-activating on a new machine hits the server-side slot cap.

Honest limits: a determined user with binary-patching skills can bypass any
offline check. This stops casual copying and gives you a server-side kill
switch, which is the standard bar for church tools.

## Deploy

Full step-by-step instructions (CLI and dashboard), the exact `wrangler`
commands, the app URL wiring, and the issue/revoke workflow live in
[`docs/LICENSE_SERVER_DEPLOYMENT.md`](../../docs/LICENSE_SERVER_DEPLOYMENT.md).

Quick CLI version:

```bash
cd workers/license
npm install

# 1. KV namespace (stores one record per license key)
npx wrangler kv namespace create LICENSES
#   → paste the returned namespace id into wrangler.toml

# 2. Admin secret (guards /issue, /revoke, /licenses)
npx wrangler secret put ADMIN_TOKEN

# 3. License signing secret (ECDSA P-256 private JWK)
#    The worker signs every /validate response so the desktop app can detect
#    hand-edited licenses. This MUST match the PUBLIC key embedded in
#    `src-tauri/src/license_crypto.rs` (LICENSE_PUB_KEY_POINT_HEX). Generate a
#    matching pair once and keep both halves in sync. In local dev / tests this
#    is set in `.dev.vars`.
npx wrangler secret put LICENSE_SIGNING_KEY
#   → paste the P-256 private JWK, e.g.
#     {"kty":"EC","x":"...","y":"...","crv":"P-256","d":"..."}

# 4. Deploy
npm run deploy
#   → note the workers.dev URL, e.g. https://wordlyte-license.<subdomain>.workers.dev

npm test   # optional: hermetic worker tests (see below)
```

## Point the app at it

In `src-tauri/src/license.rs`, set the URL in `default_server_url()`:

```rust
.unwrap_or_else(|_| "https://wordlyte-license.YOUR_SUBDOMAIN.workers.dev".to_owned())
```

(It also reads `WORDLYTE_LICENSE_URL` from the environment for local testing —
set it before `npm run tauri dev`.)

## Issue a beta key to a church

```bash
set WORDLYTE_LICENSE_URL=https://wordlyte-license.oyomworld.workers.dev
set WORDLYTE_ADMIN_TOKEN=<the ADMIN_TOKEN secret>
node scripts/issue.mjs "First Baptist Church" pastor@church.org 90 3 pro
```

Args: `church_name email [duration_days=90] [max_machines=3] [tier=pro]`.
`tier` is `free | pro | premium` and is **clamped server-side**: free → 1
machine, pro → ≤ 3, premium → ≤ 50.

The script prints the key, e.g. `WORDLYTE-XXXX-XXXX-XXXX-XXXX`. Email it to the
church; they paste it into **Settings → License**.

Other lifecycle scripts (same env vars):

| Script                       | Purpose                                   |
| ---------------------------- | ----------------------------------------- |
| `node scripts/revoke.mjs <key> [true\|false]` | Cut a church off instantly (or restore) |
| `node scripts/extend.mjs <key> [days=14] [tier]` | Extend expiry and/or change the plan (`days` can be `0` to only change tier) |
| `node scripts/bulk-issue.mjs churches.csv [--limit N]` | Issue many keys from a CSV (`church_name,email,duration_days,max_machines,tier` on each line, header row skipped) |

## Plans (tiers)

Every key carries a `tier` (`free` / `pro` / `premium`, default `free`). The
app reads it at validation time and gates capabilities (see `src/system/tiers.ts`):

- **Free** — 1 Bible version, 1 on-air window, 1 machine, output watermark, 3
  scenes, preset-only lower-third templates. No remote control / recording /
  streaming / NDI.
- **Pro** — all Bible versions, 2 on-air windows, 3 machines, remote control,
  recording, streaming (1 destination), NDI, custom templates, no watermark.
- **Premium** — everything in Pro, unlimited machines / windows / destinations,
  shared audio input.

When a paid key's time runs out the **app degrades to Free** instead of locking
(after the paid offline-grace window). Change a key's tier any time with
`extend.mjs <key> 0 <tier>` or the **Tier** button in the admin UI (downgrades
re-clamp `max_machines` to the tier cap).

## Admin web UI

Open **`https://wordlyte-license.oyomworld.workers.dev/admin`** in a browser,
enter the `ADMIN_TOKEN`, and you get a small UI to: issue keys (with a tier
selector), bulk-issue from CSV, extend, change a key's **Tier**, revoke/restore,
copy keys, and see which licenses expire soon. The page itself is public, but
every action sends the token in the `Authorization` header — so anyone who
reaches the page still needs the token to do anything.

## Admin API

| Method | Path        | Auth               | Body / notes                                         |
| ------ | ----------- | ------------------ | ---------------------------------------------------- |
| POST   | `/validate` | none (app)         | `{ license_key, machine_id, app_name, app_version }` → includes `tier` |
| POST   | `/issue`    | Bearer `ADMIN_TOKEN` | `{ church_name, email, duration_days, max_machines, tier, note }` → returns the key (machines clamped by tier) |
| POST   | `/revoke`   | Bearer `ADMIN_TOKEN` | `{ license_key, revoked?: bool }`                    |
| POST   | `/extend`   | Bearer `ADMIN_TOKEN` | `{ license_key, days?, tier? }` — add days and/or change plan (at least one required) |
| GET    | `/licenses` | Bearer `ADMIN_TOKEN` | Lists every key + registered machines + tier        |
| GET    | `/expiring?days=30` | Bearer `ADMIN_TOKEN` | Lists non-revoked keys expiring within `days`     |

## Extending / revoking

- **Extend a church's beta**: `node scripts/extend.mjs <key> 30` (POST
  `/extend`). Machines keep their slots, so nothing re-activates on the church
  side.
- **Cut a church off immediately**: `node scripts/revoke.mjs <key>` (POST
  `/revoke`). The next time their app validates (or after the offline grace
  window), it locks.

## Expiry reminders (scheduled)

The worker runs a daily cron (`09:00 UTC`, `[triggers]` in `wrangler.toml`)
that scans for licenses expiring within `EXPIRY_NOTIFY_DAYS` (default 14) plus
already-expired ones. If `EXPIRY_WEBHOOK_URL` is set (a Slack / Discord / Teams
incoming webhook), it posts a summary there; otherwise it just logs. Set both
as Worker secrets:

```bash
npx wrangler secret put EXPIRY_WEBHOOK_URL
npx wrangler secret put EXPIRY_NOTIFY_DAYS   # optional, default 14
```

The same data is queryable on demand via `GET /expiring?days=N`.

## Testing locally

The hermetic test suite spins up `wrangler dev --local` against a throwaway KV
persistence dir (never touches the real namespace or Cloudflare) and exercises
auth, issue/validate/revoke/extend, the slot cap, and the expiring list:

```bash
npm test
```

## CI (GitHub Actions)

`.github/workflows/deploy-license-worker.yml` runs on pushes to `workers/license/**`
and does, in order:

1. **verify** `wrangler.toml` has a real KV namespace id (fails otherwise),
2. **`npm test`** — the hermetic suite above,
3. **set `ADMIN_TOKEN`** from the `ADMIN_TOKEN` GitHub secret (skipped if unset),
4. **`wrangler deploy`** (needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
   GitHub secrets — token needs Workers Scripts: Edit + Workers KV Storage: Edit),
5. **smoke test** — hits the deployed `/licenses` endpoint and fails the job if
   the worker isn't healthy.

So the `ADMIN_TOKEN` now lives in **GitHub** (single source of truth) and is
pushed to Cloudflare on every deploy; you no longer set it by hand.