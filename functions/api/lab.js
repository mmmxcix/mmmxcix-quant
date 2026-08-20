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
import { cleanStrategyName } from "../_lib/strategyName.js";

const MAX_STATE_BYTES = 64 * 1024;
// How often the read path may PERSIST its self-heal (see the GET handler).
const HEAL_MIN_INTERVAL_MS = 60 * 60 * 1000;
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
// source code (comments/whitespace stripped — so a differing "// NAME:" comment
// does NOT count). Two strategies with the same sig are THE SAME strategy
// republished under different names.
function stratSig(s) {
  const code = String(s?.code || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/#[^\n]*/g, "")           // python comments too
    .replace(/\s+/g, "")
    .toLowerCase();
  return `${String(s?.symbol || "").toUpperCase()}|${s?.interval || ""}|${code}`;
}

// A NAME-based identity: instrument + the strategy's base name with provenance
// decoration stripped ("[research] ", "🤖 ", "improved · ", trailing "· SYM tf").
// Catches duplicates the code-sig misses — e.g. a broken/truncated "[research]"
// twin whose code differs from its working promotion but is plainly the same
// strategy by name.
function nameKey(s) {
  let n = String(s?.name || "").toLowerCase()
    .replace(/^\s*\[[^\]]*\]\s*/g, "")                 // [research]
    .replace(/^\s*(?:🤖|✨|📈|🔥|⭐|🚀)\s*/gu, "")        // emoji badge
    .replace(/^\s*(?:improved|variant|mined)\s*·\s*/g, "") // provenance
    .replace(/\s*·\s*[^·]*\b(?:daily|weekly|\d+\s*(?:m|min|h|d|w))\s*$/g, "") // "· BTC/USDT daily"
    .replace(/\s+/g, " ").trim();
  return `${String(s?.symbol || "").toUpperCase()}|${s?.interval || ""}|${n}`;
}

// Does the code actually define a runnable strategy? An entry whose code can't
// even define strategy()/signals() errors every single cycle and is invariably a
// broken twin of a working promotion — safe (and correct) to delete.
function codeIsRunnable(s) {
  const c = String(s?.code || "");
  if (!c) return true; // builder / no-code entries — not our concern
  return /function\s+strategy\b|(?:const|let|var)\s+strategy\s*=|\bstrategy\s*=\s*(?:function|\(|async)|def\s+(?:signals|strategy)\s*\(/.test(c);
}

// Fix a wrong/missing `language` tag by INFERRING it from the code. Several
// legacy entries carry Python code (`def signals(df)`) with an empty language,
// so the agent compiled them as JS and they errored every cycle. Setting the
// right language makes them RUN instead of getting deleted.
function normalizeLanguage(s) {
  if (!s || !s.code) return s;
  const c = String(s.code);
  const isPy = /def\s+(?:signals|strategy)\s*\(/.test(c) && !/function\s+strategy\b/.test(c);
  const isJs = /function\s+strategy\b|(?:const|let|var)\s+strategy\s*=/.test(c);
  const want = isPy ? "python" : isJs ? "js" : s.language;
  return (want && want !== s.language) ? { ...s, language: want } : s;
}

// A strategy with a CRITICAL code-validity bug must never paper-trade — its numbers
// are a lie. This is the high-precision CRITICAL subset of src/lib/strategyAudit.js
// (kept inline because Cloudflare functions don't import from src/lib): a degenerate
// single-asset "arbitrage" (log weights cancel → triggers on float error), a
// look-ahead peek at a future bar, or a constant price-independent signal.
function hasCriticalBug(s) {
  const c = String(s?.code || "");
  if (!c.trim()) return false;
  const py = s?.language === "python";
  if (/\b(bellman[- ]?ford|arbitrage|negative[- ]?cycle|triangular|cross[- ]?rate)\b/i.test(c)
    && /(Math\.log|np\.log|\blog\s*\()/i.test(c)) return true;
  if (py ? /\.shift\(\s*-\s*\d+\s*\)|\.iloc\[[^\]]*\+\s*1\s*\]|\[\s*i\s*\+\s*[1-9]/.test(c)
         : /\[\s*i\s*\+\s*[1-9]\d*\s*\]|candles\s*\[[^\]]*\+\s*[1-9]/.test(c)) return true;
  const rets = [...c.matchAll(/return\s+["'`](long|short|flat|buy|sell|hold)["'`]/gi)].map((m) => m[1].toLowerCase());
  const nonFlat = rets.filter((r) => r !== "flat" && r !== "hold");
  if (rets.length && nonFlat.length && new Set(rets).size === 1) return true;
  // Side-inverted brackets (mirrors strategyAudit's inverted-short/long-bracket):
  // a stop computed on the WRONG side of entry sits in profit, so (before the
  // engine's fill clamp) every exit was a guaranteed win. Short: stop ONLY ever
  // below entry (close − …). Long: stop ONLY ever above entry (close + …).
  const stopBelow = /\bstop\b\s*[:=][^;\n]*\b(close|price|entry|hl2|mid)\b[^;\n]*-/.test(c);
  const stopAbove = /\bstop\b\s*[:=][^;\n]*\b(close|price|entry|hl2|mid)\b[^;\n]*\+/.test(c);
  const shortBracket = /\bsignal\s*:\s*["']short["'][^}]*\b(stop|target)\b/.test(c) || /["']short["']\s*,\s*(stop|target)/.test(c);
  if (shortBracket && stopBelow && !stopAbove) return true;
  const longBracket = /\bsignal\s*:\s*["']long["'][^}]*\b(stop|target)\b/.test(c) || /["']long["']\s*,\s*(stop|target)/.test(c);
  if (longBracket && stopAbove && !stopBelow) return true;
  // Self-inclusive rolling-extreme exit (mirrors strategyAudit): an exit level
  // of close.rolling(n).min() includes the current close, so `close < level`
  // can never fire — the described exit is dead code.
  if (/df\[['"]close['"]\]\s*<\s*df\[['"]close['"]\]\.rolling\([^)]*\)\.min\(\)(?!\s*\.shift)/.test(c)) return true;
  if (/df\[['"]close['"]\]\s*>\s*df\[['"]close['"]\]\.rolling\([^)]*\)\.max\(\)(?!\s*\.shift)/.test(c)) return true;
  for (const m of c.matchAll(/(?:df\[['"](\w+)['"]\]|(\w+))\s*=\s*df\[['"]close['"]\]\.rolling\([^)]*\)\.(min|max)\(\)\s*$/gm)) {
    const name = m[1] || m[2];
    const ref = m[1] ? `df\\[['"]${name}['"]\\]` : `\\b${name}\\b`;
    const cmp = m[3] === "min" ? "<" : ">";
    if (new RegExp(`df\\[['"]close['"]\\]\\s*${cmp}\\s*${ref}(?!\\s*\\.shift)`).test(c)) return true;
  }
  return false;
}

// The full tidy pass applied wherever lab:strategies is written or self-healed:
// fix languages first (so dedupe/runnability see the truth), DROP critical-buggy
// strategies (they must not trade), collapse duplicates, then clean legacy names.
function tidyStrategies(items) {
  return cleanNames(dedupeByCode((items || []).map(normalizeLanguage).filter((s) => !hasCriticalBug(s))));
}

// Among two duplicates, which to KEEP: a runnable entry beats a broken one, a
// manual publish beats an auto-promotion, a clean name beats a "[research]" one,
// and otherwise the incumbent (earliest) wins so ids stay stable across runs.
function preferKeep(incumbent, challenger) {
  const ir = codeIsRunnable(incumbent), cr = codeIsRunnable(challenger);
  if (ir !== cr) return ir ? incumbent : challenger;
  if (!!incumbent.auto !== !!challenger.auto) return incumbent.auto ? challenger : incumbent;
  const iBad = /^\s*\[/.test(incumbent.name || ""), cBad = /^\s*\[/.test(challenger.name || "");
  if (iBad !== cBad) return iBad ? challenger : incumbent;
  return incumbent;
}

// Delete duplicate published strategies — the SOURCE fix for "the same strat is
// in the list 2×". First DROP entries whose code can't run at all (they error
// forever and are always a broken duplicate), then collapse the rest by code
// signature OR name identity, keeping the best copy of each. Order preserved.
function dedupeByCode(items) {
  const runnable = items.filter((s) => s && s.id && codeIsRunnable(s));
  const byCode = new Map(); // sig -> index in out
  const byName = new Map(); // nameKey -> index in out
  const out = [];
  for (const s of runnable) {
    const cs = s.code ? stratSig(s) : null;
    const ns = nameKey(s);
    let idx = (cs != null && byCode.has(cs)) ? byCode.get(cs)
            : (byName.has(ns) ? byName.get(ns) : -1);
    if (idx === -1) {
      idx = out.length; out.push(s);
      if (cs != null) byCode.set(cs, idx);
      byName.set(ns, idx);
      continue;
    }
    // duplicate of out[idx] — keep the better of the two, re-point its sigs
    const keep = preferKeep(out[idx], s);
    out[idx] = keep;
    if (keep.code) byCode.set(stratSig(keep), idx);
    byName.set(nameKey(keep), idx);
  }
  return out;
}

// Replace legacy source-title / "[research]" clickbait names with clean mechanism
// names derived from the code — retroactively fixing entries named before the
// generator learned to name by mechanism. Preserves already-good names.
function cleanNames(items) {
  return items.map((s) => {
    if (!s || !s.code) return s;
    const cleaned = cleanStrategyName(s.name, s.code);
    return cleaned && cleaned !== s.name ? { ...s, name: cleaned } : s;
  });
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
      // Self-heal: collapse duplicate published strategies AND clean legacy
      // clickbait names already stored, so both the agent (which reads this every
      // cycle) and the UI see a deduped, well-named list — persisted back when it
      // actually changed.
      if (field === "strategies" && Array.isArray(parsed?.items)) {
        const cleaned = tidyStrategies(parsed.items);
        if (JSON.stringify(cleaned) !== JSON.stringify(parsed.items)) {
          // The RESPONSE is always the tidied list — the caller never sees a
          // duplicate. The WRITE is throttled: three surfaces poll this endpoint
          // on 60-second timers (Dashboard, Lab panel, Registry), so an
          // unconditional persist turned every open tab into a steady stream of
          // KV writes against the free-tier daily budget. Once an hour is plenty
          // for a self-heal; the POST paths persist immediately as they always did.
          const healedAt = parsed.healedAt || 0;
          parsed.items = cleaned;
          if (Date.now() - healedAt > HEAL_MIN_INTERVAL_MS) {
            const write = env.SUBSCRIBERS.put("lab:strategies", JSON.stringify({
              items: cleaned, publishedAt: parsed.publishedAt || Date.now(), healedAt: Date.now(),
            }));
            if (waitUntil) waitUntil(write); else await write;
          }
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

  // Retire strategies from the live paper book — the "remove from EVERYWHERE"
  // hook: burying/deleting a library entry (Registry UI or the retest pass) calls
  // this so the lab agent stops trading it on its next cycle. Matches by any id
  // the caller knows (library id, paperId, candidateId) or by normalized code, so
  // a republished copy under a different id is caught too.
  if (body?.retire && typeof body.retire === "object") {
    const ids = new Set((body.retire.ids || []).filter(Boolean).map(String));
    const normCode = (c) => String(c || "")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/#[^\n]*/g, "")
      .replace(/\s+/g, "").toLowerCase();
    const codeSigs = new Set((body.retire.codes || []).filter(Boolean).map(normCode));
    const items = await readStrategyItems(env);
    const keep = items.filter((s) => {
      if (!s) return false;
      if (ids.has(String(s.id)) || (s.candidateId && ids.has(String(s.candidateId)))) return false;
      if (s.code && codeSigs.size && codeSigs.has(normCode(s.code))) return false;
      return true;
    });
    if (keep.length !== items.length) {
      await env.SUBSCRIBERS.put("lab:strategies", JSON.stringify({ items: tidyStrategies(keep), publishedAt: Date.now() }));
    }
    return json({ ok: true, retired: items.length - keep.length, remaining: keep.length });
  }

  // Registry's "Publish to agent": the user's manual paper list. Preserve any
  // research-auto-promoted strategies already stored, so a manual publish never
  // wipes the autonomous ones (and vice-versa).
  if (Array.isArray(body?.strategies)) {
    const existingAuto = (await readStrategyItems(env)).filter((s) => s && s.auto);
    const manual = body.strategies.map((s) => ({ ...s, auto: false }));
    const byId = new Map();
    for (const s of [...manual, ...existingAuto]) if (s && s.id && !byId.has(s.id)) byId.set(s.id, s);
    const items = tidyStrategies([...byId.values()]);
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
    // A candidate whose LIBRARY card is sidelined (improve) or buried must not
    // be auto-promoted back into the paper book — the card carries the fix
    // brief, and the retest pass re-admits it once it clears. Best-effort: no
    // DB binding (or a read error) simply skips the filter.
    const blocked = new Set();      // candidate ids of sidelined/buried cards
    const blockedCode = new Set();  // …and their normalized CODE
    const blockedName = new Set();  // …and their name identity
    const normCode = (c) => String(c || "")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/#[^\n]*/g, "")
      .replace(/\s+/g, "").toLowerCase();
    try {
      if (env.DB) {
        const rows = await env.DB.prepare("SELECT data FROM library WHERE owner = ?").bind("dev").all();
        for (const r of rows?.results || []) {
          try {
            const e = JSON.parse(r.data);
            if (e.status !== "improve" && e.status !== "graveyard") continue;
            if (e.candidateId) blocked.add(String(e.candidateId));
            // Cortex re-discovers the SAME idea under a fresh candidate id, so
            // an id-only filter let a sidelined strategy walk straight back into
            // the paper book. Block by code and by name identity as well.
            if (e.code) blockedCode.add(normCode(e.code));
            if (e.name) blockedName.add(nameKey(e));
          } catch { /* skip a bad row */ }
        }
      }
    } catch { /* filter is best-effort */ }
    const baseCand = (s) => String(s.candidateId || String(s.id).replace(/_(prop|private)(_.*)?$/, ""));
    const incoming = body.promote
      .filter((s) => s && s.id && typeof s.code === "string")
      .filter((s) => !blocked.has(baseCand(s)) && !blockedCode.has(normCode(s.code)) && !blockedName.has(nameKey(s)))
      // Risk-exit gate at the door: no stop/trailing/target = no paper book,
      // whatever the numbers say (mirrors the research gauntlet's own check).
      .filter((s) => /(stop|target|trailing|trail|\bsl\b|\btp\b)/i.test(String(s.code || "")))
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

    const items = tidyStrategies([...manual, ...autoItems]);
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

  // Remove candidates by id — the revalidator's cleanup for decayed entries.
  // Without this the site list only ever accumulated: a candidate that failed
  // re-validation stayed stored, was re-pulled as "due" on every later pass and
  // re-decayed forever — burning every run's budget on zombies and flooding the
  // graveyard with a fresh tombstone each time.
  if (Array.isArray(body?.candidatesRemove)) {
    let existing = [];
    try { existing = JSON.parse((await env.SUBSCRIBERS.get("lab:candidates")) || "{}").items || []; } catch { /* fresh */ }
    const drop = new Set(body.candidatesRemove.filter(Boolean).map(String));
    const items = existing.filter((c) => c && !drop.has(String(c.id)));
    if (items.length !== existing.length) {
      await env.SUBSCRIBERS.put("lab:candidates", JSON.stringify({ items, updatedAt: Date.now() }));
    }
    return json({ ok: true, removed: existing.length - items.length, remaining: items.length });
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
