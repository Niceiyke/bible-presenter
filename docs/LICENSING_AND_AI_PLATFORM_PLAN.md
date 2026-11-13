# Licensing, AI, and Dashboard Platform Plan

## Status

**Approved product direction.** This document is the source of truth for the
commercial licensing model and the phased implementation of its supporting
account, AI, and Dashboard services.

**Implementation status:** Phase 1A and the entitlement portion of Phase 2 are
in progress. The clean v3 organization/device entitlement protocol, permanent
activated-Free desktop model, server-signed plan limits, AI Add-on status, and
an admin-provisioned AI Unit wallet are implemented. The first managed AI
Gateway slice now provides device-to-AI token exchange, SQLite-backed AI
wallet reservations/settlement/release, an OpenAI Responses proxy with model
allowlisting, a managed Deepgram/AssemblyAI WebSocket relay with fractional
per-minute settlement and zero-balance cutoff, opt-in finalized transcript
sync, and a read-only Dashboard AI/transcript view. Desktop AI presentation and
transcription are now off local provider keys. Billing checkout/webhooks remain
a subsequent phase.

## Product principles

1. Every church creates a Wordlyte account and activates its first device once,
   including churches using Free.
2. Free is permanent after activation. It is not a trial and it must not expire.
3. A lapsed Pro or Premium subscription degrades to activated Free; it never
   prevents basic presentation from opening or operating.
4. AI is a separate managed add-on. Churches do not provide or store ASR/LLM
   provider API keys.
5. AI consumption is paid from one organization-level AI Unit balance.
6. The desktop app is the live-service production tool. The Dashboard is the
   account, content, transcript, and post-service ministry workspace.
7. Wordlyte does not retain microphone audio. Cloud transcript sync is explicit
   opt-in and sends finalized text only.

---

## Commercial model

### Free — present

Free requires verified account and device activation, then remains available
permanently. It includes:

- Scripture presentation;
- basic Studio presentations;
- songs;
- simple local media presentation;
- one simple output; and
- one registered computer.

Free requires one-time device activation. It excludes lower thirds, scenes,
Designer Hub authoring, custom templates, recording, streaming, remote control,
NDI, advanced output capacity, and AI capabilities.

### Pro — produce

Pro is a subscription and includes all Free capabilities plus:

- recording;
- RTMP streaming;
- remote control;
- NDI output;
- lower thirds, scenes, Designer Hub authoring, and custom templates;
- advanced media, service schedules, backups, recovery, and diagnostics;
- additional production controls; and
- increased device and output capacity.

### Premium — scale

Premium is a subscription that includes all Pro capabilities. It is for larger
teams and multi-campus production, adding higher capacity and administration:

- higher registered-device, simultaneous-output, and stream-destination limits;
- shared production resources;
- organization members, roles, and audit history;
- multi-campus or multi-room administration; and
- priority support.

Recording, streaming, remote control, and NDI remain Pro features. Premium
adds scale and collaboration rather than withholding normal production tools.

### Wordlyte AI Add-on — assist

The AI Add-on is independent of the Free, Pro, and Premium plan. It unlocks
live transcription, Scripture assistance, presentation drafting, key-point
extraction, and future AI capabilities. It may be purchased by an activated
Free, Pro, or Premium organization.

The add-on provides recurring monthly AI Units. Organizations can purchase
additional one-time AI Unit top-ups.

---

## AI Unit policy

AI Units are the single consumption currency for all managed AI services.

| Action | Initial cost |
| --- | ---: |
| Live transcription | 1 AI Unit per minute |
| Standard LLM request | 10 AI Units |
| Presentation draft | 10 AI Units |
| Key-point extraction | 10 AI Units |
| Social-media or other standard content draft | 10 AI Units |

Rules:

1. Transcription accrues at one-sixtieth of an AI Unit per second.
2. The system spends included monthly Units first, then paid top-up Units.
3. Included monthly Units reset at the billing date and do not roll over.
4. Paid top-up Units remain available until spent.
5. An LLM request reserves 10 Units before processing and settles the charge
   only after a successful response. A failed or cancelled request releases the
   reservation.
6. A request cannot start if its Units are unavailable.
7. At zero Units, the AI Gateway terminates an active transcription session
   immediately. This never changes live output, staged output, stored local
   transcripts, or normal Free/Pro/Premium features.
8. Prices are server-controlled and versioned. The Dashboard and desktop app
   must display the price before an AI action begins.

The published initial rates deliberately use a fixed 10-Unit standard LLM
request. Future unusually expensive operations may receive separately published
rates after product approval; their price must be shown before use.

---

## Activation and entitlement policy

### Account and device activation

1. An operator creates or signs in to a Wordlyte account and verifies email.
2. The account creates or joins a church organization.
3. The organization activates the Wordlyte desktop computer through a secure
   device-pairing flow.
4. The desktop app stores an Ed25519-signed, device-bound entitlement snapshot
   using current-user secure storage.

An Owner can remove an old device in the Dashboard before activating a
replacement. Free defaults to one device; paid-plan limits are policy-driven
and returned by the service rather than hard-coded in the desktop client.

### Offline behavior

| Entitlement | Offline behavior |
| --- | --- |
| Activated Free core | Continues permanently after the first successful activation. |
| Pro/Premium | Uses a signed cached entitlement during the configured grace window, then falls back to Free. |
| AI Add-on and AI Units | Requires online authorization; no offline AI usage is permitted. |

### Effective states

| Account state | Core presentation | Pro/Premium features | AI |
| --- | --- | --- | --- |
| Not activated | Blocked | Blocked | Blocked |
| Activated Free | Available | Blocked | Blocked |
| Activated Pro/Premium | Available | Available while entitled | Add-on required |
| Activated + AI balance | Available | Depends on plan | Available while Units remain |
| Pro/Premium expired | Free remains available | Blocked | Independent of plan if AI add-on is active |
| AI add-on expired or Units exhausted | Unchanged | Unchanged | New AI use blocked; active ASR stops at zero Units |

---

## Dashboard policy

Every account has access to the Wordlyte Dashboard for profile, devices,
billing, and plan information.

### Dashboard launch scope

- organization profile and members;
- Free/Pro/Premium plan status;
- AI Add-on, AI Unit balance, top-ups, invoices, and usage history;
- device activation and device removal;
- privacy and transcript-sync settings; and
- account support and audit information.

### Transcript library

Dashboard transcript access is opt-in. When enabled, the desktop app sends only
finalized transcript text, Scripture suggestions, service metadata, and
generated content. It never uploads or retains microphone audio.

Synced data is organization-owned. Owners can export it, delete it, disable
future sync, and configure retention. Local desktop session history remains
local and continues to work when cloud sync is disabled. After an AI Add-on
expires, existing synced transcripts remain readable/exportable under the
organization's retention policy, but new sync and AI generation are unavailable.

### Future content-repurposing workspace

Later Dashboard releases will let authorized members select a transcript or
message and generate editable drafts such as:

- key points and summaries;
- presentation drafts;
- discussion questions and devotionals;
- newsletter copy; and
- social-media posts and caption variants.

Each generation is a draft requiring user review. No social content is
published automatically. Standard LLM operations cost 10 AI Units.

### Roles

| Role | Access |
| --- | --- |
| Owner | Billing, plans, devices, privacy, members, and all organization content. |
| Admin | Devices, organization content, AI usage, and member management. |
| Editor | Transcripts and AI-generated content. |
| Viewer | Read/export access granted by the organization. |

---

## Target technical design

### Entitlement snapshot

The desktop app receives an Ed25519-signed entitlement snapshot. It can cache
core activation and paid-plan data; it cannot be the authority for an AI Unit
balance.

```json
{
  "version": 3,
  "organizationId": "org_123",
  "deviceId": "machine_fingerprint_hash",
  "coreActivated": true,
  "coreActivatedAt": 1790000000,
  "plan": "free",
  "planExpiresAt": null,
  "limits": {
    "devices": 1,
    "outputs": 1,
    "streamDestinations": 0,
    "maxBibleVersions": 1000,
    "maxCameras": 1,
    "maxScenes": 3,
    "sharedAudioInput": false
  },
  "ai": {
    "addonActive": false,
    "addonExpiresAt": null
  },
  "issuedAt": 1790000000,
  "refreshAfter": 1792592000,
  "signature": "base64-ed25519-signature"
}
```

The Dashboard/API returns a current display balance separately:

```json
{
  "monthlyUnitsRemaining": 2400,
  "topupUnitsRemaining": 600,
  "totalUnitsRemaining": 3000,
  "rates": {
    "transcriptionUnitPerMinute": 1,
    "standardLlmRequest": 10
  }
}
```

### Desktop authorization gates

Replace the current all-or-nothing `ensure_allowed` pattern with explicit
backend gates:

```rust
ensure_core_activated();
ensure_pro_active();
ensure_premium_active();
ensure_ai_session_authorized();
```

`ensure_core_activated` protects all desktop use. `ensure_pro_active` protects
recording, streaming, remote control, NDI, and Pro production features.
`ensure_premium_active` protects Premium capacity/collaboration features.
AI authorization is always online and happens through the AI Gateway.

### Managed AI Gateway

The desktop app and Dashboard call a Wordlyte AI Gateway. The Gateway:

- authenticates the organization, user or device, and entitlement;
- checks and atomically deducts AI Units;
- creates metered transcription sessions;
- proxies or controls provider sessions so it can end ASR exactly at zero Units;
- selects the transcription provider from platform-admin configuration, never
  from a desktop setting;
- reserves and settles LLM requests;
- keeps provider API credentials server-side; and
- records metering/audit events without retaining microphone audio.

Platform-admin AI Scripture insights are cross-organization and protected by the
platform `ADMIN_TOKEN`; church-level roles cannot access another organization's
sessions. During the current beta, finalized transcripts, suggestions, and local
detection timing are synced by default for product-quality evaluation, with the
organization able to opt out of transcript sync.

The existing Deepgram, AssemblyAI, and OpenAI API-key setup in the desktop app
is beta-only and must be removed before commercial managed-AI release.

### Server data model

The current license-key KV record is retained only as a migration bridge. The
target service is organization-centric and includes:

```text
organizations
users
organization_members
devices
subscriptions
invoices
ai_wallets
ai_topups
ai_usage_sessions
ai_usage_events
transcripts
transcript_suggestions
generated_content
audit_events
```

Use a transactional database for organization, subscription, wallet, and usage
records. Serialize wallet mutations per organization using a Durable Object or
equivalent transaction-safe mechanism. The payment provider webhook is the only
path that credits a purchased subscription or top-up.

---

## Phased implementation plan

### Phase 0 — Product, security, and migration preparation

**Goal:** lock policy and safely prepare the current beta for migration.

1. Publish this model as the commercial source of truth.
2. Define initial paid-plan capacity limits and monthly AI Unit allowances in
   server configuration; do not hard-code commercial values in the desktop app.
3. Revoke and replace existing AI provider credentials before managed service
   launch. Ensure provider credentials are never packaged, logged, or placed in
   customer configuration.
4. Inventory current beta keys, tiers, expiry dates, device slots, and current
   local AI-key users for migration communication.
5. Define the transcript retention default and deletion/export requirements.
6. Add a migration test fixture for current signed v2 license records.

**Exit criteria:** commercial limits, billing provider, retention default, and
migration policy are approved; no shared provider credential is eligible to
ship in a customer build.

### Phase 1 — Account, organization, and permanent Free activation

**Goal:** replace key-only onboarding with account-backed, one-time activation.

1. Build account sign-up/sign-in, verified email, organization creation, and
   secure device-pairing flows.
2. Create permanent core activation entitlements for verified Free accounts.
3. Issue signed v3 desktop entitlement snapshots bound to organization and
   machine fingerprint.
4. Update desktop state/types and Settings to show account, organization,
   device, and activation status.
5. Replace the main-app license gate with a core-activation gate.
6. Change basic Scripture, songs, Studio, and simple-output backend commands to
   require core activation rather than a paid active license.
7. Add Dashboard device listing and device-removal controls.

**Exit criteria:** an activated Free account can run the defined Free workflow
indefinitely; an unactivated install cannot; copying a device entitlement to a
different computer fails.

### Phase 2 — Pro and Premium subscriptions

**Goal:** implement paid production plans without threatening Free continuity.

1. Integrate checkout, subscription lifecycle, invoices, and payment webhooks.
2. Replace `free/pro/premium` hard-coded plan assumptions with server-returned
   plan, limits, and feature entitlements.
3. Keep recording, streaming, remote, and NDI behind Pro enforcement in both
   Rust commands and frontend affordances.
4. Move existing Premium-only capacity gates to explicit Premium entitlements.
5. Preserve the existing signed offline-grace behavior for paid plans; expiry
   must downgrade to Free, not lock core use.
6. Update the Dashboard billing and plan-management areas.

**Exit criteria:** upgrades and downgrades apply through signed refreshes;
expired Pro/Premium users retain Free core operation; direct IPC calls cannot
bypass paid feature gates.

### Phase 3 — AI Add-on, wallet, and managed transcription gateway

**Goal:** ship managed AI without BYOK and with authoritative metering.

1. Add AI Add-on subscriptions and monthly AI Unit grants.
2. Add one-time AI Unit top-up checkout and webhook-based wallet credits.
3. Implement an atomic per-organization wallet, reservation, settlement, and
   audit ledger.
4. Build the AI Gateway session API: authorize, start, meter, refresh, stop,
   and terminate at zero Units.
5. Route desktop transcription through the Gateway; remove local permanent
   Deepgram/AssemblyAI credentials, provider selection, and API-key UI.
6. Show managed-AI entitlement, current balance, rate, and remaining estimated
   transcription time in desktop Settings and the AI workspace.
7. Retain local transcripts/suggestions and normal presentation safety if AI
   authorization, balance, or provider connectivity fails.

**Exit criteria:** AI starts only with an active Add-on and positive balance;
transcription ends at zero Units; no provider credential is present on a
customer computer; Free/Pro/Premium presentation remains unaffected by AI
failure.

### Phase 4 — Dashboard foundation and transcript sync

**Goal:** provide organization access to account information and consented
transcripts.

1. Launch the Dashboard account, organization, roles, billing, device, and AI
   Unit views.
2. Implement opt-in finalized-text transcript sync, Scripture-suggestion sync,
   encryption in transit/at rest, exports, deletion, and retention controls.
3. Implement transcript list, search, viewer, and download/export paths.
4. Add account/organization audit events for device, membership, billing, and
   transcript-data actions.
5. Keep microphone audio out of all transcript-sync storage and logs.

**Exit criteria:** an authorized organization member can securely view its
opted-in transcripts in the Dashboard; an Owner can export, delete, and disable
sync; no audio is stored.

### Phase 5 — Managed LLM drafting and key points

**Goal:** move existing and new authoring AI from local keys to the managed AI
platform.

1. Route presentation drafting and key-point requests through the AI Gateway.
2. Remove local OpenAI API-key setup and storage from the commercial app.
3. Enforce the 10-Unit reservation/settlement flow for every standard LLM
   request.
4. Preserve current structured-output validation, local Scripture verification,
   preview, editability, and separate Stage/Go Live safeguards.
5. Add generation history and AI Unit usage records to the Dashboard.

**Exit criteria:** drafting and key points require the AI Add-on and Units;
every action displays its 10-Unit cost before submission; no generated content
can take live control.

### Phase 6 — Transcript repurposing and social drafts

**Goal:** turn approved, synced message content into editable ministry drafts.

1. Add Dashboard actions for summaries, discussion questions, devotionals,
   newsletters, social-media posts, and captions.
2. Use the same 10-Unit standard LLM flow unless an explicitly approved future
   rate applies.
3. Store generated drafts separately from source transcripts, with author,
   time, source-session, and Unit-use audit metadata.
4. Add review, copy, export, delete, and optional team-approval workflow.
5. Do not integrate automatic social publishing in this phase.

**Exit criteria:** authorized users can generate, review, edit, export, and
delete social/content drafts; no generation publishes or changes live service
output automatically.

### Phase 7 — Migration, qualification, and commercial release

**Goal:** migrate beta users safely and prove enforcement, billing, privacy,
and recovery behavior before commercial rollout.

1. Migrate existing Pro keys to Pro organizations and Premium keys to Premium
   organizations while preserving existing device allowances.
2. Convert valid historical Free activations to permanent Free accounts where
   possible; provide a guided account-claim flow otherwise.
3. Provide an in-app migration notice, documentation, support path, and a
   defined transition deadline for legacy keys.
4. Test account/device migration, entitlement signatures, revocation, paid
   expiry-to-Free downgrade, wallet concurrency, top-up webhooks, zero-balance
   ASR cutoff, LLM reservation refunds, transcript deletion, and role access.
5. Run supervised service rehearsals for Free, Pro, Premium, and AI-zero-balance
   scenarios.

**Exit criteria:** all feature gates are enforced server-side and in the
desktop backend; migrations preserve core access; payment and usage records
reconcile; privacy controls are verified; and production rehearsals pass.

---

## Existing implementation mapping

The following current areas are expected to change during the phases above:

| Current area | Planned change |
| --- | --- |
| `src-tauri/src/license.rs` | Move from v2 key/tier expiry to v3 account/device/core/plan entitlements and explicit gates. |
| `src/types/license.ts` | Represent core activation, plan limits, AI Add-on, and AI balance display state. |
| `src/system/tiers.ts` | Retain Free/Pro/Premium capability presentation but obtain limits/features from server entitlement. |
| `src/App.tsx` | Block only unactivated installs; never block an activated account merely because paid features expired. |
| `src-tauri/src/commands/display.rs` and output/window commands | Require core activation for Free basics, then enforce paid capacity separately. |
| Recording, streaming, remote, and NDI commands | Continue backend enforcement under Pro; move Premium scale rules to explicit capacity gates. |
| `src-tauri/src/commands/ai_scripture.rs` | Replace local provider key loading and direct provider authentication with AI Gateway authorization. |
| AI Settings and diagnostics | Replace provider-key setup with Add-on status, Unit balance, and managed-service diagnostics. |
| `workers/license/` | Evolve from a license-key registry into an account/organization/device entitlement service, retaining signed snapshots and migration support. |

## Non-negotiable acceptance rules

- No unactivated account can use the app.
- Activated Free never expires.
- Paid expiry cannot stop basic presentation.
- AI provider keys never ship to or are entered by customers.
- AI Units are deducted only by the server.
- Transcription stops at zero Units.
- AI errors and exhaustion never interrupt existing live output.
- Cloud transcript access requires opt-in and never includes microphone audio.
- AI-generated content is always reviewed before use and can never publish or
  take live output automatically.
