# Wordlyte Account and Entitlement Worker

This Worker is the clean v3 foundation for Wordlyte account/device activation.
It issues Ed25519-signed desktop entitlement snapshots for a church
organization and its registered computers.

## Product behavior

- Every church, including Free, must activate each desktop computer once.
- An activated Free organization remains active permanently.
- Pro and Premium are paid plan entitlements that can expire without locking
  the activated Free core.
- The Worker stores hashes of activation codes and device credentials; it never
  stores a usable plaintext device credential.
- The desktop client verifies every entitlement against its embedded Ed25519
  public key before trusting it.

The managed AI Gateway, AI access tokens, and Unit reservation/settlement are
implemented in [`../ai-gateway/`](../ai-gateway/). Billing checkout/webhooks,
streaming ASR relay, transcript sync, and the broader Dashboard workspace remain
later phases documented in
[`../../docs/LICENSING_AND_AI_PLATFORM_PLAN.md`](../../docs/LICENSING_AND_AI_PLATFORM_PLAN.md).

## Local development

```text
cd workers/license
npm install
npm test
```

The test suite creates a temporary local Worker, KV store, Durable Object
storage directory, and signing key. It never talks to the deployed Worker.

## Required Worker resources and secrets

`wrangler.toml` binds:

- `ORGANIZATIONS` — KV namespace containing organization records;
- `ORGANIZATION_REGISTRY` — SQLite-backed Durable Object that serializes
  per-organization device, plan, and transitional AI-wallet changes.

Set these secrets before deployment:

```text
ADMIN_TOKEN
LICENSE_SIGN_PRIVATE_KEY
AI_TOKEN_SECRET
AI_GATEWAY_SERVICE_TOKEN
```

`AI_TOKEN_SECRET` must match the AI Gateway Worker's value. It signs
short-lived AI access tokens. `AI_GATEWAY_SERVICE_TOKEN` protects the internal
reserve/settle/release endpoints and must also match the AI Gateway.

`LICENSE_SIGN_PRIVATE_KEY` is an Ed25519 private JWK. Its matching public key
must match `SIGNING_PUBLIC_KEY_B64` in `src-tauri/src/license.rs`. Never commit,
log, or distribute the private key.

## API surface

### Desktop endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/activate` | Redeem a one-time `WACT-...` device activation code. Returns a signed entitlement and one device credential. |
| `POST` | `/entitlement` | Refresh a device entitlement using its organization id, machine fingerprint, and device credential. |
| `POST` | `/ai/token` | Exchange a device credential for a 15-minute AI access token and current AI Unit balance. Requires an active AI Add-on. |
| `GET` | `/health` | Health check. |

The desktop app stores the returned device credential only in its protected
local activation record. `/entitlement` never returns it.

### Transitional administrator endpoints

These endpoints provision organizations until the authenticated Dashboard
replaces this transitional admin surface.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/admin/organizations` | Create an organization and initial one-time device activation code. |
| `GET` | `/admin/organizations` | List organizations. |
| `POST` | `/admin/organizations/:id/plan` | Set Free, Pro, or Premium plan, expiry, and device limit. |
| `POST` | `/admin/organizations/:id/activation-code` | Create a replacement device activation code. |
| `POST` | `/admin/organizations/:id/revoke` | Revoke or restore an organization. |
| `POST` | `/admin/organizations/:id/ai` | Provision the AI Add-on, included monthly Units, or a one-time Unit top-up. |

All administrator endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.

`/ai` accepts `addon_duration_days` (`0` disables), `monthly_units`, optional
`monthly_reset_days` (default `30`), and `topup_units`. It stores Unit balances
in milli-Units for future exact per-second transcription settlement. This is a
transitional provisioning endpoint only: only the managed AI Gateway may
reserve or spend Units, and customer AI provider keys are never accepted.

### Internal AI Gateway endpoints

These endpoints require `Authorization: Bearer <AI_GATEWAY_SERVICE_TOKEN>` and
are intended for the AI Gateway only:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/internal/ai/reserve` | Reserve Units before an AI request. Idempotency key required. |
| `POST` | `/internal/ai/settle` | Settle actual usage against a reservation. |
| `POST` | `/internal/ai/release` | Release a failed or cancelled reservation. |
| `POST` | `/internal/ai/balance` | Read the current wallet balance. |

`GET /admin/organizations/:id/ai` returns the organization, current balance, and
recent wallet events for the Dashboard.

AI balances, reservations, and wallet events are stored in the organization
Durable Object's SQLite storage. The first access imports a legacy
`organization.ai` wallet record from KV; after that, SQLite is the spendable
authority.

### Opt-in transcript sync

The desktop can POST finalized text to `/transcripts/sync` with its short-lived
AI token. Microphone audio is never accepted or stored. Admins can list, read,
and delete synced sessions with:

```text
GET    /admin/organizations/:id/transcripts
GET    /admin/organizations/:id/transcripts/:sessionId
DELETE /admin/organizations/:id/transcripts/:sessionId
```

## Signed entitlement protocol

The Worker signs the following canonical payload. Field order is protocol and
must remain identical in the Worker and desktop verifier:

```text
wl3|organization_id|machine_id|status|core_activated_at|plan|plan_expires_at|max_machines|machines_used|server_time|max_bible_versions|max_outputs|max_cameras|max_scenes|stream_destinations|shared_audio_input|ai_addon_active|ai_addon_expires_at
```

The signed payload intentionally excludes the device credential. The credential
authenticates refresh requests; the signature makes entitlement fields
tamper-evident after they reach the desktop app.

## Deployment

Use the repository deployment workflow after configuring the existing KV
namespace and Worker secrets. Do not deploy a new KV namespace or change the
configured namespace identifier without an explicit data migration decision.
