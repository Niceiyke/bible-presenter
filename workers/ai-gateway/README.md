# Wordlyte AI Gateway

Managed AI data plane for Wordlyte. Provider credentials live only in this
Worker; desktop clients present a short-lived AI token issued by the License
Worker and the Gateway enforces AI Add-on and AI Unit access.

## Current slice

- `POST /v1/llm/responses` — OpenAI Responses proxy with a model allowlist,
  AI Unit reservation, settlement on success, and release on failure.
- `GET /v1/asr/deepgram` and `GET /v1/asr/assemblyai` — managed WebSocket
  transcription relays. A Durable Object owns one client/provider socket pair,
  reserves one Unit per minute, settles fractional Units on close, and cuts the
  stream when Units run out.
- `GET /health` — health check.

The desktop provider adapters keep their existing frame decoders; only the
upstream URL and authentication changed.

## Required secrets

```text
AI_TOKEN_SECRET             # same value as the License Worker
AI_GATEWAY_SERVICE_TOKEN    # same value as the License Worker
OPENAI_API_KEY
DEEPGRAM_API_KEY
ASSEMBLYAI_API_KEY
```

`LICENSE_SERVICE` is a private Worker service binding to `wordlyte-license`, so
no public `LICENSE_SERVICE_URL` is required. `LICENSE_SERVICE_URL` remains an
optional local fallback.

Set with `npx wrangler secret put <NAME>`.

`OPENAI_ALLOWED_MODELS` is a comma-separated var. The managed desktop default
is `gpt-5.6-luna`.

## Local verification

```text
npm test
```

The test suite mocks the License Worker and OpenAI, and verifies:

- short-lived token validation and expiry;
- model allowlisting;
- 10-Unit LLM reservation and settlement;
- release on provider failure and rejection when Units are unavailable;
- ASR route authentication and Durable Object routing.

## Deployment

```text
npm install
npx wrangler deploy
```

The desktop reads `WORDLYTE_AI_GATEWAY_URL` at runtime. If it is not set, it
uses `https://wordlyte-ai-gateway.oyomworld.workers.dev`. Configure the License
Worker with the same `AI_TOKEN_SECRET` and `AI_GATEWAY_SERVICE_TOKEN`.
