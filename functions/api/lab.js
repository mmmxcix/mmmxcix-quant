// /api/lab — bridge between the local lab agent (the user's PC: n8n + Node,
// running research/paper-trading 24/7) and the site. Push model: the PC POSTs
// its state here; the site reads it back. Cloudflare cannot reach into a home
// network, so the PC always initiates.
//
// Three channels, all under the same token:
//   lab:state       agent → site   (equity, positions, heartbeat)
//   lab:strategies  site  → agent  (paper-status registry entries to execute)
//   lab:candidates  agent → site   (research survivors; MERGED by id, capped,
//                                   so good strategies accumulate on the site)
//
// Storage: the existing SUBSCRIBERS KV namespace, keys prefixed "lab:" — no
// new bindings or dashboard work. Auth: DEV_ACCESS_TOKEN (same secret as the
// AI generator), constant-time compared. Reads are token-gated too: the lab
// state is the owner's private data.

const MAX_STATE_BYTES = 64 * 1024;
// The "Deckel", now per profile: prop and private are two separate books, so a
// full prop book must not stop a private promotion. Enforced server-side so it
// holds no matter which producer (agent or Registry) last wrote. Newest
// auto-promotions win within each profile.
//
// Kept in sync with src/lib/profiles.js — duplicated deliberately: Pages
// Functions and the browser bundle do not share a module graph, and a wrong
// cap here is a portfolio-sizing bug, not a cosmetic one.
const PROFILE_CAPS = { prop: 3, private: 8 };
const DEFAULT_PROFILE = "private";
const capFor = (p) => PROFILE_CAPS[p] ?? PROFILE_CAPS[DEFAULT_PROFILE];

async function readStrategyItems(env) {
  try { return JSON.parse((await env.SUBSCRIBERS.get("lab:strategies")) || "{}").items || []; } catch { return []; }
}

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
    const whatParam = new URL(request.url).searchParams.get("what");
    const field = whatParam === "strategies" ? "strategies"
      : whatParam === "candidates" ? "candidates"
      : whatParam === "brain" ? "brain"
      : "state";
    const raw = await env.SUBSCRIBERS.get(`lab:${field}`);
    if (!raw) return json({ ok: true, [field]: null });
    try {
      return json({ ok: true, [field]: JSON.parse(raw) });
    } catch {
      return json({ ok: true, [field]: null });
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

  // Registry's "Publish to agent": the user's manual paper list. Preserve any
  // research-auto-promoted strategies already stored, so a manual publish never
  // wipes the autonomous ones (and vice-versa).
  if (Array.isArray(body?.strategies)) {
    const existingAuto = (await readStrategyItems(env)).filter((s) => s && s.auto);
    const manual = body.strategies.map((s) => ({ ...s, auto: false }));
    const byId = new Map();
    for (const s of [...manual, ...existingAuto]) if (s && s.id && !byId.has(s.id)) byId.set(s.id, s);
    const items = [...byId.values()];
    const payload = JSON.stringify({ items, publishedAt: Date.now() });
    if (payload.length > MAX_STATE_BYTES) return json({ error: "strategies_too_large", max: MAX_STATE_BYTES }, 413);
    await env.SUBSCRIBERS.put("lab:strategies", payload);
    return json({ ok: true, published: manual.length, autoKept: existingAuto.length, bytes: payload.length });
  }

  // Research auto-promotion: the agent pushes strategies that cleared the DSR
  // threshold. They MERGE with the manual list, are capped server-side, and are
  // tagged auto:true so the paper-trader and the preservation logic above can
  // tell them apart. Newest auto-promotions win when over the cap.
  if (Array.isArray(body?.promote)) {
    const existing = await readStrategyItems(env);
    const manual = existing.filter((s) => s && !s.auto);
    const incoming = body.promote
      .filter((s) => s && s.id && typeof s.code === "string")
      .map((s) => ({ ...s, auto: true, profile: s.profile || DEFAULT_PROFILE }));

    // Merge newest-first, then apply the cap SEPARATELY per profile so the two
    // books fill independently.
    const byId = new Map();
    for (const s of [...incoming, ...existing.filter((s) => s && s.auto)]) {
      if (s.id && !byId.has(s.id)) byId.set(s.id, { ...s, profile: s.profile || DEFAULT_PROFILE });
    }
    const perProfile = {};
    const autoItems = [];
    for (const s of byId.values()) {
      const p = s.profile;
      perProfile[p] = (perProfile[p] || 0) + 1;
      if (perProfile[p] <= capFor(p)) autoItems.push(s);
    }

    const items = [...manual, ...autoItems];
    const payload = JSON.stringify({ items, publishedAt: Date.now() });
    if (payload.length > MAX_STATE_BYTES) return json({ error: "strategies_too_large", max: MAX_STATE_BYTES }, 413);
    await env.SUBSCRIBERS.put("lab:strategies", payload);
    const active = {};
    for (const s of autoItems) active[s.profile] = (active[s.profile] || 0) + 1;
    return json({
      ok: true, promoted: incoming.length, autoActive: autoItems.length,
      byProfile: active, caps: PROFILE_CAPS, bytes: payload.length,
    });
  }

  // Research candidates ACCUMULATE: merge by id with what's already stored
  // (newest first), so survivors persist on the site across agent runs.
  if (Array.isArray(body?.candidates)) {
    let existing = [];
    try { existing = JSON.parse((await env.SUBSCRIBERS.get("lab:candidates")) || "{}").items || []; } catch { /* fresh */ }
    const byId = new Map();
    for (const c of [...body.candidates, ...existing]) {
      if (c && c.id && !byId.has(c.id)) byId.set(c.id, c);
    }
    // 30, matching the agent's local store — with 2–5 harvests per night the
    // old cap of 20 evicted survivors before the daytime re-validator saw them.
    const items = [...byId.values()].slice(0, 30);
    const payload = JSON.stringify({ items, updatedAt: Date.now() });
    if (payload.length > MAX_STATE_BYTES) return json({ error: "candidates_too_large", max: MAX_STATE_BYTES }, 413);
    await env.SUBSCRIBERS.put("lab:candidates", payload);
    return json({ ok: true, stored: items.length, bytes: payload.length });
  }

  // Brain vault: the research agent's knowledge graph (papers as nodes, shared
  // topics as edges). Its own channel because it can be larger than the state.
  if (body?.brain && typeof body.brain === "object") {
    const payload = JSON.stringify({ ...body.brain, updatedAt: Date.now() });
    if (payload.length > MAX_STATE_BYTES) return json({ error: "brain_too_large", max: MAX_STATE_BYTES }, 413);
    await env.SUBSCRIBERS.put("lab:brain", payload);
    return json({ ok: true, nodes: (body.brain.nodes || []).length, edges: (body.brain.edges || []).length, bytes: payload.length });
  }

  const state = body?.state;
  if (!state || typeof state !== "object") return json({ error: "state_or_strategies_required" }, 400);

  const payload = JSON.stringify({ ...state, receivedAt: Date.now() });
  if (payload.length > MAX_STATE_BYTES) return json({ error: "state_too_large", max: MAX_STATE_BYTES }, 413);

  await env.SUBSCRIBERS.put("lab:state", payload);
  return json({ ok: true, bytes: payload.length });
}
