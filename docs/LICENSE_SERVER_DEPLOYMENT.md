# Deploying the Wordlyte License Server (Cloudflare)

This is your end-to-end checklist for standing up the license server the app
validates against. Two paths are covered: **CLI (`wrangler`, recommended)** and
**Cloudflare Dashboard (no local tooling)**. The endpoint is a tiny Worker that
issues, validates, and revokes per-church license keys, backed by Cloudflare KV.

Code: `workers/license/` — Worker source `src/index.js`, config `wrangler.toml`,
issue helper `scripts/issue.mjs`.

---

## 0. What you're building

```
Church operator PC                         Cloudflare
┌─────────────────────┐     HTTPS          ┌──────────────────────────────┐
│ Wordlyte app        │ ─────────────────▶ │ Worker:  wordlyte-license    │
│ license_activate /  │   license_key +    │   POST /validate             │
│ license_refresh     │   machine id hash  │   POST /issue (admin)        │
│ (reqwest, no CORS)  │                    │   POST /revoke (admin)       │
└─────────────────────┘                    │   GET  /licenses (admin)     │
                                           │ KV: LICENSES (one per key)   │
                                           └──────────────────────────────┘
```

The app calls `/validate` from its Rust backend, so there is **no CORS** concern
for the desktop app.

**Cost:** the free Worker tier (100k requests/day) and KV free tier are far more
than a beta needs.

---

## 1. Prerequisites

- A **Cloudflare account** (free) at https://dash.cloudflare.com.
- **Node.js 18+** (for `npm` / `wrangler`).

---

## 2. Path A — CLI with `wrangler` (recommended)

### 2.1 Install dependencies

```bash
cd workers/license
npm install
```

### 2.2 Authenticate wrangler

```bash
npx wrangler login
```

A browser window opens — log in and click **Allow**. Verify:

```bash
npx wrangler whoami
```

### 2.3 Create the KV namespace

```bash
npx wrangler kv namespace create LICENSES
```

It prints something like:

```
🌀 Creating namespace with title "wordlyte-license-LICENSES"
✨ Success! Add the following to your configuration file:
[[kv_namespaces]]
binding = "LICENSES"
id = "ab12cd34..."    <── COPY THIS ID
```

Open `workers/license/wrangler.toml` and paste the id:

```toml
[[kv_namespaces]]
binding = "LICENSES"
id = "ab12cd34..."    # ← replace REPLACE_WITH_YOUR_KV_NAMESPACE_ID
```

### 2.4 Set the admin token secret

This guards the `/issue`, `/revoke`, and `/licenses` endpoints. Generate a long
random value, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
then:

```bash
npx wrangler secret put ADMIN_TOKEN
# → type/paste your token when prompted
```

**Save this token** — you need it every time you issue a key.

### 2.5 Deploy

```bash
npm run deploy
```

The output ends with your URL, e.g.:

```
Uploaded wordlyte-license
Deployed wordlyte-license (1.24 sec)
  https://wordlyte-license.<your-account>.workers.dev
```

**Save this URL.** Verify it responds:

```bash
curl -s https://wordlyte-license.<your-account>.workers.dev/validate \
  -H "content-type: application/json" \
  -d '{"license_key":"WORDLYTE-TEST","machine_id":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}'
# → {"status":"invalid","message":"Unknown license key. ..."}   (expected — no such key)
```

### 2.6 Local dev (optional)

```bash
npx wrangler dev          # serves on http://localhost:8787
```

Works the same, against your real KV, but on localhost.

---

## 3. Path B — Cloudflare Dashboard (no CLI)

You'll manually create the same three pieces: a KV namespace, the Worker code,
and a secret. The dashboard layout shifts occasionally; these are the current
menus as of this writing.

1. **KV namespace**
   - Dashboard → left sidebar **Workers & Pages** → **KV**.
   - **Create a namespace** → name it `LICENSES` (or anything; you'll bind it
     below) → **Add**.

2. **The Worker**
   - Dashboard → **Workers & Pages** → **Create application** → **Create Worker**
     → give it a name like `wordlyte-license` → **Deploy**.
   - **Edit code**, replace the template with the full contents of
     `workers/license/src/index.js`, **Deploy** again.

3. **Bind KV to the Worker**
   - In the Worker → **Settings → Variables** → **KV namespace bindings →
     Add binding**.
   - **Variable name:** `LICENSES` (this exact name — the code reads
     `env.LICENSES`).
   - **KV namespace:** select the namespace you created → **Save**.

4. **Admin token secret**
   - Same **Settings → Variables** page → **Secrets → Add**.
   - Name `ADMIN_TOKEN`, paste your long random value, **Save**.
   - Store the token somewhere safe.

5. **URL**
   - Dashboard → the Worker → **Visit** button, or use
     `https://wordlyte-license.<your-account>.workers.dev`.

---

## 4. Point the app at the server

Open `src-tauri/src/license.rs` and replace the placeholder host in
`default_server_url()`:

```rust
.unwrap_or_else(|_| "https://wordlyte-license.YOUR_SUBDOMAIN.workers.dev".to_owned())
```

with your real URL:

```rust
.unwrap_or_else(|_| "https://wordlyte-license.<your-account>.workers.dev".to_owned())
```

> For testing without rebuilding: set the environment variable
> `WORDLYTE_LICENSE_URL=https://wordlyte-license.<your-account>.workers.dev`
> before `npm run tauri dev`. The env var always wins.

Then rebuild the release bundle so testers get the real endpoint:
`npm run build` → `npm run tauri build`.

---

## 5. Issue your first beta key

```powershell
# PowerShell
$env:WORDLYTE_LICENSE_URL = "https://wordlyte-license.<your-account>.workers.dev"
$env:WORDLYTE_ADMIN_TOKEN = "<the ADMIN_TOKEN secret>"
node workers/license/scripts/issue.mjs "First Baptist Church" pastor@church.org 90 3 pro
```

Arguments: `church_name`, `email`, `duration_days` (90), `max_machines` (3),
`tier` (`pro`). The `tier` (free/pro/premium) is clamped server-side: free → 1
machine, pro → ≤ 3, premium → ≤ 50.

Output:

```
Issued license:

  Key:        WORDLYTE-XXXX-XXXX-XXXX-XXXX
  Church:     First Baptist Church
  Email:      pastor@church.org
  Tier:       Pro
  Valid until 2026-11-15
  Machines:   3
```

Email the key to the church. They paste it into **Settings → License** (or the
first-run **Activate Wordlyte** screen).

---

## 6. Day-to-day operations

| Task            | How                                                              |
| --------------- | ---------------------------------------------------------------- |
| Issue a key     | `node workers/license/scripts/issue.mjs "<church>" <email> <days> <machines> <tier>` |
| Issue many keys | `node workers/license/scripts/bulk-issue.mjs churches.csv [--limit N]` (CSV lines: `church_name,email,duration_days,max_machines,tier`) |
| Cut a church off | `node workers/license/scripts/revoke.mjs <key>` (or `curl -X POST https://…/revoke -H "authorization: Bearer $env:WORDLYTE_ADMIN_TOKEN" -H "content-type: application/json" -d '{"license_key":"WORDLYTE-…","revoked":true}'`) — their next online check (or the end of the offline grace) locks them out. |
| Extend a church | `node workers/license/scripts/extend.mjs <key> 30` — adds days to `expires_at` and keeps the registered machines. |
| Change a plan  | `node workers/license/scripts/extend.mjs <key> 0 premium` — changes the tier without touching expiry (downgrades re-clamp `max_machines`), or use the **Tier** button in the admin UI. |
| List all keys   | `curl https://…/licenses -H "authorization: Bearer $env:WORDLYTE_ADMIN_TOKEN"` |
| Manage in a UI  | Open `https://…/admin` in a browser and sign in with the `ADMIN_TOKEN` — issue (with tier selector), bulk-issue, extend, change tier, revoke/restore, copy keys, and see what's expiring. |
| Who's expiring soon | `curl "https://…/expiring?days=30" -H "authorization: Bearer $env:WORDLYTE_ADMIN_TOKEN"` (also available as a daily cron that posts to `EXPIRY_WEBHOOK_URL`, see `workers/license/README.md`) |

---

## 6.5 CI / GitHub Actions (optional)

Two small helpers live in `.github/workflows/`:

- **`build-windows.yml`** ships a guard step that **fails the app build if the
  license endpoint placeholder is still in source**. This prevents accidentally
  publishing a release that points at `YOUR_SUBDOMAIN`.
- **`deploy-license-worker.yml`** runs on pushes to `workers/license/**` (or
  manual dispatch) and does: config verification → `npm test` (hermetic worker
  tests) → pushes `ADMIN_TOKEN` to Cloudflare from the **`ADMIN_TOKEN` GitHub
  secret** → `npx wrangler deploy` → a **smoke test** against the live
  `/licenses` endpoint that fails the job if the worker isn't healthy.

  For it to work, add three **GitHub repository secrets** (Settings → Secrets
  and variables → Actions):
  - `CLOUDFLARE_API_TOKEN` — a Cloudflare API token with **Workers Scripts:
    Edit** and **Workers KV Storage: Edit** permissions (create it in
    Cloudflare → My Profile → API Tokens).
  - `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account id (dashboard URL or
    Profile → API Tokens page).
  - `ADMIN_TOKEN` — the license-server admin token. It's now managed here as
    the single source of truth and pushed to the Worker on every deploy, so you
    no longer run `wrangler secret put ADMIN_TOKEN` by hand.

  Optional Worker secrets set once in Cloudflare: `EXPIRY_WEBHOOK_URL` (daily
  expiry-reminder cron posts here; Slack/Discord/Teams webhook) and
  `EXPIRY_NOTIFY_DAYS` (default 14).

---

## 7. Troubleshooting

| Symptom                                | Likely cause                                   | Fix                                            |
| -------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| `Unknown license key` on validate      | Key copied with spaces/dashes changed          | Keys are `A-Z`/`2-9` only; paste exactly        |
| App says "Could not reach the license server" | Wrong URL in `default_server_url()`, or no internet | Check the URL; verify with `curl` from the same network |
| `Unauthorized` on `/issue`             | Wrong `ADMIN_TOKEN`                            | Re-set the secret or re-check the env var       |
| `status: error, message: Not found` on `/validate` | Hit `/` or a wrong path                      | Use `/validate` exactly                         |
| App works offline forever              | Clock was rolled back, or `license.json` edited | Offline grace is 14 days max; clock tamper flags `clock_tampered` |
| New machine won't activate             | Device slot cap reached                        | `max_machines` used up → revoke a stale machine server-side or re-issue |

**Notes / honest limits**
- A determined user who can patch the binary can bypass any offline check.
  This system stops casual copying (machine binding + slot cap) and gives you a
  kill switch (revoke). That is the standard bar for church tools.
- The offline grace period is `OFFLINE_GRACE_DAYS` (14) for Free and 30 days for
  Pro/Premium in `src-tauri/src/license.rs`; the app stays usable through it,
  then locks (Free) or degrades to Free capability (paid plans) until one
  successful online check.
- Expired paid keys **degrade to Free** rather than locking — the church keeps
  projecting with Free features (1 version, watermark, no remote/recording/
  streaming) until you renew or upgrade the key. Free keys that expire lock
  outright.
