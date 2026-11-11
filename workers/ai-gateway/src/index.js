/**
 * Wordlyte AI Gateway.
 *
 * This Worker is the only place provider credentials live. Desktop clients
 * present a short-lived AI token issued by the License Worker; the Gateway
 * validates that token, reserves AI Units, and proxies the request to the
 * configured provider. No provider key is ever sent to a customer computer.
 */

const AI_TOKEN_AUDIENCE = "wordlyte-ai";
const STANDARD_LLM_UNITS = 10;
const MAX_BODY_BYTES = 2_000_000;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

function now() {
  return Math.floor(Date.now() / 1000);
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function bearer(request) {
  return (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

function base64urlText(value) {
  return base64url(new TextEncoder().encode(value));
}

function base64url(bytes) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const raw = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(raw, (char) => char.charCodeAt(0)));
}

async function hmacBase64url(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64url(new Uint8Array(signature));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function verifyAiToken(env, token) {
  if (!env.AI_TOKEN_SECRET || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = await hmacBase64url(env.AI_TOKEN_SECRET, `${header}.${payload}`);
  if (!constantTimeEqual(expected, signature)) return null;
  let claims;
  try {
    claims = JSON.parse(decodeBase64url(payload));
  } catch {
    return null;
  }
  if (claims.aud !== AI_TOKEN_AUDIENCE) return null;
  if (!Number.isInteger(claims.exp) || claims.exp <= now()) return null;
  if (claims.addon_active !== true) return null;
  if (Number(claims.addon_expires_at) > 0 && Number(claims.addon_expires_at) <= now()) return null;
  if (typeof claims.org !== "string" || !/^org_[a-f0-9]{32}$/.test(claims.org)) return null;
  return claims;
}

async function licenseRequest(env, path, body) {
  if ((!env.LICENSE_SERVICE && !env.LICENSE_SERVICE_URL) || !env.AI_GATEWAY_SERVICE_TOKEN) {
    return { ok: false, status: 503, data: { status: "error", message: "AI billing service is not configured." } };
  }
  try {
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.AI_GATEWAY_SERVICE_TOKEN}`,
      },
      body: JSON.stringify(body),
    };
    // A service binding avoids Cloudflare error 1042 for same-zone
    // Worker-to-Worker fetches. The URL is internal; only the path matters.
    const response = env.LICENSE_SERVICE
      ? await env.LICENSE_SERVICE.fetch(`https://wordlyte-license.internal${path}`, init)
      : await fetch(`${env.LICENSE_SERVICE_URL.replace(/\/$/, "")}${path}`, init);
    const text = await response.text().catch(() => "");
    let data = null;
    try { data = JSON.parse(text); } catch { /* keep raw body for diagnostics */ }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    console.error("License service request failed", error);
    return { ok: false, status: 503, data: { status: "error", message: "AI billing service is unavailable." } };
  }
}

async function reserveLlm(env, claims, requestId) {
  return licenseRequest(env, "/internal/ai/reserve", {
    organization_id: claims.org,
    units: STANDARD_LLM_UNITS,
    kind: "llm",
    idempotency_key: `llm-reserve:${requestId}`,
  });
}

async function settleLlm(env, claims, reservationId, requestId) {
  return licenseRequest(env, "/internal/ai/settle", {
    organization_id: claims.org,
    reservation_id: reservationId,
    actual_units: STANDARD_LLM_UNITS,
    idempotency_key: `llm-settle:${requestId}`,
  });
}

async function releaseLlm(env, claims, reservationId, requestId) {
  return licenseRequest(env, "/internal/ai/release", {
    organization_id: claims.org,
    reservation_id: reservationId,
    idempotency_key: `llm-release:${requestId}`,
  });
}

function allowedModels(env) {
  return new Set(
    String(env.OPENAI_ALLOWED_MODELS || "gpt-5.6-luna")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean),
  );
}

async function llmResponses(request, env) {
  const token = bearer(request);
  const claims = await verifyAiToken(env, token);
  if (!claims) return json({ error: "A valid Wordlyte AI access token is required." }, 401);
  if (!env.OPENAI_API_KEY) return json({ error: "OpenAI is not configured on the AI Gateway." }, 503);

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return json({ error: "The AI request is too large." }, 413);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "The AI request must be valid JSON." }, 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json({ error: "The AI request must be a JSON object." }, 400);
  }
  if (payload.stream === true) {
    return json({ error: "Streaming LLM requests are not supported yet." }, 400);
  }
  if (typeof payload.model !== "string" || !allowedModels(env).has(payload.model)) {
    return json({ error: "The requested AI model is not allowed." }, 403);
  }

  const requestId = crypto.randomUUID();
  const reservation = await reserveLlm(env, claims, requestId);
  if (!reservation.ok || !reservation.data?.reservation?.id) {
    return json(
      {
        error: reservation.status === 402
          ? "This organization does not have enough AI Units."
          : reservation.data?.message || "AI Units could not be reserved.",
        ai: reservation.data?.ai,
        upstream_status: reservation.status,
      },
      reservation.status === 402 ? 402 : 503,
    );
  }
  const reservationId = reservation.data.reservation.id;

  let upstream;
  try {
    upstream = await fetch(env.OPENAI_RESPONSES_URL || OPENAI_RESPONSES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: raw,
    });
  } catch (error) {
    console.error("OpenAI request failed", error);
    await releaseLlm(env, claims, reservationId, requestId);
    return json({ error: "The AI provider could not be reached." }, 502);
  }

  const responseBody = await upstream.text();
  if (!upstream.ok) {
    await releaseLlm(env, claims, reservationId, requestId);
    console.log(JSON.stringify({
      event: "llm_request",
      organization_id: claims.org,
      request_id: requestId,
      status: upstream.status,
      units: 0,
    }));
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
      },
    });
  }

  const settlement = await settleLlm(env, claims, reservationId, requestId);
  if (!settlement.ok) {
    // Do not turn a successful provider response into a failed user request.
    // The reservation will be reconciled by support/audit tooling.
    console.error("AI Unit settlement failed after successful LLM response", {
      organization_id: claims.org,
      reservation_id: reservationId,
      status: settlement.status,
    });
  }
  console.log(JSON.stringify({
    event: "llm_request",
    organization_id: claims.org,
    request_id: requestId,
    status: upstream.status,
    units: STANDARD_LLM_UNITS,
    settlement_ok: settlement.ok,
  }));
  return new Response(responseBody, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ((url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
      return json({ status: "ok", service: "wordlyte-ai-gateway" });
    }
    if (url.pathname === "/v1/llm/responses" && request.method === "POST") {
      try {
        return await llmResponses(request, env);
      } catch (error) {
        console.error("Unhandled AI Gateway error", error);
        return json({ error: "The AI Gateway encountered an unexpected error." }, 500);
      }
    }
    return json({ error: "Not found" }, 404);
  },
};
