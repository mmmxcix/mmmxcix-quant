// /api/lab — bridge between the local lab agent (the user's PC: n8n + Node,
// running research/paper-trading 24/7) and the site. Push model: the PC POSTs
// its state here; the site reads it back. Cloudflare cannot reach into a home
// network, so the PC always initiates.
//
// Two channels, both under the same token:
//   lab:state       agent → site   (equity, positions, heartbeat)
//   lab:strategies  site  → agent  (paper-status registry entries to execute)
//
// Storage: the existing SUBSCRIBERS KV namespace, keys prefixed "lab:" — no
// new bindings or dashboard work. Auth: DEV_ACCESS_TOKEN (same secret as the
// AI generator), constant-time compared. Reads are token-gated too: the lab
// state is the owner's private data.

const MAX_STATE_BYTES = 64 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-lab-token",
      },
    });
  }
  if (!env.DEV_ACCESS_TOKEN || !env.SUBSCRIBERS) {
    return json({ error: "not_configured" }, 503);
  }

  // ── GET: token-gated reads. Default = agent state; ?what=strategies =
  // the published paper strategies (what the PC agent should execute). ─────
  if (request.method === "GET") {
    const token = request.headers.get("x-lab-token") || "";
    if (!safeEqual(token, env.DEV_ACCESS_TOKEN)) return json({ error: "unauthorized" }, 401);
    const what = new URL(request.url).searchParams.get("what") === "strategies" ? "lab:strategies" : "lab:state";
    const raw = await env.SUBSCRIBERS.get(what);
    if (!raw) return json({ ok: true, [what === "lab:strategies" ? "strategies" : "state"]: null });
    try {
      const parsed = JSON.parse(raw);
      return json({ ok: true, [what === "lab:strategies" ? "strategies" : "state"]: parsed });
    } catch {
      return json({ ok: true, [what === "lab:strategies" ? "strategies" : "state"]: null });
    }
  }

  // ── POST: { token, state } from the agent, or { token, strategies } from
  // the Registry's publish button. ─────────────────────────────────────────
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!safeEqual(String(body?.token || ""), env.DEV_ACCESS_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }

  if (Array.isArray(body?.strategies)) {
    const payload = JSON.stringify({ items: body.strategies, publishedAt: Date.now() });
    if (payload.length > MAX_STATE_BYTES) return json({ error: "strategies_too_large", max: MAX_STATE_BYTES }, 413);
    await env.SUBSCRIBERS.put("lab:strategies", payload);
    return json({ ok: true, published: body.strategies.length, bytes: payload.length });
  }

  const state = body?.state;
  if (!state || typeof state !== "object") return json({ error: "state_or_strategies_required" }, 400);

  const payload = JSON.stringify({ ...state, receivedAt: Date.now() });
  if (payload.length > MAX_STATE_BYTES) return json({ error: "state_too_large", max: MAX_STATE_BYTES }, 413);

  await env.SUBSCRIBERS.put("lab:state", payload);
  return json({ ok: true, bytes: payload.length });
}
