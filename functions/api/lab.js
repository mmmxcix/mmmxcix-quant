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
// new bindings or dashboard work. Auth (dual): the PC agents use the machine
// token DEV_ACCESS_TOKEN (constant-time compared); humans use their Better Auth
// ADMIN session cookie. Reads are gated too: the lab state is private data.

import { isAdminRequest } from "../_lib/auth.mjs";

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

// A stable signature for a published strategy: its instrument + its normalized
// source code (comments/whitespace stripped). Two strategies with the same sig
// are THE SAME strategy republished under different names.
function stratSig(s) {
  const code = String(s?.code || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
  return `${String(s?.symbol || "").toUpperCase()}|${s?.interval || ""}|${code}`;
}

// Collapse duplicate published strategies (identical instrument + code) to one
// entry — the SOURCE fix for "the same strat is in the list 2×". Keeps the best
// copy per signature: a manual publish beats an auto-promotion, and among equals
// the one already in the list (earliest) wins, so ids stay stable across runs.
// Entries with no code (can't be compared) are always kept. Order is preserved.
function dedupeByCode(items) {
  const kept = new Map(); // sig -> index in out
  const out = [];
  for (const s of items) {
    if (!s || !s.id) continue;
    if (!s.code) { out.push(s); continue; } // uncomparable → keep
    const sig = stratSig(s);
    if (!kept.has(sig)) { kept.set(sig, out.length); out.push(s); continue; }
    const idx = kept.get(sig);
    const prev = out[idx];
    // A manual entry supersedes an auto duplicate; otherwise drop the newcomer.
    if (prev.auto && !s.auto) out[idx] = s;
  }
  return out;
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

export async function onRequest({ request, env, waitUntil }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-lab-token",
      },
    });
  }
  if (!env.SUBSCRIBERS) {
    return json({ error: "not_configured" }, 503);
  }

  // Dual auth everywhere below: the PC agents send the machine token
  // (x-lab-token header / body.token = DEV_ACCESS_TOKEN); humans are gated by
  // their Better Auth ADMIN session cookie instead. Non-admins get a 401 and
  // the UI simply hides the private panels.
  const headerTokenOk = !!env.DEV_ACCESS_TOKEN && safeEqual(request.headers.get("x-lab-token") || "", env.DEV_ACCESS_TOKEN);

  // ── GET: agent-token- or admin-session-gated reads. Default = agent state;
  // ?what=strategies = the published paper strategies. ─────────────────────
  if (request.method === "GET") {
    if (!headerTokenOk && !(await isAdminRequest(env, request))) return json({ error: "unauthorized" }, 401);
    const whatParam = new URL(request.url).searchParams.get("what");
    const field = whatParam === "strategies" ? "strategies"
      : whatParam === "candidates" ? "candidates"
      : whatParam === "brain" ? "brain"
      : whatParam === "mode" ? "mode"
      : "state";
    const raw = await env.SUBSCRIBERS.get(`lab:${field}`);
    if (!raw) return json({ ok: true, [field]: null });
    try {
      const parsed = JSON.parse(raw);
      // Self-heal: collapse any duplicate published strategies already stored, so
      // both the agent (which reads this every cycle) and the UI see the list
      // without dupes — and persist the cleaned list back when it actually shrank.
      if (field === "strategies" && Array.isArray(parsed?.items)) {
        const cleaned = dedupeByCode(parsed.items);
        if (cleaned.length !== parsed.items.length) {
          parsed.items = cleaned;
          if (waitUntil) waitUntil(env.SUBSCRIBERS.put("lab:strategies", JSON.stringify({ items: cleaned, publishedAt: Date.now() })));
          else await env.SUBSCRIBERS.put("lab:strategies", JSON.stringify({ items: cleaned, publishedAt: Date.now() }));
        }
      }
      return json({ ok: true, [field]: parsed });
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
  const bodyTokenOk = !!env.DEV_ACCESS_TOKEN && safeEqual(String(body?.token || ""), env.DEV_ACCESS_TOKEN);
  if (!bodyTokenOk && !(await isAdminRequest(env, request))) {
    return json({ error: "unauthorized" }, 401);
  }

  // Cortex Always-On switch (site UI → KV → PC agents). ON = the research loop
  // runs around the clock; OFF = night cadence. The agent reads ?what=mode on
  // every 15-min cycle, so a flip takes effect within one cycle.
  if (body?.mode && typeof body.mode === "object") {
    const mode = { alwaysOn: !!body.mode.alwaysOn, updatedAt: Date.now() };
    await env.SUBSCRIBERS.put("lab:mode", JSON.stringify(mode));
    return json({ ok: true, mode });
  }

  // Registry's "Publish to agent": the user's manual paper list. Preserve any
  // research-auto-promoted strategies already stored, so a manual publish never
  // wipes the autonomous ones (and vice-versa).
  if (Array.isArray(body?.strategies)) {
    const existingAuto = (await readStrategyItems(env)).filter((s) => s && s.auto);
    const manual = body.strategies.map((s) => ({ ...s, auto: false }));
    const byId = new Map();
    for (const s of [...manual, ...existingAuto]) if (s && s.id && !byId.has(s.id)) byId.set(s.id, s);
    const items = dedupeByCode([...byId.values()]);
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
    // De-dupe by code BEFORE the cap so identical strategies never occupy two of
    // the (few) auto slots — one good strategy, not the same one twice.
    const deduped = dedupeByCode([...byId.values()]);
    const perProfile = {};
    const autoItems = [];
    for (const s of deduped) {
      const p = s.profile;
      perProfile[p] = (perProfile[p] || 0) + 1;
      if (perProfile[p] <= capFor(p)) autoItems.push(s);
    }

    const items = dedupeByCode([...manual, ...autoItems]);
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
