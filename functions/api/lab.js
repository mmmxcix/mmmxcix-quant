// /api/lab — bridge between the local lab agent (the user's PC: n8n + Node,
// running research/paper-trading 24/7) and the site. Push model: the PC POSTs
// its state here; the site reads it back. Cloudflare cannot reach into a home
// network, so the PC always initiates.
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

  // ── GET: the site (private Lab/Coach view) reads the last pushed state ──
  if (request.method === "GET") {
    const token = request.headers.get("x-lab-token") || "";
    if (!safeEqual(token, env.DEV_ACCESS_TOKEN)) return json({ error: "unauthorized" }, 401);
    const raw = await env.SUBSCRIBERS.get("lab:state");
    if (!raw) return json({ ok: true, state: null });
    try {
      return json({ ok: true, state: JSON.parse(raw) });
    } catch {
      return json({ ok: true, state: null });
    }
  }

  // ── POST: the PC agent pushes { token, state } ──────────────────────────
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
  const state = body?.state;
  if (!state || typeof state !== "object") return json({ error: "state_required" }, 400);

  const payload = JSON.stringify({ ...state, receivedAt: Date.now() });
  if (payload.length > MAX_STATE_BYTES) return json({ error: "state_too_large", max: MAX_STATE_BYTES }, 413);

  await env.SUBSCRIBERS.put("lab:state", payload);
  return json({ ok: true, bytes: payload.length });
}
