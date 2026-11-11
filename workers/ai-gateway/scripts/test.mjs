#!/usr/bin/env node
// Hermetic AI Gateway tests. The license and provider services are mocked;
// this verifies token validation, model allowlisting, Unit reservation,
// settlement, and release behavior without any network egress.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../src/index.js";

const SECRET = "EXAMPLE-local-ai-token-secret";
const ORG = `org_${"a".repeat(32)}`;
const originalFetch = globalThis.fetch;
const calls = [];

function token(overrides = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    aud: "wordlyte-ai",
    org: ORG,
    machine: "b".repeat(64),
    addon_active: true,
    addon_expires_at: timestamp + 3600,
    iat: timestamp,
    exp: timestamp + 900,
    jti: crypto.randomUUID(),
    ...overrides,
  })).toString("base64url");
  const signature = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function env(overrides = {}) {
  return {
    AI_TOKEN_SECRET: SECRET,
    AI_GATEWAY_SERVICE_TOKEN: "gateway-service-token",
    LICENSE_SERVICE_URL: "https://license.test",
    OPENAI_API_KEY: "openai-test-key",
    OPENAI_RESPONSES_URL: "https://openai.test/v1/responses",
    OPENAI_ALLOWED_MODELS: "gpt-5.6-luna",
    ...overrides,
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch({ reserveStatus = 200, openaiStatus = 200 } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target.endsWith("/internal/ai/reserve")) {
      if (reserveStatus !== 200) {
        return jsonResponse({ status: "ai_no_units", message: "Not enough AI Units." }, reserveStatus);
      }
      return jsonResponse({
        status: "ok",
        reservation: { id: `res_${"c".repeat(32)}`, units: 10, status: "reserved" },
        ai: { available_units_remaining: 90, total_units_remaining: 100 },
      });
    }
    if (target.endsWith("/internal/ai/settle")) return jsonResponse({ status: "ok" });
    if (target.endsWith("/internal/ai/release")) return jsonResponse({ status: "ok" });
    if (target === "https://openai.test/v1/responses") {
      if (openaiStatus !== 200) return jsonResponse({ error: "provider failed" }, openaiStatus);
      return jsonResponse({ id: "resp_123", output: [{ type: "message" }] });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
}

function request(body, authToken = token()) {
  return new Request("https://ai.test/v1/llm/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const validBody = {
  model: "gpt-5.6-luna",
  input: [{ role: "user", content: [{ type: "input_text", text: "Draft a short sermon outline." }] }],
  max_output_tokens: 100,
};

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

async function main() {
  installFetch();
  let response = await worker.fetch(request(validBody), env());
  await check("successful LLM request reserves and settles Units", async () => {
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, "resp_123");
    assert(calls.some((call) => call.url.endsWith("/internal/ai/reserve")));
    assert(calls.some((call) => call.url.endsWith("/internal/ai/settle")));
    assert(!calls.some((call) => call.url.endsWith("/internal/ai/release")));
  });

  calls.length = 0;
  response = await worker.fetch(request(validBody, "bad-token"), env());
  await check("missing or invalid AI token is rejected", async () => {
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  });

  const wsRequest = new Request("https://ai.test/v1/asr/deepgram", {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${token()}` },
  });
  response = await worker.fetch(wsRequest, env());
  await check("ASR route requires the Durable Object binding", async () => {
    assert.equal(response.status, 503);
  });

  const unauthenticatedWs = new Request("https://ai.test/v1/asr/deepgram", {
    headers: { Upgrade: "websocket" },
  });
  response = await worker.fetch(unauthenticatedWs, env());
  await check("ASR route rejects missing AI tokens", async () => {
    assert.equal(response.status, 401);
  });

  calls.length = 0;
  installFetch({ reserveStatus: 402 });
  response = await worker.fetch(request(validBody), env());
  await check("zero or reserved Units block the provider call", async () => {
    assert.equal(response.status, 402);
    assert(!calls.some((call) => call.url === "https://openai.test/v1/responses"));
  });

  calls.length = 0;
  installFetch();
  response = await worker.fetch(request({ ...validBody, model: "not-allowed" }), env());
  await check("model allowlist blocks arbitrary OpenAI usage", async () => {
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);
  });

  calls.length = 0;
  installFetch({ openaiStatus: 500 });
  response = await worker.fetch(request(validBody), env());
  await check("provider failure releases the reservation", async () => {
    assert.equal(response.status, 500);
    assert(calls.some((call) => call.url.endsWith("/internal/ai/release")));
    assert(!calls.some((call) => call.url.endsWith("/internal/ai/settle")));
  });

  calls.length = 0;
  const expired = token({ exp: Math.floor(Date.now() / 1000) - 1 });
  response = await worker.fetch(request(validBody, expired), env());
  await check("expired AI token is rejected", async () => {
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  });
}

try {
  await main();
} finally {
  globalThis.fetch = originalFetch;
}

const failures = results.filter((result) => !result.ok);
if (failures.length) {
  console.error(`\n${failures.length} test(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} tests passed.`);
