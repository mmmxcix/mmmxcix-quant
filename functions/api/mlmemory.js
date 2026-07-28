// /api/mlmemory — server-side home for the ML Studio's memory (run log +
// prediction ledger). It used to live only in localStorage, so the track record
// was per-browser and vanished with a cache clear — the ledger is the ONLY
// evidence of real out-of-sample skill, so it has to outlive one device.
//
// KV keys: ml:runs, ml:preds. Admin-session gated (the studio's track record is
// private); the PC agents' machine token also works, same as /api/lab.
//
// Writes MERGE rather than replace: two devices that each made predictions both
// keep them. Identity is the entry's natural key (madeAt+type+symbol/month for
// predictions, ts+label for runs), so re-syncing the same entry is idempotent
// and a RESOLVED copy always wins over an unresolved one.

import { isAdminRequest } from "../_lib/auth.mjs";

const RUNS_CAP = 120;
const PREDS_CAP = 250;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(String(a)), bb = enc.encode(String(b));
  if (ab.length !== bb.length) return false;
  let d = 0;
  for (let i = 0; i < ab.length; i++) d |= ab[i] ^ bb[i];
  return d === 0;
}

const predKey = (p) => `${p.type}|${p.type === "ranking" ? p.month : `${p.symbol}|${p.model}|${p.lastBarTime}`}`;
const runKey = (r) => `${r.ts}|${r.label}`;

/** Merge two lists by key, newest first, resolved entries winning. */
function merge(existing, incoming, keyFn, cap) {
  const by = new Map();
  for (const e of [...(existing || []), ...(incoming || [])]) {
    if (!e || typeof e !== "object") continue;
    const k = keyFn(e);
    const prev = by.get(k);
    // A resolved copy always beats an unresolved one; otherwise the newer wins.
    if (!prev || (e.resolved && !prev.resolved) || (!!e.resolved === !!prev.resolved && (e.madeAt || e.ts || 0) >= (prev.madeAt || prev.ts || 0))) {
      by.set(k, e);
    }
  }
  return [...by.values()].sort((a, b) => (b.madeAt || b.ts || 0) - (a.madeAt || a.ts || 0)).slice(0, cap);
}

export async function onRequest({ request, env }) {
  const kv = env.SUBSCRIBERS;
  if (!kv) return json({ error: "not_configured" }, 503);

  const tokenOk = !!env.DEV_ACCESS_TOKEN && safeEqual(request.headers.get("x-lab-token") || "", env.DEV_ACCESS_TOKEN);
  const read = async (k) => { try { return JSON.parse((await kv.get(`ml:${k}`)) || "[]"); } catch { return []; } };

  if (request.method === "GET") {
    if (!tokenOk && !(await isAdminRequest(env, request))) return json({ error: "unauthorized" }, 401);
    const [runs, preds] = await Promise.all([read("runs"), read("preds")]);
    return json({ ok: true, runs, preds });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
    const bodyTokenOk = !!env.DEV_ACCESS_TOKEN && safeEqual(body.token || "", env.DEV_ACCESS_TOKEN);
    if (!tokenOk && !bodyTokenOk && !(await isAdminRequest(env, request))) return json({ error: "unauthorized" }, 401);

    try {
      const out = {};
      if (Array.isArray(body.runs)) {
        out.runs = merge(await read("runs"), body.runs, runKey, RUNS_CAP);
        await kv.put("ml:runs", JSON.stringify(out.runs));
      }
      if (Array.isArray(body.preds)) {
        out.preds = merge(await read("preds"), body.preds, predKey, PREDS_CAP);
        await kv.put("ml:preds", JSON.stringify(out.preds));
      }
      return json({ ok: true, runs: out.runs?.length ?? null, preds: out.preds?.length ?? null });
    } catch (e) {
      // KV write budget exhausted etc. — the client keeps its local copy and
      // retries later rather than losing the entry.
      return json({ error: "kv_write_failed", detail: String(e?.message || e) }, 503);
    }
  }

  return json({ error: "method" }, 405);
}
