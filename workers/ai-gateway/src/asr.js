/**
 * Managed streaming transcription relay.
 *
 * One Durable Object owns one client/provider WebSocket pair. It reserves one
 * AI Unit (one minute) at a time, settles actual milliseconds when the session
 * ends or rolls into a new minute, and closes the session if Units run out.
 */

const DEEPGRAM_BASE_URL = "https://api.deepgram.com/v1/listen?model=nova-3&language=en-US&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&smart_format=true&utterance_end_ms=1200&vad_events=true&redact_usage=true";
const ASSEMBLYAI_BASE_URL = "https://streaming.assemblyai.com/v3/ws";

const BIBLE_KEYTERMS = [
  "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua",
  "Judges", "Ruth", "Samuel", "Kings", "Chronicles", "Ezra", "Nehemiah",
  "Esther", "Job", "Psalm", "Psalms", "Proverbs", "Ecclesiastes",
  "Song of Solomon", "Song of Songs", "Isaiah", "Jeremiah", "Lamentations",
  "Ezekiel", "Daniel", "Hosea", "Joel", "Amos", "Obadiah", "Jonah", "Micah",
  "Nahum", "Habakkuk", "Zephaniah", "Haggai", "Zechariah", "Malachi",
  "Matthew", "Mark", "Luke", "John", "Acts", "Romans", "Corinthians",
  "Galatians", "Ephesians", "Philippians", "Colossians", "Thessalonians",
  "Timothy", "Titus", "Philemon", "Hebrews", "James", "Peter", "Jude",
  "Revelation", "Nebuchadnezzar",
  "First Corinthians", "Second Corinthians", "First Thessalonians",
  "Second Thessalonians", "First Timothy", "Second Timothy", "First Peter",
  "Second Peter", "First John", "Second John", "Third John",
];
const VOICE_COMMAND_KEYTERMS = [
  "next verse", "previous verse", "King James", "New King James",
  "New Living Translation", "Amplified", "New International Version",
  "English Standard Version", "New American Standard", "The Message",
  "Good News Translation", "Contemporary English Version", "KJV", "NKJV",
  "NLT", "NIV", "ESV", "NASB",
];

function providerUrl(env, provider) {
  if (provider === "deepgram") {
    if (!env.DEEPGRAM_API_KEY) throw new Error("Deepgram is not configured.");
    let url = DEEPGRAM_BASE_URL;
    for (const term of [...BIBLE_KEYTERMS, ...VOICE_COMMAND_KEYTERMS]) {
      url += `&keyterm=${encodeURIComponent(term)}`;
    }
    return url;
  }
  if (provider === "assemblyai") {
    if (!env.ASSEMBLYAI_API_KEY) throw new Error("AssemblyAI is not configured.");
    const keyterms = encodeURIComponent(JSON.stringify([...BIBLE_KEYTERMS, ...VOICE_COMMAND_KEYTERMS]));
    return `${ASSEMBLYAI_BASE_URL}?speech_model=universal-3-6-pro&mode=min_latency&encoding=pcm_s16le&sample_rate=16000&language_codes=${encodeURIComponent("[\"en\"]")}&include_partial_turns=true&session_heartbeat=true&min_turn_silence=300&max_turn_silence=900&keyterms_prompt=${keyterms}`;
  }
  throw new Error("Unsupported transcription provider.");
}

function providerAuthorization(env, provider) {
  return provider === "deepgram"
    ? `Token ${env.DEEPGRAM_API_KEY}`
    : env.ASSEMBLYAI_API_KEY;
}

async function licenseCall(env, path, body) {
  if (!env.LICENSE_SERVICE || !env.AI_GATEWAY_SERVICE_TOKEN) {
    return { ok: false, status: 503, data: { message: "AI billing service is not configured." } };
  }
  try {
    const response = await env.LICENSE_SERVICE.fetch(`https://wordlyte-license.internal${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.AI_GATEWAY_SERVICE_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, data: await response.json().catch(() => null) };
  } catch (error) {
    console.error("Transcription license call failed", error);
    return { ok: false, status: 503, data: { message: "AI billing service is unavailable." } };
  }
}

export class TranscriptionSession {
  constructor(_state, env) {
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ error: "Expected a WebSocket upgrade." }, { status: 426 });
    }
    const url = new URL(request.url);
    const provider =
      request.headers.get("x-wordlyte-provider") ||
      url.pathname.split("/").filter(Boolean).pop();
    if (provider !== "deepgram" && provider !== "assemblyai") {
      return Response.json({ error: "Managed transcription is not configured." }, { status: 404 });
    }
    const organizationId = request.headers.get("x-wordlyte-org");
    if (!organizationId) return Response.json({ error: "Missing AI organization." }, { status: 401 });
    if (!this.env.LICENSE_SERVICE) {
      return Response.json({ error: "AI billing service is not configured." }, { status: 503 });
    }

    let upstream;
    try {
      const response = await fetch(providerUrl(this.env, provider), {
        headers: {
          Upgrade: "websocket",
          Authorization: providerAuthorization(this.env, provider),
        },
      });
      upstream = response.webSocket;
      if (!upstream) throw new Error(`Provider rejected WebSocket upgrade (${response.status}).`);
    } catch (error) {
      console.error("Transcription provider connection failed", error);
      return Response.json({ error: String(error?.message || error) }, { status: 502 });
    }

    const sessionId = crypto.randomUUID();
    let reservationId = null;
    let reservationStartedAt = 0;
    let reservationNumber = 0;
    let closed = false;
    let metering = false;
    let interval = null;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const reserve = async () => {
      const response = await licenseCall(this.env, "/internal/ai/reserve", {
        organization_id: organizationId,
        units: 1,
        kind: "asr",
        idempotency_key: `asr-reserve:${sessionId}:${reservationNumber++}`,
      });
      if (!response.ok || !response.data?.reservation?.id) {
        return { ok: false, status: response.status, message: response.data?.message || "AI Units could not be reserved." };
      }
      reservationId = response.data.reservation.id;
      reservationStartedAt = Date.now();
      return { ok: true };
    };

    const settle = async () => {
      if (!reservationId) return;
      const id = reservationId;
      reservationId = null;
      const elapsedMs = Math.max(0, Math.min(60_000, Date.now() - reservationStartedAt));
      // Wallet amounts are milli-Units: one reserved minute is 1,000
      // milli-Units, so elapsed milliseconds convert at 60 ms per milli-Unit.
      const elapsedMilliUnits = Math.round(elapsedMs / 60);
      await licenseCall(this.env, "/internal/ai/settle", {
        organization_id: organizationId,
        reservation_id: id,
        actual_milli_units: elapsedMilliUnits,
      });
    };

    const finish = async (code, reason) => {
      if (closed) return;
      closed = true;
      if (interval) clearInterval(interval);
      await settle();
      try { server.close(code, reason); } catch { /* already closed */ }
      try { upstream.close(code, reason); } catch { /* already closed */ }
    };

    // Reserve before accepting the client stream. If the wallet is empty, the
    // handshake fails and Rust reports a clean connection error.
    const initial = await reserve();
    if (!initial.ok) {
      try { upstream.close(1011, "AI Units unavailable"); } catch { /* noop */ }
      return Response.json({ error: initial.message }, { status: initial.status === 402 ? 402 : 503 });
    }

    try {
      upstream.binaryType = "arraybuffer";
      upstream.accept();
      server.accept({ allowHalfOpen: true });
    } catch (error) {
      await settle();
      try { upstream.close(1011, "session setup failed"); } catch { /* noop */ }
      console.error("Transcription session setup failed", error);
      return Response.json({ error: "Transcription session setup failed." }, { status: 500 });
    }

    server.addEventListener("message", (event) => {
      try { upstream.send(event.data); } catch { void finish(1011, "provider send failed"); }
    });
    upstream.addEventListener("message", (event) => {
      try { server.send(event.data); } catch { void finish(1011, "client send failed"); }
    });
    server.addEventListener("close", () => { void finish(1000, "client closed"); });
    upstream.addEventListener("close", () => { void finish(1000, "provider closed"); });
    server.addEventListener("error", () => { void finish(1011, "client socket error"); });
    upstream.addEventListener("error", () => { void finish(1011, "provider socket error"); });

    interval = setInterval(async () => {
      if (closed || metering || !reservationId) return;
      if (Date.now() - reservationStartedAt < 60_000) return;
      metering = true;
      try {
        await settle();
        const next = await reserve();
        if (!next.ok) await finish(4402, "AI Units exhausted");
      } finally {
        metering = false;
      }
    }, 10_000);

    return new Response(null, { status: 101, webSocket: client });
  }
}
